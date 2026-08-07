<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use App\Domain\Enum\AppointmentStatus;
use App\Domain\Enum\ConsultationType;
use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;
use DomainException;
use Ramsey\Uuid\Uuid;

/**
 * A booked consultation. `status` is a backed enum that guards its own
 * transitions — `transitionTo()` refuses illegal moves rather than trusting the
 * caller (see ARCHITECTURE §6). `amount` is money-as-string.
 */
#[ORM\Entity]
#[ORM\Table(name: 'appointments')]
#[ORM\Index(name: 'idx_appointments_patient', columns: ['patient_id'])]
#[ORM\Index(name: 'idx_appointments_status', columns: ['status'])]
#[ORM\HasLifecycleCallbacks]
class Appointment
{
    use TimestampsTrait;
    use SoftDeleteTrait;

    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\ManyToOne(targetEntity: Patient::class)]
    #[ORM\JoinColumn(name: 'patient_id', referencedColumnName: 'id', nullable: false)]
    private Patient $patient;

    #[ORM\ManyToOne(targetEntity: Specialist::class)]
    #[ORM\JoinColumn(name: 'specialist_id', referencedColumnName: 'id', nullable: false)]
    private Specialist $specialist;

    #[ORM\Column(type: 'datetime_immutable')]
    private DateTimeImmutable $scheduledAt;

    #[ORM\Column(type: 'string', length: 20, enumType: ConsultationType::class)]
    private ConsultationType $type = ConsultationType::VIDEO;

    #[ORM\Column(type: 'string', length: 20, enumType: AppointmentStatus::class)]
    private AppointmentStatus $status = AppointmentStatus::PENDING;

    #[ORM\Column(type: 'decimal', precision: 12, scale: 2)]
    private string $amount = '0.00';

    public function __construct(
        Patient $patient,
        Specialist $specialist,
        DateTimeImmutable $scheduledAt,
        ConsultationType $type = ConsultationType::VIDEO,
    ) {
        $this->id          = Uuid::uuid4()->toString();
        $this->patient     = $patient;
        $this->specialist  = $specialist;
        $this->scheduledAt = $scheduledAt;
        $this->type        = $type;
        $this->amount      = $specialist->getConsultationFee();
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function getStatus(): AppointmentStatus
    {
        return $this->status;
    }

    public function getPatient(): Patient
    {
        return $this->patient;
    }

    /** Enforces the state machine; illegal transitions can't be expressed. */
    public function transitionTo(AppointmentStatus $target): void
    {
        if ($this->status === $target) {
            return;
        }
        if (!$this->status->canTransitionTo($target)) {
            throw new DomainException(sprintf(
                'Cannot move appointment from %s to %s',
                $this->status->value,
                $target->value,
            ));
        }
        $this->status = $target;
    }

    public function toArray(): array
    {
        return [
            'id'           => $this->id,
            'patient_id'   => $this->patient->getId(),
            'specialist'   => [
                'id'        => $this->specialist->getId(),
                'name'      => $this->specialist->getName(),
                'specialty' => $this->specialist->getSpecialty(),
            ],
            'scheduled_at' => $this->scheduledAt->format(DATE_ATOM),
            'type'         => $this->type->value,
            'type_label'   => $this->type->label(),
            'status'       => $this->status->value,
            'status_label' => $this->status->label(),
            'amount'       => $this->amount,
            'created_at'   => $this->createdAt->format(DATE_ATOM),
        ];
    }
}
