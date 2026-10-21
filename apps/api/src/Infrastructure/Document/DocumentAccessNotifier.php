<?php

declare(strict_types=1);

namespace App\Infrastructure\Document;

use App\Domain\Document\ShareDuration;
use App\Domain\Entity\Patient;
use App\Domain\Enum\NotificationType;
use App\Domain\Settings\ClinicTime;
use App\Domain\Settings\WebUrls;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Email\MailService;
use App\Infrastructure\Service\AfterResponse;
use App\Infrastructure\Service\PatientNotifier;
use App\Infrastructure\Service\StaffNotifier;
use DateTimeImmutable;
use Predis\ClientInterface as RedisClient;

/**
 * Every string document sharing sends anyone (spec §4, §1.2), and the
 * queueing of those notices for after the commit ({@see DocumentAccessNoticeQueue}).
 *
 * Copy guard (spec §4.5): medical documents are PHI, so a title, a body, an
 * email or a reschedule sentence names at most a doctor or a patient — never
 * a document's title or type, a medicine, a diagnosis, a specialty, a visit
 * reason or the doctor's note. Every text is built here from constants with
 * names only (DocumentAccessNotifierTest).
 */
final class DocumentAccessNotifier
{
    // ----- Patient (in-app, type `document`) -----
    public const REQUEST_TITLE           = 'Document access request';
    public const REQUEST_BODY            = '%s asked to see your medical documents. Review the request to choose what to share and for how long, or decline it.';
    public const REINSTATED_TITLE        = 'Sharing with your doctor';
    public const REINSTATED_BODY         = '%s is practising on VideoMed again and can see what you shared with them. Review sharing.';
    public const REINSTATED_ENDED_TITLE  = 'Sharing with your doctor ended';
    public const REINSTATED_ENDED_BODY   = '%s is practising on VideoMed again. They were away for more than 30 days, so your sharing with them ended. Share again if you want them to see your documents.';

    // ----- Release notice (prod-migrate step 12; patients type `system`) -----
    public const RELEASE_TITLE         = 'Your documents are now private';
    public const RELEASE_BODY_GENERIC  = 'Doctors can no longer see your medical documents unless you share them. Open Medical Documents to choose who can see what, and for how long.';
    public const RELEASE_BODY_UPCOMING = 'Doctors can no longer see your medical documents unless you share them, including files you attached to an upcoming consultation. Open the consultation to choose what your doctor can see.';
    public const DOCTOR_RELEASE_TITLE  = 'Patients now choose what you see';
    public const DOCTOR_RELEASE_BODY   = "You'll only see the documents a patient chooses to share with you. You can ask a patient to share from their consultation's Documents tab.";

    // ----- Doctor (in-app, type `document_access`) -----
    public const STAFF_TYPE      = 'document_access';
    public const SHARED_TITLE    = 'Documents shared with you';
    public const SHARED_BODY     = '%s shared documents with you.';
    public const APPROVED_TITLE  = 'Access request approved';
    public const APPROVED_BODY   = '%s approved your request and shared documents with you.';
    public const DECLINED_TITLE  = 'Access request declined';
    public const DECLINED_BODY   = '%s declined your request to see their documents.';
    public const CLOSED_TITLE    = 'Access request closed';
    public const CLOSED_BODY     = "%s didn't answer your request to see their documents within 7 days.";

    // ----- The doctor-reschedule notice's extra sentence -----
    public const RESCHEDULE_SUFFIX        = 'Documents you shared for this consultation stay shared until %s after the new time.';
    public const RESCHEDULE_SUFFIX_CAPPED = 'Documents you shared for this consultation stay shared until %s.';

    /** "Documents shared with you" is sent at most once per pair per this many seconds. */
    public const SHARE_COALESCE_SECONDS = 600;

    public function __construct(
        private readonly DocumentAccessNoticeQueue $queue,
        private readonly PatientNotifier $patients,
        private readonly StaffNotifier $staff,
        private readonly MailService $mail,
        private readonly ?RedisClient $redis = null,
    ) {
    }

    // ----- Copy (pure) -----

    /** @return array{title:string, body:string} */
    public static function requestNotice(string $doctorName): array
    {
        return ['title' => self::REQUEST_TITLE, 'body' => sprintf(self::REQUEST_BODY, self::name($doctorName, 'Your doctor'))];
    }

    /** @return array{title:string, body:string} */
    public static function reinstatedNotice(string $doctorName, bool $ended): array
    {
        $doctor = self::name($doctorName, 'Your doctor');

        return $ended
            ? ['title' => self::REINSTATED_ENDED_TITLE, 'body' => sprintf(self::REINSTATED_ENDED_BODY, $doctor)]
            : ['title' => self::REINSTATED_TITLE, 'body' => sprintf(self::REINSTATED_BODY, $doctor)];
    }

    /**
     * A doctor notice: `shared`, `approved`, `declined` or `closed`.
     *
     * @return array{title:string, body:string}
     */
    public static function doctorNotice(string $kind, string $patientName): array
    {
        $patient = self::name($patientName, 'A patient');

        return match ($kind) {
            'approved' => ['title' => self::APPROVED_TITLE, 'body' => sprintf(self::APPROVED_BODY, $patient)],
            'declined' => ['title' => self::DECLINED_TITLE, 'body' => sprintf(self::DECLINED_BODY, $patient)],
            'closed'   => ['title' => self::CLOSED_TITLE, 'body' => sprintf(self::CLOSED_BODY, $patient)],
            default    => ['title' => self::SHARED_TITLE, 'body' => sprintf(self::SHARED_BODY, $patient)],
        };
    }

