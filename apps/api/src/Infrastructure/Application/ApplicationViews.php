<?php

declare(strict_types=1);

namespace App\Infrastructure\Application;

use App\Domain\Application\ApplicantContact;
use App\Domain\Application\ApplicationDocuments;
use App\Domain\Application\ApplicationSections;
use App\Domain\Application\ApplicationStateMachine;
use App\Domain\Application\ApplicationTimeline;
use App\Domain\Application\ApprovalInput;
use App\Domain\Contact\Countries;
use App\Domain\Entity\DoctorApplication;
use App\Domain\Entity\DoctorApplicationDocument;
use App\Domain\Entity\DoctorApplicationEvent;
use App\Domain\Entity\DoctorApplicationInfoRequest;
use App\Domain\Entity\Specialist;
use App\Domain\Enum\DoctorApplicationStatus;
use App\Domain\Reference\ReferenceCategory;
use App\Domain\Repository\DoctorApplicationDocumentRepository;
use App\Domain\Repository\DoctorApplicationEventRepository;
use App\Domain\Repository\DoctorApplicationInfoRequestRepository;
use App\Domain\Repository\DoctorApplicationNoteRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Domain\Settings\ClinicTime;
use App\Domain\Settings\WebUrls;
use App\Infrastructure\Service\DoctorOnboardingService;
use App\Infrastructure\Service\ReferenceDataService;
use DateTimeImmutable;

/**
 * The JSON shapes of the doctor-application endpoints — exactly the
 * TypeScript contract (libs/shared/models/src/lib/doctor-application.ts):
 * the applicant's draft, status and application; the back office's row,
 * detail and approval preview. Read-only.
 */
final class ApplicationViews
{
    /** WithdrawReason => WITHDRAW_REASON_LABELS. */
    public const WITHDRAW_REASONS = [
        'accepted_other_role' => "I've accepted another role",
        'apply_later'         => 'I want to apply later',
        'made_mistake'        => 'I made a mistake in my application',
        'not_right_for_me'    => "VideoMed isn't right for me",
        'other'               => 'Other',
    ];

    /** The labels of the sections a reviewer may ask about. */
    public const SECTION_LABELS = [
        'personal'       => 'Personal details',
        'professional'   => 'Professional details',
        'licence'        => 'Licence',
        'qualifications' => 'Qualifications',
        'indemnity'      => 'Indemnity',
    ];

    public function __construct(
        private readonly DoctorApplicationDocumentRepository $documents,
        private readonly DoctorApplicationEventRepository $events,
        private readonly DoctorApplicationInfoRequestRepository $requests,
        private readonly DoctorApplicationNoteRepository $notes,
        private readonly SpecialistRepository $specialists,
        private readonly UserRepository $users,
        private readonly ReferenceDataService $reference,
        private readonly DoctorOnboardingService $onboarding,
    ) {
    }

    /** The specialty list as a resolver (typed value → the list's label, or null). @return callable(string): ?string */
    public function specialtyResolver(): callable
    {
        return fn (string $value): ?string => $this->reference->resolveChoice(ReferenceCategory::SPECIALTY, $value);
    }

    // ----- Applicant -----

    /** ApplicationDocumentDto (`$staff` adds credential_id + sha256). @return array<string,mixed> */
    public static function document(DoctorApplicationDocument $doc, string $route, bool $staff = false): array
    {
        $out = [
            'id'              => $doc->getId(),
            'slot'            => $doc->getSlot(),
            'slot_label'      => $doc->getSlot() === ApplicationDocuments::ADDITIONAL && $doc->getLabel() !== null
                ? $doc->getLabel()
                : ApplicationDocuments::label($doc->getSlot(), $route),
            'label'           => $doc->getLabel(),
            'original_name'   => $doc->getOriginalName(),
            'mime'            => $doc->getMime(),
            'size_bytes'      => $doc->getSizeBytes(),
            'state'           => $doc->getState(),
            'uploaded_during' => $doc->getUploadedDuring(),
            'uploaded_at'     => $doc->getCreatedAt()->format(DATE_ATOM),
        ];
        if ($staff) {
            $out['credential_id'] = $doc->getCredentialId();
            $out['sha256']        = $doc->getSha256();
        }

        return $out;
    }

