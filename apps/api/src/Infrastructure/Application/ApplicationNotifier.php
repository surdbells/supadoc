<?php

declare(strict_types=1);

namespace App\Infrastructure\Application;

use App\Domain\Application\ApplicantContact;
use App\Domain\Entity\DoctorApplication;
use App\Domain\Entity\DoctorApplicationEvent;
use App\Domain\Entity\DoctorApplicationInfoRequest;
use App\Domain\Settings\ClinicTime;
use App\Domain\Settings\WebUrls;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Email\MailService;
use App\Infrastructure\Service\AfterResponse;
use App\Infrastructure\Service\DoctorOnboardingService;
use App\Infrastructure\Service\StaffNotifier;
use App\Infrastructure\Service\TermiiService;
use DateTimeImmutable;
use Doctrine\ORM\EntityManagerInterface;
use Psr\Log\LoggerInterface;

/**
 * The applicant's emails and texts, and the reviewers' notices (spec §5).
 *
 * Status notices are queued while a transition's transaction is open and sent
 * after it commits ({@see dispatch()}, through AfterResponse); a failure never
 * undoes a status change. Each send after submit records an `email_sent`,
 * `sms_sent` or `notification_failed` event ({channel, template} — no
 * content). The self-service emails (resume link + code, the confirm code)
 * pass the per-address mail cap first and record nothing (drafts have no
 * events). Logs carry hashes and template keys only (MailService).
 */
final class ApplicationNotifier
{
    /** @var list<callable(): void> */
    private array $queue = [];

    public function __construct(
        private readonly MailService $mail,
        private readonly TermiiService $sms,
        private readonly StaffNotifier $staff,
        private readonly DoctorOnboardingService $onboarding,
        private readonly ApplicationCodeService $codes,
        private readonly EntityManagerInterface $em,
        private readonly ?LoggerInterface $logger = null,
        private readonly string $backofficeUrl = '',
        private readonly string $supportEmail = 'support@videomed.app',
    ) {
    }

    public function supportEmail(): string
    {
        return $this->supportEmail;
    }

    /** Send everything queued, after the response. */
    public function dispatch(): void
    {
        $queue       = $this->queue;
        $this->queue = [];
        foreach ($queue as $task) {
            AfterResponse::defer($task);
        }
    }

    /** Drop what was queued (the transaction rolled back). */
    public function discard(): void
    {
        $this->queue = [];
    }

    // ----- Self-service (no events; within the mail cap) -----

    /**
     * The resume email (link + draft code). Returns whether it went.
     * `$slotClaimed`: the caller already took today's mail slot for the address
     * (it rotates the code and link only when one is free), so it isn't counted twice.
     */
    public function resumeEmail(string $email, string $first, string $link, string $code, int $linkDays, int $draftDays, bool $slotClaimed = false): bool
    {
        if (!$slotClaimed && !$this->codes->claimMailSlot($email)) {
            return false;
        }
        $tpl = EmailTemplates::applicationSaved($first, $link, $code, $linkDays, $draftDays);

        return $this->mail->send($email, $first !== '' ? $first : 'Applicant', $tpl['subject'], $tpl['html'], 'applicationSaved');
    }

    /** A confirm-email code (before submit). */
    public function confirmCode(string $email, string $code): bool
    {
        if (!$this->codes->claimMailSlot($email)) {
            return false;
        }
        $tpl = EmailTemplates::applicationCode($code, 'confirm_email');

        return $this->mail->send($email, 'Applicant', $tpl['subject'], $tpl['html'], 'applicationCode');
    }

    /**
     * A status-check code, by email (within the mail cap) or SMS.
     * `$slotClaimed`: the mail slot was taken when the code was armed
     * ({@see ApplicationCodeService::armTrackCode}).
     */
    public function trackCode(DoctorApplication $app, string $channel, string $code, bool $slotClaimed = false): void
    {
        if ($channel === 'sms') {
            $this->sendSms($app, 'track_code', ['code' => $code]);

            return;
        }
        if (!$slotClaimed && !$this->codes->claimMailSlot($app->getEmail())) {
            return;
        }
        $this->sendEmail($app, 'applicationCode', EmailTemplates::applicationCode($code, 'track'));
    }

