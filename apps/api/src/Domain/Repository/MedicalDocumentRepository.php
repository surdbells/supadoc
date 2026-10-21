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

    // There is deliberately no "every document of a patient" reader here: what
    // a doctor may see is decided ONLY by DocumentAccessPolicy (spec §2.1), and
    // NoPolicyBypassTest keeps it that way.

    /** One of the patient's own documents, or null (unknown and foreign ids read the same). */
    public function findForPatient(string $id, string $patientId): ?MedicalDocument
    {
        $doc = $this->find(strtolower(trim($id)));

        return $doc instanceof MedicalDocument && strtolower($doc->getPatientId()) === strtolower($patientId) ? $doc : null;
    }

    /**
     * Those of `$ids` that are the patient's own documents, keyed by id, in no
     * particular order. Never another patient's.
     *
     * @param list<string> $ids
     * @return array<string, MedicalDocument>
     */
    public function byIdsForPatient(string $patientId, array $ids): array
    {
        if ($ids === []) {
            return [];
        }
        $out = [];
        foreach ($this->byIdsForPatientQuery($patientId, $ids)->getResult() as $doc) {
            $out[strtolower($doc->getId())] = $doc;
        }

        return $out;
    }

    /** @param list<string> $ids */
    public function byIdsForPatientQuery(string $patientId, array $ids): Query
    {
        return $this->qb()
            ->andWhere('e.patientId = :patient')
            ->andWhere('e.id IN (:ids)')
            ->setParameter('patient', $patientId)
            ->setParameter('ids', array_values($ids))
            ->getQuery();
    }

    /**
     * The ids of the files the patient attached when booking each of these
     * appointments, newest first — ONE query for many appointments (no N+1).
     * Appointments with none are absent.
     *
     * @param list<string> $appointmentIds
     * @return array<string, list<string>> appointment id => document ids
     */
    public function attachmentIdsByAppointment(string $patientId, array $appointmentIds): array
    {
        $appointmentIds = array_values(array_unique(array_filter(array_map(static fn ($id): string => strtolower(trim((string) $id)), $appointmentIds))));
        if ($appointmentIds === []) {
            return [];
        }
        $out = [];
        foreach ($this->attachmentIdsByAppointmentQuery($patientId, $appointmentIds)->getScalarResult() as $row) {
            $out[strtolower((string) $row['appointment_id'])][] = strtolower((string) $row['id']);
        }

        return $out;
    }

    /**
     * The query behind {@see attachmentIdsByAppointment()}.
     *
     * @param list<string> $appointmentIds
     */
    public function attachmentIdsByAppointmentQuery(string $patientId, array $appointmentIds): Query
    {
        return $this->em->createQueryBuilder()
            ->select('e.id AS id', 'IDENTITY(e.appointment) AS appointment_id')
            ->from(MedicalDocument::class, 'e')
            ->andWhere('e.patientId = :patient')
            ->andWhere('IDENTITY(e.appointment) IN (:ids)')
            ->setParameter('patient', $patientId)
            ->setParameter('ids', $appointmentIds)
            ->orderBy('e.createdAt', 'DESC')
            ->addOrderBy('e.id', 'DESC')
            ->getQuery();
    }

    /**
     * The files the patient attached when booking this appointment, newest first.
     *
     * @return list<MedicalDocument>
     */
    public function attachmentsOf(string $appointmentId, string $patientId): array
    {
        return $this->qb()
            ->andWhere('e.patientId = :patient')
            ->andWhere('IDENTITY(e.appointment) = :appointment')
            ->setParameter('patient', $patientId)
            ->setParameter('appointment', $appointmentId)
            ->orderBy('e.createdAt', 'DESC')
            ->addOrderBy('e.id', 'DESC')
            ->getQuery()
            ->getResult();
    }
}
