<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\StaffSession;

final class StaffSessionRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return StaffSession::class;
    }
}