    // ----- Status changes (queued; sent after commit) -----

    public function submitted(DoctorApplication $app): void
    {
        $ref  = (string) $app->getReference();
        $name = $app->fullName();
        $this->queue[] = function () use ($app, $ref): void {
            $this->sendEmail($app, 'applicationSubmitted', EmailTemplates::applicationSubmitted((string) $app->getFirstName(), $ref, $this->trackUrl($app)));
            $this->sendSms($app, 'submitted', ['ref' => $ref]);
        };
        $this->reviewers($app, 'New doctor application: ' . $name, $name . ' submitted application ' . $ref . '.', true);
    }

    public function underReview(DoctorApplication $app): void
    {
        $ref = (string) $app->getReference();
        $this->queue[] = function () use ($app, $ref): void {
            $this->sendEmail($app, 'applicationUnderReview', EmailTemplates::applicationUnderReview((string) $app->getFirstName(), $ref, $this->trackUrl($app)));
            $this->sendSms($app, 'under_review', ['ref' => $ref]);
        };
    }

    public function infoRequested(DoctorApplication $app, DoctorApplicationInfoRequest $request, ?string $cancelledInterviewLabel): void
    {
        $ref    = (string) $app->getReference();
        $labels = array_map(static fn (array $i): string => (string) ($i['label'] ?? ''), $request->getItems());
        $text   = $request->getMessage();
        $this->queue[] = function () use ($app, $ref, $labels, $text, $cancelledInterviewLabel): void {
            $this->sendEmail($app, 'applicationInfoRequested', EmailTemplates::applicationInfoRequested(
                (string) $app->getFirstName(),
                $ref,
                $text,
                $labels,
                $this->trackUrl($app),
                $cancelledInterviewLabel,
            ));
            $this->sendSms($app, 'more_info', ['ref' => $ref, 'host' => (string) parse_url($this->trackUrl($app), PHP_URL_HOST)]);
        };
    }

    public function infoReceived(DoctorApplication $app): void
    {
        $ref  = (string) $app->getReference();
        $name = $app->fullName();
        $this->queue[] = function () use ($app, $ref): void {
            $this->sendEmail($app, 'applicationInfoReceived', EmailTemplates::applicationInfoReceived((string) $app->getFirstName(), $ref));
        };
        $this->reviewers($app, 'Application update: ' . $name, $name . ' sent the items you asked for on ' . $ref . '.', true);
    }

    public function interview(DoctorApplication $app, bool $rescheduled): void
    {
        $ref     = (string) $app->getReference();
        $epoch   = $app->getInterviewEpoch();
        $minutes = (int) $app->getInterviewDurationMinutes();
        $url     = (string) $app->getInterviewMeetingUrl();
        $note    = $app->getInterviewNote();
        if ($epoch === null) {
            return;
        }
        $at = (new DateTimeImmutable('@' . $epoch))->setTimezone(ClinicTime::zone());
        $this->queue[] = function () use ($app, $ref, $at, $minutes, $url, $note, $rescheduled): void {
            $this->sendEmail($app, 'applicationInterview', EmailTemplates::applicationInterview(
                (string) $app->getFirstName(),
                $ref,
                $at->format(DATE_ATOM),
                $minutes,
                $url,
                $note,
                $rescheduled,
                $this->supportEmail,
            ));
            $this->sendSms($app, 'interview', ['ref' => $ref, 'when' => ApplicationSms::when($at, ClinicTime::zone())]);
        };
    }

    /**
     * After approval: the text (the email is the set-password invite, sent
     * synchronously by the approval) and an event for each.
     */
    public function approved(DoctorApplication $app, bool $inviteEmailSent): void
    {
        $ref = (string) $app->getReference();
        $this->queue[] = function () use ($app, $ref, $inviteEmailSent): void {
            $this->record($app, $inviteEmailSent ? 'email_sent' : 'notification_failed', ['channel' => 'email', 'template' => 'applicationApproved']);
            $this->sendSms($app, 'approved', ['ref' => $ref]);
        };
    }

