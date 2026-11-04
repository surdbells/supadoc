<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use App\Domain\Settings\ProcessClock;
use DateTimeImmutable;
use Doctrine\Common\Collections\ArrayCollection;
use Doctrine\Common\Collections\Collection;
use Doctrine\ORM\Mapping as ORM;

/**
 * A laboratory & diagnostics request (spec §1.1): a doctor's signed request
 * for tests, imaging and physiological studies, numbered
 * GVM-REQ-YYYYMMDD-NNNNN when it is sent (there are no drafts). Lifecycle
 * (§1.7):
 *
 *   awaiting_consent ──accept──▶ booked ──sample──▶ in_lab ──result──▶ result_ready
 *        │  └──decline──▶ declined          │                 │
 *        └──(expires_at, also booked)──▶ expired   cancel ◀────┘ (awaiting / booked / in_lab)
 *
 * Booked and In Lab are reported by the patient; staff may correct them.
 * Expiry is also computed on read ({@see effectiveStatus()}). Everything the
 * PDF prints is frozen at send: the prescriber, the patient, the signature and
 * each item's catalogue snapshot — nothing is edited after send.
 *
 * Instants are stored on the process clock; `valid_until` and `lab_date` are
 * calendar dates (never normalised). Patient, doctor, appointment and
 * documents are scalar ids (policy decides what a doctor sees).
 */
#[ORM\Entity]
#[ORM\Table(name: 'lab_requests')]
#[ORM\Index(name: 'idx_lab_requests_patient', columns: ['patient_id', 'last_activity_at'])]
#[ORM\Index(name: 'idx_lab_requests_specialist', columns: ['specialist_id', 'last_activity_at'])]
#[ORM\Index(name: 'idx_lab_requests_appointment', columns: ['appointment_id'])]
#[ORM\Index(name: 'idx_lab_requests_status_due', columns: ['status', 'expires_at'])]
#[ORM\UniqueConstraint(name: 'uniq_lab_requests_number', columns: ['number'])]
#[ORM\UniqueConstraint(name: 'uniq_lab_requests_client_key', columns: ['specialist_id', 'client_key'])]
#[ORM\HasLifecycleCallbacks]
class LabRequest
{
    use TimestampsTrait;

    public const STATUS_AWAITING_CONSENT = 'awaiting_consent';
    public const STATUS_BOOKED           = 'booked';
    public const STATUS_IN_LAB           = 'in_lab';
    public const STATUS_RESULT_READY     = 'result_ready';
    public const STATUS_DECLINED         = 'declined';
    public const STATUS_CANCELLED        = 'cancelled';
    public const STATUS_EXPIRED          = 'expired';

