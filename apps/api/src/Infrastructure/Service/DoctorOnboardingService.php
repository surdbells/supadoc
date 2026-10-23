<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Application\GoLiveRules;
use App\Domain\Doctor\DoctorCredentials;
use App\Domain\Doctor\DoctorStanding;
use App\Domain\Entity\DoctorApplication;
use App\Domain\Entity\Specialist;
use App\Domain\Entity\SpecialistCredential;
use App\Domain\Entity\SpecialistStatusEvent;
use App\Domain\Entity\User;
use App\Domain\Enum\SpecialistStatus;
use App\Domain\Exception\ValidationException;
use App\Domain\Repository\AvailabilitySlotRepository;
use App\Domain\Repository\DoctorApplicationRepository;
use App\Domain\Repository\PayoutAccountRepository;
use App\Domain\Repository\SpecialistCredentialRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\SpecialistStatusEventRepository;
use App\Domain\Repository\UserRepository;
use App\Domain\Settings\ClinicTime;
use App\Domain\Settings\PractitionerTerms;
use App\Domain\Settings\WebUrls;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Email\MailService;
use DateTimeImmutable;

/**
 * Doctor onboarding: admin invites → doctor sets a password, completes the
 * checklist (profile, MDCN certificate + practising licence uploaded, terms
 * accepted) → submits for review → a reviewer verifies the documents and
 * approves (listed + bookable; what was approved is snapshotted) or sends it
 * back with a reason. Once approved, the identity fields are locked: the
 * doctor's edits wait for a reviewer ({@see approveChanges()}). The checklist
 * and approval rules are pure ({@see checklistFrom()}, {@see approvalProblems()})
 * so they are unit-tested without a database.
 */
final class DoctorOnboardingService
{
    /** Checklist keys, in the order the doctor works through them. */
    public const ITEMS = [
        'photo', 'bio', 'qualifications', 'mdcn', 'mdcn_certificate', 'practising_licence',
        'signature', 'availability', 'payout', 'terms',
    ];

    /** What each missing item asks for, for the "not ready yet" message. */
    private const MISSING_LABELS = [
        'photo'              => 'a profile photo',
        'bio'                => 'a short bio',
        'qualifications'     => 'your qualifications',
        'mdcn'               => 'your MDCN registration number',
        'mdcn_certificate'   => 'your MDCN full-registration certificate',
        'practising_licence' => 'your current annual practising licence',
        'signature'          => 'your signature',
        'availability'       => 'your availability',
        'payout'             => 'a payout account',
        'terms'              => 'your acceptance of the practitioner terms',
    ];

    /** The same, for a doctor licensed abroad (spec §4.4). */
    private const MISSING_LABELS_ABROAD = [
        'mdcn'               => 'your licence or registration number',
        'mdcn_certificate'   => 'your Certificate of Good Standing',
        'practising_licence' => 'your current practising licence',
    ];

    /** A change-request / send-back reason's limit. */
    public const MAX_REASON = 2000;

    public function __construct(
        private readonly SpecialistRepository $specialists,
        private readonly UserRepository $users,
        private readonly AvailabilitySlotRepository $slots,
        private readonly PayoutAccountRepository $payoutAccounts,
        private readonly StaffPasswordService $passwords,
        private readonly MailService $mail,
        private readonly StaffNotifier $notifier,
        private readonly SpecialistCredentialRepository $credentials,
        private readonly SpecialistStatusEventRepository $statusEvents,
        private readonly AuditLogger $audit,
        /** Back-office base URL for the reviewers' email ('' = no link, see {@see backofficeUrlFromEnv()}). */
        private readonly string $backofficeUrl = '',
        /** The applications doctors came from (invite wording, go-live). */
        private readonly ?DoctorApplicationRepository $applications = null,
    ) {
    }

    /** What a missing checklist item asks for, worded for the doctor's licence route. */
    public static function missingLabel(string $key, string $route = 'ng'): string
    {
        return ($route === 'abroad' ? (self::MISSING_LABELS_ABROAD[$key] ?? null) : null) ?? self::MISSING_LABELS[$key] ?? $key;
    }

