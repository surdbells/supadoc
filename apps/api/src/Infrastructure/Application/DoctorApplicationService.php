<?php

declare(strict_types=1);

namespace App\Infrastructure\Application;

use App\Domain\Application\ApplicantContact;
use App\Domain\Application\ApplicationDocuments;
use App\Domain\Application\ApplicationReference;
use App\Domain\Application\ApplicationSections;
use App\Domain\Application\ApplicationStateMachine as SM;
use App\Domain\Contact\PhoneNumber;
use App\Domain\Entity\DoctorApplication;
use App\Domain\Entity\DoctorApplicationDocument;
use App\Domain\Entity\DoctorApplicationEvent;
use App\Domain\Entity\DoctorApplicationInfoRequest;
use App\Domain\Entity\Specialist;
use App\Domain\Enum\DoctorApplicationStatus as S;
use App\Domain\Enum\SpecialistStatus;
use App\Domain\Exception\ApplicationProblem;
use App\Domain\Exception\EntityNotFoundException;
use App\Domain\Exception\ValidationException;
use App\Domain\Repository\DoctorApplicationDocumentRepository;
use App\Domain\Repository\DoctorApplicationEventRepository;
use App\Domain\Repository\DoctorApplicationInfoRequestRepository;
use App\Domain\Repository\DoctorApplicationRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Domain\Settings\ClinicTime;
use App\Domain\Settings\WebUrls;
use App\Infrastructure\Service\AfterResponse;
use App\Infrastructure\Service\AuditLogger;
use App\Infrastructure\Service\JwtService;
use App\Infrastructure\Service\TermiiService;
use App\Infrastructure\Storage\ApplicationDocumentStore;
use DateTimeImmutable;
use Doctrine\DBAL\Exception\UniqueConstraintViolationException;
use Doctrine\ORM\EntityManagerInterface;
use Psr\Http\Message\UploadedFileInterface;
use Psr\Log\LoggerInterface;

/**
 * The applicant's side of a doctor application (spec §3.2): drafts (create,
 * resume by code or link, save sections, uploads, the confirm-email code,
 * submit, cancel), the status check (track) and, once submitted, the more-info
 * response and withdraw.
 *
 * Locks (spec §2.1, §3.6): every applicant transition, every info-response
 * write and every draft write (section, route, upload, document delete, email
 * proof, code rotation, discard) holds `pg_advisory_xact_lock(0x0DA1,
 * hashtext(id))` and a re-read row lock, then re-checks that the row is still
 * a draft (409 `draft_submitted`); vault files are deleted only after the
 * commit. Submit holds `(0x0DA2, hashtext(email))`, the row lock and the
 * reference `(0x0DA3, 0)`, and re-runs its gates on the re-read row. A
 * unique-index backstop becomes a coded 409 and is logged by class and id
 * only. Nothing here logs a name, an email, a phone, a code or a document.
 */
final class DoctorApplicationService
{
    public const DRAFT_TTL_DAYS   = 30;
    public const RESUME_LINK_DAYS = 7;
    public const DRAFT_TOKEN_TTL  = 14400;
    public const ACCESS_TOKEN_TTL = 1800;
    public const MAX_FILES        = 20;
    public const MAX_APP_BYTES    = 40 * 1024 * 1024;
    public const MAX_NOTE         = 1000;

