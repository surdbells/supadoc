<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;

/**
 * Per-day sequence behind prescription numbers (GVM-RX-YYYYMMDD-NNNNN). Bumped
 * atomically with an UPSERT by {@see \App\Infrastructure\Prescription\PrescriptionNumberGenerator},
 * so two doctors issuing at the same instant never get the same number.
 */
#[ORM\Entity]
#[ORM\Table(name: 'prescription_counters')]
class PrescriptionCounter
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