    /**
     * The back office's base URL: BACKOFFICE_WEB_URL, else the CORS-allowed
     * origin whose host starts with "backoffice." (how the portals are deployed),
     * else '' — the reviewers' email then says where to look instead of linking.
     */
    public static function backofficeUrlFromEnv(array $env): string
    {
        $isWeb = static fn (string $url): bool => preg_match('#^https?://[^/\s]+$#i', $url) === 1;

        $explicit = rtrim(trim((string) ($env['BACKOFFICE_WEB_URL'] ?? '')), '/');
        if ($isWeb($explicit)) {
            return $explicit;
        }
        foreach (explode(',', (string) ($env['CORS_ALLOWED_ORIGINS'] ?? '')) as $origin) {
            $origin = rtrim(trim($origin), '/');
            if ($isWeb($origin) && str_starts_with(strtolower((string) parse_url($origin, PHP_URL_HOST)), 'backoffice.')) {
                return $origin;
            }
        }

        return '';
    }

    /**
     * Why a NEW doctor login can't be made for this specialist from their
     * contact email, or null when it can. A live doctor (approved, legacy or
     * suspended) has appointments and patient records, and `specialists.manage`
     * can change the contact email — so an invite that creates a login there
     * could hand that inbox's owner the doctor's patient records. Their login
     * has to be created from Staff (`staff.manage`) instead. Doctors still
     * onboarding can't have been booked, so there is nothing to expose.
     */
    public static function newLoginProblem(Specialist $s): ?string
    {
        $status = $s->getStatus(); // a legacy NULL reads as APPROVED

        return $status === SpecialistStatus::APPROVED || $status === SpecialistStatus::SUSPENDED
            ? 'This doctor is already live, so their login has to be created from Staff & roles.'
            : null;
    }

    /**
     * The checklist rule. Availability counts either recurring weekly hours or at
     * least one published open slot from now on. The documents count once
     * uploaded and not turned down (a reviewer verifies them during the
     * review); the licence must not have expired. Terms: the version in force.
     *
     * @param list<SpecialistCredential> $credentials
     * @return array<string,bool> keyed by {@see ITEMS}
     */
    public static function checklistFrom(
        Specialist $s,
        bool $hasOpenSlots,
        bool $hasPayoutAccount,
        array $credentials = [],
        ?string $termsVersion = null,
        ?string $todayYmd = null,
    ): array {
        $hours = array_filter(
            $s->getWeeklyHours() ?? [],
            static fn (mixed $windows): bool => is_array($windows) && $windows !== [],
        );
        $today = $todayYmd ?? ClinicTime::todayYmd();
        $route = $s->getLicenceRoute();

        return [
            'photo'              => ($s->getPhotoUrl() ?? '') !== '',
            'bio'                => trim((string) $s->getBio()) !== '',
            'qualifications'     => trim((string) $s->getQualifications()) !== '' || $s->getQualificationEntries() !== [],
            'mdcn'               => ($s->registrationNumberForRoute() ?? '') !== '',
            'mdcn_certificate'   => DoctorCredentials::mdcnProvided($credentials, $route),
            'practising_licence' => DoctorCredentials::licenceProvided($credentials, $today, $route),
            'signature'          => $s->getSignatureKey() !== null,
            'availability'       => $hours !== [] || $hasOpenSlots,
            'payout'             => $hasPayoutAccount,
            'terms'              => $s->hasAcceptedTerms($termsVersion ?? PractitionerTerms::version()),
        ];
    }

    /** @param array<string,bool> $checklist */
    public static function isComplete(array $checklist): bool
    {
        foreach (self::ITEMS as $key) {
            if (($checklist[$key] ?? false) !== true) {
                return false;
            }
        }

        return true;
    }

    /**
     * Why a reviewer can't approve this doctor yet, as field => message (empty
     * when they can): the profile must be waiting for review with every
     * checklist item done, the MDCN certificate and a current practising
     * licence must have been VERIFIED (with an attestation, see
     * DoctorCredentialService::verify()), the terms in force accepted, and the
     * reviewer must confirm (`$attested`).
     *
     * @param array<string,bool>         $checklist
     * @param list<SpecialistCredential> $credentials
     * @return array<string,string>
     */
    public static function approvalProblems(
        Specialist $s,
        array $checklist,
        array $credentials,
        string $termsVersion,
        string $todayYmd,
        bool $attested,
    ): array {
        $status = $s->getStatus();
        if ($status === SpecialistStatus::APPROVED) {
            return ['status' => 'This doctor is already approved'];
        }
        if ($status === SpecialistStatus::SUSPENDED) {
            return ['status' => 'This doctor is suspended. Reinstate them instead.'];
        }
        if ($status !== SpecialistStatus::PENDING_REVIEW) {
            return ['status' => "This doctor hasn't submitted their profile for review yet"];
        }

        $problems = self::readinessProblems($s, $checklist, $credentials, $termsVersion, $todayYmd);
        if (!$attested) {
            $problems['attest'] = $s->getLicenceRoute() === 'abroad'
                ? 'Confirm that you checked their documents against the ' . (trim((string) $s->getRegulatorName()) !== '' ? trim((string) $s->getRegulatorName()) : "regulator's") . ' register.'
                : 'Confirm that you checked their documents against the MDCN register.';
        }

        return $problems;
    }

