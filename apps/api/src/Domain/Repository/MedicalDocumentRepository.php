<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\MedicalDocument;

final class MedicalDocumentRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return MedicalDocument::class;
    }

    /**
     * A patient's documents with optional search (title/type) + type filter,
     * newest or oldest first.
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
    ): array {
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

        return $this->paginatedQuery($qb, $this->alias(), $offset, $perPage, 'createdAt', $sortDir);
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
