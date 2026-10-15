<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\PaymentIntent;
use DateTimeImmutable;
use Doctrine\DBAL\LockMode;
use Doctrine\ORM\Query;

/**
 * Card checkouts ({@see PaymentIntent}). Every read that decides something
 * about money is a fresh read (an already-loaded copy is overwritten with the
 * row as it is now), and every state change happens either under the row lock
 * ({@see lock()}) or as a compare-and-set whose affected-row count decides.
 * Each finder has a public *Query() twin so its DQL compiles in the offline tests.
 */
final class PaymentIntentRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return PaymentIntent::class;
    }

    /** The checkout under `$reference` as the database has it now, or null. */
    public function byReference(string $reference): ?PaymentIntent
    {
        $intent = $this->byReferenceQuery($reference)->getOneOrNullResult();

        return $intent instanceof PaymentIntent ? $intent : null;
    }

    public function byReferenceQuery(string $reference): Query
    {
        return $this->qb()
            ->andWhere('e.reference = :reference')
            ->setParameter('reference', $reference)
            ->getQuery()
            ->setHint(Query::HINT_REFRESH, true);
    }

    /**
     * Lock `$intent`'s row until the current transaction ends and reload it
     * (call inside {@see transactional()}): what another request committed a
     * moment ago — a consumption, a wallet credit — is what this one sees.
     */
    public function lock(PaymentIntent $intent): void
    {
        $this->em->refresh($intent, LockMode::PESSIMISTIC_WRITE);
    }

    /**
     * Record Paystack's confirmation as a compare-and-set: only a checkout that
     * is still payable (initiated / expired / failed) becomes paid, so the
     * webhook, the sweep and a booking confirming it at once write it once.
     * True when THIS call recorded it.
     */
    public function markPaid(string $reference, string $amount, string $currency, ?string $gatewayReference, DateTimeImmutable $at): bool
    {
        return (int) $this->markPaidQuery($reference, $amount, $currency, $gatewayReference, $at)->execute() === 1;
    }

    public function markPaidQuery(string $reference, string $amount, string $currency, ?string $gatewayReference, DateTimeImmutable $at): Query
    {
        return $this->em->createQueryBuilder()
            ->update(PaymentIntent::class, 'p')
            ->set('p.status', ':paid')
            ->set('p.verifiedAmount', ':amount')
            ->set('p.verifiedCurrency', ':currency')
            ->set('p.gatewayReference', ':gateway')
            ->set('p.paidAt', ':at')
            ->set('p.lastCheckedAt', ':at')
            ->set('p.failureReason', 'NULL')
            ->set('p.updatedAt', ':at')
            ->where('p.reference = :reference')
            ->andWhere('p.status IN (:payable)')
            ->setParameter('paid', PaymentIntent::STATUS_PAID)
            ->setParameter('amount', bcadd($amount, '0', 2))
            ->setParameter('currency', strtoupper($currency))
            ->setParameter('gateway', $gatewayReference)
            ->setParameter('at', $at)
            ->setParameter('reference', $reference)
            ->setParameter('payable', PaymentIntent::PAYABLE)
            ->getQuery();
    }

    /**
     * Note that the sweep just tried it — asked Paystack, or tried to credit it
     * — whatever came of that (no status change). It moves to the back of its
     * queue, so a payment that keeps failing can't hold up the others. Plain
     * DBAL on the connection, so it works after a failure closed the entity
     * manager.
     */
    public function touchChecked(string $reference, DateTimeImmutable $at): void
    {
        $this->em->getConnection()->executeStatement(
            sprintf('UPDATE %s SET last_checked_at = ? WHERE reference = ?', $this->table()),
            [$at, $reference],
            [\Doctrine\DBAL\Types\Types::DATETIME_IMMUTABLE, \Doctrine\DBAL\ParameterType::STRING],
        );
    }

    /**
     * When the first checkout was recorded — i.e. roughly when payment intents
     * were deployed (null: none yet). A pre-intent reference is adopted only if
     * it was paid around then ({@see \App\Infrastructure\Service\PaymentIntentService}).
     */
    public function firstRecordedAt(): ?DateTimeImmutable
    {
        $first = $this->em->getConnection()->fetchOne(sprintf('SELECT MIN(created_at) FROM %s', $this->table()));

        return is_string($first) && $first !== '' ? new DateTimeImmutable($first) : null;
    }

    /**
     * Whether appointment `$appointmentId` ever had a guest removed (audited)
     * or a removed guest's fee refunded (`appt_guest_refund_<guest id>`):
     * the old code kept a guest's card reference only on the guest entry, so a
     * pre-intent guest payment there may have been refunded already.
     * `$appointmentId` must be a UUID (the caller checks).
     */
    public function guestRemovedFrom(string $appointmentId): bool
    {
        return $this->em->getConnection()->fetchOne(
            "SELECT 1 FROM audit_events ae
              WHERE ae.appointment_id = ?
                AND (ae.action = 'appointment.guest_removed'
                     OR (ae.resource_type = 'guest' AND EXISTS (
                            SELECT 1 FROM wallet_transactions wt WHERE wt.reference = 'appt_guest_refund_' || ae.resource_id)))
              LIMIT 1",
            [strtolower($appointmentId)],
        ) !== false;
    }

    private function table(): string
    {
        return $this->em->getClassMetadata(PaymentIntent::class)->getTableName();
    }

    /** An initiated checkout never paid by `$cutoff` expires — compare-and-set, true when THIS call did it. */
    public function expire(string $reference, DateTimeImmutable $cutoff, DateTimeImmutable $at): bool
    {
        return (int) $this->em->createQueryBuilder()
            ->update(PaymentIntent::class, 'p')
            ->set('p.status', ':expired')
            ->set('p.lastCheckedAt', ':at')
            ->set('p.updatedAt', ':at')
            ->where('p.reference = :reference')
            ->andWhere('p.status = :initiated')
            ->andWhere('p.createdAt <= :cutoff')
            ->setParameter('expired', PaymentIntent::STATUS_EXPIRED)
            ->setParameter('initiated', PaymentIntent::STATUS_INITIATED)
            ->setParameter('reference', $reference)
            ->setParameter('cutoff', $cutoff)
            ->setParameter('at', $at)
            ->getQuery()
            ->execute() === 1;
    }

    /**
     * Initiated checkouts started before `$startedBefore` that are due another
     * look at Paystack — a charge whose webhook never arrived is found this
     * way: never asked yet; asked before `$checkedBefore` while still started
     * after `$youngSince`; or, once older, asked before `$slowCheckedBefore`
     * (an abandoned checkout is asked less and less often). Never-asked first,
     * then the least recently asked, so a backlog of abandoned checkouts can't
     * starve a new one out of the batch.
     *
     * @param list<string> $skip references to leave out (failed earlier this run)
     * @return list<PaymentIntent>
     */
    public function dueForReverify(
        DateTimeImmutable $startedBefore,
        DateTimeImmutable $youngSince,
        DateTimeImmutable $checkedBefore,
        DateTimeImmutable $slowCheckedBefore,
        int $limit,
        array $skip = [],
    ): array {
        return $this->dueForReverifyQuery($startedBefore, $youngSince, $checkedBefore, $slowCheckedBefore, $limit, $skip)->getResult();
    }

    /** @param list<string> $skip */
    public function dueForReverifyQuery(
        DateTimeImmutable $startedBefore,
        DateTimeImmutable $youngSince,
        DateTimeImmutable $checkedBefore,
        DateTimeImmutable $slowCheckedBefore,
        int $limit,
        array $skip = [],
    ): Query {
        $qb = $this->qb()
            ->addSelect('CASE WHEN e.lastCheckedAt IS NULL THEN 0 ELSE 1 END AS HIDDEN askedBefore')
            ->andWhere('e.status = :initiated')
            ->andWhere('e.createdAt <= :startedBefore')
            ->andWhere(
                'e.lastCheckedAt IS NULL'
                . ' OR (e.createdAt > :youngSince AND e.lastCheckedAt <= :checkedBefore)'
                . ' OR e.lastCheckedAt <= :slowCheckedBefore',
            )
            ->setParameter('initiated', PaymentIntent::STATUS_INITIATED)
            ->setParameter('startedBefore', $startedBefore)
            ->setParameter('youngSince', $youngSince)
            ->setParameter('checkedBefore', $checkedBefore)
            ->setParameter('slowCheckedBefore', $slowCheckedBefore)
            ->orderBy('askedBefore', 'ASC')
            ->addOrderBy('e.lastCheckedAt', 'ASC')
            ->addOrderBy('e.createdAt', 'ASC')
            ->addOrderBy('e.id', 'ASC')
            ->setMaxResults(max(1, $limit));
        if ($skip !== []) {
            $qb->andWhere('e.reference NOT IN (:skip)')->setParameter('skip', $skip);
        }

        return $qb->getQuery()->setHint(Query::HINT_REFRESH, true);
    }

    /**
     * Paid checkouts nothing used since `$paidBefore` — due to be credited to
     * the patient's wallet. Least recently tried first (a payment's first try
     * counts from when it was paid; a failed credit is touched — {@see
     * touchChecked()} — and goes to the back), so one that keeps failing can't
     * starve the rest out of the batch. One that can never be credited
     * automatically is held for review instead, which takes it off this list.
     *
     * @param list<string> $skip
     * @return list<PaymentIntent>
     */
    public function dueForCredit(DateTimeImmutable $paidBefore, int $limit, array $skip = []): array
    {
        return $this->dueForCreditQuery($paidBefore, $limit, $skip)->getResult();
    }

    /** @param list<string> $skip */
    public function dueForCreditQuery(DateTimeImmutable $paidBefore, int $limit, array $skip = []): Query
    {
        $qb = $this->qb()
            ->addSelect('COALESCE(e.lastCheckedAt, e.paidAt) AS HIDDEN lastTried')
            ->andWhere('e.status = :paid')
            ->andWhere('e.paidAt <= :paidBefore')
            ->setParameter('paid', PaymentIntent::STATUS_PAID)
            ->setParameter('paidBefore', $paidBefore)
            ->orderBy('lastTried', 'ASC')
            ->addOrderBy('e.paidAt', 'ASC')
            ->addOrderBy('e.id', 'ASC')
            ->setMaxResults(max(1, $limit));
        if ($skip !== []) {
            $qb->andWhere('e.reference NOT IN (:skip)')->setParameter('skip', $skip);
        }

        return $qb->getQuery()->setHint(Query::HINT_REFRESH, true);
    }

    /**
     * Run `$work` in one DB transaction (flushed and committed together, or
     * rolled back). An exception thrown inside closes the entity manager, so
     * `$work` hands refusals back instead of throwing them.
     *
     * @template T
     * @param callable(): T $work
     * @return T
     */
    public function transactional(callable $work): mixed
    {
        return $this->em->wrapInTransaction(static fn (): mixed => $work());
    }

    public function isOpen(): bool
    {
        return $this->em->isOpen();
    }
}