    /**
     * The one sentence the doctor-reschedule patient notice gains when shares
     * anchored to that consultation moved ('' when none did): "… until 24
     * hours after the new time.", or — when a share was capped, or they
     * differ — the latest end as a date in the clinic's time zone.
     *
     * @param list<array{duration:string, expires_at:DateTimeImmutable, capped:bool}> $moved
     */
    public static function rescheduleSuffix(array $moved): string
    {
        if ($moved === []) {
            return '';
        }
        $durations = array_values(array_unique(array_map(static fn (array $m): string => (string) $m['duration'], $moved)));
        $capped    = in_array(true, array_map(static fn (array $m): bool => (bool) $m['capped'], $moved), true);
        $length    = count($durations) === 1 ? ShareDuration::tryFrom($durations[0])?->lengthLabel() : null;
        if (!$capped && $length !== null) {
            return sprintf(self::RESCHEDULE_SUFFIX, $length);
        }
        $latest = max(array_map(static fn (array $m): DateTimeImmutable => $m['expires_at'], $moved));

        return sprintf(self::RESCHEDULE_SUFFIX_CAPPED, $latest->setTimezone(ClinicTime::zone())->format('j M, g:i A'));
    }

    /** @return array{subject:string, html:string} */
    public static function requestEmail(string $firstName, string $doctorName, string $url): array
    {
        return EmailTemplates::documentAccessRequested($firstName, self::name($doctorName, 'Your doctor'), $url);
    }

    /** The patient's link to one request. */
    public static function requestLink(string $requestId): string
    {
        return '/dashboard/documents?request=' . rawurlencode($requestId);
    }

    /** The patient's link to their sharing with one doctor. */
    public static function sharingLink(string $specialistId): string
    {
        return '/dashboard/documents/sharing?doctor=' . rawurlencode($specialistId);
    }

    /** The doctor's link to one consultation's Documents tab. */
    public static function doctorLink(?string $appointmentId): string
    {
        return $appointmentId !== null ? '/appointments/' . rawurlencode($appointmentId) . '?tab=documents' : '/schedule';
    }

    // ----- Queueing (sent after the commit) -----

    /** A doctor asked: in-app notice + an email when the patient takes emails. */
    public function queueRequested(Patient $patient, string $doctorName, string $requestId): void
    {
        $this->queue->push(function () use ($patient, $doctorName, $requestId): void {
            $notice = self::requestNotice($doctorName);
            $this->patients->notify($patient, NotificationType::DOCUMENT, $notice['title'], $notice['body'], self::requestLink($requestId));
            if (!($patient->getSettings()['delivery']['email'] ?? true) || !$this->mail->isConfigured()) {
                return;
            }
            $p    = $patient->toArray();
            $mail = self::requestEmail((string) ($p['first_name'] ?? ''), $doctorName, WebUrls::forPatient($patient) . self::requestLink($requestId));
            $to   = (string) ($p['email'] ?? '');
            $name = trim((string) ($p['first_name'] ?? '') . ' ' . (string) ($p['last_name'] ?? ''));
            if ($to !== '') {
                AfterResponse::defer(fn () => $this->mail->send($to, $name, $mail['subject'], $mail['html']));
            }
        });
    }

    /** A doctor came back: one notice to a patient whose sharing survived (or ended). */
    public function queueReinstated(Patient $patient, string $doctorName, string $specialistId, bool $ended): void
    {
        $this->queue->push(function () use ($patient, $doctorName, $specialistId, $ended): void {
            $notice = self::reinstatedNotice($doctorName, $ended);
            $this->patients->notify($patient, NotificationType::DOCUMENT, $notice['title'], $notice['body'], self::sharingLink($specialistId));
        });
    }

    /**
     * A doctor notice (`shared` / `approved` / `declined` / `closed`). A
     * `shared` notice is coalesced per pair for ten minutes (Redis `SET NX`,
     * fail open); an `approved` one claims the same key, so a share made at
     * the same moment doesn't notify twice.
     */
    public function queueDoctor(string $kind, string $specialistId, string $patientId, string $patientName, ?string $appointmentId): void
    {
        $this->queue->push(function () use ($kind, $specialistId, $patientId, $patientName, $appointmentId): void {
            if (in_array($kind, ['shared', 'approved'], true)) {
                $first = $this->claim('docshare:notify:' . strtolower($specialistId) . ':' . strtolower($patientId));
                if ($kind === 'shared' && !$first) {
                    return;
                }
            }
            $notice = self::doctorNotice($kind, $patientName);
            $this->staff->notifyDoctor($specialistId, self::STAFF_TYPE, $notice['title'], $notice['body'], self::doctorLink($appointmentId));
        });
    }

    /** Whether this is the first notice of its kind in the window (true when Redis can't say: fail open). */
    private function claim(string $key): bool
    {
        if ($this->redis === null) {
            return true;
        }
        try {
            return $this->redis->set($key, '1', 'EX', self::SHARE_COALESCE_SECONDS, 'NX') !== null;
        } catch (\Throwable) {
            return true;
        }
    }

    private static function name(string $name, string $fallback): string
    {
        $name = trim($name);

        return $name !== '' ? $name : $fallback;
    }
}
