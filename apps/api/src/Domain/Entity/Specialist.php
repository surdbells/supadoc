<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use App\Domain\Enum\SpecialistStatus;
use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/**
 * A bookable specialist. `consultationFee` is `decimal` mapped to STRING — money
 * never touches a float (see ARCHITECTURE §6); do arithmetic with bcmath.
 *
 * Once approved, the fields a patient or pharmacist relies on to know who the
 * doctor is ({@see LOCKED_FIELDS}) only change through a review: the doctor's
 * edits wait in `pending_changes` until a reviewer approves them, and what was
 * approved is kept in `approved_snapshot`.
 */
#[ORM\Entity]
#[ORM\Table(name: 'specialists')]
#[ORM\HasLifecycleCallbacks]
class Specialist
{
    use TimestampsTrait;
    use SoftDeleteTrait;

    /** Identity fields that, once approved, change only through a review ({@see stageChanges()}). */
    public const LOCKED_FIELDS = ['name', 'specialty', 'mdcn_number', 'qualifications', 'qualification_entries', 'certifications'];

    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(type: 'string', length: 200)]
    private string $name;

    #[ORM\Column(type: 'string', length: 120)]
    private string $specialty;

    #[ORM\Column(type: 'string', length: 200, nullable: true)]
    private ?string $location = null;

    #[ORM\Column(type: 'decimal', precision: 12, scale: 2)]
    private string $consultationFee = '0.00';

    #[ORM\Column(type: 'decimal', precision: 3, scale: 2)]
    private string $rating = '0.00';

    #[ORM\Column(type: 'integer')]
    private int $reviewsCount = 0;

    #[ORM\Column(type: 'boolean')]
    private bool $available = true;

    #[ORM\Column(name: 'years_experience', type: 'integer', nullable: true)]
    private ?int $yearsExperience = null;

    /** Comma-separated spoken languages, e.g. "English, French". */
    #[ORM\Column(type: 'string', length: 200, nullable: true)]
    private ?string $languages = null;

    /**
     * Read through {@see isVerified()}: shown as verified only while approved.
     * Set by approval; no longer a free back-office toggle.
     */
    #[ORM\Column(type: 'boolean', options: ['default' => true])]
    private bool $verified = true;

    /**
     * Recurring weekly availability: map of weekday ("0"=Sun … "6"=Sat) to a
     * list of [start, end] "HH:MM" windows. Null falls back to a default in
     * {@see \App\Infrastructure\Service\AvailabilityService}.
     */
    #[ORM\Column(name: 'weekly_hours', type: 'json', nullable: true)]
    private ?array $weeklyHours = null;

    /** The specialist's gender ('male' / 'female'), for the directory filter. */
    #[ORM\Column(type: 'string', length: 20, nullable: true)]
    private ?string $gender = null;

    /** Doctor contact email — used server-side for confirmations; never in toArray. */
    #[ORM\Column(type: 'string', length: 255, nullable: true)]
    private ?string $email = null;

    /** Public headshot URL (absolute, or a relative /uploads path). */
    #[ORM\Column(name: 'photo_url', type: 'string', length: 300, nullable: true)]
    private ?string $photoUrl = null;

    /** Whether they also offer in-person visits (all offer online/telehealth). */
    #[ORM\Column(name: 'offers_in_person', type: 'boolean', options: ['default' => false])]
    private bool $offersInPerson = false;

    /** Public "about me" blurb. */
    #[ORM\Column(type: 'text', nullable: true)]
    private ?string $bio = null;

    /** Qualifications / credentials, e.g. "MBBS, FMCP · MDCN 12345". */
    #[ORM\Column(type: 'string', length: 300, nullable: true)]
    private ?string $qualifications = null;

    /** Contact phone for the doctor (self-service profile). */
    #[ORM\Column(type: 'string', length: 40, nullable: true)]
    private ?string $phone = null;

    #[ORM\Column(name: 'date_of_birth', type: 'date_immutable', nullable: true)]
    private ?DateTimeImmutable $dateOfBirth = null;

    /** Country / region, distinct from the free-text `location`. */
    #[ORM\Column(type: 'string', length: 120, nullable: true)]
    private ?string $country = null;

    /**
     * Areas of expertise (chips), e.g. ["Heart Failure", "Hypertension"].
     *
     * @var list<string>|null
     */
    #[ORM\Column(type: 'json', nullable: true)]
    private ?array $expertise = null;

    /**
     * Structured qualifications: each {title, institution, year}. Kept alongside
     * the legacy `qualifications` string (still used by the public directory).
     *
     * @var list<array{title:string,institution:string,year:string}>|null
     */
    #[ORM\Column(name: 'qualification_entries', type: 'json', nullable: true)]
    private ?array $qualificationEntries = null;

    /**
     * Certifications: each {name, body, year}.
     *
     * @var list<array{name:string,body:string,year:string}>|null
     */
    #[ORM\Column(type: 'json', nullable: true)]
    private ?array $certifications = null;

    /**
     * Registration number with the Medical and Dental Council of Nigeria. Printed
     * on prescriptions and shown on the public prescription check page.
     */
    #[ORM\Column(name: 'mdcn_number', type: 'string', length: 40, nullable: true)]
    private ?string $mdcnNumber = null;

    /**
     * Storage key of the doctor's saved signature picture (encrypted at rest,
     * outside the web root — see SignatureStore). Null when none is saved.
     */
    #[ORM\Column(name: 'signature_key', type: 'string', length: 120, nullable: true)]
    private ?string $signatureKey = null;

    /**
     * The doctor-portal site this doctor last signed in from (see WebUrls), so
     * emailed links send them back there. Never part of the public payload.
     */
    #[ORM\Column(name: 'web_origin', type: 'string', length: 255, nullable: true)]
    private ?string $webOrigin = null;

    /** Default consultation length in minutes for generated slots (15/30/45/60). */
    #[ORM\Column(name: 'slot_minutes', type: 'integer', options: ['default' => 30])]
    private int $slotMinutes = 30;

    /**
     * Onboarding / review state ({@see SpecialistStatus}). NULL is a doctor from
     * before onboarding existed and counts as approved; a new specialist starts
     * invited and is only listed and bookable once an admin approves them.
     */
    #[ORM\Column(type: 'string', length: 20, nullable: true, enumType: SpecialistStatus::class)]
    private ?SpecialistStatus $status = null;

    /** When the doctor last submitted their profile for review. */
    #[ORM\Column(name: 'submitted_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $submittedAt = null;

    #[ORM\Column(name: 'approved_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $approvedAt = null;

    /** Staff user id of the admin who approved the doctor. */
    #[ORM\Column(name: 'approved_by', type: 'uuid', nullable: true)]
    private ?string $approvedBy = null;

    /** Why the last review sent the profile back — shown to the doctor. */
    #[ORM\Column(name: 'rejection_reason', type: 'text', nullable: true)]
    private ?string $rejectionReason = null;

    /** The practitioner terms version the doctor last accepted ({@see \App\Domain\Settings\PractitionerTerms}). */
    #[ORM\Column(name: 'terms_version', type: 'string', length: 20, nullable: true)]
    private ?string $termsVersion = null;

    #[ORM\Column(name: 'terms_accepted_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $termsAcceptedAt = null;

    #[ORM\Column(name: 'terms_accepted_ip', type: 'string', length: 45, nullable: true)]
    private ?string $termsAcceptedIp = null;

    /**
     * What a reviewer approved: the locked fields' values, the credential ids
     * that were verified, who approved and when. Null for a doctor approved
     * before credentials existed.
     *
     * @var array<string,mixed>|null
     */
    #[ORM\Column(name: 'approved_snapshot', type: 'json', nullable: true)]
    private ?array $approvedSnapshot = null;

    /**
     * Edits to locked fields waiting for a reviewer: {fields: {key: value},
     * submitted_at}. Null when nothing is waiting.
     *
     * @var array<string,mixed>|null
     */
    #[ORM\Column(name: 'pending_changes', type: 'json', nullable: true)]
    private ?array $pendingChanges = null;

    /** Why a reviewer turned down the last change request — shown to the doctor until they send another. */
    #[ORM\Column(name: 'changes_review_note', type: 'text', nullable: true)]
    private ?string $changesReviewNote = null;

    #[ORM\Column(name: 'suspended_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $suspendedAt = null;

    /** Staff user who suspended the doctor (null: the system, e.g. an expired licence). */
    #[ORM\Column(name: 'suspended_by', type: 'uuid', nullable: true)]
    private ?string $suspendedBy = null;

    /** licence_expired | conduct | complaint | admin | other. */
    #[ORM\Column(name: 'suspension_code', type: 'string', length: 30, nullable: true)]
    private ?string $suspensionCode = null;

    /** Shown to the doctor while they are suspended. */
    #[ORM\Column(name: 'suspension_reason', type: 'text', nullable: true)]
    private ?string $suspensionReason = null;

    /** Last valid day of the current verified practising licence (copied from it, for filters). */
    #[ORM\Column(name: 'licence_expires_at', type: 'date_immutable', nullable: true)]
    private ?DateTimeImmutable $licenceExpiresAt = null;

    /**
     * A doctor approved before credentials existed must upload them by this
     * date (set once by the licence cron / prod-migrate). Cleared when their
     * MDCN certificate and a current licence are verified. Never suspends.
     */
    #[ORM\Column(name: 'credentials_due_at', type: 'date_immutable', nullable: true)]
    private ?DateTimeImmutable $credentialsDueAt = null;

    /** The most urgent "credentials due" reminder already sent (days before). */
    #[ORM\Column(name: 'credentials_reminder_stage', type: 'smallint', nullable: true)]
    private ?int $credentialsReminderStage = null;

    public function __construct(string $name, string $specialty)
    {
        $this->id        = Uuid::uuid4()->toString();
        $this->name      = $name;
        $this->specialty = $specialty;
        $this->status    = SpecialistStatus::INVITED;
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function getName(): string
    {
        return $this->name;
    }

    public function getSpecialty(): string
    {
        return $this->specialty;
    }

    public function getConsultationFee(): string
    {
        return $this->consultationFee;
    }

    public function setConsultationFee(string $fee): void
    {
        $this->consultationFee = $fee;
    }

    public function setLocation(?string $location): void
    {
        $this->location = $location;
    }

    /** @param numeric-string $rating */
    public function setRating(string $rating): void
    {
        $this->rating = $rating;
    }

    public function setReviewsCount(int $count): void
    {
        $this->reviewsCount = $count;
    }

    public function setAvailable(bool $available): void
    {
        $this->available = $available;
    }

    public function isAvailable(): bool
    {
        return $this->available;
    }

    public function setYearsExperience(?int $years): void
    {
        $this->yearsExperience = $years;
    }

    public function setLanguages(?string $languages): void
    {
        $this->languages = $languages !== null && $languages !== '' ? $languages : null;
    }

    public function setVerified(bool $verified): void
    {
        $this->verified = $verified;
    }

    /** @return array<string, list<array{0:string,1:string}>>|null */
    public function getWeeklyHours(): ?array
    {
        return $this->weeklyHours;
    }

    /** @param array<string, list<array{0:string,1:string}>>|null $hours */
    public function setWeeklyHours(?array $hours): void
    {
        $this->weeklyHours = $hours;
    }

    public function setGender(?string $gender): void
    {
        $this->gender = $gender !== null && $gender !== '' ? strtolower($gender) : null;
    }

    public function getEmail(): ?string
    {
        return $this->email;
    }

    public function setEmail(?string $email): void
    {
        $this->email = $email !== null && $email !== '' ? $email : null;
    }

    public function getPhotoUrl(): ?string
    {
        return $this->photoUrl;
    }

    public function setPhotoUrl(?string $url): void
    {
        $this->photoUrl = $url !== null && $url !== '' ? $url : null;
    }

    public function setOffersInPerson(bool $offers): void
    {
        $this->offersInPerson = $offers;
    }

    public function getBio(): ?string
    {
        return $this->bio;
    }

    public function setBio(?string $bio): void
    {
        $this->bio = $bio !== null && trim($bio) !== '' ? trim($bio) : null;
    }

    public function setQualifications(?string $qualifications): void
    {
        $this->qualifications = $qualifications !== null && trim($qualifications) !== '' ? trim($qualifications) : null;
    }

    public function setName(string $name): void
    {
        $this->name = trim($name);
    }

    public function setSpecialty(string $specialty): void
    {
        $this->specialty = trim($specialty);
    }

    public function getPhone(): ?string
    {
        return $this->phone;
    }

    public function setPhone(?string $phone): void
    {
        $this->phone = $phone !== null && trim($phone) !== '' ? trim($phone) : null;
    }

    public function getDateOfBirth(): ?DateTimeImmutable
    {
        return $this->dateOfBirth;
    }

    public function setDateOfBirth(?DateTimeImmutable $dob): void
    {
        $this->dateOfBirth = $dob;
    }

    public function setCountry(?string $country): void
    {
        $this->country = $country !== null && trim($country) !== '' ? trim($country) : null;
    }

    /** @return list<string> */
    public function getExpertise(): array
    {
        return $this->expertise ?? [];
    }

    /** @param list<string> $expertise */
    public function setExpertise(array $expertise): void
    {
        $clean = array_values(array_filter(array_map(
            static fn (mixed $x): string => trim((string) $x),
            $expertise,
        ), static fn (string $x): bool => $x !== ''));
        $this->expertise = $clean !== [] ? $clean : null;
    }

    /** @return list<array{title:string,institution:string,year:string}> */
    public function getQualificationEntries(): array
    {
        return $this->qualificationEntries ?? [];
    }

    /** @param list<array{title:string,institution:string,year:string}> $entries */
    public function setQualificationEntries(array $entries): void
    {
        $this->qualificationEntries = $entries !== [] ? array_values($entries) : null;
    }

    /** @return list<array{name:string,body:string,year:string}> */
    public function getCertifications(): array
    {
        return $this->certifications ?? [];
    }

    /** @param list<array{name:string,body:string,year:string}> $entries */
    public function setCertifications(array $entries): void
    {
        $this->certifications = $entries !== [] ? array_values($entries) : null;
    }

    public function getMdcnNumber(): ?string
    {
        return $this->mdcnNumber;
    }

    public function setMdcnNumber(?string $number): void
    {
        $number           = $number !== null ? strtoupper(trim($number)) : null;
        $this->mdcnNumber = $number !== '' ? $number : null;
    }

    public function getWebOrigin(): ?string
    {
        return $this->webOrigin;
    }

    public function setWebOrigin(?string $origin): void
    {
        $this->webOrigin = $origin !== null && $origin !== '' ? $origin : null;
    }

    public function getSignatureKey(): ?string
    {
        return $this->signatureKey;
    }

    public function setSignatureKey(?string $key): void
    {
        $this->signatureKey = $key;
    }

    public function getQualifications(): ?string
    {
        return $this->qualifications;
    }

    public function getSlotMinutes(): int
    {
        return $this->slotMinutes > 0 ? $this->slotMinutes : 30;
    }

    public function setSlotMinutes(int $minutes): void
    {
        $this->slotMinutes = in_array($minutes, [15, 30, 45, 60], true) ? $minutes : 30;
    }

    /** The effective onboarding status — a legacy NULL reads as approved. */
    public function getStatus(): SpecialistStatus
    {
        return $this->status ?? SpecialistStatus::APPROVED;
    }

    public function setStatus(SpecialistStatus $status): void
    {
        $this->status = $status;
    }

    /** Approved (or legacy) — may be listed in the directory. */
    public function isApproved(): bool
    {
        return SpecialistStatus::isListable($this->status);
    }

    /** Approved AND switched on for bookings by the admin. */
    public function isBookable(): bool
    {
        return $this->isApproved() && $this->available;
    }

    public function getRejectionReason(): ?string
    {
        return $this->rejectionReason;
    }

    public function getSubmittedAt(): ?DateTimeImmutable
    {
        return $this->submittedAt;
    }

    public function getApprovedAt(): ?DateTimeImmutable
    {
        return $this->approvedAt;
    }

    /** The doctor sends their finished profile to an admin for review. */
    public function submitForReview(?DateTimeImmutable $now = null): void
    {
        $this->status          = SpecialistStatus::PENDING_REVIEW;
        $this->submittedAt     = $now ?? new DateTimeImmutable();
        $this->rejectionReason = null;
    }

    /** An admin approves the doctor: listed, bookable, and shown as verified. */
    public function approve(?string $approvedBy, ?DateTimeImmutable $now = null): void
    {
        $this->status          = SpecialistStatus::APPROVED;
        $this->approvedAt      = $now ?? new DateTimeImmutable();
        $this->approvedBy      = $approvedBy;
        $this->rejectionReason = null;
        $this->verified        = true;
    }

    /** An admin sends the profile back with a reason the doctor will see. */
    public function reject(string $reason): void
    {
        $this->status          = SpecialistStatus::REJECTED;
        $this->rejectionReason = trim($reason);
        $this->approvedAt      = null;
        $this->approvedBy      = null;
    }

    /** "Verified" on the public profile: approved, and not marked unverified before approval existed. */
    public function isVerified(): bool
    {
        return $this->isApproved() && $this->verified;
    }

    /** A legacy doctor's MDCN certificate and licence were verified: they read as verified again. */
    public function markVerified(): void
    {
        $this->verified = true;
    }

    // ----- Locked fields + change review -----

    /** Approved (or legacy) or suspended — they have practised here, so their identity fields are locked. */
    public function hasLockedFields(): bool
    {
        $status = $this->getStatus();

        return $status === SpecialistStatus::APPROVED || $status === SpecialistStatus::SUSPENDED;
    }

    /**
     * The locked fields' current values, keyed as the API names them.
     *
     * @return array<string,mixed>
     */
    public function lockedValues(): array
    {
        return [
            'name'                  => $this->name,
            'specialty'             => $this->specialty,
            'mdcn_number'           => $this->mdcnNumber,
            'qualifications'        => $this->qualifications,
            'qualification_entries' => $this->getQualificationEntries(),
            'certifications'        => $this->getCertifications(),
        ];
    }

    /**
     * Set locked fields (values already validated and normalised). Unknown
     * keys are ignored.
     *
     * @param array<string,mixed> $values
     */
    public function applyLockedValues(array $values): void
    {
        foreach ($values as $key => $value) {
            match ($key) {
                'name'                  => $this->setName((string) $value),
                'specialty'             => $this->setSpecialty((string) $value),
                'mdcn_number'           => $this->setMdcnNumber($value !== null ? (string) $value : null),
                'qualifications'        => $this->setQualifications($value !== null ? (string) $value : null),
                'qualification_entries' => $this->setQualificationEntries(is_array($value) ? array_values($value) : []),
                'certifications'        => $this->setCertifications(is_array($value) ? array_values($value) : []),
                default                 => null,
            };
        }
    }

    /**
     * Edits to locked fields waiting for review, keyed like {@see lockedValues()}.
     *
     * @return array<string,mixed>
     */
    public function getPendingFields(): array
    {
        $fields = $this->pendingChanges['fields'] ?? null;

        return is_array($fields) ? $fields : [];
    }

    /** When the doctor last sent a change for review, or null. */
    public function getPendingChangesSubmittedAt(): ?string
    {
        $at = $this->pendingChanges['submitted_at'] ?? null;

        return is_string($at) ? $at : null;
    }

    /**
     * Stage the doctor's edits to locked fields for review. A value that reads
     * the same as the current one ({@see comparable()}: entry key order,
     * spacing and blank rows aside) drops out of the change set (an edit
     * undone, or no edit at all); the set is
     * cleared once nothing differs. Returns whether anything new is now waiting
     * (so reviewers are told only then).
     *
     * @param array<string,mixed> $values normalised values keyed by LOCKED_FIELDS
     */
    public function stageChanges(array $values, ?DateTimeImmutable $now = null): bool
    {
        $fields  = $this->getPendingFields();
        $current = $this->lockedValues();
        $changed = false;
        foreach ($values as $key => $value) {
            if (!in_array($key, self::LOCKED_FIELDS, true)) {
                continue;
            }
            $wanted = self::comparable($key, $value);
            if ($wanted === self::comparable($key, $current[$key])) {
                unset($fields[$key]);
                continue;
            }
            if (!array_key_exists($key, $fields) || self::comparable($key, $fields[$key]) !== $wanted) {
                $changed = true;
            }
            $fields[$key] = $value;
        }

        if ($fields === []) {
            $this->pendingChanges = null;

            return false;
        }
        $this->pendingChanges = [
            'fields'       => $fields,
            'submitted_at' => $changed || $this->getPendingChangesSubmittedAt() === null
                ? ($now ?? new DateTimeImmutable())->format(DATE_ATOM)
                : $this->getPendingChangesSubmittedAt(),
        ];
        if ($changed) {
            $this->changesReviewNote = null;
        }

        return $changed;
    }

    /**
     * A locked field's value as the reader sees it — what decides whether an
     * edit changes anything: entries become rows of exactly their fields in a
     * fixed order (a JSON column may hand keys back in another order, and a
     * legacy row may lack one), trimmed, blank rows dropped; other values are
     * trimmed strings, null reading as ''.
     */
    private static function comparable(string $key, mixed $value): mixed
    {
        $columns = match ($key) {
            'qualification_entries' => ['title', 'institution', 'year'],
            'certifications'        => ['name', 'body', 'year'],
            default                 => null,
        };
        if ($columns === null) {
            return is_scalar($value) ? trim((string) $value) : '';
        }

        $rows = [];
        foreach (is_array($value) ? $value : [] as $row) {
            if (!is_array($row)) {
                continue;
            }
            $cells = array_map(
                static fn (string $column): string => is_scalar($row[$column] ?? null) ? trim((string) $row[$column]) : '',
                $columns,
            );
            if (implode('', $cells) !== '') {
                $rows[] = $cells;
            }
        }

        return $rows;
    }

    /**
     * A reviewer approved the waiting changes: apply them. Returns the values
     * they replaced, keyed like the change set (for the audit's before/after).
     *
     * @return array<string,mixed>
     */
    public function approvePendingChanges(): array
    {
        $fields  = $this->getPendingFields();
        $current = $this->lockedValues();
        $before  = array_intersect_key($current, $fields);
        $this->applyLockedValues($fields);
        $this->pendingChanges    = null;
        $this->changesReviewNote = null;

        return $before;
    }

    /** A reviewer turned the waiting changes down, with a reason the doctor sees. */
    public function rejectPendingChanges(string $reason): void
    {
        $this->pendingChanges    = null;
        $this->changesReviewNote = trim($reason);
    }

    /** The doctor withdraws their waiting changes. */
    public function clearPendingChanges(): void
    {
        $this->pendingChanges = null;
    }

    public function getChangesReviewNote(): ?string
    {
        return $this->changesReviewNote;
    }

    /** @return array<string,mixed>|null */
    public function getApprovedSnapshot(): ?array
    {
        return $this->approvedSnapshot;
    }

    /**
     * Record what was approved (now, or after a change review).
     *
     * @param list<string> $credentialIds the verified documents it rests on
     */
    public function snapshotApproval(array $credentialIds, ?string $approverId, string $approverName, ?DateTimeImmutable $at = null): void
    {
        $this->approvedSnapshot = $this->lockedValues() + [
            'credential_ids'   => array_values($credentialIds),
            'approved_by'      => $approverId,
            'approved_by_name' => $approverName,
            'approved_at'      => ($at ?? new DateTimeImmutable())->format(DATE_ATOM),
        ];
    }

    // ----- Practitioner terms -----

    public function hasAcceptedTerms(string $version): bool
    {
        return $this->termsVersion !== null && $this->termsVersion === $version;
    }

    public function acceptTerms(string $version, ?string $ip, ?DateTimeImmutable $now = null): void
    {
        $ip                    = $ip !== null ? trim($ip) : '';
        $this->termsVersion    = $version;
        $this->termsAcceptedAt = $now ?? new DateTimeImmutable();
        $this->termsAcceptedIp = $ip !== '' ? mb_substr($ip, 0, 45) : null;
    }

    public function getTermsVersion(): ?string
    {
        return $this->termsVersion;
    }

    public function getTermsAcceptedAt(): ?DateTimeImmutable
    {
        return $this->termsAcceptedAt;
    }

    public function getTermsAcceptedIp(): ?string
    {
        return $this->termsAcceptedIp;
    }

    // ----- Suspension -----

    public function isSuspended(): bool
    {
        return $this->status === SpecialistStatus::SUSPENDED;
    }

    /** The doctor stopped practising here: unlisted, no clinical work (see SpecialistSuspensionService). */
    public function suspend(string $code, string $reason, ?string $by, ?DateTimeImmutable $now = null): void
    {
        $this->status           = SpecialistStatus::SUSPENDED;
        $this->suspendedAt      = $now ?? new DateTimeImmutable();
        $this->suspendedBy      = $by !== null && Uuid::isValid($by) ? $by : null;
        $this->suspensionCode   = $code;
        $this->suspensionReason = trim($reason);
    }

    /** Back to approved; the suspension stays in the status history only. */
    public function reinstate(): void
    {
        $this->status           = SpecialistStatus::APPROVED;
        $this->suspendedAt      = null;
        $this->suspendedBy      = null;
        $this->suspensionCode   = null;
        $this->suspensionReason = null;
    }

    public function getSuspensionCode(): ?string
    {
        return $this->suspensionCode;
    }

    public function getSuspensionReason(): ?string
    {
        return $this->suspensionReason;
    }

    public function getSuspendedAt(): ?DateTimeImmutable
    {
        return $this->suspendedAt;
    }

    // ----- Licence + credentials due -----

    public function getLicenceExpiresAt(): ?DateTimeImmutable
    {
        return $this->licenceExpiresAt;
    }

    public function setLicenceExpiresAt(?DateTimeImmutable $date): void
    {
        $this->licenceExpiresAt = $date;
    }

    public function getCredentialsDueAt(): ?DateTimeImmutable
    {
        return $this->credentialsDueAt;
    }

    public function setCredentialsDueAt(?DateTimeImmutable $date): void
    {
        $this->credentialsDueAt = $date;
        if ($date === null) {
            $this->credentialsReminderStage = null;
        }
    }

    public function getCredentialsReminderStage(): ?int
    {
        return $this->credentialsReminderStage;
    }

    public function setCredentialsReminderStage(?int $stage): void
    {
        $this->credentialsReminderStage = $stage;
    }

    /**
     * Review fields for the back office and the doctor's own onboarding page.
     * Never part of the public payload.
     *
     * @return array<string,mixed>
     */
    public function toReviewArray(): array
    {
        $status = $this->getStatus();

        return [
            'status'              => $status->value,
            'status_label'        => $status->label(),
            'rejection_reason'    => $this->rejectionReason,
            'submitted_at'        => $this->submittedAt?->format(DATE_ATOM),
            'approved_at'         => $this->approvedAt?->format(DATE_ATOM),
            'suspended_at'        => $this->suspendedAt?->format(DATE_ATOM),
            'suspension_code'     => $this->suspensionCode,
            'suspension_reason'   => $this->suspensionReason,
            'licence_expires_at'  => $this->licenceExpiresAt?->format('Y-m-d'),
            'credentials_due_at'  => $this->credentialsDueAt?->format('Y-m-d'),
            'has_pending_changes' => $this->getPendingFields() !== [],
            'terms_version'       => $this->termsVersion,
            'terms_accepted_at'   => $this->termsAcceptedAt?->format(DATE_ATOM),
        ];
    }

    public function toArray(): array
    {
        return [
            'id'               => $this->id,
            'name'             => $this->name,
            'specialty'        => $this->specialty,
            'location'         => $this->location,
            'country'          => $this->country,
            'consultation_fee' => $this->consultationFee,
            'rating'           => $this->rating,
            'reviews_count'    => $this->reviewsCount,
            'available'        => $this->available,
            'years_experience' => $this->yearsExperience,
            'languages'        => $this->languages,
            'verified'         => $this->isVerified(),
            'gender'           => $this->gender,
            'offers_in_person' => $this->offersInPerson,
            'photo_url'        => $this->photoUrl,
            'bio'              => $this->bio,
            'qualifications'   => $this->qualifications,
            'expertise'        => $this->getExpertise(),
            'qualification_entries' => $this->getQualificationEntries(),
            'certifications'   => $this->getCertifications(),
            'slot_minutes'     => $this->getSlotMinutes(),
        ];
    }

    /**
     * The authenticated doctor's own profile — the public {@see toArray} plus the
     * personal fields (phone, date of birth) that must never appear in the public
     * directory, and which identity fields are locked / waiting for review.
     *
     * @return array<string,mixed>
     */
    public function toPrivateArray(): array
    {
        $pending = $this->getPendingFields();

        return $this->toArray() + [
            'email'           => $this->email,
            'phone'           => $this->phone,
            'date_of_birth'   => $this->dateOfBirth?->format('Y-m-d'),
            'weekly_hours'    => $this->weeklyHours,
            'mdcn_number'     => $this->mdcnNumber,
            'has_signature'   => $this->signatureKey !== null,
            'locked_fields'   => $this->hasLockedFields() ? self::LOCKED_FIELDS : [],
            'pending_changes' => $pending !== [] ? $pending : null,
            'pending_changes_submitted_at' => $pending !== [] ? $this->getPendingChangesSubmittedAt() : null,
            'changes_review_note' => $this->changesReviewNote,
        ];
    }
}