    /**
     * Everything an approval rests on apart from the status and the reviewer's
     * attestation (spec §4.4): the checklist done, the registration document
     * and a current practising licence VERIFIED (for the doctor's licence
     * route), the terms in force accepted. Also the first gate of go-live
     * ({@see \App\Domain\Application\GoLiveRules}).
     *
     * @param array<string,bool>         $checklist
     * @param list<SpecialistCredential> $credentials
     * @return array<string,string>
     */
    public static function readinessProblems(
        Specialist $s,
        array $checklist,
        array $credentials,
        string $termsVersion,
        string $todayYmd,
    ): array {
        $route    = $s->getLicenceRoute();
        $abroad   = $route === 'abroad';
        $problems = [];
        $missing  = array_keys(array_filter(
            $checklist,
            static fn (bool $done, string $key): bool => !$done && !in_array($key, ['mdcn_certificate', 'practising_licence', 'terms'], true),
            ARRAY_FILTER_USE_BOTH,
        ));
        if ($missing !== []) {
            $problems['checklist'] = 'The profile is missing ' . self::humanList(array_map(
                static fn (string $k): string => str_replace('your ', 'their ', self::missingLabel($k, $route)),
                $missing,
            )) . '.';
        }
        if (!DoctorCredentials::hasVerifiedRegistration($credentials, $route)) {
            $problems['mdcn_certificate'] = $abroad
                ? 'Verify their Certificate of Good Standing first.'
                : 'Verify their MDCN full-registration certificate first.';
        }
        if (DoctorCredentials::currentLicence($credentials, $todayYmd, $route) === null) {
            $problems['practising_licence'] = $abroad
                ? 'Verify a current practising licence first.'
                : 'Verify a current annual practising licence first.';
        }
        if (!$s->hasAcceptedTerms($termsVersion)) {
            $problems['terms'] = 'The doctor has not accepted the practitioner terms (version ' . $termsVersion . ') yet.';
        }

        return $problems;
    }

    /**
     * @param list<SpecialistCredential>|null $credentials (loaded when null)
     * @return array<string,bool>
     */
    public function checklist(Specialist $s, ?array $credentials = null): array
    {
        return self::checklistFrom(
            $s,
            $this->slots->hasOpenSlotsSince($s->getId(), new DateTimeImmutable()),
            $this->payoutAccounts->forSpecialist($s->getId()) !== null,
            $credentials ?? $this->credentials->forSpecialist($s->getId()),
        );
    }

