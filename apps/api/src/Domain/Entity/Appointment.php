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

    /** The patient's reason for the consultation (free text). */
    #[ORM\Column(type: 'text', nullable: true)]
    private ?string $notes = null;

    /** Relative URL of an optional supporting document (image), or null. */
    #[ORM\Column(name: 'document_url', type: 'string', length: 300, nullable: true)]
    private ?string $documentUrl = null;

    /** unpaid | pending | paid — payment is a later step; bookings start unpaid. */
    #[ORM\Column(name: 'payment_status', type: 'string', length: 20, options: ['default' => 'unpaid'])]
    private string $paymentStatus = 'unpaid';

    /**
     * Invited third parties (up to 3): list of {name, email}. Each adds the
     * configurable guest fee to the appointment amount.
     *
     * @var list<array{name:string,email:string}>|null
     */
    #[ORM\Column(type: 'json', nullable: true)]
    private ?array $guests = null;

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

    public function getSpecialist(): Specialist
    {
        return $this->specialist;
    }

    public function getScheduledAt(): DateTimeImmutable
    {
        return $this->scheduledAt;
    }

    public function setNotes(?string $notes): void
    {
        $this->notes = $notes !== null && trim($notes) !== '' ? trim($notes) : null;
    }

    public function setDocumentUrl(?string $url): void
    {
        $this->documentUrl = $url !== null && $url !== '' ? $url : null;
    }

    public function setPaymentStatus(string $status): void
    {
        $this->paymentStatus = $status;
    }

    /** @return list<array{name:string,email:string}> */
    public function getGuests(): array
    {
        return $this->guests ?? [];
    }

    /** @param list<array{name:string,email:string}> $guests */
    public function setGuests(array $guests): void
    {
        $this->guests = $guests !== [] ? $guests : null;
    }

    public function setAmount(string $amount): void
    {
        $this->amount = $amount;
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
            'status'         => $this->status->value,
            'status_label'   => $this->status->label(),
            'amount'         => $this->amount,
            'notes'          => $this->notes,
            'document_url'   => $this->documentUrl,
            'payment_status' => $this->paymentStatus,
            'guests'         => $this->getGuests(),
            'created_at'     => $this->createdAt->format(DATE_ATOM),
        ];
    }
}