    /** The six sections, each null until saved; consent without its evidence. @return array<string, mixed> */
    public static function sections(DoctorApplication $app): array
    {
        $out = [];
        foreach (ApplicationSections::SECTIONS as $key) {
            $values = $app->section($key);
            if ($key === 'consent' && $values !== null) {
                unset($values['consent_ip'], $values['user_agent']);
            }
            $out[$key] = $values;
        }

        return $out;
    }

    /**
     * Each wizard step: not_started (nothing saved or uploaded yet),
     * incomplete, or complete (the full rules pass today and its documents
     * are there; consent also needs the current wording).
     *
     * @param list<DoctorApplicationDocument> $active
     * @return array<string,string>
     */
    public function steps(DoctorApplication $app, array $active): array
    {
        $today    = ClinicTime::todayYmd();
        $route    = $app->getLicenceRoute();
        $slots    = array_map(static fn (DoctorApplicationDocument $d): string => $d->getSlot(), $active);
        $personal = $app->section('personal') ?? [];
        $out      = [];
        foreach (['personal', 'professional', 'licence', 'qualifications', 'documents', 'indemnity', 'consent'] as $step) {
            $needs  = ApplicationDocuments::requiredForStep($step, $route);
            $hasDoc = array_intersect($needs, $slots) !== [];
            $docsOk = array_diff($needs, $slots) === [];
            if ($step === 'documents') {
                $out[$step] = $docsOk ? 'complete' : ($hasDoc ? 'incomplete' : 'not_started');
                continue;
            }
            $values = $app->section($step);
            if ($values === null && !$hasDoc) {
                $out[$step] = 'not_started';
                continue;
            }
            $ok = $values !== null
                && $docsOk
                && ApplicationSections::isComplete($step, $values, $route, $today, $this->specialtyResolver(), $personal)
                && ($step !== 'consent' || ($values['consent_version'] ?? null) === ApplicationSections::CONSENT_VERSION);
            $out[$step] = $ok ? 'complete' : 'incomplete';
        }

        return $out;
    }

    /** ApplicationDraftDto. @return array<string,mixed> */
    public function draft(DoctorApplication $app): array
    {
        $active = $this->documents->activeFor($app->getId());
        $steps  = $this->steps($app, $active);
        $next   = 'review';
        foreach ($steps as $step => $state) {
            if ($state !== 'complete') {
                $next = $step;
                break;
            }
        }

        return [
            'id'              => $app->getId(),
            'status'          => 'draft',
            'licence_route'   => $app->getLicenceRoute(),
            'sections'        => self::sections($app),
            'documents'       => array_map(static fn (DoctorApplicationDocument $d): array => self::document($d, $app->getLicenceRoute()), $active),
            'steps'           => $steps,
            'next_step'       => $next,
            'ready_to_submit' => $next === 'review',
            'email_verified'  => $app->isEmailVerified(),
            'expires_at'      => ($app->getDraftExpiresAt() ?? ClinicTime::now())->format(DATE_ATOM),
            'last_saved_at'   => $app->getLastSavedAt()?->format(DATE_ATOM),
        ];
    }

    /** SubmittedApplicationDto (the applicant typed these, so they come back whole). @return array<string,string> */
    public static function submitted(DoctorApplication $app): array
    {
        return [
            'id'           => $app->getId(),
            'reference'    => (string) $app->getReference(),
            'status'       => 'submitted',
            'submitted_at' => (string) $app->getSubmittedAt()?->format(DATE_ATOM),
            'email'        => $app->getEmail(),
            'phone'        => (string) $app->getPhone(),
        ];
    }

