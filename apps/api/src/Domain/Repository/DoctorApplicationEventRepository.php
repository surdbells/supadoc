<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\DoctorApplicationEvent;
use Doctrine\ORM\Query;

final class DoctorApplicationEventRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return DoctorApplicationEvent::class;
    }

    /**
     * An application's events, newest first (the back office's Timeline).
     *
     * @return list<DoctorApplicationEvent>
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
            ->orderBy('e.createdAt', 'DESC')
            ->addOrderBy('e.id', 'DESC')
            ->setMaxResults(500)
            ->getQuery();
    }

    /**
     * The status changes the applicant sees, as ApplicationTimeline input.
     *
     * @return list<array{to_status:string, at:string}>
     */
    public function statusChanges(string $applicationId): array
    {
        $out = [];
        foreach ($this->forApplication($applicationId) as $event) {
            if ($event->isApplicantVisible() && $event->getToStatus() !== null) {
                $out[] = ['to_status' => $event->getToStatus(), 'at' => $event->getCreatedAt()->format(DATE_ATOM)];
            }
        }

        return $out;
    }
}