    /**
     * Everything the onboarding page (doctor) and the review panel (admin)
     * show: the review state, the checklist, the documents, the change request,
     * the terms, the licence and the doctor's standing. `$forReviewer` adds the
     * reviewers' view of the documents (attestations, replaced ones) and
     * whether — or why not — they can approve now.
     *
     * @return array<string,mixed>
     */
    public function summary(Specialist $s, bool $forReviewer = false): array
    {
        $credentials = $this->credentials->forSpecialist($s->getId());
        $checklist   = $this->checklist($s, $credentials);
        $today       = ClinicTime::todayYmd();
        $terms       = PractitionerTerms::version();
        $pending     = $s->getPendingFields();
        $shown       = $forReviewer
            ? $credentials
            : array_values(array_filter($credentials, static fn (SpecialistCredential $c): bool => $c->getStatus() !== SpecialistCredential::STATUS_SUPERSEDED));

        $out = $s->toReviewArray() + [
            'checklist'       => $checklist,
            'completed'       => count(array_filter($checklist)),
            'total'           => count($checklist),
            'complete'        => self::isComplete($checklist),
            'credentials'     => array_map(static fn (SpecialistCredential $c): array => $c->toArray($forReviewer), $shown),
            'locked_fields'   => $s->identityLocked() ? Specialist::LOCKED_FIELDS : [],
            'pending_changes' => $pending !== [] ? $pending : null,
            'pending_changes_submitted_at' => $pending !== [] ? $s->getPendingChangesSubmittedAt() : null,
            'changes_review_note' => $s->getChangesReviewNote(),
            'terms'           => [
                'current_version'  => $terms,
                'accepted_version' => $s->getTermsVersion(),
                'accepted_at'      => $s->getTermsAcceptedAt()?->format(DATE_ATOM),
                'accepted'         => $s->hasAcceptedTerms($terms),
            ],
            'licence'         => [
                'expires_at' => $s->getLicenceExpiresAt()?->format('Y-m-d'),
                'status'     => DoctorCredentials::licenceStatus($s->getLicenceExpiresAt()?->format('Y-m-d'), $today),
            ],
            'suspension'      => $s->isSuspended() ? [
                'code'         => $s->getSuspensionCode(),
                'code_label'   => SpecialistSuspensionService::codeLabel((string) $s->getSuspensionCode()),
                'reason'       => $s->getSuspensionReason(),
                'suspended_at' => $s->getSuspendedAt()?->format(DATE_ATOM),
            ] : null,
            'standing'        => DoctorStanding::payload($s, $terms),
            // Spec §4.6: where they are licensed, how they came, whether "Go live" approves at once.
            'licence_route'   => $s->getLicenceRoute(),
            'registration'    => $s->getLicenceRoute() === 'abroad' ? [
                'regulator_name'      => $s->getRegulatorName(),
                'regulator_country'   => $s->getRegulatorCountry(),
                'registration_number' => $s->getRegistrationNumber(),
            ] : null,
            'application'       => $this->applicationLink($s),
            'go_live_on_submit' => $s->getApplicationId() !== null && $s->getStatus() === SpecialistStatus::INVITED,
        ];
        if ($forReviewer) {
            $problems           = self::approvalProblems($s, $checklist, $credentials, $terms, $today, true);
            $out['approval']    = ['ready' => $problems === [], 'problems' => (object) $problems];
            $out['credentials_missing'] = $s->getCredentialsDueAt() !== null;
            $out['approved_snapshot']   = $s->getApprovedSnapshot();
            $out['terms']['accepted_ip'] = $s->getTermsAcceptedIp();
        }

        return $out;
    }