    /** ApplicationInterviewDto, or null. @return array<string,mixed>|null */
    public static function interview(DoctorApplication $app): ?array
    {
        $epoch = $app->getInterviewEpoch();
        if ($epoch === null) {
            return null;
        }
        $at  = (new DateTimeImmutable('@' . $epoch))->setTimezone(ClinicTime::zone());
        $url = (string) $app->getInterviewMeetingUrl();

        return [
            'starts_at'        => $at->format(DATE_ATOM),
            'starts_at_label'  => $at->format('l j F, H:i T'),
            'duration_minutes' => (int) $app->getInterviewDurationMinutes(),
            'meeting_url'      => $url,
            'meeting_host'     => (string) (parse_url($url, PHP_URL_HOST) ?? ''),
            'note'             => $app->getInterviewNote(),
        ];
    }

    /** ApplicationStatusDto (the applicant's status page). @return array<string,mixed> */
    public function status(DoctorApplication $app): array
    {
        $status    = $app->getStatus();
        $open      = $this->requests->openFor($app->getId());
        $interview = in_array($status, [DoctorApplicationStatus::INTERVIEW_SCHEDULED, DoctorApplicationStatus::APPROVED, DoctorApplicationStatus::REJECTED, DoctorApplicationStatus::WITHDRAWN], true)
            ? self::interview($app)
            : null;

        return [
            'id'                => $app->getId(),
            'reference'         => (string) $app->getReference(),
            'status'            => $status->value,
            'status_label'      => $status->applicantLabel(),
            'full_name'         => $app->fullName(),
            'licence_route'     => $app->getLicenceRoute(),
            'submitted_at'      => (string) $app->getSubmittedAt()?->format(DATE_ATOM),
            'timeline'          => ApplicationTimeline::rows($status, $this->events->statusChanges($app->getId())),
            'interview'         => $interview,
            'info_request'      => $open?->toArray(false),
            'rejection_reason'  => $status === DoctorApplicationStatus::REJECTED ? $app->getRejectReason() : null,
            'can_withdraw'      => $status->isOpen(),
            'doctor_portal_url' => $status === DoctorApplicationStatus::APPROVED ? WebUrls::staffForOnboardingOrigin($app->getWebOrigin()) : null,
            'email_masked'      => ApplicantContact::maskEmail($app->getEmail()),
        ];
    }

    /**
     * ApplicantApplicationDto (the respond page). Its open request also says
     * which requested sections were saved since it was made
     * (`updated_sections`), so the page knows in any tab or device.
     *
     * @return array<string,mixed>
     */
    public function applicantApplication(DoctorApplication $app): array
    {
        $open    = $this->requests->openFor($app->getId());
        $request = $open?->toArray(false);
        if ($open !== null && $request !== null) {
            $request['updated_sections'] = $this->updatedSections($app, $open);
        }

        return [
            'id'            => $app->getId(),
            'reference'     => (string) $app->getReference(),
            'status'        => $app->getStatus()->value,
            'licence_route' => $app->getLicenceRoute(),
            'sections'      => self::sections($app),
            'documents'     => array_map(
                static fn (DoctorApplicationDocument $d): array => self::document($d, $app->getLicenceRoute()),
                $this->documents->activeFor($app->getId()),
            ),
            'info_request'  => $request,
        ];
    }

    /**
     * The sections `$request` asked for that the applicant has saved since it
     * was made (an `info_item_updated` event for this request), in the
     * request's order. The reply's completeness check uses the same rule.
     *
     * @return list<string>
     */
    public function updatedSections(DoctorApplication $app, DoctorApplicationInfoRequest $request): array
    {
        $since = $request->getRequestedAt();
        $saved = [];
        foreach ($this->events->forApplication($app->getId()) as $event) {
            $meta = $event->getMetadata();
            if ($event->getKind() === 'info_item_updated' && $event->getCreatedAt() >= $since && ($meta['info_request_id'] ?? null) === $request->getId() && isset($meta['section'])) {
                $saved[(string) $meta['section']] = true;
            }
        }
        $out = [];
        foreach ($request->getItems() as $item) {
            if (($item['kind'] ?? '') === 'section' && isset($saved[$item['key']]) && !in_array($item['key'], $out, true)) {
                $out[] = (string) $item['key'];
            }
        }

        return $out;
    }

