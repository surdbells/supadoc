<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\DoctorApplicationDocument;
use Doctrine\ORM\Query;

final class DoctorApplicationDocumentRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return DoctorApplicationDocument::class;
    }

    /**
     * Every document of an application (replaced ones too), oldest first.
     *
     * @return list<DoctorApplicationDocument>
     */
    public function forApplication(string $applicationId): array
    {
        return $this->forApplicationQuery($applicationId)->getResult();
    }

    public function forApplicationQuery(string $applicationId): Query
    {
        return $this->qb()
            ->andWhere('e.applicationId = :app')
            ->setParameter('app', $applicationId)
            ->orderBy('e.createdAt', 'ASC')
            ->addOrderBy('e.id', 'ASC')
            ->getQuery();
    }

    /** @return list<DoctorApplicationDocument> */
    public function activeFor(string $applicationId): array
    {
        return array_values(array_filter($this->forApplication($applicationId), static fn (DoctorApplicationDocument $d): bool => $d->isActive()));
    }

    /** One document, only when it belongs to this application. */
    public function findForApplication(string $id, string $applicationId): ?DoctorApplicationDocument
    {
        if (!DoctorApplicationRepository::isUuid($id)) {
            return null;
        }
        $doc = $this->find($id);

        return $doc instanceof DoctorApplicationDocument && $doc->getApplicationId() === $applicationId ? $doc : null;
    }

    /** @return array{count:int, bytes:int} every row of the application (the per-application caps) */
    public function usage(string $applicationId): array
    {
        $row = $this->usageQuery($applicationId)->getSingleResult();

        return ['count' => (int) ($row['n'] ?? 0), 'bytes' => (int) ($row['bytes'] ?? 0)];
    }

    public function usageQuery(string $applicationId): Query
    {
        return $this->em->createQueryBuilder()
            ->select('COUNT(e.id) AS n', 'COALESCE(SUM(e.sizeBytes), 0) AS bytes')
            ->from(DoctorApplicationDocument::class, 'e')
            ->andWhere('e.applicationId = :app')
            ->setParameter('app', $applicationId)
            ->getQuery();
    }
}
