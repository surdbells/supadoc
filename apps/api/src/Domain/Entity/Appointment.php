<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use App\Domain\Appointment\AppointmentLifecycle;
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
     * Invited third parties (up to MAX_GUESTS at once), each an entry of:
     *   id                stable uuid — the `gid` claim of the guest's join links
     *   uid               stable Agora uid (>= FIRST_GUEST_UID, never reused after removal)
     *   name, email       as the patient entered them
     *   display_name      what the guest chose in the call lobby (null until then)
     *   fee               what inviting them cost (money string; part of `amount`)
     *   paid_by           booking | wallet | card | free
     *   payment_reference the Paystack reference when paid by card on its own
     *   invited_at, last_sent_at, joined_at, consented_at (ATOM or null)
     *   consent_version   the notice version the guest accepted
     *   rtc_issued_at     when they were last given an Agora token (set from their first join)
     *   left_at           when they last left the call cleanly (set from their first leave)
     *   legacy_uid        guests invited before ids existed: the uid (3, 4, 5)
     *                     their older join links carry ({@see findLegacyGuest()})
     * A removed guest is dropped from the list, so their links stop working.
     *
     * @var list<array<string,mixed>>|null
     */
    #[ORM\Column(type: 'json', nullable: true)]
    private ?array $guests = null;

    /** The last Agora uid given to a guest, so a removed guest's uid is never handed out again. */
    #[ORM\Column(name: 'guest_uid_seq', type: 'integer', nullable: true)]
    private ?int $guestUidSeq = null;

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

    // ----- Lifecycle closure ({@see AppointmentLifecycle}; all nullable, set from 2026-10 on) -----

    /**
     * Why it was closed when not by an ordinary patient / doctor action
     * (AppointmentLifecycle::CLOSURE_REASONS): expired_unconfirmed, no_show,
     * auto_completed, staff_cancelled, staff_completed.
     */
    #[ORM\Column(name: 'closure_reason', type: 'string', length: 30, nullable: true)]
    private ?string $closureReason = null;

    /** A missed consultation: who didn't come — doctor | patient | both. */
    #[ORM\Column(name: 'no_show', type: 'string', length: 10, nullable: true)]
    private ?string $noShow = null;

    /** When it reached a closed status (completed, cancelled, missed). */
    #[ORM\Column(name: 'closed_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $closedAt = null;

    /** The doctor's first call heartbeat inside the presence window ({@see AppointmentLifecycle::presenceWindow()}). */
    #[ORM\Column(name: 'doctor_first_joined_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $doctorFirstJoinedAt = null;

    /** The patient's first call heartbeat inside the presence window. */
    #[ORM\Column(name: 'patient_first_joined_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $patientFirstJoinedAt = null;

    /** Who moved it last: patient | doctor | staff (null: never moved). */
    #[ORM\Column(name: 'rescheduled_by', type: 'string', length: 10, nullable: true)]
    private ?string $rescheduledBy = null;

    /**
     * What went back to the patient's wallet for it so far (consultation and
     * guest fees — a cancellation, no-show or back-office refund), money
     * string; null when nothing was refunded or on rows from before it was
     * kept (a `refunded` payment_status then means the whole amount).
     */
    #[ORM\Column(name: 'refunded_amount', type: 'decimal', precision: 12, scale: 2, nullable: true)]
    private ?string $refundedAmount = null;

    /** The patient declined it; the doctor (or the back office) withdrew it; it closed unanswered. */
    public const FOLLOW_UP_OUTCOMES = ['declined', 'withdrawn', 'expired'];

    /** The most guests a consultation can have at once. */
    public const MAX_GUESTS = 3;
    /** The Agora uids the patient and the doctor join as; guests get FIRST_GUEST_UID and up. */
    public const PATIENT_UID = 1;
    public const DOCTOR_UID = 2;
    public const FIRST_GUEST_UID = 100;
    /** How a guest's fee was paid: with the booking, from the wallet, by card, or nothing to pay. */
    public const GUEST_PAID_BY = ['booking', 'wallet', 'card', 'free'];
    /** The guest-entry fields {@see updateGuest()} may change. */
    private const GUEST_MUTABLE = ['display_name', 'last_sent_at', 'joined_at', 'consented_at', 'consent_version', 'rtc_issued_at', 'left_at'];

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

    /**
     * Move it. A real move clears both first-join stamps: they belonged to the
     * old slot, and the presence stamp is only ever written once
     * ({@see \App\Domain\Repository\AppointmentRepository::recordPresence()}),
     * so keeping them would leave the new slot with no stamps at all.
     */
    public function setScheduledAt(DateTimeImmutable $scheduledAt): void
    {
        if ($scheduledAt != $this->scheduledAt) {
            $this->doctorFirstJoinedAt  = null;
            $this->patientFirstJoinedAt = null;
        }
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

    /**
     * The invited guests' full entries (see the property). Emails are for the
     * patient's own views and the emails sent to each guest only.
     *
     * @return list<array<string,mixed>>
     */
    public function getGuests(): array
    {
        return array_values($this->guests ?? []);
    }

    /** @return array<string,mixed>|null the guest with this id, while still invited */
    public function findGuest(string $id): ?array
    {
        foreach ($this->getGuests() as $guest) {
            if ($id !== '' && ($guest['id'] ?? null) === $id) {
                return $guest;
            }
        }

        return null;
    }

    /**
     * Invite a guest: a stable id and an Agora uid of their own (never one a
     * removed guest had). `$fee` is what inviting them cost — the caller has
     * taken it and adds it to the amount. Returns the new entry.
     *
     * @return array<string,mixed>
     */
    public function addGuest(
        string $name,
        string $email,
        string $fee,
        string $paidBy,
        ?string $paymentReference,
        DateTimeImmutable $now,
        ?string $id = null,
    ): array {
        if (!in_array($paidBy, self::GUEST_PAID_BY, true)) {
            throw new \InvalidArgumentException('Unknown guest payment: ' . $paidBy);
        }
        $entry = [
            'id'                => $id ?? Uuid::uuid4()->toString(),
            'uid'               => $this->nextGuestUid(),
            'name'              => $name,
            'email'             => $email,
            'display_name'      => null,
            'fee'               => bcadd($fee, '0', 2),
            'paid_by'           => $paidBy,
            'payment_reference' => $paymentReference,
            'invited_at'        => $now->format(DATE_ATOM),
            'last_sent_at'      => null,
            'joined_at'         => null,
            'consented_at'      => null,
            'consent_version'   => null,
        ];
        $this->guests = [...$this->getGuests(), $entry];

        return $entry;
    }

    /** Remove a guest (their links stop working at once); returns the entry, or null when not invited. */
    public function removeGuest(string $id): ?array
    {
        $guest = $this->findGuest($id);
        if ($guest === null) {
            return null;
        }
        $left         = array_values(array_filter($this->getGuests(), static fn (array $g): bool => ($g['id'] ?? null) !== $id));
        $this->guests = $left !== [] ? $left : null;

        return $guest;
    }

    /**
     * Record something about a guest (GUEST_MUTABLE fields only — never who
     * they are or what they paid). Returns the updated entry, or null.
     *
     * @param array<string,mixed> $changes
     * @return array<string,mixed>|null
     */
    public function updateGuest(string $id, array $changes): ?array
    {
        $changes = array_intersect_key($changes, array_flip(self::GUEST_MUTABLE));
        $updated = null;
        $guests  = $this->getGuests();
        foreach ($guests as $i => $guest) {
            if ($id !== '' && ($guest['id'] ?? null) === $id) {
                $guests[$i] = $updated = $changes + $guest;
            }
        }
        if ($updated !== null) {
            $this->guests = $guests;
        }

        return $updated;
    }

    /**
     * The guest an older join link (minted before guests had ids: uid 3, 4, 5
     * in invitation order, no `gid`) stands for — only while that same guest
     * is still invited, matched by the uid recorded when ids were assigned and
     * by name.
     *
     * @return array<string,mixed>|null
     */
    public function findLegacyGuest(int $uid, string $name): ?array
    {
        $name = mb_strtolower(trim($name));
        foreach ($this->getGuests() as $guest) {
            if (
                isset($guest['legacy_uid'])
                && (int) $guest['legacy_uid'] === $uid
                && mb_strtolower(trim((string) ($guest['name'] ?? ''))) === $name
            ) {
                return $guest;
            }
        }

        return null;
    }

    /**
     * Give every guest invited before guests had identities an id, a uid and
     * the uid their older links carry (3 + their position), plus `$feeEach` as
     * what they cost. Idempotent (bin/prod-migrate.php): guests with an id are
     * left alone. Returns how many were given one.
     */
    public function assignGuestIdentities(string $feeEach): int
    {
        $assigned  = 0;
        $guests    = $this->getGuests();
        $invitedAt = (isset($this->createdAt) ? $this->createdAt : new DateTimeImmutable())->format(DATE_ATOM);
        foreach ($guests as $i => $guest) {
            if (is_string($guest['id'] ?? null) && $guest['id'] !== '') {
                continue;
            }
            $guests[$i] = [
                'id'                => Uuid::uuid4()->toString(),
                'uid'               => $this->nextGuestUid(),
                'name'              => (string) ($guest['name'] ?? ''),
                'email'             => (string) ($guest['email'] ?? ''),
                'display_name'      => null,
                'fee'               => bcadd($feeEach, '0', 2),
                'paid_by'           => 'booking',
                'payment_reference' => null,
                'invited_at'        => $invitedAt,
                'last_sent_at'      => null,
                'joined_at'         => null,
                'consented_at'      => null,
                'consent_version'   => null,
                'legacy_uid'        => 3 + $i,
            ];
            $assigned++;
        }
        if ($assigned > 0) {
            $this->guests = $guests;
        }

        return $assigned;
    }

    /**
     * What each guest without an identity is taken to have cost when they are
     * given one (it is what removing them refunds): the guest fee now
     * (`$guestFee`), never more than an equal share of what was paid above
     * the consultation's own price — the follow-up price it was booked at,
     * else the doctor's fee — and the guests already given one; nothing on a
     * free consultation or when guests were free at booking.
     */
    public function legacyGuestFee(string $guestFee): string
    {
        $count = count(array_filter($this->getGuests(), static fn (array $g): bool => !is_string($g['id'] ?? null) || $g['id'] === ''));
        if ($count === 0 || $this->isFree() || bccomp($guestFee, '0', 2) <= 0) {
            return '0.00';
        }
        $extra = bcsub($this->amount, $this->consultationPrice(), 2);
        foreach ($this->getGuests() as $guest) {
            if (is_string($guest['id'] ?? null) && $guest['id'] !== '') {
                $extra = bcsub($extra, bcadd((string) ($guest['fee'] ?? '0'), '0', 2), 2);
            }
        }
        if (bccomp($extra, '0', 2) <= 0) {
            return '0.00';
        }
        $share = bcdiv($extra, (string) $count, 2);

        return bccomp($guestFee, $share, 2) <= 0 ? bcadd($guestFee, '0', 2) : $share;
    }

    /** The consultation's own price, guests aside: what a follow-up was priced at, else the doctor's fee now. */
    private function consultationPrice(): string
    {
        $priced = $this->followUpPricing['amount'] ?? null;

        return bcadd(is_numeric($priced) ? (string) $priced : $this->specialist->getConsultationFee(), '0', 2);
    }

    /** The name a guest shows as in the call: the one they chose in the lobby, else the invitation's. */
    public static function guestDisplayName(array $guest): string
    {
        $chosen = trim((string) ($guest['display_name'] ?? ''));

        return $chosen !== '' ? $chosen : (string) ($guest['name'] ?? 'Guest');
    }

    /** The next guest uid: above every uid handed out so far (removed guests' too). */
    private function nextGuestUid(): int
    {
        $next = max(self::FIRST_GUEST_UID - 1, $this->guestUidSeq ?? 0, ...array_map(
            static fn (array $g): int => (int) ($g['uid'] ?? 0),
            $this->getGuests(),
        )) + 1;
        $this->guestUidSeq = $next;

        return $next;
    }

    public function setAmount(string $amount): void
    {
        $this->amount = $amount;
    }

    /**
     * Enforces the state machine; illegal transitions can't be expressed.
     * `$privileged`: the system or the back office is moving it, which allows
     * {@see AppointmentStatus::privilegedTransitions()} too. Reaching a closed
     * status records when (closed_at).
     */
    public function transitionTo(AppointmentStatus $target, bool $privileged = false): void
    {
        if ($this->status === $target) {
            return;
        }
        if (!$this->status->canTransitionTo($target, $privileged)) {
            throw new DomainException(sprintf(
                'This appointment is %s and can no longer be marked %s.',
                str_replace('_', ' ', $this->status->value),
                str_replace('_', ' ', $target->value),
            ));
        }
        $this->status = $target;
        if ($target->isTerminal()) {
            $this->closedAt = new DateTimeImmutable();
        }
    }

    // ----- Lifecycle closure -----

    public function getClosureReason(): ?string
    {
        return $this->closureReason;
    }

    /** One of AppointmentLifecycle::CLOSURE_REASONS, or null. */
    public function setClosureReason(?string $reason): void
    {
        if ($reason !== null && !in_array($reason, AppointmentLifecycle::CLOSURE_REASONS, true)) {
            throw new \InvalidArgumentException('Unknown closure reason: ' . $reason);
        }
        $this->closureReason = $reason;
    }

    public function getNoShow(): ?string
    {
        return $this->noShow;
    }

    /** doctor | patient | both (a missed consultation), or null. */
    public function setNoShow(?string $noShow): void
    {
        if ($noShow !== null && !in_array($noShow, AppointmentLifecycle::NO_SHOWS, true)) {
            throw new \InvalidArgumentException('Unknown no-show party: ' . $noShow);
        }
        $this->noShow = $noShow;
    }

    public function getClosedAt(): ?DateTimeImmutable
    {
        return $this->closedAt;
    }

    public function getDoctorFirstJoinedAt(): ?DateTimeImmutable
    {
        return $this->doctorFirstJoinedAt;
    }

    public function getPatientFirstJoinedAt(): ?DateTimeImmutable
    {
        return $this->patientFirstJoinedAt;
    }

    /** The first-join stamp of `$role` (patient | doctor), or null. */
    public function getFirstJoinedAt(string $role): ?DateTimeImmutable
    {
        return match ($role) {
            'doctor'  => $this->doctorFirstJoinedAt,
            'patient' => $this->patientFirstJoinedAt,
            default   => null,
        };
    }

    /** Record (in memory) `$role`'s first join — the repository stores it once ({@see \App\Domain\Repository\AppointmentRepository::stampFirstJoin()}). */
    public function markFirstJoined(string $role, DateTimeImmutable $at): void
    {
        if ($role === 'doctor') {
            $this->doctorFirstJoinedAt ??= $at;
        } elseif ($role === 'patient') {
            $this->patientFirstJoinedAt ??= $at;
        }
    }

    public function getRescheduledBy(): ?string
    {
        return $this->rescheduledBy;
    }

    /** patient | doctor | staff. */
    public function setRescheduledBy(string $who): void
    {
        if (!in_array($who, AppointmentLifecycle::RESCHEDULERS, true)) {
            throw new \InvalidArgumentException('Unknown rescheduler: ' . $who);
        }
        $this->rescheduledBy = $who;
    }

    /**
     * What went back to the wallet for it so far: the recorded refunds, or —
     * on a row from before they were kept — the whole amount when it reads
     * `refunded`.
     */
    public function getRefundedAmount(): string
    {
        if ($this->refundedAmount !== null) {
            return bcadd($this->refundedAmount, '0', 2);
        }

        return $this->paymentStatus === 'refunded' ? bcadd($this->amount, '0', 2) : '0.00';
    }

    /**
     * Record `$amount` more refunded to the wallet; once everything paid went
     * back, payment_status becomes `refunded`.
     */
    public function recordRefund(string $amount): void
    {
        $total                = bcadd($this->getRefundedAmount(), $amount, 2);
        $this->refundedAmount = $total;
        if (bccomp($total, $this->amount, 2) >= 0) {
            $this->paymentStatus = 'refunded';
        }
    }

    /** What is left to refund: what was paid less what went back (nothing unless paid). */
    public function refundableAmount(): string
    {
        if (!in_array($this->paymentStatus, ['paid', 'refunded'], true) || $this->isFree()) {
            return '0.00';
        }
        $left = bcsub($this->amount, $this->getRefundedAmount(), 2);

        return bccomp($left, '0', 2) > 0 ? $left : '0.00';
    }

    /**
     * The guest fees taken for it (each invited guest's recorded fee), never
     * more than the amount — what a missed consultation always refunds.
     */
    public function guestFeesTotal(): string
    {
        $total = '0.00';
        foreach ($this->getGuests() as $guest) {
            $fee = bcadd((string) ($guest['fee'] ?? '0'), '0', 2);
            if (bccomp($fee, '0', 2) > 0 && ($guest['paid_by'] ?? 'booking') !== 'free') {
                $total = bcadd($total, $fee, 2);
            }
        }

        return bccomp($total, $this->amount, 2) <= 0 ? $total : bcadd($this->amount, '0', 2);
    }

    /**
     * The lifecycle fields every payload carries (see {@see AppointmentLifecycle}):
     * ends_at, phase, display_status / display_label / display_detail,
     * needs_attention, and for a patient or doctor which changes they may make
     * now. `$inCall`: someone is in the call right now (a list that knows it).
     *
     * @return array<string,mixed>
     */
    public function lifecycleFields(DateTimeImmutable $now, string $audience = 'patient', bool $inCall = false): array
    {
        [$display, $label, $detail] = AppointmentLifecycle::display($this, $now, $audience, $inCall);
        $open    = $this->status->isOpenBooking();
        $started = AppointmentLifecycle::hasStarted($this, $now);
        $fields  = [
            'ends_at'         => AppointmentLifecycle::endsAt($this)->format(DATE_ATOM),
            'phase'           => AppointmentLifecycle::phase($this, $now, $inCall),
            'display_status'  => $display,
            'display_label'   => $label,
            'display_detail'  => $detail,
            'needs_attention' => AppointmentLifecycle::needsAttention($this, $now, $inCall),
        ];
        if ($audience === 'patient') {
            $fields['can_cancel']     = $open && !$started;
            $fields['can_reschedule'] = $open && !$started;
        } elseif ($audience === 'doctor') {
            $fields['can_confirm']    = in_array($this->status, [AppointmentStatus::PENDING, AppointmentStatus::RESCHEDULED], true)
                && AppointmentLifecycle::doctorConfirmProblem($this, $now) === null;
            $fields['can_reschedule'] = $open && AppointmentLifecycle::doctorRescheduleProblem($this, $now) === null;
            $fields['can_decline']    = $open && AppointmentLifecycle::doctorDeclineProblem($this, $now) === null;
        }

        return $fields;
    }

    /**
     * The payload. `$audience` (patient | doctor | staff) words the display
     * detail for the viewer and picks which allowed-change flags are added
     * (patient: can_cancel / can_reschedule; doctor: can_confirm / can_reschedule / can_decline).
     */
    public function toArray(string $audience = 'patient', ?DateTimeImmutable $now = null): array
    {
        $now ??= new DateTimeImmutable();

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
            // Names only, in every payload (the doctor's and the back office's too):
            // a guest's email stays on the patient's guest list (GET .../guests).
            'guests'         => array_map(static fn (array $g): array => [
                'id'   => isset($g['id']) ? (string) $g['id'] : null,
                'name' => (string) ($g['name'] ?? ''),
            ], $this->getGuests()),
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
            // Lifecycle closure (null until it applies).
            'closure_reason'        => $this->closureReason,
            'no_show'               => $this->noShow,
            'closed_at'             => $this->closedAt?->format(DATE_ATOM),
            'rescheduled_by'        => $this->rescheduledBy,
            'refunded_amount'       => $this->refundedAmount !== null || $this->paymentStatus === 'refunded' ? $this->getRefundedAmount() : null,
            'created_at'     => $this->createdAt->format(DATE_ATOM),
        ] + $this->lifecycleFields($now, $audience);
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
        $base = $this->toArray('staff');
        unset($base['follow_up_note'], $base['decline_reason']);

        return $base + [
            'patient' => [
                'id'    => $this->patient->getId(),
                'name'  => trim(((string) ($p['first_name'] ?? '')) . ' ' . ((string) ($p['last_name'] ?? ''))),
                'email' => $p['email'] ?? null,
                'phone' => $p['phone'] ?? null,
            ],
            // Presence evidence, for resolving a missed or stale consultation.
            'doctor_first_joined_at'  => $this->doctorFirstJoinedAt?->format(DATE_ATOM),
            'patient_first_joined_at' => $this->patientFirstJoinedAt?->format(DATE_ATOM),
        ];
    }
}
