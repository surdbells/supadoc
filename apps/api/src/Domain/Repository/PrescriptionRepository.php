<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\Prescription;
use App\Domain\Settings\ClinicTime;
use DateTimeImmutable;

final class PrescriptionRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return Prescription::class;
    }

    public function findById(string $id): ?Prescription
    {
        if (preg_match('/^[0-9a-f\-]{36}$/i', $id) !== 1) {
            return null;
        }
        $rx = $this->find($id);

        return $rx instanceof Prescription ? $rx : null;
    }

    public function findByNumber(string $number): ?Prescription
    {
        return $this->qb()
            ->andWhere('e.number = :number')
            ->setParameter('number', $number)
            ->getQuery()
            ->getOneOrNullResult();
    }

    /**
     * A consultation's prescriptions, newest first. Pass $signedOnly for the
     * patient view — a draft the doctor is still building is never exposed.
     *
     * @return list<Prescription>
     */
    public function forAppointment(string $appointmentId, bool $signedOnly = false): array
    {
        $qb = $this->qb()
            ->addSelect('COALESCE(e.sentAt, e.signedAt, e.createdAt) AS HIDDEN sort_at')
            ->andWhere('e.appointmentId = :appointment')
            ->setParameter('appointment', $appointmentId)
            ->orderBy('sort_at', 'DESC')
            ->addOrderBy('e.createdAt', 'DESC');

        if ($signedOnly) {
            $qb->andWhere('e.status <> :draft')->setParameter('draft', Prescription::STATUS_DRAFT);
        }

        return $qb->getQuery()->getResult();
    }

    /**
     * A patient's sent prescriptions (never drafts), most recently sent first.
     *
     * @return list<Prescription>
     */
    public function sentForPatient(string $patientId): array
    {
        return $this->qb()
            ->andWhere('e.patientId = :patient')
            ->andWhere('e.status <> :draft')
            ->setParameter('patient', $patientId)
            ->setParameter('draft', Prescription::STATUS_DRAFT)
            ->addSelect('COALESCE(e.sentAt, e.signedAt, e.createdAt) AS HIDDEN sort_at')
            ->orderBy('sort_at', 'DESC')
            ->addOrderBy('e.createdAt', 'DESC')
            ->getQuery()
            ->getResult();
    }

    /**
     * A doctor's prescriptions, newest first, optionally for one patient and/or
     * stored status. Returns items + total for pagination.
     *
     * @return array{items: list<Prescription>, total: int}
     */
    public function forSpecialist(string $specialistId, ?string $patientId, ?string $status, int $offset, int $perPage): array
    {
        $qb = $this->qb()
            ->andWhere('e.specialistId = :specialist')
            ->setParameter('specialist', $specialistId);
        if ($patientId !== null && $patientId !== '') {
            $qb->andWhere('e.patientId = :patient')->setParameter('patient', $patientId);
        }
        $today = ClinicTime::todayYmd();
        match ($status) {
            Prescription::STATUS_DRAFT, Prescription::STATUS_CANCELLED => $qb
                ->andWhere('e.status = :status')->setParameter('status', $status),
            // Effective "active" / "expired" depend on the valid-until date.
            Prescription::STATUS_ACTIVE => $qb
                ->andWhere('e.status IN (:live)')->setParameter('live', [Prescription::STATUS_ACTIVE, Prescription::STATUS_SIGNED])
                ->andWhere('e.validUntil IS NULL OR e.validUntil >= :today')->setParameter('today', $today),
            Prescription::STATUS_EXPIRED => $qb
                ->andWhere('e.status = :expired OR (e.status IN (:live) AND e.validUntil < :today)')
                ->setParameter('expired', Prescription::STATUS_EXPIRED)
                ->setParameter('live', [Prescription::STATUS_ACTIVE, Prescription::STATUS_SIGNED])
                ->setParameter('today', $today),
            default => null,
        };

        return $this->paginatedQuery($qb, 'e', $offset, $perPage);
    }

    /**
     * Active prescriptions whose valid-until date has passed (to store as expired).
     *
     * @return list<Prescription>
     */
    public function pastValidity(DateTimeImmutable $today, int $limit = 500): array
    {
        return $this->qb()
            ->andWhere('e.status IN (:live)')
            ->andWhere('e.validUntil < :today')
            ->setParameter('live', [Prescription::STATUS_ACTIVE, Prescription::STATUS_SIGNED])
            ->setParameter('today', $today->format('Y-m-d'))
            ->setMaxResults($limit)
            ->getQuery()
            ->getResult();
    }

    /**
     * Active prescriptions that allow repeats, expire on `$expiresOn`, and have
     * not had their expiry reminder yet.
     *
     * @return list<Prescription>
     */
    public function dueForExpiryReminder(DateTimeImmutable $expiresOn, int $limit = 500): array
    {
        return $this->qb()
            ->andWhere('e.status = :active')
            ->andWhere('e.allowsRepeats = true')
            ->andWhere('e.validUntil = :day')
            ->andWhere('e.expiryReminderSentAt IS NULL')
            ->setParameter('active', Prescription::STATUS_ACTIVE)
            ->setParameter('day', $expiresOn->format('Y-m-d'))
            ->setMaxResults($limit)
            ->getQuery()
            ->getResult();
    }
}
