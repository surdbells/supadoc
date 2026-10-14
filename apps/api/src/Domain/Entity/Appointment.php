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
 *
 * A follow-up links to the consultation it follows on from (`parent`). The
 * doctor can propose one ({@see proposeFollowUp()}: PROPOSED until the patient
 * accepts, declines or it expires), or the patient books one from a completed
 * consultation ({@see bookAsFollowUpOf()}). Either way `amount` is the final,
 * follow-up-priced fee, so refunds use it.
 */
#[ORM\Entity]
#[ORM\Table(name: 'appointments')]
#[ORM\Index(name: 'idx_appointments_patient', columns: ['patient_id'])]
#[ORM\Index(name: 'idx_appointments_status', columns: ['status'])]
#[ORM\Index(name: 'idx_appointments_specialist_scheduled', columns: ['specialist_id', 'scheduled_at'])]
#[ORM\Index(name: 'idx_appointments_scheduled', columns: ['scheduled_at'])]
#[ORM\Index(name: 'idx_appointments_parent', columns: ['parent_appointment_id'])]
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

    /**
     * LEGACY, read-only: the public URL of a booking attachment from before they
     * became private MedicalDocuments linked to the appointment. Nothing writes
     * it any more; bin/prod-migrate.php moves each file into document storage
     * and nulls it. Still mapped so the schema update can't drop the column
     * before that has run.
     */
    #[ORM\Column(name: 'document_url', type: 'string', length: 300, nullable: true)]
    private ?string $documentUrl = null;

    /** unpaid | pending | paid — payment is a later step; bookings start unpaid. */
    #[ORM\Column(name: 'payment_status', type: 'string', length: 20, options: ['default' => 'unpaid'])]
    private string $paymentStatus = 'unpaid';

    /** Paystack reference when the consultation was paid directly by card. */
    #[ORM\Column(name: 'payment_reference', type: 'string', length: 100, nullable: true)]
    private ?string $paymentReference = null;

    /**
     * Invited third parties (up to 3): list of {name, email}. Each adds the
     * configurable guest fee to the appointment amount.
     *
     * @var list<array{name:string,email:string}>|null
     */
    #[ORM\Column(type: 'json', nullable: true)]
    private ?array $guests = null;

    /** The consultation this follow-up follows on from; null for an ordinary booking. */
    #[ORM\ManyToOne(targetEntity: Appointment::class)]
    #[ORM\JoinColumn(name: 'parent_appointment_id', referencedColumnName: 'id', nullable: true)]
    private ?Appointment $parent = null;

    /** Who created the follow-up: 'doctor' (a proposal) or 'patient' (booked it); null otherwise. */
    #[ORM\Column(name: 'proposed_by', type: 'string', length: 10, nullable: true)]
    private ?string $proposedBy = null;

    /** The doctor's note to the patient on a proposal — shown in the app only, never in emails or notifications. */
    #[ORM\Column(name: 'follow_up_note', type: 'text', nullable: true)]
    private ?string $followUpNote = null;

    /**
     * How the follow-up was priced ({@see \App\Infrastructure\Service\PricingService::followUpPrice()}):
     * base_fee, amount, rule, discount_percent, window_days, window_ends_at, waived.
     *
     * @var array<string,mixed>|null
     */
    #[ORM\Column(name: 'follow_up_pricing', type: 'json', nullable: true)]
    private ?array $followUpPricing = null;

    /** An unanswered proposal closes here (the reminders cron cancels it); it holds the slot until then. */
    #[ORM\Column(name: 'expires_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $expiresAt = null;

    /** When the patient was reminded about an unanswered proposal (it happens once). */
    #[ORM\Column(name: 'follow_up_nudged_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $followUpNudgedAt = null;

    /** The patient's optional reason for declining a proposal (patient + doctor only). */
    #[ORM\Column(name: 'decline_reason', type: 'text', nullable: true)]
    private ?string $declineReason = null;

    /**
     * How a doctor's proposal closed without being accepted (one of
     * FOLLOW_UP_OUTCOMES); null while open, once accepted, on an ordinary
     * booking — and on proposals closed before this was recorded.
     */
    #[ORM\Column(name: 'follow_up_outcome', type: 'string', length: 10, nullable: true)]
    private ?string $followUpOutcome = null;

    /** The patient declined it; the doctor (or the back office) withdrew it; it closed unanswered. */
    public const FOLLOW_UP_OUTCOMES = ['declined', 'withdrawn', 'expired'];

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

    /**
     * A doctor-proposed follow-up of `$parent`: same patient and doctor, a video
     * consultation, PROPOSED (holding the slot) until the patient answers or
     * `$expiresAt` passes. Priced by `$pricing` (its `amount` is the fee).
     *
     * @param array<string,mixed> $pricing
     */
    public static function proposeFollowUp(
        Appointment $parent,
        DateTimeImmutable $scheduledAt,
        array $pricing,
        ?string $note,
        DateTimeImmutable $expiresAt,
    ): self {
        $proposal               = new self($parent->patient, $parent->specialist, $scheduledAt, ConsultationType::FOLLOW_UP);
        $proposal->status       = AppointmentStatus::PROPOSED;
        $proposal->parent       = $parent;
        $proposal->proposedBy   = 'doctor';
        $proposal->followUpNote = $note !== null && trim($note) !== '' ? trim($note) : null;
        $proposal->expiresAt    = $expiresAt;
        $proposal->priceFollowUp($pricing);

        return $proposal;
    }

    /**
     * The patient books this consultation as a follow-up of `$parent`. Only the
     * link and the pricing record are set here — the caller sets the amount
     * (the follow-up price plus any guests).
     *
     * @param array<string,mixed> $pricing
     */
    public function bookAsFollowUpOf(Appointment $parent, array $pricing): void
    {
        $this->parent          = $parent;
        $this->proposedBy      = 'patient';
        $this->type            = ConsultationType::FOLLOW_UP;
        $this->followUpPricing = $pricing;
    }

    /**
     * The patient accepts a proposal at another open slot: the new time and its
     * price (re-quoted for that time, keeping a doctor's waiver).
     *
     * @param array<string,mixed> $pricing
     */
    public function moveProposal(DateTimeImmutable $scheduledAt, array $pricing): void
    {
        $this->scheduledAt = $scheduledAt;
        $this->priceFollowUp($pricing);
    }

    /** @param array<string,mixed> $pricing */
    private function priceFollowUp(array $pricing): void
    {
        $this->followUpPricing = $pricing;
        $this->amount          = (string) $pricing['amount'];
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function getType(): ConsultationType
    {
        return $this->type;
    }

    public function getParent(): ?Appointment
    {
        return $this->parent;
    }

    public function getProposedBy(): ?string
    {
        return $this->proposedBy;
    }

    public function getFollowUpNote(): ?string
    {
        return $this->followUpNote;
    }

    /** @return array<string,mixed>|null */
    public function getFollowUpPricing(): ?array
    {
        return $this->followUpPricing;
    }

    /** The doctor waived the fee when proposing (a re-quote for another slot keeps it free). */
    public function isFeeWaived(): bool
    {
        return ($this->followUpPricing['waived'] ?? false) === true;
    }

    public function getExpiresAt(): ?DateTimeImmutable
    {
        return $this->expiresAt;
    }

    /** A proposal the patient can still answer: PROPOSED and not past its expiry. */
    public function isOpenProposal(DateTimeImmutable $now): bool
    {
        return $this->status === AppointmentStatus::PROPOSED
            && $this->expiresAt !== null
            && $this->expiresAt > $now;
    }

    public function getFollowUpNudgedAt(): ?DateTimeImmutable
    {
        return $this->followUpNudgedAt;
    }

    public function markFollowUpNudged(DateTimeImmutable $at): void
    {
        $this->followUpNudgedAt = $at;
    }

    public function getDeclineReason(): ?string
    {
        return $this->declineReason;
    }

    public function setDeclineReason(?string $reason): void
    {
        $this->declineReason = $reason !== null && trim($reason) !== '' ? trim($reason) : null;
    }

    public function getFollowUpOutcome(): ?string
    {
        return $this->followUpOutcome;
    }

    /** Record how the proposal closed (declined | withdrawn | expired). */
    public function setFollowUpOutcome(string $outcome): void
    {
        if (!in_array($outcome, self::FOLLOW_UP_OUTCOMES, true)) {
            throw new \InvalidArgumentException('Unknown follow-up outcome: ' . $outcome);
        }
        $this->followUpOutcome = $outcome;
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

    public function setScheduledAt(DateTimeImmutable $scheduledAt): void
    {
        $this->scheduledAt = $scheduledAt;
    }

    public function getAmount(): string
    {
        return $this->amount;
    }

    /** Nothing to pay (a ₦0 fee and no paid guests): no card checkout, no wallet posting. */
    public function isFree(): bool
    {
        return bccomp($this->amount, '0', 2) <= 0;
    }

    public function getPaymentStatus(): string
    {
        return $this->paymentStatus;
    }

    public function setNotes(?string $notes): void
    {
        $this->notes = $notes !== null && trim($notes) !== '' ? trim($notes) : null;
    }

    public function setPaymentStatus(string $status): void
    {
        $this->paymentStatus = $status;
    }

    public function getPaymentReference(): ?string
    {
        return $this->paymentReference;
    }

    /** Mark the consultation paid directly by card (Paystack), not the wallet. */
    public function payByCard(string $reference): void
    {
        $this->paymentStatus    = 'paid';
        $this->paymentReference = $reference;
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
                'This appointment is %s and can no longer be marked %s.',
                str_replace('_', ' ', $this->status->value),
                str_replace('_', ' ', $target->value),
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
            // Follow-ups (all null on an ordinary booking).
            'parent_appointment_id' => $this->parent?->getId(),
            'parent'                => $this->parent !== null ? [
                'id'              => $this->parent->getId(),
                'scheduled_at'    => $this->parent->getScheduledAt()->format(DATE_ATOM),
                'status'          => $this->parent->getStatus()->value,
                'specialist_name' => $this->parent->getSpecialist()->getName(),
            ] : null,
            'proposed_by'           => $this->proposedBy,
            'follow_up_note'        => $this->followUpNote,
            'follow_up_pricing'     => $this->followUpPricing,
            'expires_at'            => $this->expiresAt?->format(DATE_ATOM),
            'decline_reason'        => $this->declineReason,
            'follow_up_outcome'     => $this->followUpOutcome,
            'created_at'     => $this->createdAt->format(DATE_ATOM),
        ];
    }

    /**
     * Admin serialisation — the base shape plus the patient's identity, so the
     * back-office can show WHO booked each appointment. Kept separate from
     * toArray() so the patient-facing /portal responses don't leak other data.
     *
     * @return array<string,mixed>
     */
    public function toAdminArray(): array
    {
        $p = $this->patient->toArray();
        // What the doctor and the patient wrote each other about a follow-up stays between them.
        $base = $this->toArray();
        unset($base['follow_up_note'], $base['decline_reason']);

        return $base + [
            'patient' => [
                'id'    => $this->patient->getId(),
                'name'  => trim(((string) ($p['first_name'] ?? '')) . ' ' . ((string) ($p['last_name'] ?? ''))),
                'email' => $p['email'] ?? null,
                'phone' => $p['phone'] ?? null,
            ],
        ];
    }
}