    /**
     * Invite (or re-invite) the doctor: find or create their login — no usable
     * password until they choose one — and email a set-password link. Calling
     * it again is a resend: the old link stops working.
     *
     * A login that already exists keeps its own email (the invite goes there),
     * and one whose password is already set can't be invited at all — so
     * `specialists.manage` can never be used to take over a doctor's account by
     * pointing the contact email elsewhere. Changing a login's email stays a
     * `staff.manage` action, and so does creating a login for a doctor who is
     * already live ({@see newLoginProblem()}).
     *
     * @return array<string,mixed>
     */
    public function invite(Specialist $s): array
    {
        $user = $this->users->findBySpecialist($s->getId());
        if ($user !== null && $user->hasPassword()) {
            throw new ValidationException(['email' => 'This doctor has already set a password. They can use "Forgot password?" on the sign-in page.']);
        }

        // A live doctor with no login: never create one from the (editable) contact email.
        $problem = $user === null ? self::newLoginProblem($s) : null;
        if ($problem !== null) {
            throw new ValidationException(['email' => $problem]);
        }

        $email = strtolower(trim((string) $s->getEmail()));
        if ($user === null && ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL))) {
            throw new ValidationException(['email' => "Add the doctor's email address before sending an invite"]);
        }

        if ($user === null) {
            $existing = $this->users->findByEmail($email);
            if ($existing !== null) {
                if ($existing->getSpecialistId() !== null && $existing->getSpecialistId() !== $s->getId()) {
                    throw new ValidationException(['email' => "This email already belongs to another doctor's login"]);
                }
                if (!in_array('doctor', $existing->getRoles(), true)) {
                    throw new ValidationException(['email' => 'This email belongs to a staff account that is not a doctor login. Use a different email.']);
                }
                if ($existing->hasPassword()) {
                    throw new ValidationException(['email' => 'A doctor login with this email already exists. Link it to this specialist from Staff.']);
                }
                $user = $existing;
            } else {
                [$first, $last] = self::nameParts($s->getName());
                $user = new User($email, $first, $last);
                $user->setRoles(['doctor']);
                $user->setPermissions(['appointments.view']);
            }
            $user->setSpecialistId($s->getId());
        }
        if (!$user->isActive()) {
            throw new ValidationException(['email' => "This doctor's login is deactivated. Reactivate it in Staff first."]);
        }

        // A doctor who came from an application gets its "Welcome aboard" wording (spec §4.7).
        $template    = null;
        $application = $s->getApplicationId() !== null ? $this->applications?->find($s->getApplicationId()) : null;
        if ($application instanceof DoctorApplication) {
            $first     = (string) ($application->getFirstName() ?? $user->getFirstName());
            $last      = (string) ($application->getLastName() ?? '');
            $reference = (string) $application->getReference();
            $template  = static fn (string $name, string $link, int $days): array => EmailTemplates::applicationApproved($first, $last, $reference, $link, $days);
        }
        $result = $this->passwords->sendInvite($user, $s->getName(), WebUrls::forSpecialist($s), $template);

        return $result + ['login' => $this->loginArray($user)];
    }

    /**
     * The doctor presses "Submit for review" — or, for a doctor vetted through
     * an application and still onboarding, "Go live" (spec §4.6): approved at
     * once when {@see GoLiveRules} finds nothing, otherwise sent for a quick
     * final check like any submission. Returns the status reached.
     *
     * @return 'approved'|'pending_review'
     */
    public function submit(Specialist $s, ?string $actorId = null): string
    {
        if ($s->getApplicationId() === null || $s->getStatus() !== SpecialistStatus::INVITED) {
            $this->submitForReview($s, $actorId);

            return SpecialistStatus::PENDING_REVIEW->value;
        }

        $credentials = $this->credentials->forSpecialist($s->getId());
        $checklist   = $this->checklist($s, $credentials);
        $missing     = array_keys(array_filter($checklist, static fn (bool $done): bool => !$done));
        if ($missing !== []) {
            $route  = $s->getLicenceRoute();
            $labels = array_map(static fn (string $k): string => self::missingLabel($k, $route), $missing);
            throw new ValidationException(['checklist' => 'Before submitting, add ' . self::humanList($labels) . '.']);
        }

        $application = $this->applications?->find($s->getApplicationId());
        $application = $application instanceof DoctorApplication ? $application : null;
        $today       = ClinicTime::todayYmd();
        $terms       = PractitionerTerms::version();
        $problems    = GoLiveRules::problems($s, $application, $checklist, $credentials, $terms, $today);
        if ($problems !== []) {
            $this->submitForReview($s, $actorId, ['go_live_blocked' => array_keys($problems)]);

            return SpecialistStatus::PENDING_REVIEW->value;
        }

        $reference = (string) $application?->getReference();
        $route     = $s->getLicenceRoute();
        $decidedBy = $application?->getDecidedById();
        $s->approve($decidedBy);
        $s->setLicenceExpiresAt(DoctorCredentials::currentLicence($credentials, $today, $route)?->getExpiresAt());
        $s->setCredentialsDueAt(null);
        $s->snapshotApproval(
            DoctorCredentials::verifiedIds($credentials, $today, $route),
            $decidedBy,
            trim((string) $application?->getDecidedByName()) . ' (application ' . $reference . ')',
        );
        $user = $this->users->findBySpecialist($s->getId());
        $this->statusEvents->persist(new SpecialistStatusEvent(
            $s->getId(),
            SpecialistStatus::INVITED->value,
            SpecialistStatus::APPROVED->value,
            $user?->getId() ?? $actorId,
            $s->getName(),
            'Went live after setup (application ' . $reference . ')',
            'went_live',
        ));
        $this->specialists->save($s);
        $this->recordAudit($s->getName(), 'doctor', 'specialist.went_live', $s, ['application_id' => $s->getApplicationId(), 'reference' => $reference], $actorId);

        // An FYI for the reviewers (in-app only); the doctor is told and emailed.
        $this->notifier->notifyPermission('specialists.manage', 'onboarding', 'Doctor now live: ' . $s->getName(), 'Vetted at application ' . $reference . '.', '/specialists/' . $s->getId());
        $this->notifier->notifyDoctor($s->getId(), 'onboarding', "You're live", 'Patients can now find and book you.', '/dashboard');
        $this->emailDoctor($s, EmailTemplates::doctorApproved($s->getName(), WebUrls::forSpecialist($s)));

        return SpecialistStatus::APPROVED->value;
    }

    /** The application a doctor came from, as SpecialistApplicationLinkDto, or null. @return array{id:string, reference:string, approved_at:?string}|null */
    public function applicationLink(Specialist $s): ?array
    {
        if ($s->getApplicationId() === null) {
            return null;
        }
        try {
            $application = $this->applications?->find($s->getApplicationId());
        } catch (\Throwable) {
            $application = null;
        }
        if (!$application instanceof DoctorApplication) {
            return null;
        }

        return [
            'id'          => $application->getId(),
            'reference'   => (string) $application->getReference(),
            'approved_at' => $application->getDecidedAt()?->format(DATE_ATOM),
        ];
    }

    /**
     * The doctor submits a complete checklist for review; admins are notified.
     *
     * @param array<string,mixed> $auditExtra e.g. why "Go live" fell back to review
     */
    private function submitForReview(Specialist $s, ?string $actorId, array $auditExtra = []): void
    {
        $status = $s->getStatus();
        if ($status === SpecialistStatus::APPROVED) {
            throw new ValidationException(['status' => 'Your profile is already approved']);
        }
        if ($status === SpecialistStatus::PENDING_REVIEW) {
            throw new ValidationException(['status' => 'Your profile is already waiting for review']);
        }
        if ($status === SpecialistStatus::SUSPENDED) {
            throw new ValidationException(['status' => 'Your account is suspended. Please contact support.']);
        }

        $missing = array_keys(array_filter($this->checklist($s), static fn (bool $done): bool => !$done));
        if ($missing !== []) {
            $route  = $s->getLicenceRoute();
            $labels = array_map(static fn (string $k): string => self::missingLabel($k, $route), $missing);
            throw new ValidationException(['checklist' => 'Before submitting, add ' . self::humanList($labels) . '.']);
        }

        $s->submitForReview();
        $this->statusEvents->persist(new SpecialistStatusEvent($s->getId(), $status->value, SpecialistStatus::PENDING_REVIEW->value, $actorId, $s->getName()));
        $this->specialists->save($s);
        $this->recordAudit($s->getName(), 'doctor', 'specialist.submitted', $s, $auditExtra, $actorId);

        $this->notifier->notifyPermission(
            'specialists.manage',
            'onboarding',
            'Doctor ready for review',
            $s->getName() . ' submitted their profile for review.',
            '/specialists/' . $s->getId(),
        );

        // The back office has no notification bell, so the reviewers are also
        // emailed — after the doctor's reply has gone, so N sends don't slow it.
        $name = $s->getName();
        AfterResponse::defer(fn () => $this->emailReviewers($name));
    }

    /**
     * Email everyone who can approve doctors (`specialists.manage`, super admins
     * included) that a profile is waiting. Only the doctor's name — no profile or
     * medical content. Best-effort, one failure never stops the rest.
     *
     * @return int how many emails were accepted
     */
    public function emailReviewers(string $doctorName): int
    {
        return $this->emailReviewersTemplate(EmailTemplates::doctorReadyForReview($doctorName, $this->backofficeUrl));
    }

    /**
     * Tell the reviewers something about a doctor needs a look — in-app now,
     * by email after the response. Name and what happened only.
     */
    public function notifyReviewers(Specialist $s, string $headline, string $text): void
    {
        $path = '/specialists/' . $s->getId();
        $this->notifier->notifyPermission('specialists.manage', 'onboarding', $headline, $text, $path);
        $tpl = EmailTemplates::reviewerNotice($headline, $text, $this->backofficeUrl, $path);
        AfterResponse::defer(fn () => $this->emailReviewersTemplate($tpl));
    }

    /**
     * A reviewer approves: the doctor becomes listed and bookable, what was
     * approved is snapshotted, the doctor is emailed. 422 with every reason
     * when {@see approvalProblems()} finds any.
     */
    public function approve(Specialist $s, string $actorId, string $actorName = 'Admin', bool $attested = false, ?string $note = null): void
    {
        $credentials = $this->credentials->forSpecialist($s->getId());
        $today       = ClinicTime::todayYmd();
        $problems    = self::approvalProblems($s, $this->checklist($s, $credentials), $credentials, PractitionerTerms::version(), $today, $attested);
        if ($problems !== []) {
            throw new ValidationException($problems, (string) reset($problems));
        }

        $from    = $s->getStatus()->value;
        $route   = $s->getLicenceRoute();
        $licence = DoctorCredentials::currentLicence($credentials, $today, $route);
        $s->approve($actorId !== '' ? $actorId : null);
        $s->setLicenceExpiresAt($licence?->getExpiresAt());
        $s->setCredentialsDueAt(null);
        $s->snapshotApproval(DoctorCredentials::verifiedIds($credentials, $today, $route), $actorId !== '' ? $actorId : null, $actorName);
        $this->statusEvents->persist(new SpecialistStatusEvent(
            $s->getId(),
            $from,
            SpecialistStatus::APPROVED->value,
            $actorId,
            $actorName,
            $note !== null && trim($note) !== '' ? mb_substr(trim($note), 0, self::MAX_REASON) : null,
        ));
        $this->specialists->save($s);

        $this->notifier->notifyDoctor($s->getId(), 'onboarding', 'Profile approved', 'Patients can now find and book you.', '/dashboard');
        $tpl = EmailTemplates::doctorApproved($s->getName(), WebUrls::forSpecialist($s));
        $this->emailDoctor($s, $tpl);
    }

    /** An admin sends a submitted profile back with a reason. Emails the doctor. */
    public function reject(Specialist $s, string $reason, ?string $actorId = null, string $actorName = 'Admin'): void
    {
        $reason = trim($reason);
        if ($reason === '') {
            throw new ValidationException(['reason' => 'Tell the doctor what to change']);
        }
        if (mb_strlen($reason) > self::MAX_REASON) {
            throw new ValidationException(['reason' => 'Keep the reason under 2000 characters']);
        }
        if ($s->getStatus() !== SpecialistStatus::PENDING_REVIEW) {
            throw new ValidationException(['status' => 'Only a profile waiting for review can be sent back']);
        }

        $s->reject($reason);
        $this->statusEvents->persist(new SpecialistStatusEvent(
            $s->getId(),
            SpecialistStatus::PENDING_REVIEW->value,
            SpecialistStatus::REJECTED->value,
            $actorId,
            $actorName,
            $reason,
        ));
        $this->specialists->save($s);

        $this->notifier->notifyDoctor($s->getId(), 'onboarding', 'Profile needs changes', $reason, '/onboarding');
        $tpl = EmailTemplates::doctorRejected($s->getName(), $reason, WebUrls::forSpecialist($s));
        $this->emailDoctor($s, $tpl);
    }

    // ----- Change requests (locked fields after approval) -----

    /** The doctor sent (or updated) a change request: reviewers are told and it is audited. */
    public function changesSubmitted(Specialist $s, ?string $actorId): void
    {
        $this->recordAudit($s->getName(), 'doctor', 'specialist.changes_submitted', $s, [
            'fields'  => array_keys($s->getPendingFields()),
            'changes' => $s->getPendingFields(),
        ], $actorId);
        $this->notifyReviewers(
            $s,
            'Profile changes to review: ' . $s->getName(),
            $s->getName() . ' asked to change ' . self::humanList(array_map(
                static fn (string $k): string => str_replace('_', ' ', $k),
                array_keys($s->getPendingFields()),
            )) . ' on their profile. The changes go live only once approved.',
        );
    }

    /**
     * A reviewer approves the waiting changes: they go live, the approval
     * snapshot is refreshed, the doctor is told. Returns {before, after}.
     *
     * @return array{before: array<string,mixed>, after: array<string,mixed>}
     */
    public function approveChanges(Specialist $s, ?string $actorId, string $actorName): array
    {
        $after = $s->getPendingFields();
        if ($after === []) {
            throw new ValidationException(['changes' => 'There are no changes waiting for review']);
        }
        $before      = $s->approvePendingChanges();
        $credentials = $this->credentials->forSpecialist($s->getId());
        $s->snapshotApproval(DoctorCredentials::verifiedIds($credentials, ClinicTime::todayYmd(), $s->getLicenceRoute()), $actorId, $actorName);
        $this->specialists->save($s);

        $this->recordAudit($actorName, 'admin', 'specialist.changes_approved', $s, ['before' => $before, 'after' => $after], $actorId);
        $this->notifier->notifyDoctor($s->getId(), 'onboarding', 'Profile changes approved', 'Your requested profile changes are now live.', '/profile');
        $this->emailDoctor($s, EmailTemplates::doctorChangesReviewed($s->getName(), true, '', WebUrls::forSpecialist($s)));

        return ['before' => $before, 'after' => $after];
    }

    /** A reviewer turns the waiting changes down, with a reason the doctor sees. */
    public function rejectChanges(Specialist $s, string $reason, ?string $actorId, string $actorName): void
    {
        $reason = trim($reason);
        if ($reason === '') {
            throw new ValidationException(['reason' => 'Tell the doctor why the changes were not approved']);
        }
        if (mb_strlen($reason) > self::MAX_REASON) {
            throw new ValidationException(['reason' => 'Keep the reason under 2000 characters']);
        }
        $fields = $s->getPendingFields();
        if ($fields === []) {
            throw new ValidationException(['changes' => 'There are no changes waiting for review']);
        }
        $s->rejectPendingChanges($reason);
        $this->specialists->save($s);

        $this->recordAudit($actorName, 'admin', 'specialist.changes_rejected', $s, ['reason' => $reason, 'rejected' => $fields], $actorId);
        $this->notifier->notifyDoctor($s->getId(), 'onboarding', 'Profile changes not approved', $reason, '/profile');
        $this->emailDoctor($s, EmailTemplates::doctorChangesReviewed($s->getName(), false, $reason, WebUrls::forSpecialist($s)));
    }

    /** The doctor withdraws their waiting changes. */
    public function withdrawChanges(Specialist $s, ?string $actorId): void
    {
        if ($s->getPendingFields() === []) {
            return;
        }
        $s->clearPendingChanges();
        $this->specialists->save($s);
        $this->recordAudit($s->getName(), 'doctor', 'specialist.changes_withdrawn', $s, [], $actorId);
    }

    /**
     * The login state the back office shows next to a specialist.
     *
     * @return array<string,mixed>|null
     */
    public function loginArray(?User $user): ?array
    {
        if ($user === null) {
            return null;
        }
        $u = $user->toArray();

        return [
            'id'                => $u['id'],
            'email'             => $u['email'],
            'active'            => $u['active'],
            'password_set'      => $u['password_set'],
            'invite_pending'    => $u['invite_pending'],
            'invite_expires_at' => $u['invite_expires_at'],
        ];
    }

    /** Strip an honorific and split "Dr. Grace Bell" into [first, last]. */
    public static function nameParts(string $name): array
    {
        $clean = trim(preg_replace('/^(dr|prof|mr|mrs|ms)\.?\s+/i', '', trim($name)) ?? $name);
        $parts = preg_split('/\s+/', $clean) ?: [$clean];
        $first = $parts[0] !== '' ? $parts[0] : 'Doctor';

        return [$first, count($parts) > 1 ? implode(' ', array_slice($parts, 1)) : 'Doctor'];
    }

    /** @param list<string> $items */
    public static function humanList(array $items): string
    {
        if (count($items) <= 1) {
            return $items[0] ?? '';
        }
        $last = array_pop($items);

        return implode(', ', $items) . ' and ' . $last;
    }

    /**
     * Email a template to every reviewer (`specialists.manage`, super admins
     * included). Best-effort. Also used by the doctor-application notices.
     *
     * @param array{subject:string, html:string} $tpl
     */
    public function emailReviewersTemplate(array $tpl, string $templateKey = 'reviewerNotice'): int
    {
        $sent = 0;
        try {
            $reviewers = $this->users->withPermission('specialists.manage');
        } catch (\Throwable) {
            return 0;
        }
        foreach ($reviewers as $reviewer) {
            try {
                if ($this->mail->send($reviewer->getEmail(), $reviewer->getFirstName(), $tpl['subject'], $tpl['html'], $templateKey)) {
                    $sent++;
                }
            } catch (\Throwable) {
                // non-fatal — the in-app notification and the Needs review count remain.
            }
        }

        return $sent;
    }

    /** @param array<string,mixed> $metadata */
    private function recordAudit(string $actorName, string $role, string $action, Specialist $s, array $metadata, ?string $actorId): void
    {
        try {
            $this->audit->record($actorName, $role, $action, null, 'specialist', $s->getId(), $metadata + ['doctor' => $s->getName()], $actorId);
        } catch (\Throwable) {
            // non-fatal — the change itself is saved.
        }
    }

    /** @param array{subject:string, html:string} $tpl */
    private function emailDoctor(Specialist $s, array $tpl): void
    {
        try {
            $login = $this->users->findBySpecialist($s->getId());
            $email = $login?->getEmail() ?? $s->getEmail();
            if ($email !== null && $email !== '') {
                $this->mail->send($email, $s->getName(), $tpl['subject'], $tpl['html']);
            }
        } catch (\Throwable) {
            // non-fatal — the review decision already succeeded.
        }
    }
}