    public const STATUSES = [
        self::STATUS_AWAITING_CONSENT, self::STATUS_BOOKED, self::STATUS_IN_LAB, self::STATUS_RESULT_READY,
        self::STATUS_DECLINED, self::STATUS_CANCELLED, self::STATUS_EXPIRED,
    ];

    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(type: 'string', length: 32)]
    private string $number;

    #[ORM\Column(name: 'client_key', type: 'uuid', nullable: true)]
    private ?string $clientKey;

    #[ORM\Column(name: 'request_hash', type: 'string', length: 64, nullable: true)]
    private ?string $requestHash;

    #[ORM\Column(name: 'patient_id', type: 'uuid')]
    private string $patientId;

    #[ORM\Column(name: 'specialist_id', type: 'uuid')]
    private string $specialistId;

    #[ORM\Column(name: 'appointment_id', type: 'uuid', nullable: true)]
    private ?string $appointmentId;

    #[ORM\Column(name: 'duplicated_from_id', type: 'uuid', nullable: true)]
    private ?string $duplicatedFromId;

    #[ORM\Column(type: 'string', length: 20, options: ['default' => self::STATUS_AWAITING_CONSENT])]
    private string $status = self::STATUS_AWAITING_CONSENT;

    #[ORM\Column(type: 'string', length: 10)]
    private string $priority;

    #[ORM\Column(type: 'string', length: 20, nullable: true)]
    private ?string $purpose;

    #[ORM\Column(name: 'clinical_question', type: 'string', length: 200)]
    private string $clinicalQuestion;

    #[ORM\Column(type: 'text', nullable: true)]
    private ?string $history;

    #[ORM\Column(type: 'text', nullable: true)]
    private ?string $medication;

    #[ORM\Column(type: 'text', nullable: true)]
    private ?string $allergies;

    /** @var array<string,mixed> {fasting, fasting_hours, pregnancy_asked, pregnant, weeks_pregnant, infection_alerts, transfusion_3m} */
    #[ORM\Column(name: 'clinical_flags', type: 'json')]
    private array $clinicalFlags;

    /** @var array<string,string>|null {contrast_allergy, mobility, pregnant} */
    #[ORM\Column(name: 'imaging_safety', type: 'json', nullable: true)]
    private ?array $imagingSafety;

    #[ORM\Column(name: 'catalogue_version', type: 'string', length: 20)]
    private string $catalogueVersion;

    /** @var array<string,string> PrescriberSnapshot::of() at send */
    #[ORM\Column(type: 'json')]
    private array $prescriber;

    /** @var array<string,string> */
    #[ORM\Column(name: 'patient_snapshot', type: 'json')]
    private array $patientSnapshot;

    #[ORM\Column(name: 'signature_mode', type: 'string', length: 10)]
    private string $signatureMode;

    #[ORM\Column(name: 'signature_key', type: 'string', length: 120)]
    private string $signatureKey;

    #[ORM\Column(name: 'attested_at', type: 'datetime_immutable')]
    private DateTimeImmutable $attestedAt;

    #[ORM\Column(name: 'signed_at', type: 'datetime_immutable')]
    private DateTimeImmutable $signedAt;

    #[ORM\Column(name: 'sent_at', type: 'datetime_immutable')]
    private DateTimeImmutable $sentAt;

    /** Clinic calendar date (never normalised). */
    #[ORM\Column(name: 'valid_until', type: 'date_immutable')]
    private DateTimeImmutable $validUntil;

    #[ORM\Column(name: 'expires_at', type: 'datetime_immutable')]
    private DateTimeImmutable $expiresAt;

    #[ORM\Column(name: 'reminded_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $remindedAt = null;

    #[ORM\Column(name: 'doctor_nudged_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $doctorNudgedAt = null;

    #[ORM\Column(name: 'result_reminded_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $resultRemindedAt = null;

    #[ORM\Column(name: 'result_share_key', type: 'uuid')]
    private string $resultShareKey;

    /** @var array<string,mixed>|null {version, tests, pays_lab, lab_disclosure, share_results} */
    #[ORM\Column(type: 'json', nullable: true)]
    private ?array $consent = null;

    #[ORM\Column(name: 'consented_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $consentedAt = null;

    #[ORM\Column(name: 'share_results', type: 'boolean', options: ['default' => false])]
    private bool $shareResults = false;

    #[ORM\Column(name: 'lab_name', type: 'string', length: 120, nullable: true)]
    private ?string $labName = null;

    /** Patient-reported planned date: a calendar date (never normalised). */
    #[ORM\Column(name: 'lab_date', type: 'date_immutable', nullable: true)]
    private ?DateTimeImmutable $labDate = null;

    #[ORM\Column(name: 'declined_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $declinedAt = null;

    #[ORM\Column(name: 'decline_reason', type: 'text', nullable: true)]
    private ?string $declineReason = null;

    #[ORM\Column(name: 'sample_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $sampleAt = null;

    #[ORM\Column(name: 'result_ready_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $resultReadyAt = null;

    #[ORM\Column(name: 'results_count', type: 'smallint', options: ['default' => 0])]
    private int $resultsCount = 0;

    /** Results with reviewed_at IS NULL — a SQL pre-filter only (the DTO figure is computed on read). */
    #[ORM\Column(name: 'unreviewed_total', type: 'smallint', options: ['default' => 0])]
    private int $unreviewedTotal = 0;

    #[ORM\Column(type: 'boolean', options: ['default' => false])]
    private bool $abnormal = false;

    #[ORM\Column(name: 'reviewed_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $reviewedAt = null;

    #[ORM\Column(name: 'cancelled_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $cancelledAt = null;

    #[ORM\Column(name: 'cancel_reason', type: 'text', nullable: true)]
    private ?string $cancelReason = null;

    #[ORM\Column(name: 'expired_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $expiredAt = null;

    #[ORM\Column(name: 'corrected_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $correctedAt = null;

    #[ORM\Column(name: 'last_activity_at', type: 'datetime_immutable')]
    private DateTimeImmutable $lastActivityAt;

    /** @var Collection<int, LabRequestItem> */
    #[ORM\OneToMany(targetEntity: LabRequestItem::class, mappedBy: 'request', cascade: ['persist'])]
    #[ORM\OrderBy(['position' => 'ASC'])]
    private Collection $items;

    /** @var Collection<int, LabRequestResult> */
    #[ORM\OneToMany(targetEntity: LabRequestResult::class, mappedBy: 'request', cascade: ['persist'])]
    #[ORM\OrderBy(['uploadedAt' => 'ASC', 'id' => 'ASC'])]
    private Collection $results;

    /**
     * T2 — the request as sent.
     *
     * @param array<string,mixed>  $form       LabRequestForm::validate() output
     * @param array<string,string> $prescriber
     * @param array<string,string> $patient
     * @param array{valid_until: DateTimeImmutable, expires_at: DateTimeImmutable} $validity
     */
    public function __construct(
        string $id,
        string $number,
        string $patientId,
        string $specialistId,
        ?string $appointmentId,
        ?string $duplicatedFromId,
        ?string $clientKey,
        ?string $requestHash,
        array $form,
        string $catalogueVersion,
        array $prescriber,
        array $patient,
        string $signatureMode,
        string $signatureKey,
        string $resultShareKey,
        array $validity,
        DateTimeImmutable $now,
    ) {
        $now                    = ProcessClock::normalize($now);
        $this->id               = strtolower($id);
        $this->number           = $number;
        $this->patientId        = strtolower($patientId);
        $this->specialistId     = strtolower($specialistId);
        $this->appointmentId    = $appointmentId !== null ? strtolower($appointmentId) : null;
        $this->duplicatedFromId = $duplicatedFromId !== null ? strtolower($duplicatedFromId) : null;
        $this->clientKey        = $clientKey !== null ? strtolower($clientKey) : null;
        $this->requestHash      = $requestHash;
        $this->priority         = (string) $form['priority'];
        $this->purpose          = $form['purpose'] ?? null;
        $this->clinicalQuestion = (string) $form['clinical_question'];
        $this->history          = $form['history'] ?? null;
        $this->medication       = $form['medication'] ?? null;
        $this->allergies        = $form['allergies'] ?? null;
        $this->clinicalFlags    = (array) $form['clinical_flags'];
        $this->imagingSafety    = $form['imaging_safety'] ?? null;
        $this->catalogueVersion = $catalogueVersion;
        $this->prescriber       = $prescriber;
        $this->patientSnapshot  = $patient;
        $this->signatureMode    = $signatureMode;
        $this->signatureKey     = $signatureKey;
        $this->resultShareKey   = strtolower($resultShareKey);
        $this->attestedAt       = $now;
        $this->signedAt         = $now;
        $this->sentAt           = $now;
        $this->lastActivityAt   = $now;
        $this->items            = new ArrayCollection();
        $this->results          = new ArrayCollection();
        $this->setValidity($validity);
    }

    // ----- identity -----

    public function getId(): string
    {
        return $this->id;
    }

    public function getNumber(): string
    {
        return $this->number;
    }

    public function getClientKey(): ?string
    {
        return $this->clientKey;
    }

    public function getRequestHash(): ?string
    {
        return $this->requestHash;
    }

    public function getPatientId(): string
    {
        return $this->patientId;
    }

    public function getSpecialistId(): string
    {
        return $this->specialistId;
    }

    public function getAppointmentId(): ?string
    {
        return $this->appointmentId;
    }

    public function getDuplicatedFromId(): ?string
    {
        return $this->duplicatedFromId;
    }

    // ----- status -----

    public function getStatus(): string
    {
        return $this->status;
    }

    /** The stored status, or `expired` once an unanswered / booked request passed `expires_at`. */
    public function effectiveStatus(DateTimeImmutable $now): string
    {
        if (in_array($this->status, [self::STATUS_AWAITING_CONSENT, self::STATUS_BOOKED], true) && $this->expiresAt <= $now) {
            return self::STATUS_EXPIRED;
        }

        return $this->status;
    }

    /** Due an expiry that hasn't been stored yet. */
    public function expiryDue(DateTimeImmutable $now): bool
    {
        return $this->status !== self::STATUS_EXPIRED && $this->effectiveStatus($now) === self::STATUS_EXPIRED;
    }

    /** Still somewhere a doctor or patient acts on (not declined, cancelled or expired). */
    public function isOpen(DateTimeImmutable $now): bool
    {
        return in_array($this->effectiveStatus($now), [self::STATUS_AWAITING_CONSENT, self::STATUS_BOOKED, self::STATUS_IN_LAB, self::STATUS_RESULT_READY], true);
    }

    // ----- content -----

    public function getPriority(): string
    {
        return $this->priority;
    }

    public function getPurpose(): ?string
    {
        return $this->purpose;
    }

    public function getClinicalQuestion(): string
    {
        return $this->clinicalQuestion;
    }

    public function getHistory(): ?string
    {
        return $this->history;
    }

    public function getMedication(): ?string
    {
        return $this->medication;
    }

    public function getAllergies(): ?string
    {
        return $this->allergies;
    }

    /** @return array<string,mixed> */
    public function getClinicalFlags(): array
    {
        return $this->clinicalFlags;
    }

    /** @return array<string,string>|null */
    public function getImagingSafety(): ?array
    {
        return $this->imagingSafety;
    }

    public function getCatalogueVersion(): string
    {
        return $this->catalogueVersion;
    }

    /** @return array<string,string> */
    public function getPrescriber(): array
    {
        return $this->prescriber;
    }

    /** @return array<string,string> */
    public function getPatientSnapshot(): array
    {
        return $this->patientSnapshot;
    }

    public function getSignatureMode(): string
    {
        return $this->signatureMode;
    }

    public function getSignatureKey(): string
    {
        return $this->signatureKey;
    }

    public function addItem(LabRequestItem $item): void
    {
        $this->items->add($item);
    }

    /** @return list<LabRequestItem> in position order */
    public function getItems(): array
    {
        $items = [];
        foreach ($this->items as $item) {
            $items[$item->getId()] = $item;
        }
        $items = array_values($items);
        usort($items, static fn (LabRequestItem $a, LabRequestItem $b): int => $a->getPosition() <=> $b->getPosition());

        return array_values($items);
    }

    /** @return list<string> */
    public function itemIds(): array
    {
        return array_map(static fn (LabRequestItem $i): string => $i->getId(), $this->getItems());
    }

    /** @return array{lab: list<LabRequestItem>, imaging: list<LabRequestItem>, physiological: list<LabRequestItem>} */
    public function itemsByKind(): array
    {
        $out = ['lab' => [], 'imaging' => [], 'physiological' => []];
        foreach ($this->getItems() as $item) {
            $out[$item->getKind()][] = $item;
        }

        return $out;
    }

    /** "Troponin I, ECG (12-lead)": each item's short, lab → imaging → physiological. */
    public function testsLabel(): string
    {
        $shorts = [];
        foreach ($this->itemsByKind() as $items) {
            foreach ($items as $item) {
                $shorts[] = $item->getShort();
            }
        }

        return implode(', ', $shorts);
    }

    public function addResult(LabRequestResult $result): void
    {
        $this->results->add($result);
    }

    /** @return list<LabRequestResult> oldest first */
    public function getResults(): array
    {
        $results = [];
        foreach ($this->results as $result) {
            $results[$result->getId()] = $result;
        }
        $results = array_values($results);
        usort($results, static fn (LabRequestResult $a, LabRequestResult $b): int => [$a->getUploadedAt(), $a->getId()] <=> [$b->getUploadedAt(), $b->getId()]);

        return array_values($results);
    }

    public function result(string $resultId): ?LabRequestResult
    {
        foreach ($this->results as $result) {
            if ($result->getId() === strtolower(trim($resultId))) {
                return $result;
            }
        }

        return null;
    }

    // ----- times -----

    public function getAttestedAt(): DateTimeImmutable
    {
        return $this->attestedAt;
    }

    public function getSignedAt(): DateTimeImmutable
    {
        return $this->signedAt;
    }

    public function getSentAt(): DateTimeImmutable
    {
        return $this->sentAt;
    }

    public function getValidUntil(): DateTimeImmutable
    {
        return $this->validUntil;
    }

    public function getExpiresAt(): DateTimeImmutable
    {
        return $this->expiresAt;
    }

    public function getRemindedAt(): ?DateTimeImmutable
    {
        return $this->remindedAt;
    }

    public function getDoctorNudgedAt(): ?DateTimeImmutable
    {
        return $this->doctorNudgedAt;
    }

    public function getResultRemindedAt(): ?DateTimeImmutable
    {
        return $this->resultRemindedAt;
    }

    public function getResultShareKey(): string
    {
        return $this->resultShareKey;
    }

    /** @return array<string,mixed>|null */
    public function getConsent(): ?array
    {
        return $this->consent;
    }

    public function getConsentedAt(): ?DateTimeImmutable
    {
        return $this->consentedAt;
    }

    public function sharesResults(): bool
    {
        return $this->shareResults;
    }

    public function getLabName(): ?string
    {
        return $this->labName;
    }

    public function getLabDate(): ?DateTimeImmutable
    {
        return $this->labDate;
    }

    public function getDeclinedAt(): ?DateTimeImmutable
    {
        return $this->declinedAt;
    }

    public function getDeclineReason(): ?string
    {
        return $this->declineReason;
    }

    public function getSampleAt(): ?DateTimeImmutable
    {
        return $this->sampleAt;
    }

    public function getResultReadyAt(): ?DateTimeImmutable
    {
        return $this->resultReadyAt;
    }

    public function getResultsCount(): int
    {
        return $this->resultsCount;
    }

    public function getUnreviewedTotal(): int
    {
        return $this->unreviewedTotal;
    }

    public function isAbnormal(): bool
    {
        return $this->abnormal;
    }

    public function getReviewedAt(): ?DateTimeImmutable
    {
        return $this->reviewedAt;
    }

    public function getCancelledAt(): ?DateTimeImmutable
    {
        return $this->cancelledAt;
    }

    public function getCancelReason(): ?string
    {
        return $this->cancelReason;
    }

    public function getExpiredAt(): ?DateTimeImmutable
    {
        return $this->expiredAt;
    }

    public function getCorrectedAt(): ?DateTimeImmutable
    {
        return $this->correctedAt;
    }

    public function getLastActivityAt(): DateTimeImmutable
    {
        return $this->lastActivityAt;
    }

    // ----- transitions (§1.7); the service checks they are allowed -----

    /**
     * Validity (calendar date + the clinic midnight that ends it), stored as
     * given — `valid_until` is never normalised.
     *
     * @param array{valid_until: DateTimeImmutable, expires_at: DateTimeImmutable} $v
     */
    public function setValidity(array $v): void
    {
        $this->validUntil = $v['valid_until'];
        $this->expiresAt  = ProcessClock::normalize($v['expires_at']);
    }

    /**
     * T3 accept.
     *
     * @param array<string,mixed> $consent
     */
    public function markAccepted(array $consent, bool $shareResults, ?string $labName, ?DateTimeImmutable $labDate, DateTimeImmutable $now): void
    {
        $this->status       = self::STATUS_BOOKED;
        $this->consent      = $consent;
        $this->consentedAt  = ProcessClock::normalize($now);
        $this->shareResults = $shareResults;
        $this->labName      = $labName;
        $this->labDate      = $labDate;
        $this->touch($now);
    }

    /** T4 decline. */
    public function markDeclined(?string $reason, DateTimeImmutable $now): void
    {
        $this->status        = self::STATUS_DECLINED;
        $this->declinedAt    = ProcessClock::normalize($now);
        $this->declineReason = $reason;
        $this->touch($now);
    }

    /** T5 sample given. */
    public function markSampleGiven(DateTimeImmutable $now): void
    {
        $this->status   = self::STATUS_IN_LAB;
        $this->sampleAt = ProcessClock::normalize($now);
        $this->touch($now);
    }

    /** T6 / T6b / T6c: one more result (a cancelled request stays cancelled). */
    public function addResultCounts(DateTimeImmutable $now): void
    {
        ++$this->resultsCount;
        ++$this->unreviewedTotal;
        $this->resultReadyAt ??= ProcessClock::normalize($now);
        if ($this->status !== self::STATUS_CANCELLED) {
            $this->status    = self::STATUS_RESULT_READY;
            $this->expiredAt = null;
        }
        $this->touch($now);
    }

    /** T7: the totals recomputed from the result rows. */
    public function applyReviewTotals(int $unreviewed, bool $abnormal, ?DateTimeImmutable $reviewedAt, DateTimeImmutable $now): void
    {
        $this->unreviewedTotal = max(0, $unreviewed);
        $this->abnormal        = $abnormal;
        $this->reviewedAt      = $reviewedAt !== null ? ProcessClock::normalize($reviewedAt) : null;
        $this->touch($now);
    }

    /** T8 cancel. */
    public function markCancelled(string $reason, DateTimeImmutable $now): void
    {
        $this->status       = self::STATUS_CANCELLED;
        $this->cancelledAt  = ProcessClock::normalize($now);
        $this->cancelReason = $reason;
        $this->touch($now);
    }

    /**
     * T9: expired at `expires_at` (stored late by a read, a write or the
     * sweeper). The list order never moves backwards past a later event.
     */
    public function markExpired(): void
    {
        $this->status         = self::STATUS_EXPIRED;
        $this->expiredAt      = $this->expiresAt;
        if ($this->expiresAt > $this->lastActivityAt) {
            $this->lastActivityAt = $this->expiresAt;
        }
    }

    /**
     * C1–C4, a staff correction. `$sampleAt` (C1) is the reported sample time;
     * `$validity` (C3 / C4) the new validity; reopening clears the reminders.
     *
     * @param array{valid_until: DateTimeImmutable, expires_at: DateTimeImmutable}|null $validity
     */
    public function correctTo(string $to, ?DateTimeImmutable $sampleAt, ?array $validity, DateTimeImmutable $now): void
    {
        $from = $this->status;
        if ($from === self::STATUS_BOOKED && $to === self::STATUS_IN_LAB) {
            $this->sampleAt = ProcessClock::normalize($sampleAt ?? $now);
        } elseif ($from === self::STATUS_IN_LAB && $to === self::STATUS_BOOKED) {
            $this->sampleAt = null;
        } elseif ($from === self::STATUS_DECLINED) {
            $this->declinedAt    = null;
            $this->declineReason = null;
        } elseif ($from === self::STATUS_EXPIRED) {
            $this->expiredAt = null;
        }
        if ($validity !== null) {
            $this->setValidity($validity);
        }
        if ($from === self::STATUS_DECLINED || $from === self::STATUS_EXPIRED) {
            $this->remindedAt     = null;
            $this->doctorNudgedAt = null;
        }
        $this->status      = $to;
        $this->correctedAt = ProcessClock::normalize($now);
        $this->touch($now);
    }

    /** A new grant key for this request's results (the last grant ended and the patient shares again). */
    public function rotateResultShareKey(string $uuid): void
    {
        $this->resultShareKey = strtolower($uuid);
    }

    /** T10: the patient's reminder — a `reminded` event, so it bumps the list order too. */
    public function markReminded(DateTimeImmutable $now): void
    {
        $this->remindedAt = ProcessClock::normalize($now);
        $this->touch($now);
    }

    public function markDoctorNudged(DateTimeImmutable $now): void
    {
        $this->doctorNudgedAt = ProcessClock::normalize($now);
    }

    public function markResultReminded(DateTimeImmutable $now): void
    {
        $this->resultRemindedAt = ProcessClock::normalize($now);
    }

    public function touch(DateTimeImmutable $now): void
    {
        $this->lastActivityAt = ProcessClock::normalize($now);
    }
}
