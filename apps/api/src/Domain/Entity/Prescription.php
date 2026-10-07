<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use App\Domain\Settings\ClinicTime;
use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/**
 * An electronic prescription on the GVM-F-RX-01 form, numbered
 * GVM-RX-YYYYMMDD-NNNNN. Lifecycle (GVM-RX-02 §4):
 *
 *   draft ──send──▶ active ──(day after valid-until)──▶ expired
 *     │                └──cancel (and replace)──▶ cancelled
 *     └──delete
 *
 * Only the prescribing doctor sees a draft. Sending locks it: every field the
 * form prints (including the prescriber and patient details) is snapshotted, so
 * the document never changes afterwards. Medicines come from the RxNorm
 * catalogue and are snapshotted per row, so a catalogue refresh never rewrites
 * an issued prescription. Prescriptions issued before the structured form
 * (status `signed`, free-text items) are read as `active`.
 */
#[ORM\Entity]
#[ORM\Table(name: 'prescriptions')]
#[ORM\Index(name: 'idx_prescriptions_appointment', columns: ['appointment_id'])]
#[ORM\Index(name: 'idx_prescriptions_patient', columns: ['patient_id'])]
#[ORM\Index(name: 'idx_prescriptions_specialist', columns: ['specialist_id'])]
#[ORM\UniqueConstraint(name: 'uniq_prescriptions_number', columns: ['number'])]
#[ORM\HasLifecycleCallbacks]
class Prescription
{
    use TimestampsTrait;

    public const STATUS_DRAFT     = 'draft';
    public const STATUS_ACTIVE    = 'active';
    public const STATUS_EXPIRED   = 'expired';
    public const STATUS_CANCELLED = 'cancelled';
    /** Legacy pre-structured-form status; read as active. */
    public const STATUS_SIGNED    = 'signed';

