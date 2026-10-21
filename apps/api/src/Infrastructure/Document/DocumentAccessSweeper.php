<?php

declare(strict_types=1);

namespace App\Infrastructure\Document;

use App\Domain\Repository\DocumentAccessGrantRepository;
use App\Domain\Repository\DocumentAccessRequestRepository;
use DateTimeImmutable;
use Doctrine\ORM\EntityManagerInterface;

/**
 * Document-sharing bookkeeping for bin/send-reminders.php (spec §2.6). Visibility
 * never depends on it — the policy checks every window at request time — it
 * only records what ran out and sends the notices that follow:
 *
 *  1. expire grants past their end;
 *  2. end `after_*` grants whose consultation is cancelled, deleted or gone (`appointment_cancelled`);
 *  3. end selected grants none of whose documents exists any more (`emptied`);
 *  4. expire requests past their close (the doctor is told "closed");
 *  5. cancel pending requests of doctors who are not practising (`doctor_unavailable`, no notice);
 *  6. cancel pending requests whose consultation went, when the pair has no
 *     other consultation a request could come from (`not_eligible`, no notice).
 *
 * Each row is one short transaction through {@see DocumentAccessTransitions}
 * (compare-and-set, so an overlap with a request's lazy expiry records it once),
 * its notices dispatched after that commit. A session advisory try-lock keeps
 * two runs from doing the same work twice.
 */
final class DocumentAccessSweeper
{
    /** pg_try_advisory_lock(SWEEP_LOCK, 1). */
    public const SWEEP_LOCK = 3494;

    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly DocumentAccessTransitions $transitions,
        private readonly DocumentAccessGrantRepository $grants,
        private readonly DocumentAccessRequestRepository $requests,
        private readonly DocumentAccessNoticeQueue $queue,
    ) {
    }

    /**
     * @return array{skipped:bool, expired:int, ended_cancelled:int, emptied:int, requests_expired:int, requests_cancelled:int,
     *               errors:int, active_grants:int, pending_requests:int}
     */
    public function run(DateTimeImmutable $now, int $limit = 500): array
    {
        $out = ['skipped' => false, 'expired' => 0, 'ended_cancelled' => 0, 'emptied' => 0, 'requests_expired' => 0, 'requests_cancelled' => 0, 'errors' => 0, 'active_grants' => 0, 'pending_requests' => 0];
        $conn = $this->em->getConnection();
        $got  = $conn->fetchOne('SELECT pg_try_advisory_lock(' . self::SWEEP_LOCK . ', 1)');
        if (!in_array($got, [true, 't', 1, '1'], true)) {
            return ['skipped' => true] + $out;
        }
        try {
            foreach ($this->grants->dueIds($now, $limit) as $id) {
                $this->row($out, 'expired', fn (): bool => $this->transitions->expireGrant($id, $now));
            }
            foreach ($this->grants->danglingAnchoredIds($limit) as $id) {
                $this->row($out, 'ended_cancelled', fn (): bool => $this->transitions->endGrant($id, 'appointment_cancelled', 'system', $now));
            }
            foreach ($this->grants->emptiedIds($limit) as $id) {
                $this->row($out, 'emptied', fn (): bool => $this->transitions->endGrant($id, 'emptied', 'system', $now));
            }
            foreach ($this->requests->dueIds($now, $limit) as $id) {
                $this->row($out, 'requests_expired', fn (): bool => $this->transitions->expireRequest($id, $now));
            }
            foreach ($this->requests->pendingOfNonPractisingIds($limit) as $id) {
                $this->row($out, 'requests_cancelled', fn (): bool => $this->transitions->closeRequest($id, 'cancelled', 'doctor_unavailable', 'system', $now));
            }
            foreach ($this->requests->pendingWithoutEligibleAppointmentIds($now, $limit) as $id) {
                $this->row($out, 'requests_cancelled', fn (): bool => $this->transitions->closeRequest($id, 'cancelled', 'not_eligible', 'system', $now));
            }
            $out['active_grants']    = $this->grants->countActive();
            $out['pending_requests'] = $this->requests->countPending($now);
        } finally {
            try {
                $conn->executeQuery('SELECT pg_advisory_unlock(' . self::SWEEP_LOCK . ', 1)');
            } catch (\Throwable) {
                // the session ends with the process anyway
            }
        }

        return $out;
    }

    /**
     * One row in its own transaction; its notices go after the commit.
     *
     * @param array<string,mixed> $out
     */
    private function row(array &$out, string $counter, callable $work): void
    {
        $conn = $this->em->getConnection();
        $conn->beginTransaction();
        try {
            $changed = (bool) $work();
            $conn->commit();
        } catch (\Throwable $e) {
            if ($conn->isTransactionActive()) {
                $conn->rollBack();
            }
            $this->queue->discard();
            $out['errors']++;
            error_log('[doc-access] sweeper failed: ' . $e::class . ': ' . $e->getMessage());
            if (function_exists('\Sentry\captureException')) {
                \Sentry\captureException($e);
            }

            return;
        }
        $this->queue->dispatch();
        if ($changed) {
            $out[$counter]++;
        }
    }
}
