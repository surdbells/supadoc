<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use App\Domain\Enum\DoctorApplicationStatus;
use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/**
 * A doctor's application to join VideoMed (spec §2.2): a draft the applicant
 * builds without an account (resumed by an emailed link or a 6-character
 * code), then — once submitted with a reference — reviewed in the back office
 * until approved (a doctor login and profile are created), rejected or
 * withdrawn.
 *
 * The form lives in `sections` (keyed by section, spec §2.11); the fields the
 * back office lists, searches and filters on are promoted to columns. Codes and
 * tokens are stored only as hashes. One open application per email is enforced
 * by the partial unique index `uniq_doctor_applications_open_email`
 * (RawIndexes) behind the submit lock. Every instant is on the process clock;
 * an interview's instant is also kept as epoch seconds.
 */
#[ORM\Entity]
#[ORM\Table(name: 'doctor_applications')]
#[ORM\UniqueConstraint(name: 'uniq_doctor_applications_reference', columns: ['reference'])]
#[ORM\UniqueConstraint(name: 'uniq_doctor_applications_specialist', columns: ['specialist_id'])]
#[ORM\Index(name: 'idx_doctor_applications_status_submitted', columns: ['status', 'submitted_at'])]
#[ORM\Index(name: 'idx_doctor_applications_email', columns: ['email'])]
#[ORM\Index(name: 'idx_doctor_applications_awaiting', columns: ['awaiting_staff', 'status'])]
#[ORM\Index(name: 'idx_doctor_applications_draft_expiry', columns: ['draft_expires_at'])]
#[ORM\HasLifecycleCallbacks]
class DoctorApplication
{
    use TimestampsTrait;

