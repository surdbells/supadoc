<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;

/**
 * Per-day sequence behind lab request numbers (GVM-REQ-YYYYMMDD-NNNNN), bumped
 * atomically with an UPSERT by {@see \App\Infrastructure\Lab\LabRequestNumberGenerator}
 * — its own table, so `prescription_counters` is never touched.
 */
#[ORM\Entity]
#[ORM\Table(name: 'lab_request_counters')]
class LabRequestCounter
{
    #[ORM\Id]
    #[ORM\Column(type: 'date_immutable')]
    private DateTimeImmutable $day;

    #[ORM\Column(name: 'last_value', type: 'integer')]
    private int $lastValue = 0;

    public function __construct(DateTimeImmutable $day)
    {
        $this->day = $day;
    }
}
