<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/**
 * A record that one reminder (for a given "minutes before" offset) has been sent
 * for an appointment. The unique (appointment_id, offset_minutes) pair is the
 * dedupe key so the reminder cron is safe to run every few minutes / catch up
 * after downtime without ever emailing the same reminder twice.
 */
#[ORM\Entity]
#[ORM\Table(name: 'appointment_reminders')]
#[ORM\UniqueConstraint(name: 'uniq_appt_reminder', columns: ['appointment_id', 'offset_minutes'])]
class AppointmentReminder
{
    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(name: 'appointment_id', type: 'uuid')]
    private string $appointmentId;

    #[ORM\Column(name: 'offset_minutes', type: 'integer')]
    private int $offsetMinutes;

    #[ORM\Column(name: 'sent_at', type: 'datetime_immutable')]
    private DateTimeImmutable $sentAt;

    public function __construct(string $appointmentId, int $offsetMinutes)
    {
        $this->id            = Uuid::uuid4()->toString();
        $this->appointmentId = $appointmentId;
        $this->offsetMinutes = $offsetMinutes;
        $this->sentAt        = new DateTimeImmutable();
    }

    public function getId(): string
    {
        return $this->id;
    }
}