    // ----- Staff -----

    /** DoctorApplicationRowDto. @return array<string,mixed> */
    public static function row(DoctorApplication $app): array
    {
        $status = $app->getStatus();

        return [
            'id'                  => $app->getId(),
            'reference'           => (string) $app->getReference(),
            'status'              => $status->value,
            'status_label'        => $status->label(),
            'full_name'           => $app->fullName(),
            'email'               => $app->getEmail(),
            'specialty'           => $app->getSpecialty(),
            'licence_route'       => $app->getLicenceRoute(),
            'licence_label'       => $app->getLicenceRoute() === 'abroad'
                ? 'Abroad · ' . Countries::name($app->getRegulatorCountry() ?? '')
                : 'Nigeria · MDCN',
            'submitted_at'        => (string) $app->getSubmittedAt()?->format(DATE_ATOM),
            'awaiting_staff'      => $app->isAwaitingStaff(),
            'interview_starts_at' => self::interview($app)['starts_at'] ?? null,
            'last_activity_at'    => $app->getUpdatedAt()->format(DATE_ATOM),
        ];
    }

    /** DoctorApplicationDetailDto. @return array<string,mixed> */
    public function detail(DoctorApplication $app): array
    {
        $status  = $app->getStatus();
        $all     = $this->documents->forApplication($app->getId());
        $active  = array_values(array_filter($all, static fn (DoctorApplicationDocument $d): bool => $d->isActive()));
        $actions = ApplicationStateMachine::staffActions($status);
        $consent = $app->getConsent();
        $reason  = $app->getWithdrawReason();

        return self::row($app) + [
            'phone'                  => (string) $app->getPhone(),
            'email_verified_at'      => $app->getEmailVerifiedAt()?->format(DATE_ATOM),
            'sections'               => self::sections($app),
            'documents'              => array_map(static fn (DoctorApplicationDocument $d): array => self::document($d, $app->getLicenceRoute(), true), $all),
            'info_requests'          => array_map(static fn (DoctorApplicationInfoRequest $r): array => $r->toArray(true), $this->requests->forApplication($app->getId())),
            'interview'              => self::interview($app),
            'rejection_reason'       => $app->getRejectReason(),
            'withdraw_reason'        => $reason,
            'withdraw_reason_label'  => $reason !== null ? (self::WITHDRAW_REASONS[$reason] ?? null) : null,
            'review_started_at'      => $app->getReviewStartedAt()?->format(DATE_ATOM),
            'review_started_by_name' => $app->getReviewStartedByName(),
            'decided_at'             => $app->getDecidedAt()?->format(DATE_ATOM),
            'decided_by_name'        => $app->getDecidedByName(),
            'consent'                => $consent !== null ? [
                'accept_terms'           => ($consent['accept_terms'] ?? false) === true,
                'authorise_verification' => ($consent['authorise_verification'] ?? false) === true,
                'confirm_accurate'       => ($consent['confirm_accurate'] ?? false) === true,
                'signature_name'         => (string) ($consent['signature_name'] ?? ''),
                'consent_version'        => (string) ($consent['consent_version'] ?? ''),
                'consented_at'           => $consent['consented_at'] ?? null,
                'consent_ip'             => $consent['consent_ip'] ?? null,
            ] : null,
            'specialist'             => $this->specialist($app),
            'actions'                => $actions,
            'approval'               => in_array(ApplicationStateMachine::APPROVE, $actions, true) ? $this->approvalPreview($app, $active) : null,
            'events'                 => array_map(static fn (DoctorApplicationEvent $e): array => $e->toArray(), $this->events->forApplication($app->getId())),
            'notes_count'            => $this->notes->countFor($app->getId()),
        ];
    }