    public const LOCK_APPLICATION = 0x0DA1;
    public const LOCK_EMAIL       = 0x0DA2;
    public const LOCK_REFERENCE   = 0x0DA3;

    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly DoctorApplicationRepository $applications,
        private readonly DoctorApplicationDocumentRepository $documents,
        private readonly DoctorApplicationEventRepository $events,
        private readonly DoctorApplicationInfoRequestRepository $requests,
        private readonly SpecialistRepository $specialists,
        private readonly UserRepository $users,
        private readonly ApplicationDocumentStore $store,
        private readonly ApplicationCodeService $codes,
        private readonly ApplicationNotifier $notifier,
        private readonly ApplicationDraftPurger $purger,
        private readonly ApplicationViews $views,
        private readonly JwtService $jwt,
        private readonly AuditLogger $audit,
        private readonly TermiiService $termii,
        private readonly ?LoggerInterface $logger = null,
        private readonly string $legalTermsUrl = '',
        private readonly string $legalPrivacyUrl = '',
    ) {
    }

    // ----- Config -----

    /** ApplicationConfigDto. @return array<string,mixed> */
    public function config(): array
    {
        $https = static fn (string $url): ?string => preg_match('#^https://[^\s/]+\.[^\s/]+(/\S*)?$#i', trim($url)) === 1 ? trim($url) : null;

        return [
            'consent_version'             => ApplicationSections::CONSENT_VERSION,
            'max_upload_bytes'            => ApplicationDocumentStore::MAX_BYTES,
            'accepted_mime'               => ['application/pdf', 'image/png', 'image/jpeg'],
            'doctor_portal_url'           => WebUrls::staffForOnboardingOrigin(WebUrls::requestOnboardingOrigin()),
            'support_email'               => $this->notifier->supportEmail(),
            'draft_ttl_days'              => self::DRAFT_TTL_DAYS,
            'good_standing_max_age_months' => ApplicationSections::GOOD_STANDING_MONTHS,
            'sms_enabled'                 => $this->termii->isConfigured(),
            'legal_terms_url'             => $https($this->legalTermsUrl),
            'legal_privacy_url'           => $https($this->legalPrivacyUrl),
            'patient_site_url'            => WebUrls::patientDefault(),
        ];
    }

    // ----- Drafts -----

    /**
     * POST /drafts: the draft (personal details; the email is required and
     * must be valid even for a partial save), its token, and — after the
     * response — the resume email (within the mail cap) and a purge of up to
     * 20 expired drafts. Never says anything about other drafts or
     * applications for the email.
     *
     * @param array<string,mixed> $body
     * @return array<string,mixed> CreateDraftResultDto
     */
    public function createDraft(array $body, string $ip, string $userAgent): array
    {
        $route = $body['licence_route'] ?? null;
        if (!in_array($route, DoctorApplication::ROUTES, true)) {
            throw new ValidationException(['licence_route' => "Choose where you're licensed."]);
        }
        $values  = is_array($body['personal'] ?? null) ? $body['personal'] : [];
        $partial = ($body['partial'] ?? false) === true;
        $result  = ApplicationSections::validate('personal', $values, $route, ClinicTime::todayYmd(), $partial);
        $errors  = $result['errors'];
        if (!isset($result['values']['email'])) {
            $errors['email'] = ApplicationSections::M['email'];
        }
        if ($errors !== []) {
            throw new ValidationException($errors, (string) reset($errors));
        }

        $now = ClinicTime::now();
        $app = new DoctorApplication($route, (string) $result['values']['email']);
        $app->setWebOrigin(WebUrls::requestOnboardingOrigin());
        $this->applyPersonal($app, $result['values']);
        $app->touchDraft($now, self::DRAFT_TTL_DAYS);
        $secrets = $this->issueResumeSecrets($app, $now);
        $this->em->persist($app);
        $this->em->flush();

        $email = $app->getEmail();
        $first = (string) $app->getFirstName();
        $this->codes->markResendCooldown($email);
        AfterResponse::defer(fn () => $this->notifier->resumeEmail($email, $first, $secrets['link'], $secrets['code'], self::RESUME_LINK_DAYS, self::DRAFT_TTL_DAYS));
        AfterResponse::defer(fn () => $this->purger->purgeExpired(20));

        return $this->session($app) + [
            'resume_email_sent_to' => ApplicantContact::maskEmail($email),
        ] + $this->devSecrets($secrets);
    }

    /**
     * POST /drafts/resume: email + draft code. One failure message whether or
     * not the email has drafts; 5 failures per email lock it for 30 minutes
     * (each attempt is counted up front, a success is given back). The match
     * is confirmed under the application lock: the draft must still be a live
     * draft for this email holding this code (an email change kills the code).
     *
     * @param array<string,mixed> $body
     * @return array<string,mixed> DraftSessionDto
     */
    public function resumeWithCode(array $body): array
    {
        $email = strtolower(trim(is_string($body['email'] ?? null) ? $body['email'] : ''));
        $code  = ApplicationCodeService::normaliseDraftCode(is_string($body['draft_code'] ?? null) ? $body['draft_code'] : '');
        $this->codes->beginResumeAttempt($email);

        $now = ClinicTime::now();
        if ($email !== '' && preg_match('/^[0-9A-HJKMNP-TV-Z]{6}$/', $code) === 1) {
            foreach ($this->applications->liveDraftsForEmail($email, $now) as $draft) {
                if (!$this->codes->matches($draft->getId(), $code, $draft->getDraftCodeHash())) {
                    continue;
                }
                $verified = $this->markVerifiedIf($draft->getId(), $now, fn (DoctorApplication $locked): bool => $locked->getEmail() === $email
                    && $this->codes->matches($locked->getId(), $code, $locked->getDraftCodeHash()));
                if ($verified !== null) {
                    $this->codes->resumeSucceeded($email);

                    return $this->session($verified);
                }
            }
        }

        throw new ApplicationProblem(422, 'resume_invalid', "We couldn't find a draft with those details. Check your resume email.");
    }

    /**
     * POST /drafts/resume-link: the token from the link's #fragment. Confirmed
     * under the application lock: the draft must still hold this live link.
     *
     * @param array<string,mixed> $body
     * @return array<string,mixed> DraftSessionDto
     */
    public function resumeWithLink(array $body): array
    {
        $token = is_string($body['token'] ?? null) ? trim($body['token']) : '';
        $now   = ClinicTime::now();
        $hash  = hash('sha256', $token);
        $draft = $token !== '' && strlen($token) <= 128 ? $this->applications->findDraftByResumeTokenHash($hash) : null;
        if ($draft !== null && $draft->isExpiredDraft($now)) {
            $this->purger->purge($draft, $now);
            $draft = null;
        }
        $verified = $draft === null ? null : $this->markVerifiedIf($draft->getId(), $now, static function (DoctorApplication $locked) use ($hash, $now): bool {
            $expires = $locked->getResumeTokenExpiresAt();

            return hash_equals((string) $locked->getResumeTokenHash(), $hash) && $expires !== null && $expires > $now;
        });
        if ($verified === null) {
            throw new ApplicationProblem(422, 'link_invalid', 'This link has expired or was replaced by a newer one. Enter your email and draft code instead.');
        }

        return $this->session($verified);
    }

    /**
     * POST /drafts/resend: always the same answer; the work happens after the
     * response — the most recently saved live draft for the email gets a new
     * link and code (the old ones stop working), within the cooldown and the
     * mail cap. Over the cap nothing changes: the code and link already sent
     * keep working (rotating without sending would lock the applicant out).
     *
     * @param array<string,mixed> $body
     */
    public function resend(array $body): void
    {
        $email = strtolower(trim(is_string($body['email'] ?? null) ? $body['email'] : ''));
        if ($email === '' || !ApplicationSections::emailOk($email)) {
            return;
        }
        AfterResponse::defer(function () use ($email): void {
            try {
                $draft = $this->applications->liveDraftsForEmail($email, ClinicTime::now())[0] ?? null;
                if ($draft === null || !$this->codes->claimResendCooldown($email)) {
                    return;
                }
                $sent = $this->inApplicationLock($draft->getId(), function (DoctorApplication $locked) use ($email): ?array {
                    $now = ClinicTime::now();
                    if (!$locked->isDraft() || $locked->isExpiredDraft($now) || $locked->getEmail() !== $email || !$this->codes->claimMailSlot($email)) {
                        return null;
                    }

                    return [$this->issueResumeSecrets($locked, $now), (string) $locked->getFirstName()];
                });
                if ($sent !== null) {
                    [$secrets, $first] = $sent;
                    $this->notifier->resumeEmail($email, $first, $secrets['link'], $secrets['code'], self::RESUME_LINK_DAYS, self::DRAFT_TTL_DAYS, slotClaimed: true);
                }
            } catch (\Throwable $e) {
                $this->logger?->warning('Draft resend failed', ['error' => $e::class]);
            }
        });
    }

    /** @return array<string,mixed> ApplicationDraftDto */
    public function draft(DoctorApplication $app): array
    {
        return $this->views->draft($app);
    }

    /**
     * PATCH /drafts/current: switch the licence route — clears the licence
     * details and certificates (spec §2.12).
     *
     * @param array<string,mixed> $body
     * @return array<string,mixed>
     */
    public function changeRoute(DoctorApplication $app, array $body): array
    {
        $route = $body['licence_route'] ?? null;
        if (!in_array($route, DoctorApplication::ROUTES, true)) {
            throw new ValidationException(['licence_route' => "Choose where you're licensed."]);
        }
        $keys   = [];
        $locked = $this->inApplicationLock($app->getId(), function (DoctorApplication $locked) use ($route, &$keys): DoctorApplication {
            $this->assertStillDraft($locked);
            if ($route === $locked->getLicenceRoute()) {
                return $locked;
            }
            foreach ($this->documents->forApplication($locked->getId()) as $doc) {
                if (in_array($doc->getSlot(), [ApplicationDocuments::MDCN_CERTIFICATE, ApplicationDocuments::GOOD_STANDING], true)) {
                    $keys[] = $doc->getVaultKey();
                    $this->em->remove($doc);
                }
            }
            $locked->setLicenceRoute($route);
            $locked->clearLicence();
            $locked->touchDraft(ClinicTime::now(), self::DRAFT_TTL_DAYS);

            return $locked;
        });
        foreach ($keys as $key) {
            $this->store->delete($key); // only once the rows are committed
        }

        return $this->views->draft($locked);
    }

    /**
     * PUT /drafts/current/sections/{section}, under the application lock (a
     * submit that committed meanwhile answers 409 `draft_submitted`). A changed
     * email forgets that the old one was confirmed and kills the code and link
     * sent to it — and sends nothing (D31).
     *
     * @param array<string,mixed> $body
     * @return array<string,mixed>
     */
    public function saveSection(DoctorApplication $app, string $section, array $body, string $ip, string $userAgent): array
    {
        if (!in_array($section, ApplicationSections::SECTIONS, true)) {
            throw new EntityNotFoundException('Unknown section');
        }
        $partial = ($body['partial'] ?? false) === true;
        $locked  = $this->inApplicationLock($app->getId(), function (DoctorApplication $locked) use ($section, $body, $partial, $ip, $userAgent): DoctorApplication {
            $this->assertStillDraft($locked);
            $result = $this->checkSection($locked, $section, $body, $partial);
            $now    = ClinicTime::now();
            $this->applySection($locked, $section, $result['values'], $now, $ip, $userAgent);
            $locked->touchDraft($now, self::DRAFT_TTL_DAYS);

            return $locked;
        });

        return $this->views->draft($locked);
    }

    /**
     * POST /drafts/current/documents: one document per slot — a re-upload
     * replaces (deletes) the old one, under the draft's row lock.
     *
     * @return array<string,mixed> ApplicationDocumentDto
     */
    public function uploadDraftDocument(DoctorApplication $app, string $slot, UploadedFileInterface $file): array
    {
        if (!in_array($slot, ApplicationDocuments::slotsFor($app->getLicenceRoute()), true)) {
            throw new ApplicationProblem(422, 'upload_slot_invalid', "This document can't be uploaded here.", ['slot' => "This document can't be uploaded here."]);
        }
        $read = $this->store->read($file);

        $oldKeys = [];
        $doc     = $this->withUpload($app->getId(), $read, function (DoctorApplication $locked, string $key) use ($slot, $read, &$oldKeys): DoctorApplicationDocument {
            $this->assertStillDraft($locked);
            if (!in_array($slot, ApplicationDocuments::slotsFor($locked->getLicenceRoute()), true)) {
                // the route changed while this upload waited
                throw new ApplicationProblem(422, 'upload_slot_invalid', "This document can't be uploaded here.", ['slot' => "This document can't be uploaded here."]);
            }
            $replaced = [];
            foreach ($this->documents->forApplication($locked->getId()) as $old) {
                if ($old->getSlot() === $slot) {
                    $replaced[] = $old;
                }
            }
            $this->assertCaps($locked->getId(), $read['size'], $replaced);
            foreach ($replaced as $old) {
                $oldKeys[] = $old->getVaultKey();
                $this->em->remove($old);
            }
            $doc = new DoctorApplicationDocument($locked->getId(), $slot, $key, $read['name'], $read['mime'], $read['size'], $read['sha256']);
            $this->em->persist($doc);
            $locked->touchDraft(ClinicTime::now(), self::DRAFT_TTL_DAYS);

            return $doc;
        });
        foreach ($oldKeys as $key) {
            $this->store->delete($key);
        }

        return ApplicationViews::document($doc, $app->getLicenceRoute());
    }

    public function deleteDraftDocument(DoctorApplication $app, string $docId): void
    {
        $key = $this->inApplicationLock($app->getId(), function (DoctorApplication $locked) use ($docId): string {
            $this->assertStillDraft($locked);
            $doc = $this->documents->findForApplication($docId, $locked->getId()) ?? throw new EntityNotFoundException('Document not found');
            $this->em->remove($doc);
            $locked->touchDraft(ClinicTime::now(), self::DRAFT_TTL_DAYS);

            return $doc->getVaultKey();
        });
        $this->store->delete($key); // only once the row is committed
    }

    /**
     * A document's bytes for its own applicant (active ones only on the status side).
     *
     * @return array{0: DoctorApplicationDocument, 1: string}
     */
    public function documentFile(DoctorApplication $app, string $docId, bool $activeOnly): array
    {
        $doc = $this->documents->findForApplication($docId, $app->getId());
        if ($doc === null || ($activeOnly && !$doc->isActive()) || $doc->getFilePurgedAt() !== null) {
            throw new EntityNotFoundException('Document not found');
        }
        $bytes = $this->store->bytes($doc->getVaultKey());
        if ($bytes === null) {
            throw new ApplicationProblem(404, 'file_missing', 'This document could not be read. Upload it again.');
        }

        return [$doc, $bytes];
    }

    /**
     * POST /drafts/current/resume-email: a new link + code to the draft's
     * address (the old ones stop working). 429 within 60 s of the last one.
     * The rotation happens under the application lock and only when today's
     * mail slot for the address is free: over the cap the answer is the same
     * 202, nothing is sent and the code and link already sent keep working.
     *
     * @return array<string,mixed> ResumeEmailSentDto
     */
    public function sendResumeEmail(DoctorApplication $app): array
    {
        $email = $app->getEmail();
        if (!$this->codes->claimResendCooldown($email)) {
            throw new ApplicationProblem(429, 'resend_cooldown', "We've just sent one. Check your inbox.", ['retry_after' => $this->codes->resendRetryAfter($email)]);
        }
        [$email, $first, $secrets] = $this->inApplicationLock($app->getId(), function (DoctorApplication $locked): array {
            $this->assertStillDraft($locked);
            $to = $locked->getEmail();
            $secrets = $this->codes->claimMailSlot($to) ? $this->issueResumeSecrets($locked, ClinicTime::now()) : null;

            return [$to, (string) $locked->getFirstName(), $secrets];
        });
        if ($secrets !== null) {
            AfterResponse::defer(fn () => $this->notifier->resumeEmail($email, $first, $secrets['link'], $secrets['code'], self::RESUME_LINK_DAYS, self::DRAFT_TTL_DAYS, slotClaimed: true));
        }

        return ['sent_to' => ApplicantContact::maskEmail($email), 'resend_after' => ApplicationCodeService::COOLDOWN] + ($secrets !== null ? $this->devSecrets($secrets) : []);
    }

    /**
     * POST /drafts/current/email-code.
     *
     * @return array{0:int, 1: array<string,mixed>} [HTTP status, CodeSentDto]
     */
    public function sendEmailCode(DoctorApplication $app): array
    {
        $email = $app->getEmail();
        if ($app->isEmailVerified()) {
            return [200, ['sent_to' => ApplicantContact::maskEmail($email), 'expires_in' => 0, 'resend_after' => 0, 'already_verified' => true]];
        }
        $code = $this->codes->issueEmailConfirm($app->getId(), $email);
        AfterResponse::defer(fn () => $this->notifier->confirmCode($email, $code));
        $out = ['sent_to' => ApplicantContact::maskEmail($email), 'expires_in' => ApplicationCodeService::CODE_TTL, 'resend_after' => ApplicationCodeService::COOLDOWN];
        if ($this->codes->exposeCodes()) {
            $out['dev_code'] = $code;
        }

        return [202, $out];
    }

    /**
     * POST /drafts/current/email-verify, under the application lock: the code
     * must have been sent to the address the draft has now.
     *
     * @param array<string,mixed> $body
     * @return array<string,mixed> ApplicationDraftDto
     */
    public function verifyEmail(DoctorApplication $app, array $body): array
    {
        $code   = is_string($body['code'] ?? null) ? $body['code'] : '';
        $locked = $this->inApplicationLock($app->getId(), function (DoctorApplication $locked) use ($code): DoctorApplication {
            $this->assertStillDraft($locked);
            $this->codes->verifyEmailConfirm($locked->getId(), $locked->getEmail(), $code);
            $locked->markEmailVerified(ClinicTime::now());

            return $locked;
        });

        return $this->views->draft($locked);
    }

    /**
     * POST /drafts/current/submit (spec §3.2.15). Idempotent: a replay — or the
     * loser of a race — answers 200 with the same reference. The gates run
     * again on the row re-read under the lock; if its email changed while
     * submit waited, 409 `status_changed` (the email lock and the conflict
     * checks were for the old address).
     *
     * @return array<string,string> SubmittedApplicationDto
     */
    public function submit(DoctorApplication $app): array
    {
        if (!$app->isDraft()) {
            return ApplicationViews::submitted($app);
        }
        $this->assertSubmittable($app);

        $id    = $app->getId();
        $email = $app->getEmail();
        $conn  = $this->em->getConnection();
        $conn->beginTransaction();
        try {
            $conn->executeStatement('SELECT pg_advisory_xact_lock(' . self::LOCK_EMAIL . ', hashtext(?))', [$email]);
            $locked = $this->applications->findForUpdate($id) ?? throw new EntityNotFoundException('Application not found');
            if (!$locked->isDraft()) {
                $conn->rollBack(); // a concurrent submit won

                return ApplicationViews::submitted($locked);
            }
            if ($locked->getEmail() !== $email) {
                throw new ApplicationProblem(409, 'status_changed', 'Your application changed while it was being sent. Check your details and submit again.');
            }
            $this->assertSubmittable($locked);
            if ($this->applications->openForEmail($email, $id) !== null) {
                throw new ApplicationProblem(409, 'duplicate_open_application', 'You already have an application in progress with this email. Check its status with your reference number.');
            }
            if ($this->alreadyRegistered($email)) {
                throw new ApplicationProblem(409, 'already_registered', 'You already have a VideoMed doctor account. Sign in to the doctor portal instead.');
            }
            $now       = ClinicTime::now();
            $reference = $this->assignReference($now);
            $locked->markSubmitted($reference, $now);
            $this->em->persist(new DoctorApplicationEvent($id, 'submitted', 'applicant', S::DRAFT->value, S::SUBMITTED->value, applicantVisible: true, at: $now));
            $this->em->flush();
            $this->audit->record('Applicant', 'applicant', 'doctor_application.submitted', null, 'doctor_application', $id, ['reference' => $reference]);
            $conn->commit();
        } catch (\Throwable $e) {
            if ($conn->isTransactionActive()) {
                $conn->rollBack();
            }

            throw $this->backstop($e, $id);
        }

        $this->notifier->submitted($locked);
        $this->notifier->dispatch();

        return ApplicationViews::submitted($locked);
    }

    /**
     * DELETE /drafts/current: the documents and the draft, then the files —
     * under the application lock, so a submit that committed meanwhile wins
     * (409 `draft_submitted`) and keeps its files.
     */
    public function discard(DoctorApplication $app): void
    {
        SM::assertCan($app->getStatus(), SM::DISCARD);
        if (!$this->purger->purge($app)) {
            throw self::draftSubmitted($app); // the purge re-read the row (refreshing $app): submitted meanwhile
        }
    }

    // ----- Track (status check) -----

    /**
     * POST /track/start: always the same shape (spec §3.5) — the channel of
     * what was typed shows its mask, the other one a generic phrase.
     *
     * @param array<string,mixed> $body
     * @return array<string,mixed> TrackStartDto
     */
    public function trackStart(array $body): array
    {
        $reference = ApplicationReference::normalise(is_string($body['reference'] ?? null) ? $body['reference'] : '');
        $contact   = trim(is_string($body['contact'] ?? null) ? $body['contact'] : '');
        $errors    = [];
        if (!ApplicationReference::isValid($reference)) {
            $errors['reference'] = 'Enter your reference number, e.g. GVM-DR-2026-12345.';
        }
        $kind  = ApplicantContact::looksLikeEmail($contact) ? 'email' : 'phone';
        $email = $kind === 'email' ? strtolower($contact) : null;
        $phone = $kind === 'phone' ? PhoneNumber::toE164($contact) : null;
        if (($kind === 'email' && !ApplicationSections::emailOk((string) $email)) || ($kind === 'phone' && $phone === null)) {
            $errors['contact'] = 'Enter the email or phone number you applied with.';
        }
        if ($errors !== []) {
            throw new ValidationException($errors, (string) reset($errors));
        }

        $app   = $this->applications->findByReference($reference);
        $match = $app !== null && !$app->isDraft()
            && ($kind === 'email' ? $app->getEmail() === $email : $app->getPhone() === $phone);

        $destinations = $kind === 'email'
            ? ['email' => ApplicantContact::maskEmail((string) $email), 'sms' => ApplicantContact::GENERIC_PHONE]
            : ['email' => ApplicantContact::GENERIC_EMAIL, 'sms' => ApplicantContact::maskPhone((string) $phone)];
        $tid = $this->codes->startTrack($match ? $app->getId() : null, $kind, $destinations);

        $channels = [];
        if ($this->termii->isConfigured()) {
            $channels[] = ['channel' => 'sms', 'destination' => $destinations['sms'], 'generic' => $kind !== 'phone', 'default' => $kind === 'phone'];
        }
        $channels[] = ['channel' => 'email', 'destination' => $destinations['email'], 'generic' => $kind !== 'email', 'default' => $kind === 'email'];
        if (!in_array(true, array_column($channels, 'default'), true)) {
            $channels[0]['default'] = true;
        }

        return ['track_id' => $tid, 'expires_in' => ApplicationCodeService::TRACK_TTL, 'channels' => $channels];
    }

    /**
     * POST /track/request-code: always 202 (410 once the check timed out); a
     * code goes out only for a match, after the response.
     *
     * @param array<string,mixed> $body
     * @return array<string,mixed> CodeSentDto
     */
    public function trackRequestCode(array $body): array
    {
        $tid     = is_string($body['track_id'] ?? null) ? $body['track_id'] : '';
        $channel = $body['channel'] ?? null;
        if (!in_array($channel, ['sms', 'email'], true)) {
            throw new ValidationException(['channel' => 'Choose how to get your code.']);
        }
        // Before the response, the same for a match and a mismatch: the check's
        // cooldown and a placeholder code that verifies nothing (spec §3.5 #2).
        $opened  = $this->codes->openTrackCode($tid, $channel);
        $session = $opened['session'];
        $aid     = is_string($session['aid'] ?? null) ? $session['aid'] : null;
        $devCode = null;
        if ($opened['fresh'] && $aid !== null) {
            // The lookup, the per-application cooldown and the caps — and so any
            // timing difference — come after the response. A real code replaces
            // the placeholder only when it is actually sent.
            $arm = function () use ($tid, $aid, $channel): ?array {
                $app  = $this->applications->findApplication($aid);
                $dest = ($app === null || $app->isDraft()) ? null
                    : ($channel === 'email' ? $app->getEmail() : ($this->termii->isConfigured() ? $app->getPhone() : null));
                $code = $dest !== null ? $this->codes->armTrackCode($tid, $aid, $channel, $dest) : null;

                return $app !== null && $code !== null ? [$app, $code] : null;
            };
            if ($this->codes->exposeCodes()) {
                // Outside production the decision runs now so `dev_code` can show it (codes are never exposed where timing matters).
                $armed = $arm();
                if ($armed !== null) {
                    [$app, $devCode] = $armed;
                    $code = $devCode;
                    AfterResponse::defer(fn () => $this->notifier->trackCode($app, $channel, $code, slotClaimed: true));
                }
            } else {
                AfterResponse::defer(function () use ($arm, $channel): void {
                    try {
                        $armed = $arm();
                        if ($armed !== null) {
                            $this->notifier->trackCode($armed[0], $channel, $armed[1], slotClaimed: true);
                        }
                    } catch (\Throwable $e) {
                        $this->logger?->warning('Status code not sent', ['error' => $e::class]);
                    }
                });
            }
        }
        $out = [
            'sent_to'      => (string) ($channel === 'email' ? $session['email_mask'] : $session['phone_mask']),
            'expires_in'   => ApplicationCodeService::CODE_TTL,
            'resend_after' => ApplicationCodeService::COOLDOWN,
        ];
        if ($this->codes->exposeCodes()) {
            $out['dev_code'] = $devCode;
        }

        return $out;
    }

    /**
     * @param array<string,mixed> $body
     * @return array{access_token:string, expires_in:int} TrackSessionDto
     */
    public function trackVerify(array $body): array
    {
        $tid  = is_string($body['track_id'] ?? null) ? $body['track_id'] : '';
        $code = is_string($body['code'] ?? null) ? $body['code'] : '';
        $aid  = $this->codes->verifyTrackCode($tid, $code);
        $app  = $this->applications->findApplication($aid);
        if ($app === null || $app->isDraft()) {
            throw ApplicationCodeService::trackExpired();
        }

        return [
            'access_token' => $this->jwt->issueApplicantToken($app->getId(), JwtService::APPLICATION_ACCESS, self::ACCESS_TOKEN_TTL),
            'expires_in'   => self::ACCESS_TOKEN_TTL,
        ];
    }

    /** @return array<string,mixed> ApplicationStatusDto */
    public function status(DoctorApplication $app): array
    {
        return $this->views->status($app);
    }

    /** @return array<string,mixed> ApplicantApplicationDto */
    public function applicantApplication(DoctorApplication $app): array
    {
        return $this->views->applicantApplication($app);
    }

    // ----- More info (the applicant's response) -----

    /**
     * PUT /track/info-response/sections/{section}: only a section the open
     * request asked for; full validation; the email can't change.
     *
     * @param array<string,mixed> $body
     * @return array<string,mixed> ApplicantApplicationDto
     */
    public function saveInfoSection(DoctorApplication $app, string $section, array $body): array
    {
        if (!isset(ApplicationViews::SECTION_LABELS[$section])) {
            throw new ApplicationProblem(403, 'item_not_requested', "We didn't ask for changes to this section.");
        }
        $locked = $this->inApplicationLock($app->getId(), function (DoctorApplication $locked) use ($section, $body): DoctorApplication {
            $request = $this->openRequestOrRefuse($locked);
            if (!$request->asks('section', $section)) {
                throw new ApplicationProblem(403, 'item_not_requested', "We didn't ask for changes to this section.");
            }
            $result = $this->checkSection($locked, $section, $body, false);
            if ($section === 'personal' && ($result['values']['email'] ?? null) !== $locked->getEmail()) {
                throw new ValidationException(['email' => "You can't change your email after submitting. Contact support."]);
            }
            $this->applySection($locked, $section, $result['values'], ClinicTime::now(), '', '');
            $this->em->persist(new DoctorApplicationEvent($locked->getId(), 'info_item_updated', 'applicant', metadata: ['section' => $section, 'info_request_id' => $request->getId()]));

            return $locked;
        });

        return $this->views->applicantApplication($locked);
    }

    /**
     * POST /track/info-response/documents: only a requested slot. The previous
     * document becomes `replaced` (kept); one uploaded earlier in this same
     * response is deleted instead, the new one taking over what it replaced.
     *
     * @return array<string,mixed> ApplicationDocumentDto
     */
    public function uploadInfoDocument(DoctorApplication $app, string $slot, UploadedFileInterface $file): array
    {
        if (!in_array($slot, ApplicationDocuments::ALL, true)) {
            throw new ApplicationProblem(403, 'item_not_requested', "We didn't ask for this document.");
        }
        $read    = $this->store->read($file);
        $oldKeys = [];
        $doc     = $this->withUpload($app->getId(), $read, function (DoctorApplication $locked, string $key) use ($slot, $read, &$oldKeys): DoctorApplicationDocument {
            $request = $this->openRequestOrRefuse($locked);
            if (!$request->asks('document', $slot)) {
                throw new ApplicationProblem(403, 'item_not_requested', "We didn't ask for this document.");
            }
            $previous = null;
            foreach ($this->documents->forApplication($locked->getId()) as $d) {
                $sameRequest = $d->getInfoRequestId() === $request->getId();
                if ($d->isActive() && $d->getSlot() === $slot && ($slot !== ApplicationDocuments::ADDITIONAL || $sameRequest)) {
                    $previous = $d;
                }
            }
            $ownEarlier = $previous !== null && $previous->getInfoRequestId() === $request->getId();
            $this->assertCaps($locked->getId(), $read['size'], $ownEarlier ? [$previous] : []);

            $doc = new DoctorApplicationDocument(
                $locked->getId(),
                $slot,
                $key,
                $read['name'],
                $read['mime'],
                $read['size'],
                $read['sha256'],
                DoctorApplicationDocument::DURING_INFO,
                $request->getId(),
                $slot === ApplicationDocuments::ADDITIONAL ? $request->additionalLabel() : null,
            );
            if ($previous !== null && $ownEarlier) {
                $doc->setReplacesDocumentId($previous->getReplacesDocumentId());
                $oldKeys[] = $previous->getVaultKey();
                $this->em->remove($previous);
            } elseif ($previous !== null) {
                $previous->markReplaced();
                $doc->setReplacesDocumentId($previous->getId());
            }
            $this->em->persist($doc);
            $this->em->persist(new DoctorApplicationEvent($locked->getId(), 'info_item_updated', 'applicant', metadata: ['slot' => $slot, 'info_request_id' => $request->getId()]));

            return $doc;
        });
        foreach ($oldKeys as $key) {
            $this->store->delete($key);
        }

        return ApplicationViews::document($doc, $app->getLicenceRoute());
    }

    /** DELETE /track/info-response/documents/{docId}: only one sent in this response; the one it replaced comes back. */
    public function deleteInfoDocument(DoctorApplication $app, string $docId): void
    {
        $key = $this->inApplicationLock($app->getId(), function (DoctorApplication $locked) use ($docId): string {
            $request = $this->openRequestOrRefuse($locked);
            $doc     = $this->documents->findForApplication($docId, $locked->getId());
            if ($doc === null || $doc->getInfoRequestId() !== $request->getId() || $doc->getUploadedDuring() !== DoctorApplicationDocument::DURING_INFO) {
                throw new EntityNotFoundException('Document not found');
            }
            $replaced = $doc->getReplacesDocumentId() !== null ? $this->documents->findForApplication($doc->getReplacesDocumentId(), $locked->getId()) : null;
            $replaced?->reactivate();
            $this->em->remove($doc);

            return $doc->getVaultKey();
        });
        $this->store->delete($key);
    }

    /**
     * POST /track/info-response/submit: every requested section saved and every
     * requested document uploaded since the request — then back to Under review.
     *
     * @param array<string,mixed> $body
     * @return array<string,mixed> ApplicationStatusDto
     */
    public function submitInfoResponse(DoctorApplication $app, array $body): array
    {
        $note = $body['note'] ?? null;
        if ($note !== null && (!is_string($note) || mb_strlen(trim($note)) > self::MAX_NOTE)) {
            throw new ValidationException(['note' => 'Keep your note to ' . self::MAX_NOTE . ' characters.']);
        }
        $locked = $this->inApplicationLock($app->getId(), function (DoctorApplication $locked) use ($note): DoctorApplication {
            $to      = SM::assertCan($locked->getStatus(), SM::APPLICANT_REPLY);
            $request = $this->openRequestOrRefuse($locked);
            $missing = $this->missingItems($locked, $request);
            if ($missing !== []) {
                $labels = array_map(static fn (array $i): string => (string) $i['label'], $missing);
                throw new ApplicationProblem(422, 'incomplete', 'Send every item we asked for: ' . implode(', ', $labels) . '.', ['items' => $missing]);
            }
            $now = ClinicTime::now();
            $request->respond(is_string($note) ? $note : null, $now);
            $from = $locked->getStatus();
            $locked->setStatus($to ?? S::UNDER_REVIEW);
            $locked->setLastApplicantReplyAt($now);
            $locked->setAwaitingStaff(true);
            $this->em->persist(new DoctorApplicationEvent($locked->getId(), 'applicant_replied', 'applicant', $from->value, S::UNDER_REVIEW->value, applicantVisible: true, at: $now));
            $this->em->flush();
            $this->audit->record('Applicant', 'applicant', 'doctor_application.info_received', null, 'doctor_application', $locked->getId(), ['reference' => $locked->getReference()]);
            $this->notifier->infoReceived($locked);

            return $locked;
        });
        $this->notifier->dispatch();

        return $this->views->status($locked);
    }

    /**
     * POST /track/withdraw: a ticked confirmation and an optional reason; only
     * while open (409 `not_allowed` once decided — even a moment ago).
     *
     * @param array<string,mixed> $body
     * @return array<string,mixed> ApplicationStatusDto
     */
    public function withdraw(DoctorApplication $app, array $body): array
    {
        if (($body['confirm'] ?? null) !== true) {
            throw new ValidationException(['confirm' => 'Tick the box to confirm.']);
        }
        $reason = $body['reason'] ?? null;
        if ($reason !== null && (!is_string($reason) || !isset(ApplicationViews::WITHDRAW_REASONS[$reason]))) {
            throw new ValidationException(['reason' => 'Choose a reason from the list.']);
        }
        $locked = $this->inApplicationLock($app->getId(), function (DoctorApplication $locked) use ($reason): DoctorApplication {
            $from = $locked->getStatus();
            $to   = SM::assertCan($from, SM::WITHDRAW) ?? S::WITHDRAWN;
            $now  = ClinicTime::now();
            $locked->setStatus($to);
            $locked->setWithdrawReason(is_string($reason) ? $reason : null);
            $locked->setAwaitingStaff(false);
            $this->requests->openFor($locked->getId())?->close(DoctorApplicationInfoRequest::CLOSE_WITHDRAWN, $now);
            $this->em->persist(new DoctorApplicationEvent($locked->getId(), 'withdrawn', 'applicant', $from->value, $to->value, applicantVisible: true, at: $now));
            $this->em->flush();
            $this->audit->record('Applicant', 'applicant', 'doctor_application.withdrawn', null, 'doctor_application', $locked->getId(), ['reference' => $locked->getReference(), 'reason' => $reason]);
            $this->notifier->withdrawn($locked, $from !== S::SUBMITTED);

            return $locked;
        });
        $this->notifier->dispatch();

        return $this->views->status($locked);
    }

    // ----- Helpers -----

    public static function draftSubmitted(DoctorApplication $app): ApplicationProblem
    {
        return new ApplicationProblem(409, 'draft_submitted', 'This application has already been submitted. Check its status with your reference number.', ['reference' => $app->getReference()]);
    }

    /** Every draft write re-checks the row it locked: a submit may have committed while it waited. */
    private function assertStillDraft(DoctorApplication $locked): void
    {
        if (!$locked->isDraft()) {
            throw self::draftSubmitted($locked);
        }
    }

    /** Submit's gates (spec §3.2.15 steps 2–3): the current consent wording, every step, a proven email. */
    private function assertSubmittable(DoctorApplication $app): void
    {
        $consent = $app->section('consent');
        if ($consent !== null && ($consent['consent_version'] ?? null) !== ApplicationSections::CONSENT_VERSION) {
            throw new ApplicationProblem(409, 'consent_outdated', 'The consent wording has changed. Please read it again.');
        }
        $steps      = $this->views->steps($app, $this->documents->activeFor($app->getId()));
        $incomplete = array_keys(array_filter($steps, static fn (string $s): bool => $s !== 'complete'));
        if ($incomplete !== []) {
            throw new ApplicationProblem(422, 'incomplete', 'Complete every step before you submit.', ['steps' => $incomplete]);
        }
        if (!$app->isEmailVerified()) {
            throw new ApplicationProblem(409, 'email_unverified', 'Confirm your email before you submit.');
        }
    }

    /**
     * Mark a draft's email as proven — under the application lock, and only if
     * the re-read row is still a live draft that `$stillProves` accepts (the
     * code or link is still the one on file, for this address). Null
     * otherwise, also when the row is gone.
     *
     * @param callable(DoctorApplication): bool $stillProves
     */
    private function markVerifiedIf(string $id, DateTimeImmutable $now, callable $stillProves): ?DoctorApplication
    {
        try {
            return $this->inApplicationLock($id, static function (DoctorApplication $locked) use ($now, $stillProves): ?DoctorApplication {
                if (!$locked->isDraft() || $locked->isExpiredDraft($now) || !$stillProves($locked)) {
                    return null;
                }
                $locked->markEmailVerified($now);

                return $locked;
            });
        } catch (EntityNotFoundException) {
            return null; // discarded meanwhile
        }
    }

    /** @return array<string,mixed> DraftSessionDto (dev fields added by the caller) */
    private function session(DoctorApplication $app): array
    {
        return [
            'draft_token' => $this->jwt->issueApplicantToken($app->getId(), JwtService::APPLICATION_DRAFT, self::DRAFT_TOKEN_TTL),
            'expires_in'  => self::DRAFT_TOKEN_TTL,
            'draft'       => $this->views->draft($app),
        ];
    }

    /**
     * A new draft code + resume link (the old ones stop working). Only hashes are stored.
     *
     * @return array{code:string, token:string, link:string}
     */
    private function issueResumeSecrets(DoctorApplication $app, DateTimeImmutable $now): array
    {
        $code  = ApplicationCodeService::newDraftCode();
        $token = rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
        $app->setResumeSecrets($this->codes->hash($app->getId(), $code), hash('sha256', $token), $now, $now->modify('+' . self::RESUME_LINK_DAYS . ' days'));

        return ['code' => $code, 'token' => $token, 'link' => WebUrls::forApplication($app->getWebOrigin()) . '/resume#t=' . $token];
    }

    /** @param array{code:string, token:string, link:string} $secrets @return array<string,string> */
    private function devSecrets(array $secrets): array
    {
        return $this->codes->exposeCodes() ? ['dev_draft_code' => $secrets['code'], 'dev_resume_link' => $secrets['link']] : [];
    }

    /**
     * Validate a section's input (spec §2.11); consent must echo the current wording.
     *
     * @param array<string,mixed> $body
     * @return array{values: array<string,mixed>, errors: array<string,string>}
     */
    private function checkSection(DoctorApplication $app, string $section, array $body, bool $partial): array
    {
        if (!in_array($section, ApplicationSections::SECTIONS, true)) {
            throw new EntityNotFoundException('Unknown section');
        }
        $values = is_array($body['values'] ?? null) ? $body['values'] : [];
        if ($section === 'consent') {
            $version = $values['consent_version'] ?? null;
            if ((!$partial || $version !== null) && $version !== ApplicationSections::CONSENT_VERSION) {
                throw new ApplicationProblem(409, 'consent_outdated', 'The consent wording has changed. Please read it again.');
            }
        }
        $result = ApplicationSections::validate(
            $section,
            $values,
            $app->getLicenceRoute(),
            ClinicTime::todayYmd(),
            $partial,
            $this->views->specialtyResolver(),
            $app->section('personal') ?? [],
        );
        if ($result['errors'] !== []) {
            throw new ValidationException($result['errors'], (string) reset($result['errors']));
        }

        return $result;
    }

    /**
     * Store a section and its promoted columns (consent: plus its evidence).
     *
     * @param array<string,mixed> $values
     */
    private function applySection(DoctorApplication $app, string $section, array $values, DateTimeImmutable $now, string $ip, string $userAgent): void
    {
        switch ($section) {
            case 'personal':
                $this->applyPersonal($app, $values);
                return;
            case 'professional':
                $app->setSection('professional', $values);
                if (isset($values['specialty'])) {
                    $app->setSpecialty((string) $values['specialty']);
                }
                return;
            case 'licence':
                $app->setSection('licence', $values);
                $date = static fn (mixed $v): ?DateTimeImmutable => is_string($v) && ApplicationSections::parseYmd($v) !== null
                    ? (DateTimeImmutable::createFromFormat('!Y-m-d', $v) ?: null)
                    : null;
                if ($app->getLicenceRoute() === 'abroad') {
                    $app->setAbroadLicence(
                        $values['regulator_country'] ?? null,
                        $values['regulator_name'] ?? null,
                        $values['registration_number'] ?? null,
                        $date($values['good_standing_issued_on'] ?? null),
                    );
                } else {
                    $app->setNgLicence($values['mdcn_number'] ?? null, $date($values['licence_expires_on'] ?? null));
                }
                return;
            case 'consent':
                $values['consented_at'] = $now->format(DATE_ATOM);
                $app->setSection('consent', $values);
                $app->setConsent($values + [
                    'consent_ip' => $ip !== '' ? mb_substr($ip, 0, 45) : null,
                    'user_agent' => $userAgent !== '' ? mb_substr($userAgent, 0, 300) : null,
                ]);
                return;
            default:
                $app->setSection($section, $values);
        }
    }

    /** @param array<string,mixed> $values */
    private function applyPersonal(DoctorApplication $app, array $values): void
    {
        // A partial save without the email keeps the one on file (the draft always has one).
        if (!isset($values['email']) || !is_string($values['email']) || $values['email'] === '') {
            $values = ['email' => $app->getEmail()] + $values;
        }
        $app->setSection('personal', $values);
        $app->setNames($values['first_name'] ?? null, $values['last_name'] ?? null);
        if (isset($values['email']) && is_string($values['email']) && $values['email'] !== '') {
            $app->setEmail($values['email']); // a new address forgets the confirmation and the code + link sent to the old one; sends nothing (D31)
        }
        if (isset($values['phone']) && is_string($values['phone']) && str_starts_with($values['phone'], '+')) {
            $app->setPhone($values['phone']);
        }
        if (isset($values['country_of_residence']) && is_string($values['country_of_residence'])) {
            $app->setResidenceCountry($values['country_of_residence']);
        }
    }

    /**
     * Run an upload's database work under the application's row lock, with its
     * bytes reserved from the daily budget and sealed in the vault first; any
     * failure gives the budget back and deletes the new file.
     *
     * @param array{bytes:string, name:string, mime:string, size:int, sha256:string} $read
     * @param callable(DoctorApplication, string): DoctorApplicationDocument $work
     */
    private function withUpload(string $id, array $read, callable $work): DoctorApplicationDocument
    {
        $this->store->reserve($read['size']);
        try {
            $key = $this->store->store($read['bytes']);
        } catch (\Throwable $e) {
            $this->store->release($read['size']);

            throw $e;
        }
        try {
            return $this->inApplicationLock($id, fn (DoctorApplication $locked): DoctorApplicationDocument => $work($locked, $key));
        } catch (\Throwable $e) {
            $this->store->delete($key);
            $this->store->release($read['size']);

            throw $e;
        }
    }

    /**
     * 20 files and 40MB per application, counting every row (replaced ones too)
     * except those this upload deletes.
     *
     * @param list<DoctorApplicationDocument> $leaving
     */
    private function assertCaps(string $applicationId, int $size, array $leaving): void
    {
        $usage = $this->documents->usage($applicationId);
        $count = $usage['count'] - count($leaving);
        $bytes = $usage['bytes'] - array_sum(array_map(static fn (DoctorApplicationDocument $d): int => $d->getSizeBytes(), $leaving));
        if ($count + 1 > self::MAX_FILES || $bytes + $size > self::MAX_APP_BYTES) {
            throw new ApplicationProblem(422, 'upload_limit', "You've reached the upload limit for this application. Remove a file and try again.");
        }
    }

    /**
     * One transaction under the application lock (advisory + re-read row lock).
     *
     * @template T
     * @param callable(DoctorApplication): T $work
     * @return T
     */
    private function inApplicationLock(string $id, callable $work): mixed
    {
        $conn = $this->em->getConnection();
        $conn->beginTransaction();
        try {
            $conn->executeStatement('SELECT pg_advisory_xact_lock(' . self::LOCK_APPLICATION . ', hashtext(?))', [$id]);
            $locked = $this->applications->findForUpdate($id) ?? throw new EntityNotFoundException('Application not found');
            $result = $work($locked);
            $this->em->flush();
            $conn->commit();

            return $result;
        } catch (\Throwable $e) {
            if ($conn->isTransactionActive()) {
                $conn->rollBack();
            }
            $this->notifier->discard();

            throw $this->backstop($e, $id);
        }
    }

    /** The open info request, or 409 not_allowed (nothing is waiting on the applicant). */
    private function openRequestOrRefuse(DoctorApplication $app): DoctorApplicationInfoRequest
    {
        if ($app->getStatus() !== S::MORE_INFO_NEEDED) {
            throw new ApplicationProblem(409, 'not_allowed', "This application isn't waiting for more information.");
        }

        return $this->requests->openFor($app->getId())
            ?? throw new ApplicationProblem(409, 'not_allowed', "This application isn't waiting for more information.");
    }

    /**
     * The requested items not yet sent: sections saved since the request,
     * documents uploaded in this response.
     *
     * @return list<array{kind:string, key:string, label:string}>
     */
    private function missingItems(DoctorApplication $app, DoctorApplicationInfoRequest $request): array
    {
        $sections = array_fill_keys($this->views->updatedSections($app, $request), true);
        $slots    = [];
        foreach ($this->documents->forApplication($app->getId()) as $doc) {
            if ($doc->isActive() && $doc->getInfoRequestId() === $request->getId()) {
                $slots[$doc->getSlot()] = true;
            }
        }
        $missing = [];
        foreach ($request->getItems() as $item) {
            $done = ($item['kind'] ?? '') === 'section' ? isset($sections[$item['key']]) : isset($slots[$item['key']]);
            if (!$done) {
                $missing[] = $item;
            }
        }

        return $missing;
    }

    /** A live doctor account for this email: an approved application, a doctor login, or a profile not turned down. */
    private function alreadyRegistered(string $email): bool
    {
        if ($this->applications->approvedForEmail($email)) {
            return true;
        }
        $user = $this->users->findByEmail($email);
        if ($user !== null && in_array('doctor', $user->getRoles(), true)) {
            return true;
        }
        foreach ($this->specialists->findByEmail($email) as $s) {
            if ($s instanceof Specialist && $s->getStatus() !== SpecialistStatus::REJECTED) {
                return true;
            }
        }

        return false;
    }

    /** A random free reference for the clinic year, under the reference lock (D7). */
    private function assignReference(DateTimeImmutable $now): string
    {
        $this->em->getConnection()->executeStatement('SELECT pg_advisory_xact_lock(' . self::LOCK_REFERENCE . ', 0)');
        $year = (int) ClinicTime::now()->format('Y');
        for ($i = 0; $i < 10; $i++) {
            $candidate = ApplicationReference::candidate($year);
            if (!$this->applications->referenceTaken($candidate)) {
                return $candidate;
            }
        }

        throw new ApplicationProblem(409, 'status_changed', 'We could not number your application just now. Please try again.');
    }

    /** A unique-index backstop as a coded 409, never with the database's message (it holds the email). */
    private function backstop(\Throwable $e, string $id): \Throwable
    {
        if (!$e instanceof UniqueConstraintViolationException) {
            return $e;
        }
        $this->logger?->warning('Doctor application unique constraint', ['application_id' => $id, 'error' => $e::class]);

        return str_contains($e->getMessage(), 'uniq_doctor_applications_open_email')
            ? new ApplicationProblem(409, 'duplicate_open_application', 'You already have an application in progress with this email. Check its status with your reference number.')
            : new ApplicationProblem(409, 'status_changed', 'This application changed meanwhile. Reload and try again.');
    }
}