    /** Medicine rows per printed page; the form allows one extra page. */
    public const ROWS_PER_PAGE = 5;
    public const MAX_ITEMS     = 10;

    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(type: 'string', length: 32, nullable: true)]
    private ?string $number = null;

    /** Null for a prescription written outside a consultation. */
    #[ORM\Column(name: 'appointment_id', type: 'uuid', nullable: true)]
    private ?string $appointmentId;

    #[ORM\Column(name: 'patient_id', type: 'uuid')]
    private string $patientId;

    #[ORM\Column(name: 'specialist_id', type: 'uuid', nullable: true)]
    private ?string $specialistId = null;

    #[ORM\Column(type: 'string', length: 20, options: ['default' => self::STATUS_DRAFT])]
    private string $status = self::STATUS_DRAFT;

    /** @var array<string,string> health readings + `source` / `taken_at` */
    #[ORM\Column(type: 'json', nullable: true)]
    private ?array $readings = null;

    #[ORM\Column(type: 'text', nullable: true)]
    private ?string $reason = null;

    #[ORM\Column(name: 'icd_code', type: 'string', length: 20, nullable: true)]
    private ?string $icdCode = null;

    #[ORM\Column(name: 'current_medications', type: 'text', nullable: true)]
    private ?string $currentMedications = null;

    /** no | pregnant | breastfeeding | unknown | not_applicable */
    #[ORM\Column(name: 'pregnancy_status', type: 'string', length: 20, nullable: true)]
    private ?string $pregnancyStatus = null;

    /** @var list<array<string,mixed>> medicine rows (see PrescriptionForm) */
    #[ORM\Column(type: 'json')]
    private array $items = [];

    #[ORM\Column(type: 'text', nullable: true)]
    private ?string $advice = null;

    #[ORM\Column(name: 'follow_up_date', type: 'date_immutable', nullable: true)]
    private ?DateTimeImmutable $followUpDate = null;

    /** video | in_person */
    #[ORM\Column(name: 'follow_up_mode', type: 'string', length: 12, nullable: true)]
    private ?string $followUpMode = null;

    #[ORM\Column(name: 'tests_referrals', type: 'text', nullable: true)]
    private ?string $testsReferrals = null;

    #[ORM\Column(name: 'valid_until', type: 'date_immutable', nullable: true)]
    private ?DateTimeImmutable $validUntil = null;

    #[ORM\Column(name: 'allows_repeats', type: 'boolean', options: ['default' => false])]
    private bool $allowsRepeats = false;

    /** Legacy free-text notes (pre-structured form). */
    #[ORM\Column(type: 'text', nullable: true)]
    private ?string $notes = null;

    /** @var array<string,string>|null prescriber details as printed, frozen at send */
    #[ORM\Column(type: 'json', nullable: true)]
    private ?array $prescriber = null;

    /** @var array<string,string>|null patient details as printed, frozen at send */
    #[ORM\Column(name: 'patient_snapshot', type: 'json', nullable: true)]
    private ?array $patientSnapshot = null;

    /** How it was signed: `saved` (profile picture) or `drawn` (by hand). */
    #[ORM\Column(name: 'signature_mode', type: 'string', length: 10, nullable: true)]
    private ?string $signatureMode = null;

    /** Storage key of the signature image frozen into this prescription. */
    #[ORM\Column(name: 'signature_key', type: 'string', length: 120, nullable: true)]
    private ?string $signatureKey = null;

    #[ORM\Column(name: 'signed_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $signedAt = null;

    #[ORM\Column(name: 'sent_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $sentAt = null;

    #[ORM\Column(name: 'author_name', type: 'string', length: 200, nullable: true)]
    private ?string $authorName = null;

    #[ORM\Column(name: 'cancelled_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $cancelledAt = null;

    #[ORM\Column(name: 'cancel_reason', type: 'text', nullable: true)]
    private ?string $cancelReason = null;

    #[ORM\Column(name: 'replaces_id', type: 'uuid', nullable: true)]
    private ?string $replacesId = null;

    #[ORM\Column(name: 'replaced_by_id', type: 'uuid', nullable: true)]
    private ?string $replacedById = null;

    #[ORM\Column(name: 'expiry_reminder_sent_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $expiryReminderSentAt = null;

    public function __construct(
        string $patientId,
        ?string $specialistId,
        ?string $appointmentId,
        string $number,
        DateTimeImmutable $validUntil,
    ) {
        $this->id            = Uuid::uuid4()->toString();
        $this->patientId     = $patientId;
        $this->specialistId  = $specialistId;
        $this->appointmentId = $appointmentId;
        $this->number        = $number;
        $this->validUntil    = $validUntil;
    }

    // ----- identity -----

    public function getId(): string
    {
        return $this->id;
    }

    public function getNumber(): string
    {
        return $this->number ?? ('RX-' . strtoupper(substr($this->id, 0, 8)));
    }

    public function hasNumber(): bool
    {
        return $this->number !== null;
    }

    public function assignNumber(string $number): void
    {
        $this->number ??= $number;
    }

    public function getAppointmentId(): ?string
    {
        return $this->appointmentId;
    }

    public function getPatientId(): string
    {
        return $this->patientId;
    }

    public function getSpecialistId(): ?string
    {
        return $this->specialistId;
    }

    // ----- lifecycle -----

    public function getStatus(): string
    {
        return $this->status;
    }

    public function isDraft(): bool
    {
        return $this->status === self::STATUS_DRAFT;
    }

    public function isSent(): bool
    {
        return !$this->isDraft();
    }

    /** Signed-legacy rows count as sent (they were visible to the patient). */
    public function isSigned(): bool
    {
        return $this->isSent();
    }

    /**
     * The status as of `$today`: an active prescription is expired from the day
     * after its valid-until date, whether or not the nightly job has stored it.
     */
    public function effectiveStatus(?DateTimeImmutable $today = null): string
    {
        return match ($this->status) {
            self::STATUS_DRAFT, self::STATUS_CANCELLED, self::STATUS_EXPIRED => $this->status,
            default => $this->isPastValidity($today) ? self::STATUS_EXPIRED : self::STATUS_ACTIVE,
        };
    }

    private function isPastValidity(?DateTimeImmutable $today): bool
    {
        if ($this->validUntil === null) {
            return false;
        }
        // Compared on the clinic's calendar (APP_TIMEZONE), as Y-m-d strings.
        $todayYmd = $today?->format('Y-m-d') ?? ClinicTime::todayYmd();

        return $todayYmd > $this->validUntil->format('Y-m-d');
    }

    /**
     * Lock and issue the prescription.
     *
     * @param array<string,string> $prescriber
     * @param array<string,string> $patient
     */
    public function send(
        array $prescriber,
        array $patient,
        string $signatureMode,
        ?string $signatureKey,
        DateTimeImmutable $now,
    ): void {
        $this->status          = self::STATUS_ACTIVE;
        $this->prescriber      = $prescriber;
        $this->patientSnapshot = $patient;
        $this->signatureMode   = $signatureMode;
        $this->signatureKey    = $signatureKey;
        $this->signedAt        = $now;
        $this->sentAt          = $now;
        $this->authorName      = $prescriber['name'] ?? null;
    }

    public function cancel(string $reason, DateTimeImmutable $now): void
    {
        $this->status       = self::STATUS_CANCELLED;
        $this->cancelledAt  = $now;
        $this->cancelReason = trim($reason) !== '' ? trim($reason) : null;
    }

    public function markExpired(): void
    {
        if ($this->status === self::STATUS_ACTIVE || $this->status === self::STATUS_SIGNED) {
            $this->status = self::STATUS_EXPIRED;
        }
    }

    public function linkReplacement(string $replacementId): void
    {
        $this->replacedById = $replacementId;
    }

    public function markReplaces(string $originalId): void
    {
        $this->replacesId = $originalId;
    }

    public function getReplacesId(): ?string
    {
        return $this->replacesId;
    }

    public function getSentAt(): ?DateTimeImmutable
    {
        return $this->sentAt ?? $this->signedAt;
    }

    public function getSignedAt(): ?DateTimeImmutable
    {
        return $this->signedAt;
    }

    public function getCancelledAt(): ?DateTimeImmutable
    {
        return $this->cancelledAt;
    }

    public function getExpiryReminderSentAt(): ?DateTimeImmutable
    {
        return $this->expiryReminderSentAt;
    }

    public function markExpiryReminderSent(DateTimeImmutable $now): void
    {
        $this->expiryReminderSentAt = $now;
    }

    // ----- form content (drafts only; enforced by the service) -----

    /** @param array<string,string> $readings */
    public function setReadings(array $readings): void
    {
        $this->readings = $readings !== [] ? $readings : null;
    }

    /** @return array<string,string> */
    public function getReadings(): array
    {
        return $this->readings ?? [];
    }

    public function setConsultation(?string $reason, ?string $icdCode, ?string $currentMedications, ?string $pregnancyStatus): void
    {
        $this->reason             = self::nullable($reason);
        $this->icdCode            = self::nullable($icdCode);
        $this->currentMedications = self::nullable($currentMedications);
        $this->pregnancyStatus    = self::nullable($pregnancyStatus);
    }

    public function getReason(): ?string
    {
        return $this->reason;
    }

    public function getIcdCode(): ?string
    {
        return $this->icdCode;
    }

    public function getCurrentMedications(): ?string
    {
        return $this->currentMedications;
    }

    public function getPregnancyStatus(): ?string
    {
        return $this->pregnancyStatus;
    }

    /** @param list<array<string,mixed>> $items */
    public function setItems(array $items): void
    {
        $this->items = array_values(array_slice($items, 0, self::MAX_ITEMS));
    }

    /**
     * Medicine rows in the structured shape. Legacy free-text rows
     * ({medication, strength, dosage…}) are mapped onto it for display.
     *
     * @return list<array<string,mixed>>
     */
    public function getItems(): array
    {
        return array_map(static function (array $row): array {
            if (array_key_exists('rxcui', $row)) {
                return $row;
            }
            $name = trim(((string) ($row['medication'] ?? '')) . ' ' . ((string) ($row['strength'] ?? '')));

            return [
                'rxcui'         => null,
                'name'          => $name,
                'generic_name'  => $name,
                'brand'         => null,
                'branded'       => false,
                'dose_form'     => null,
                'dose'          => (string) ($row['dosage'] ?? ''),
                'route'         => (string) ($row['route'] ?? ''),
                'frequency'     => (string) ($row['frequency'] ?? ''),
                'duration'      => (string) ($row['duration'] ?? ''),
                'quantity'      => (string) ($row['quantity'] ?? ''),
                'repeats'       => (int) ($row['refills'] ?? 0),
                'no_substitute' => false,
                'instructions'  => (string) ($row['instructions'] ?? ''),
            ];
        }, $this->items);
    }

    public function setAdvice(?string $advice, ?DateTimeImmutable $followUpDate, ?string $followUpMode, ?string $testsReferrals): void
    {
        $this->advice         = self::nullable($advice);
        $this->followUpDate   = $followUpDate;
        $this->followUpMode   = $followUpDate !== null ? self::nullable($followUpMode) : null;
        $this->testsReferrals = self::nullable($testsReferrals);
    }

    public function getAdvice(): ?string
    {
        return $this->advice ?? $this->notes;
    }

    public function getFollowUpDate(): ?DateTimeImmutable
    {
        return $this->followUpDate;
    }

    public function getFollowUpMode(): ?string
    {
        return $this->followUpMode;
    }

    public function getTestsReferrals(): ?string
    {
        return $this->testsReferrals;
    }

    public function setValidity(DateTimeImmutable $validUntil, bool $allowsRepeats): void
    {
        $this->validUntil    = $validUntil;
        $this->allowsRepeats = $allowsRepeats;
    }

    public function getValidUntil(): ?DateTimeImmutable
    {
        return $this->validUntil;
    }

    public function allowsRepeats(): bool
    {
        return $this->allowsRepeats;
    }

    /** @return array<string,string> */
    public function getPrescriber(): array
    {
        return $this->prescriber ?? ($this->authorName !== null ? ['name' => $this->authorName] : []);
    }

    /** @return array<string,string> */
    public function getPatientSnapshot(): array
    {
        return $this->patientSnapshot ?? [];
    }

    public function getSignatureMode(): ?string
    {
        return $this->signatureMode;
    }

    public function getSignatureKey(): ?string
    {
        return $this->signatureKey;
    }

    public function getCancelReason(): ?string
    {
        return $this->cancelReason;
    }

    /** Printed pages: one, plus the extra page when there are more than five medicines. */
    public function pageCount(): int
    {
        return max(1, (int) ceil(count($this->items) / self::ROWS_PER_PAGE));
    }

    // ----- serialisation -----

    /** Compact row for lists (never names medicines — safe for any list view). */
    public function toSummaryArray(?DateTimeImmutable $today = null): array
    {
        return [
            'id'             => $this->id,
            'number'         => $this->getNumber(),
            'status'         => $this->effectiveStatus($today),
            'appointment_id' => $this->appointmentId,
            'patient_id'     => $this->patientId,
            'prescriber'     => $this->getPrescriber()['name'] ?? $this->authorName,
            'patient_name'   => $this->patientSnapshot['name'] ?? null,
            'items_count'    => count($this->items),
            'valid_until'    => $this->validUntil?->format('Y-m-d'),
            'allows_repeats' => $this->allowsRepeats,
            'sent_at'        => $this->getSentAt()?->format(DATE_ATOM),
            'cancelled_at'   => $this->cancelledAt?->format(DATE_ATOM),
            'created_at'     => $this->createdAt->format(DATE_ATOM),
        ];
    }

    /** Full record for the prescriber and the patient. */
    public function toArray(?DateTimeImmutable $today = null): array
    {
        return $this->toSummaryArray($today) + [
            'readings'            => (object) $this->getReadings(),
            'reason'              => $this->reason,
            'icd_code'            => $this->icdCode,
            'current_medications' => $this->currentMedications,
            'pregnancy_status'    => $this->pregnancyStatus,
            'items'               => $this->getItems(),
            'advice'              => $this->getAdvice(),
            'follow_up_date'      => $this->followUpDate?->format('Y-m-d'),
            'follow_up_mode'      => $this->followUpMode,
            'tests_referrals'     => $this->testsReferrals,
            'prescriber_details'  => (object) $this->getPrescriber(),
            'patient_details'     => (object) $this->getPatientSnapshot(),
            'signature_mode'      => $this->signatureMode,
            'cancel_reason'       => $this->cancelReason,
            'replaces_id'         => $this->replacesId,
            'replaced_by_id'      => $this->replacedById,
            'page_count'          => $this->pageCount(),
            // Legacy fields kept for older clients.
            'notes'               => $this->getAdvice(),
            'signed_at'           => $this->signedAt?->format(DATE_ATOM),
            'author'              => $this->authorName,
            'specialist_id'       => $this->specialistId,
        ];
    }

    private static function nullable(?string $value): ?string
    {
        $value = $value !== null ? trim($value) : null;

        return $value !== '' ? $value : null;
    }
}