    /**
     * ApprovalPreviewDto: what stops an approval before anything is typed (a
     * missing document, the specialty off the list, a blocked login) and the
     * per-document prefill (spec §4.3).
     *
     * @param list<DoctorApplicationDocument> $active
     * @return array<string,mixed>
     */
    public function approvalPreview(DoctorApplication $app, array $active): array
    {
        $problems = ApprovalInput::problems($app, $active, $this->specialtyResolver());
        $login    = $this->loginState($app->getEmail());
        if ($login['state'] === 'blocked') {
            $problems['email'] = (string) $login['problem'];
        }
        $route    = $app->getLicenceRoute();
        $indemnity = $app->section('indemnity') ?? [];
        $promoted = [
            'reference'               => (string) $app->getReference(),
            'mdcn_number'             => $app->getMdcnNumber(),
            'registration_number'     => $app->getRegistrationNumber(),
            'regulator_name'          => $app->getRegulatorName(),
            'licence_expires_on'      => $app->getLicenceExpiresOn()?->format('Y-m-d'),
            'good_standing_issued_on' => $app->getGoodStandingIssuedOn()?->format('Y-m-d'),
            'policy_number'           => $indemnity['policy_number'] ?? null,
            'cover_expires_on'        => $indemnity['cover_expires_on'] ?? null,
        ];
        $documents = [];
        foreach (ApprovalInput::carried($active) as $doc) {
            $documents[] = [
                'document_id'     => $doc->getId(),
                'slot'            => $doc->getSlot(),
                'slot_label'      => ApplicationDocuments::label($doc->getSlot(), $route),
                'original_name'   => $doc->getOriginalName(),
                'credential_type' => (string) ApplicationDocuments::typeFor($doc->getSlot(), $route),
            ] + ApplicationDocuments::prefill($doc->getSlot(), $route, $promoted);
        }
        $specialty = (string) $app->getSpecialty();

        return [
            'ready'             => $problems === [],
            'problems'          => (object) $problems,
            'documents'         => $documents,
            'login'             => $login,
            'specialty_on_list' => $specialty !== '' && ($this->specialtyResolver())($specialty) !== null,
            'register_name'     => ApprovalInput::registerName($app),
        ];
    }

    /**
     * Whether approval may create (or reuse) a doctor login for this email
     * (spec §4.2 step 4, mirroring DoctorOnboardingService::invite()): `new`,
     * `reuse_invited_login` (a doctor login nobody has used yet), or `blocked`
     * with why — shown to the reviewer only.
     *
     * @return array{state:string, problem:?string}
     */
    public function loginState(string $email): array
    {
        $existing = $this->users->findByEmail($email);
        $problem  = null;
        if ($existing !== null) {
            $problem = match (true) {
                !in_array('doctor', $existing->getRoles(), true) => 'This email belongs to a staff account that is not a doctor login. Use a different email.',
                $existing->getSpecialistId() !== null            => "This email already belongs to another doctor's login",
                $existing->hasPassword()                         => 'A doctor login with this email already exists. Link it to this specialist from Staff.',
                !$existing->isActive()                           => "This doctor's login is deactivated. Reactivate it in Staff first.",
                default                                          => null,
            };
        } elseif ($this->users->existsIncludingDeleted($email)) {
            $problem = 'This email belongs to a deleted login. Ask an admin with Staff & roles access to restore or remove it, then approve again.';
        }
        if ($problem === null) {
            $profiles = $this->specialists->findByEmail($email);
            if ($profiles !== []) {
                $problem = 'A doctor profile with this email already exists (' . $profiles[0]->getName() . '). Open it instead.';
            }
        }
        if ($problem !== null) {
            return ['state' => 'blocked', 'problem' => $problem];
        }

        return ['state' => $existing !== null ? 'reuse_invited_login' : 'new', 'problem' => null];
    }

    /** DoctorApplicationSpecialistDto, or null. @return array<string,mixed>|null */
    private function specialist(DoctorApplication $app): ?array
    {
        $id = $app->getSpecialistId();
        $s  = $id !== null ? $this->specialists->find($id) : null;
        if (!$s instanceof Specialist) {
            return null;
        }

        return [
            'id'     => $s->getId(),
            'name'   => $s->getName(),
            'status' => $s->getStatus()->value,
            'login'  => $this->onboarding->loginArray($this->users->findBySpecialist($s->getId())),
        ];
    }
}