    public const ROUTES = ['ng', 'abroad'];

    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(type: 'string', length: 24, enumType: DoctorApplicationStatus::class, options: ['default' => 'draft'])]
    private DoctorApplicationStatus $status = DoctorApplicationStatus::DRAFT;

    #[ORM\Column(name: 'licence_route', type: 'string', length: 10)]
    private string $licenceRoute;

    #[ORM\Column(type: 'string', length: 20, nullable: true)]
    private ?string $reference = null;

    /** Trimmed and lower-cased. */
    #[ORM\Column(type: 'string', length: 254)]
    private string $email;

    #[ORM\Column(name: 'email_verified_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $emailVerifiedAt = null;

    /** E.164. */
    #[ORM\Column(type: 'string', length: 20, nullable: true)]
    private ?string $phone = null;

    #[ORM\Column(name: 'first_name', type: 'string', length: 100, nullable: true)]
    private ?string $firstName = null;

    #[ORM\Column(name: 'last_name', type: 'string', length: 100, nullable: true)]
    private ?string $lastName = null;

    /** The specialty list's label, in its spelling. */
    #[ORM\Column(type: 'string', length: 120, nullable: true)]
    private ?string $specialty = null;

    #[ORM\Column(name: 'residence_country', type: 'string', length: 2, nullable: true)]
    private ?string $residenceCountry = null;

    #[ORM\Column(name: 'mdcn_number', type: 'string', length: 40, nullable: true)]
    private ?string $mdcnNumber = null;

    /** Nigeria route: the annual practising licence's expiry. */
    #[ORM\Column(name: 'licence_expires_on', type: 'date_immutable', nullable: true)]
    private ?DateTimeImmutable $licenceExpiresOn = null;

    #[ORM\Column(name: 'regulator_country', type: 'string', length: 2, nullable: true)]
    private ?string $regulatorCountry = null;

    #[ORM\Column(name: 'regulator_name', type: 'string', length: 150, nullable: true)]
    private ?string $regulatorName = null;

    #[ORM\Column(name: 'registration_number', type: 'string', length: 40, nullable: true)]
    private ?string $registrationNumber = null;

    #[ORM\Column(name: 'good_standing_issued_on', type: 'date_immutable', nullable: true)]
    private ?DateTimeImmutable $goodStandingIssuedOn = null;

    /** @var array<string, mixed> section => values */
    #[ORM\Column(type: 'json', options: ['jsonb' => true])]
    private array $sections = [];

    /**
     * Consent evidence: {accept_terms, authorise_verification, confirm_accurate,
     * signature_name, consent_version, consented_at, consent_ip, user_agent}.
     *
     * @var array<string,mixed>|null
     */
    #[ORM\Column(type: 'json', nullable: true)]
    private ?array $consent = null;

    #[ORM\Column(name: 'draft_code_hash', type: 'string', length: 64, nullable: true)]
    private ?string $draftCodeHash = null;

    #[ORM\Column(name: 'draft_code_issued_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $draftCodeIssuedAt = null;

    #[ORM\Column(name: 'resume_token_hash', type: 'string', length: 64, nullable: true)]
    private ?string $resumeTokenHash = null;

    #[ORM\Column(name: 'resume_token_expires_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $resumeTokenExpiresAt = null;

    #[ORM\Column(name: 'last_saved_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $lastSavedAt = null;

    #[ORM\Column(name: 'draft_expires_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $draftExpiresAt = null;

    /** The onboarding site it was started on (WebUrls::matchOnboarding). */
    #[ORM\Column(name: 'web_origin', type: 'string', length: 255, nullable: true)]
    private ?string $webOrigin = null;

    #[ORM\Column(name: 'submitted_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $submittedAt = null;

    #[ORM\Column(name: 'review_started_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $reviewStartedAt = null;

    #[ORM\Column(name: 'review_started_by_name', type: 'string', length: 200, nullable: true)]
    private ?string $reviewStartedByName = null;

    #[ORM\Column(name: 'decided_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $decidedAt = null;

    #[ORM\Column(name: 'decided_by_id', type: 'uuid', nullable: true)]
    private ?string $decidedById = null;

    #[ORM\Column(name: 'decided_by_name', type: 'string', length: 200, nullable: true)]
    private ?string $decidedByName = null;

    #[ORM\Column(name: 'last_applicant_reply_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $lastApplicantReplyAt = null;

    /** Waiting on a reviewer ("Needs action"). */
    #[ORM\Column(name: 'awaiting_staff', type: 'boolean', options: ['default' => false])]
    private bool $awaitingStaff = false;

    #[ORM\Column(name: 'interview_starts_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $interviewStartsAt = null;

    /** The interview's instant, authoritative (epoch seconds). */
    #[ORM\Column(name: 'interview_epoch', type: 'bigint', nullable: true)]
    private int|string|null $interviewEpoch = null;

    #[ORM\Column(name: 'interview_duration_minutes', type: 'smallint', nullable: true)]
    private ?int $interviewDurationMinutes = null;

    #[ORM\Column(name: 'interview_meeting_url', type: 'string', length: 500, nullable: true)]
    private ?string $interviewMeetingUrl = null;

    #[ORM\Column(name: 'interview_note', type: 'string', length: 500, nullable: true)]
    private ?string $interviewNote = null;

    #[ORM\Column(name: 'interview_notified_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $interviewNotifiedAt = null;

    /** Shown to the applicant. */
    #[ORM\Column(name: 'reject_reason', type: 'text', nullable: true)]
    private ?string $rejectReason = null;

    #[ORM\Column(name: 'withdraw_reason', type: 'string', length: 40, nullable: true)]
    private ?string $withdrawReason = null;

    #[ORM\Column(name: 'specialist_id', type: 'uuid', nullable: true)]
    private ?string $specialistId = null;

    /** @var array<string,mixed>|null {locked, credential_ids, consultation_fee, specialty, approved_by_id, approved_by_name, approved_at} */
    #[ORM\Column(name: 'approval_snapshot', type: 'json', nullable: true)]
    private ?array $approvalSnapshot = null;

    public function __construct(string $licenceRoute, string $email)
    {
        $this->id           = Uuid::uuid4()->toString();
        $this->licenceRoute = in_array($licenceRoute, self::ROUTES, true) ? $licenceRoute : 'ng';
        $this->email        = strtolower(trim($email));
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function getStatus(): DoctorApplicationStatus
    {
        return $this->status;
    }

    public function setStatus(DoctorApplicationStatus $status): void
    {
        $this->status = $status;
    }

    public function isDraft(): bool
    {
        return $this->status === DoctorApplicationStatus::DRAFT;
    }

    public function getLicenceRoute(): string
    {
        return $this->licenceRoute;
    }

    public function setLicenceRoute(string $route): void
    {
        $this->licenceRoute = in_array($route, self::ROUTES, true) ? $route : 'ng';
    }

    public function getReference(): ?string
    {
        return $this->reference;
    }

    public function setReference(?string $reference): void
    {
        $this->reference = $reference;
    }

    public function getEmail(): string
    {
        return $this->email;
    }

    /**
     * Changing the address forgets that the old one was proven, and kills the
     * draft code and resume link mailed to it: neither may prove the new one
     * (D10). Nothing new is issued or sent here (D31).
     */
    public function setEmail(string $email): void
    {
        $email = strtolower(trim($email));
        if ($email !== $this->email) {
            $this->emailVerifiedAt = null;
            $this->setResumeSecrets(null, null, null, null);
        }
        $this->email = $email;
    }

    public function getEmailVerifiedAt(): ?DateTimeImmutable
    {
        return $this->emailVerifiedAt;
    }

    public function isEmailVerified(): bool
    {
        return $this->emailVerifiedAt !== null;
    }

    public function markEmailVerified(DateTimeImmutable $at): void
    {
        $this->emailVerifiedAt = $at;
    }

    public function getPhone(): ?string
    {
        return $this->phone;
    }

    public function setPhone(?string $phone): void
    {
        $this->phone = $phone !== null && $phone !== '' ? $phone : null;
    }

    public function getFirstName(): ?string
    {
        return $this->firstName;
    }

    public function getLastName(): ?string
    {
        return $this->lastName;
    }

    public function setNames(?string $first, ?string $last): void
    {
        $this->firstName = $first !== null && $first !== '' ? mb_substr($first, 0, 100) : $this->firstName;
        $this->lastName  = $last !== null && $last !== '' ? mb_substr($last, 0, 100) : $this->lastName;
    }

    /** "First Last", or '' before step 1 is saved. */
    public function fullName(): string
    {
        return trim(($this->firstName ?? '') . ' ' . ($this->lastName ?? ''));
    }

    public function getSpecialty(): ?string
    {
        return $this->specialty;
    }

    public function setSpecialty(?string $specialty): void
    {
        $this->specialty = $specialty !== null && $specialty !== '' ? mb_substr($specialty, 0, 120) : null;
    }

    public function getResidenceCountry(): ?string
    {
        return $this->residenceCountry;
    }

    public function setResidenceCountry(?string $iso2): void
    {
        $this->residenceCountry = $iso2 !== null && strlen($iso2) === 2 ? $iso2 : null;
    }

    public function getMdcnNumber(): ?string
    {
        return $this->mdcnNumber;
    }

    public function getLicenceExpiresOn(): ?DateTimeImmutable
    {
        return $this->licenceExpiresOn;
    }

    public function getRegulatorCountry(): ?string
    {
        return $this->regulatorCountry;
    }

    public function getRegulatorName(): ?string
    {
        return $this->regulatorName;
    }

    public function getRegistrationNumber(): ?string
    {
        return $this->registrationNumber;
    }

    public function getGoodStandingIssuedOn(): ?DateTimeImmutable
    {
        return $this->goodStandingIssuedOn;
    }

    /** The promoted licence columns of the Nigeria route. */
    public function setNgLicence(?string $mdcnNumber, ?DateTimeImmutable $expiresOn): void
    {
        $this->mdcnNumber       = $mdcnNumber !== null && $mdcnNumber !== '' ? mb_substr($mdcnNumber, 0, 40) : null;
        $this->licenceExpiresOn = $expiresOn;
    }

    /** The promoted licence columns of the abroad route. */
    public function setAbroadLicence(?string $country, ?string $regulator, ?string $number, ?DateTimeImmutable $goodStandingIssuedOn): void
    {
        $this->regulatorCountry     = $country !== null && strlen($country) === 2 ? $country : null;
        $this->regulatorName        = $regulator !== null && $regulator !== '' ? mb_substr($regulator, 0, 150) : null;
        $this->registrationNumber   = $number !== null && $number !== '' ? mb_substr($number, 0, 40) : null;
        $this->goodStandingIssuedOn = $goodStandingIssuedOn;
    }

    /** Forget every licence detail (the route changed on a draft). */
    public function clearLicence(): void
    {
        unset($this->sections['licence']);
        $this->setNgLicence(null, null);
        $this->setAbroadLicence(null, null, null, null);
    }

    /** @return array<string,mixed>|null */
    public function section(string $key): ?array
    {
        $values = $this->sections[$key] ?? null;

        return is_array($values) ? $values : null;
    }

    /** @return array<string,mixed> */
    public function getSections(): array
    {
        return $this->sections;
    }

    /** @param array<string,mixed>|null $values */
    public function setSection(string $key, ?array $values): void
    {
        $sections = $this->sections;
        if ($values === null) {
            unset($sections[$key]);
        } else {
            $sections[$key] = $values;
        }
        $this->sections = $sections; // a new array, so Doctrine sees the change
    }

    /** @return array<string,mixed>|null */
    public function getConsent(): ?array
    {
        return $this->consent;
    }

    /** @param array<string,mixed>|null $consent */
    public function setConsent(?array $consent): void
    {
        $this->consent = $consent;
    }

    // ----- Draft code + resume link (hashes only) -----

    public function getDraftCodeHash(): ?string
    {
        return $this->draftCodeHash;
    }

    public function getResumeTokenHash(): ?string
    {
        return $this->resumeTokenHash;
    }

    public function getResumeTokenExpiresAt(): ?DateTimeImmutable
    {
        return $this->resumeTokenExpiresAt;
    }

    public function setResumeSecrets(?string $codeHash, ?string $tokenHash, ?DateTimeImmutable $issuedAt, ?DateTimeImmutable $tokenExpiresAt): void
    {
        $this->draftCodeHash        = $codeHash;
        $this->draftCodeIssuedAt    = $codeHash !== null ? $issuedAt : null;
        $this->resumeTokenHash      = $tokenHash;
        $this->resumeTokenExpiresAt = $tokenHash !== null ? $tokenExpiresAt : null;
    }

    public function getLastSavedAt(): ?DateTimeImmutable
    {
        return $this->lastSavedAt;
    }

    public function getDraftExpiresAt(): ?DateTimeImmutable
    {
        return $this->draftExpiresAt;
    }

    /** A draft save: keeps it 30 more days. */
    public function touchDraft(DateTimeImmutable $now, int $ttlDays): void
    {
        $this->lastSavedAt    = $now;
        $this->draftExpiresAt = $now->modify('+' . $ttlDays . ' days');
    }

    public function isExpiredDraft(DateTimeImmutable $now): bool
    {
        return $this->isDraft() && $this->draftExpiresAt !== null && $this->draftExpiresAt < $now;
    }

    public function getWebOrigin(): ?string
    {
        return $this->webOrigin;
    }

    public function setWebOrigin(?string $origin): void
    {
        $this->webOrigin = $origin !== null && $origin !== '' ? mb_substr($origin, 0, 255) : null;
    }

    // ----- Review lifecycle -----

    /** Submitted: the reference is set, the draft's secrets and expiry are gone. */
    public function markSubmitted(string $reference, DateTimeImmutable $now): void
    {
        $this->status    = DoctorApplicationStatus::SUBMITTED;
        $this->reference = $reference;
        $this->submittedAt = $now;
        $this->awaitingStaff = true;
        $this->setResumeSecrets(null, null, null, null);
        $this->draftExpiresAt = null;
    }

    public function getSubmittedAt(): ?DateTimeImmutable
    {
        return $this->submittedAt;
    }

    public function getReviewStartedAt(): ?DateTimeImmutable
    {
        return $this->reviewStartedAt;
    }

    public function getReviewStartedByName(): ?string
    {
        return $this->reviewStartedByName;
    }

    /** Returns whether this was the first time (the applicant is told only then). */
    public function markReviewStarted(DateTimeImmutable $now, string $byName): bool
    {
        if ($this->reviewStartedAt !== null) {
            return false;
        }
        $this->reviewStartedAt     = $now;
        $this->reviewStartedByName = mb_substr($byName, 0, 200);

        return true;
    }

    public function getDecidedAt(): ?DateTimeImmutable
    {
        return $this->decidedAt;
    }

    public function getDecidedById(): ?string
    {
        return $this->decidedById;
    }

    public function getDecidedByName(): ?string
    {
        return $this->decidedByName;
    }

    public function markDecided(DateTimeImmutable $now, ?string $byId, ?string $byName): void
    {
        $this->decidedAt     = $now;
        $this->decidedById   = $byId !== null && Uuid::isValid($byId) ? $byId : null;
        $this->decidedByName = $byName !== null ? mb_substr($byName, 0, 200) : null;
    }

    public function getLastApplicantReplyAt(): ?DateTimeImmutable
    {
        return $this->lastApplicantReplyAt;
    }

    public function setLastApplicantReplyAt(DateTimeImmutable $at): void
    {
        $this->lastApplicantReplyAt = $at;
    }

    public function isAwaitingStaff(): bool
    {
        return $this->awaitingStaff;
    }

    public function setAwaitingStaff(bool $awaiting): void
    {
        $this->awaitingStaff = $awaiting;
    }

    // ----- Interview -----

    public function hasInterview(): bool
    {
        return $this->interviewEpoch !== null;
    }

    public function getInterviewStartsAt(): ?DateTimeImmutable
    {
        return $this->interviewStartsAt;
    }

    public function getInterviewEpoch(): ?int
    {
        return $this->interviewEpoch !== null ? (int) $this->interviewEpoch : null;
    }

    public function getInterviewDurationMinutes(): ?int
    {
        return $this->interviewDurationMinutes;
    }

    public function getInterviewMeetingUrl(): ?string
    {
        return $this->interviewMeetingUrl;
    }

    public function getInterviewNote(): ?string
    {
        return $this->interviewNote;
    }

    public function getInterviewNotifiedAt(): ?DateTimeImmutable
    {
        return $this->interviewNotifiedAt;
    }

    public function scheduleInterview(DateTimeImmutable $startsAt, int $minutes, string $meetingUrl, ?string $note): void
    {
        $this->interviewStartsAt        = $startsAt; // stored on the process clock by the column type
        $this->interviewEpoch           = $startsAt->getTimestamp();
        $this->interviewDurationMinutes = $minutes;
        $this->interviewMeetingUrl      = mb_substr($meetingUrl, 0, 500);
        $this->interviewNote            = $note !== null && trim($note) !== '' ? mb_substr(trim($note), 0, 500) : null;
    }

    public function clearInterview(): void
    {
        $this->interviewStartsAt        = null;
        $this->interviewEpoch           = null;
        $this->interviewDurationMinutes = null;
        $this->interviewMeetingUrl      = null;
        $this->interviewNote            = null;
        $this->interviewNotifiedAt      = null;
    }

    public function markInterviewNotified(DateTimeImmutable $at): void
    {
        $this->interviewNotifiedAt = $at;
    }

    // ----- Outcome -----

    public function getRejectReason(): ?string
    {
        return $this->rejectReason;
    }

    public function setRejectReason(?string $reason): void
    {
        $this->rejectReason = $reason;
    }

    public function getWithdrawReason(): ?string
    {
        return $this->withdrawReason;
    }

    public function setWithdrawReason(?string $reason): void
    {
        $this->withdrawReason = $reason;
    }

    public function getSpecialistId(): ?string
    {
        return $this->specialistId;
    }

    public function setSpecialistId(?string $id): void
    {
        $this->specialistId = $id;
    }

    /** @return array<string,mixed>|null */
    public function getApprovalSnapshot(): ?array
    {
        return $this->approvalSnapshot;
    }

    /** @param array<string,mixed>|null $snapshot */
    public function setApprovalSnapshot(?array $snapshot): void
    {
        $this->approvalSnapshot = $snapshot;
    }
}
