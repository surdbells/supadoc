<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\Appointment;
use App\Domain\Entity\MedicalDocument;
use DateTimeImmutable;
use Doctrine\ORM\Query;
use Doctrine\ORM\QueryBuilder;

final class MedicalDocumentRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return MedicalDocument::class;
    }

    /**
     * A patient's documents with optional search (title/type), type filter and
     * appointment filter (the files shared for one booking), newest or oldest
     * first.
     *
     * @return array{items: list<MedicalDocument>, total: int}
     */
    public function paginatedForPatient(
        string $patientId,
        int $offset,
        int $perPage,
        ?string $search = null,
        ?string $type = null,
        string $sortDir = 'desc',
        ?string $appointmentId = null,
    ): array {
        return $this->paginatedQuery(
            $this->filteredForPatient($patientId, $search, $type, $appointmentId),
            $this->alias(),
            $offset,
            $perPage,
            'createdAt',
            $sortDir,
        );
    }

    /** The filtered (unpaged) builder behind {@see paginatedForPatient()}. */
    public function filteredForPatient(
        string $patientId,
        ?string $search = null,
        ?string $type = null,
        ?string $appointmentId = null,
    ): QueryBuilder {
        $qb = $this->qb()
            ->andWhere('e.patientId = :patient')
            ->setParameter('patient', $patientId);

        if ($search !== null && trim($search) !== '') {
            $qb->andWhere('LOWER(e.title) LIKE :q OR LOWER(e.customType) LIKE :q')
                ->setParameter('q', '%' . strtolower(trim($search)) . '%');
        }
        if ($type !== null && $type !== '') {
            $qb->andWhere('e.documentType = :type')->setParameter('type', $type);
        }
        if ($appointmentId !== null && $appointmentId !== '') {
            $qb->andWhere('IDENTITY(e.appointment) = :appointment')->setParameter('appointment', $appointmentId);
        }

        return $qb;
    }

    /**
     * Those of `$ids` that belong to the patient, each with the appointment it
     * is attached to (null: none). Anything else (unknown, or another
     * patient's) is simply absent, so the caller compares them. Read straight
     * from the database, never the identity map, so it is current even after
     * {@see saveWithAttachments()} turned a booking down.
     *
     * @param list<string> $ids
     * @return array<string,?string> document id => appointment id
     */
    public function attachmentStates(string $patientId, array $ids): array
    {
        if ($ids === []) {
            return [];
        }

        $states = [];
        foreach ($this->attachmentStatesQuery($patientId, $ids)->getScalarResult() as $row) {
            $states[strtolower((string) $row['id'])] = $row['appointment_id'] !== null ? (string) $row['appointment_id'] : null;
        }

        return $states;
    }

    /**
     * The query behind {@see attachmentStates()}.
     *
     * @param list<string> $ids
     */
    public function attachmentStatesQuery(string $patientId, array $ids): Query
    {
        return $this->em->createQueryBuilder()
            ->select('e.id AS id', 'IDENTITY(e.appointment) AS appointment_id')
            ->from(MedicalDocument::class, 'e')
            ->andWhere('e.patientId = :patient')
            ->andWhere('e.id IN (:ids)')
            ->setParameter('patient', $patientId)
            ->setParameter('ids', $ids)
            ->getQuery();
    }

    /**
     * Store a new booking and attach `$ids` to it in one transaction. The link
     * is a guarded UPDATE (see {@see attachQuery()}), so of two bookings racing
     * for the same file only one can take it — the later one used to silently
     * move it to itself. Returns false, with nothing stored, when any of them
     * is no longer the patient's unattached document.
     *
     * @param list<string> $ids
     */
    public function saveWithAttachments(Appointment $appointment, string $patientId, array $ids): bool
    {
        $conn = $this->em->getConnection();
        $conn->beginTransaction();
        try {
            $this->em->persist($appointment);
            $this->em->flush();
            if ((int) $this->attachQuery($appointment->getId(), $patientId, $ids)->execute() !== count($ids)) {
                $conn->rollBack();
                // Never stored: forget it, so no later flush writes to a row that isn't there.
                $this->em->detach($appointment);

                return false;
            }
            $conn->commit();
        } catch (\Throwable $e) {
            if ($conn->isTransactionActive()) {
                $conn->rollBack();
            }
            throw $e;
        }

        return true;
    }

    /**
     * Link `$ids` to an appointment — only those that are still the patient's
     * and still unattached; the caller compares the affected row count.
     *
     * @param list<string> $ids
     */
    public function attachQuery(string $appointmentId, string $patientId, array $ids): Query
    {
        return $this->em->createQueryBuilder()
            ->update(MedicalDocument::class, 'e')
            ->set('e.appointment', ':appointment')
            ->set('e.updatedAt', ':now')
            ->where('e.id IN (:ids)')
            ->andWhere('e.patientId = :patient')
            ->andWhere('e.appointment IS NULL')
            ->setParameter('appointment', $appointmentId)
            ->setParameter('now', new DateTimeImmutable())
            ->setParameter('ids', $ids)
            ->setParameter('patient', $patientId)
            ->getQuery();
    }

    /**
     * A patient's documents, newest first — the doctor's in-call view (no paging).
     *
     * @return list<MedicalDocument>
     */
    public function allForPatient(string $patientId): array
    {
        return $this->qb()
            ->andWhere('e.patientId = :patient')
            ->setParameter('patient', $patientId)
            ->orderBy('e.createdAt', 'DESC')
            ->getQuery()
            ->getResult();
    }
}