    public function rejected(DoctorApplication $app): void
    {
        $ref    = (string) $app->getReference();
        $reason = (string) $app->getRejectReason();
        $this->queue[] = function () use ($app, $ref, $reason): void {
            $this->sendEmail($app, 'applicationRejected', EmailTemplates::applicationRejected((string) $app->getFirstName(), $ref, $reason, $this->supportEmail));
            $this->sendSms($app, 'rejected', ['ref' => $ref]);
        };
    }

    public function withdrawn(DoctorApplication $app, bool $tellReviewers): void
    {
        $ref  = (string) $app->getReference();
        $name = $app->fullName();
        $this->queue[] = function () use ($app, $ref): void {
            $this->sendEmail($app, 'applicationWithdrawn', EmailTemplates::applicationWithdrawn((string) $app->getFirstName(), $ref));
            $this->sendSms($app, 'withdrawn', ['ref' => $ref]);
        };
        if ($tellReviewers) {
            $this->reviewers($app, 'Application withdrawn: ' . $name, $name . ' withdrew application ' . $ref . '.', false);
        }
    }

    // ----- Helpers -----

    /** The applicant's status-check page on the site they applied from. */
    public function trackUrl(DoctorApplication $app): string
    {
        return WebUrls::forApplication($app->getWebOrigin()) . '/?dialog=track';
    }

    /**
     * The reviewers (`specialists.manage`): in-app now (after commit, with the
     * rest), by email after the response when `$email`. Name and reference only.
     */
    private function reviewers(DoctorApplication $app, string $headline, string $text, bool $email): void
    {
        $path = '/applications/' . $app->getId();
        $this->queue[] = function () use ($headline, $text, $path, $email): void {
            $this->staff->notifyPermission('specialists.manage', 'application', $headline, $text, $path);
            if ($email) {
                $this->onboarding->emailReviewersTemplate(EmailTemplates::reviewerNotice($headline, $text, $this->backofficeUrl, $path), 'reviewerNotice');
            }
        };
    }

    /** @param array{subject:string, html:string} $tpl */
    private function sendEmail(DoctorApplication $app, string $template, array $tpl): void
    {
        $sent = false;
        try {
            $sent = $this->mail->send($app->getEmail(), (string) ($app->getFirstName() ?? 'Applicant'), $tpl['subject'], $tpl['html'], $template);
        } catch (\Throwable) {
            // send() never throws by contract
        }
        $this->record($app, $sent ? 'email_sent' : 'notification_failed', ['channel' => 'email', 'template' => $template]);
    }

    /** @param array<string,string> $vars */
    private function sendSms(DoctorApplication $app, string $key, array $vars): void
    {
        $phone = $app->getPhone();
        if (!$this->sms->isConfigured() || $phone === null) {
            $this->record($app, 'notification_failed', ['channel' => 'sms', 'template' => $key, 'reason' => 'sms_unconfigured']);

            return;
        }
        $sent = $this->sms->send($phone, ApplicationSms::text($key, $vars));
        $this->record($app, $sent ? 'sms_sent' : 'notification_failed', ['channel' => 'sms', 'template' => $key]);
    }

    /** @param array<string,string> $metadata */
    private function record(DoctorApplication $app, string $kind, array $metadata): void
    {
        if ($app->isDraft() || !$this->em->isOpen()) {
            return; // no events before submit
        }
        try {
            $this->em->persist(new DoctorApplicationEvent($app->getId(), $kind, 'system', metadata: $metadata));
            $this->em->flush();
        } catch (\Throwable $e) {
            $this->logger?->warning('Application notification event not recorded', ['application_id' => $app->getId(), 'error' => $e::class]);
        }
    }

    /** "Ada***@…" — what the applicant is told a message went to. */
    public static function maskedEmail(DoctorApplication $app): string
    {
        return ApplicantContact::maskEmail($app->getEmail());
    }
}
