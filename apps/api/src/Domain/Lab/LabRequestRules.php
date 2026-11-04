<?php

declare(strict_types=1);

namespace App\Domain\Lab;

use App\Domain\Entity\LabRequest;
use App\Domain\Entity\LabRequestItem;
use App\Domain\Settings\ClinicTime;
use App\Domain\Settings\ProcessClock;
use App\Infrastructure\Prescription\PrescriptionForm;
use DateTimeImmutable;

/**
 * The pure rules of lab & diagnostics requests (spec §1.11): limits, the
 * consent wording, timers of the reminders and the review safety net, the
 * list filters, validity (a clinic calendar date), who is asked about
 * pregnancy, and the patient's preparation list.
 *
 * Time: every stored instant is on the process clock ({@see now()}); the
 * validity date and the patient's planned lab date are CALENDAR dates — parsed
 * `!Y-m-d` in the clinic zone and never normalised.
 */
final class LabRequestRules
{
    public const CONSENT_VERSION = 'LAB-2026-11.1';

    public const EXPIRY_DAYS      = 30;
    public const QUIET_AFTER_DAYS = 3;
    public const MAX_ITEMS        = 20;
    public const MAX_RESULTS      = 10;
    public const LINK_MINUTES     = 15;
    public const QUESTION_MIN     = 3;
    public const QUESTION_MAX     = 200;
    public const TEXT_MAX         = 500;
    public const COMMENT_MAX      = 1000;
    public const COMMENT_MIN      = 3;
    public const REASON_MIN       = 3;
    public const REASON_MAX       = 500;
    /** A staff correction's reason (5–500). */
    public const STAFF_REASON_MIN = 5;
    public const LAB_NAME_MAX     = 120;
    public const SEARCH_MAX       = 100;
    public const FASTING_HOURS    = [1, 24];
    public const WEEKS_PREGNANT   = [1, 42];

    /** T10: the patient's reminder while a request is unanswered. */
    public const REMINDER_HOURS = ['stat' => 2, 'urgent' => 12, 'routine' => 48];
    /** T11: the doctor's "not accepted yet" notice (routine: none). */
    public const DOCTOR_NUDGE_HOURS = ['stat' => 4, 'urgent' => 24];
    /** T12: the doctor's review reminder. */
    public const REVIEW_REMIND_HOURS = ['stat' => 4, 'urgent' => 4, 'routine' => 48];
    /** T12: escalation to `labs.manage` staff. */
    public const REVIEW_ESCALATE_DAYS = 7;
    /** Back-office `review_overdue`. */
    public const REVIEW_OVERDUE_HOURS = 72;
    /** T13: the patient's "add your result" nudge. */
    public const RESULT_NUDGE_DAYS = ['stat' => 2, 'urgent' => 2, 'routine' => 7];

    /** First key of the send-idempotency advisory lock (0x1AB0); the second is hashtext("specialist:client_key"). */
    public const LOCK_NAMESPACE = 0x1AB0;

    public const RESULT_EXTENSIONS = ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'dcm', 'docx'];

    public const RESULT_DOCUMENT_TYPES = ['laboratory_test_report', 'blood_test_report', 'urine_test_report', 'pathology_report',
        'histopathology_report', 'xray_report', 'ct_scan_report', 'mri_report', 'ultrasound_report', 'radiology_report',
        'ecg_report', 'echocardiogram_report'];

    /** value => [label, subtitle] */
    public const PRIORITIES = [
        'routine' => ['Routine', 'Results in 24 - 48 hours'],
        'urgent'  => ['Urgent', 'Same day'],
        'stat'    => ['STAT', 'Under 1 hour'],
    ];

    public const PURPOSES = ['diagnosis' => 'Diagnosis', 'monitoring' => 'Monitoring', 'screening' => 'Screening', 'pre_operative' => 'Pre-operative'];

    public const LAB_CATEGORIES = ['routine_panel' => 'Routine panels', 'single_test' => 'Single tests', 'microbiology' => 'Microbiology'];

    public const INFECTION_ALERTS = ['hiv' => 'HIV', 'hep_b' => 'Hep B', 'hep_c' => 'Hep C', 'tb' => 'TB'];

    public const MOBILITY = ['walking' => 'Walking', 'chair' => 'Chair', 'bed' => 'Bed', 'portable' => 'Portable'];

    public const CONTRAST_ALLERGY = ['yes' => 'Yes', 'no' => 'No'];

    /** The doctor-facing status labels (chips, the correction notice). */
    public const STATUS_LABELS = [
        'awaiting_consent' => 'Awaiting Consent',
        'booked'           => 'Booked',
        'in_lab'           => 'In Lab',
        'result_ready'     => 'Result ready',
        'declined'         => 'Declined',
        'cancelled'        => 'Cancelled',
        'expired'          => 'Expired',
    ];

    public const GROUPS = ['all', 'awaiting_patient', 'in_progress', 'result_ready'];

    /**
     * List filters: each a fully parenthesised predicate on `lab_requests`
     * (bound `:now`), so "owner = :x AND " + fragment can never widen.
     */
    public const GROUP_SQL = [
        'all'              => '(1 = 1)',
        'awaiting_patient' => "(status = 'awaiting_consent' AND expires_at > :now)",
        'in_progress'      => "((status = 'booked' AND expires_at > :now) OR status = 'in_lab')",
        'result_ready'     => "(status = 'result_ready')",
    ];

    /** The consent statements (spec §1.8), in the order they are served; `{doctor}` is the requesting doctor's name. */
    public const CONSENT_STATEMENTS = [
        ['key' => 'tests', 'required' => true, 'default' => false, 'text' => 'I agree to have the tests in this request.'],
        ['key' => 'pays_lab', 'required' => true, 'default' => false, 'text' => "I understand I choose the lab and pay the lab directly. VideoMed doesn't charge for these tests."],
        ['key' => 'lab_disclosure', 'required' => true, 'default' => false, 'text' => 'I understand the request PDF I show the lab includes the clinical details my doctor wrote, such as medicines, allergies and other health information.'],
        ['key' => 'share_results', 'required' => false, 'default' => true, 'text' => 'Share the results I add to this request with {doctor}. Only those result files — you can stop sharing any time in Manage sharing.'],
    ];

    /** 409 `status_changed` messages, by effective status (spec §2.1). */
    public const STATUS_MESSAGES = [
        'awaiting_consent' => "This request is waiting for the patient's answer.",
        'booked'           => 'The patient has accepted this request.',
        'in_lab'           => 'The patient has given their sample.',
        'result_ready'     => 'A result has been added to this request.',
        'declined'         => 'The patient declined this request.',
        'cancelled'        => 'This request was cancelled.',
        'expired'          => 'This request has expired.',
    ];

    public const NOT_FOUND = 'Lab request not found';

    /** The current instant, to the second, on the process clock. */
    public static function now(): DateTimeImmutable
    {
        return ProcessClock::normalize(new DateTimeImmutable('@' . time()));
    }

    /**
     * Validity of a request sent at `$sentAt`: `valid_until` = the clinic
     * calendar date of the send + EXPIRY_DAYS (a date, `!Y-m-d` in the clinic
     * zone, never normalised); `expires_at` = the clinic midnight after it, on
     * the process clock.
     *
     * @return array{valid_until: DateTimeImmutable, expires_at: DateTimeImmutable}
     */
    public static function validity(DateTimeImmutable $sentAt): array
    {
        $zone  = ClinicTime::zone();
        $day   = $sentAt->setTimezone($zone)->format('Y-m-d');
        $start = DateTimeImmutable::createFromFormat('!Y-m-d', $day, $zone);
        \assert($start instanceof DateTimeImmutable);
        $validUntil = $start->modify('+' . self::EXPIRY_DAYS . ' days');

        return [
            'valid_until' => $validUntil,
            'expires_at'  => ProcessClock::normalize($validUntil->modify('+1 day')),
        ];
    }

    /** A 'Y-m-d' calendar date in the clinic zone (`!Y-m-d`), or null when it isn't one. */
    public static function parseDate(mixed $raw): ?DateTimeImmutable
    {
        if (!is_string($raw) || preg_match('/^\d{4}-\d{2}-\d{2}$/', trim($raw)) !== 1) {
            return null;
        }
        $d = DateTimeImmutable::createFromFormat('!Y-m-d', trim($raw), ClinicTime::zone());

        return $d instanceof DateTimeImmutable && $d->format('Y-m-d') === trim($raw) ? $d : null;
    }

    /** The clinic calendar date of an instant, Y-m-d. */
    public static function clinicDate(DateTimeImmutable $at): string
    {
        return $at->setTimezone(ClinicTime::zone())->format('Y-m-d');
    }

    /** "4 Dec 2026" from a calendar date — its own Y-m-d parts, no zone conversion. */
    public static function dateLabel(?DateTimeImmutable $date): string
    {
        if ($date === null) {
            return '';
        }
        $months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

        return (int) $date->format('j') . ' ' . $months[(int) $date->format('n') - 1] . ' ' . $date->format('Y');
    }

    /**
     * Whether the form asks "Pregnant?": the prescription rule (female 12–55,
     * or female of unknown age) — or a sex not recorded as female / male with
     * an unknown age or one of 12–55.
     */
    public static function asksPregnancy(?string $gender, ?DateTimeImmutable $dob, DateTimeImmutable $today): bool
    {
        if (PrescriptionForm::asksPregnancy($gender, $dob, $today)) {
            return true;
        }
        if (in_array(strtolower(trim((string) $gender)), ['female', 'f', 'woman', 'male', 'm', 'man'], true)) {
            return false;
        }
        if ($dob === null) {
            return true;
        }
        $age = $dob->diff($today)->y;

        return $age >= 12 && $age <= 55;
    }

    /**
     * Pregnant, and any study that is ionising or may use contrast (Preview,
     * detail and PDF warning). `$items`: catalogue / snapshot arrays or
     * {@see LabRequestItem}s.
     *
     * @param iterable<array<string,mixed>|LabRequestItem> $items
     */
    public static function pregnancyWarning(?bool $pregnant, iterable $items): bool
    {
        if ($pregnant !== true) {
            return false;
        }
        foreach ($items as $item) {
            if ($item instanceof LabRequestItem) {
                if ($item->isIonising() || $item->isContrastPossible()) {
                    return true;
                }
            } elseif (is_array($item) && (!empty($item['ionising']) || !empty($item['contrast_possible']))) {
                return true;
            }
        }

        return false;
    }

    /**
     * The upload dialog's default document type: all lab → a lab report; one
     * imaging modality → its report (other / several → radiology); only ECGs →
     * an ECG report; only echoes → an echocardiogram report; a mix → a lab report.
     *
     * @param iterable<LabRequestItem> $items
     */
    public static function defaultDocumentType(iterable $items): string
    {
        $kinds      = [];
        $modalities = [];
        $codes      = [];
        foreach ($items as $item) {
            $kinds[$item->getKind()] = true;
            $codes[]                 = $item->getCode();
            if ($item->getKind() === 'imaging') {
                $modalities[(string) $item->getModality()] = true;
            }
        }
        if (count($kinds) !== 1) {
            return 'laboratory_test_report';
        }
        $kind = array_key_first($kinds);
        if ($kind === 'imaging') {
            if (count($modalities) !== 1) {
                return 'radiology_report';
            }

            return match (array_key_first($modalities)) {
                'x_ray'      => 'xray_report',
                'ultrasound' => 'ultrasound_report',
                'ct'         => 'ct_scan_report',
                'mri'        => 'mri_report',
                default      => 'radiology_report',
            };
        }
        if ($kind === 'physiological') {
            if (array_filter($codes, static fn (string $c): bool => $c !== 'ECG12') === []) {
                return 'ecg_report';
            }
            if (array_filter($codes, static fn (string $c): bool => !str_starts_with($c, 'ECHO-')) === []) {
                return 'echocardiogram_report';
            }
        }

        return 'laboratory_test_report';
    }

    /**
     * What the patient does to get ready (spec §4.4), in order: fasting, each
     * distinct imaging preparation, the contrast-allergy line, and always
     * "Take this request".
     *
     * @return list<array{key:string, title:string, text:string}>
     */
    public static function patientInstructions(LabRequest $r, LabCatalogue $catalogue): array
    {
        $out   = [];
        $flags = $r->getClinicalFlags();
        if (($flags['fasting'] ?? null) === true && is_int($flags['fasting_hours'] ?? null)) {
            $out[] = ['key' => 'fasting', 'title' => 'Fasting', 'text' => sprintf(
                "Don't eat or drink anything except water for %d hours before your sample is taken.",
                $flags['fasting_hours'],
            )];
        }
        $seen     = [];
        $contrast = false;
        foreach ($r->getItems() as $item) {
            if ($item->getKind() !== 'imaging') {
                continue;
            }
            $contrast = $contrast || $item->isContrastPossible();
            $code     = (string) $item->getPreparationCode();
            if ($code === '' || $code === 'none' || isset($seen[$code])) {
                continue;
            }
            $seen[$code] = true;
            $prep = $catalogue->preparation($code);
            if ($prep !== null && $prep['patient_text'] !== null) {
                $out[] = ['key' => 'preparation_' . $code, 'title' => (string) ($item->getPreparationLabel() ?? $prep['label']), 'text' => $prep['patient_text']];
            }
        }
        if ($contrast && (($r->getImagingSafety() ?? [])['contrast_allergy'] ?? null) === 'yes') {
            $out[] = ['key' => 'contrast', 'title' => 'Contrast allergy', 'text' => 'Tell the imaging centre about your contrast allergy before your scan.'];
        }
        $out[] = ['key' => 'bring', 'title' => 'Take this request', 'text' => 'Show the request PDF at the lab, on your phone or printed, with a photo ID.'];

        return $out;
    }

    /** The served consent statements, `{doctor}` filled in. @return list<array{key:string, text:string, required:bool, default:bool}> */
    public static function consentStatements(string $doctorName): array
    {
        return array_map(static fn (array $s): array => [
            'key'      => $s['key'],
            'text'     => str_replace('{doctor}', $doctorName !== '' ? $doctorName : 'your doctor', $s['text']),
            'required' => $s['required'],
            'default'  => $s['default'],
        ], self::CONSENT_STATEMENTS);
    }

    public static function priorityLabel(string $priority): string
    {
        return self::PRIORITIES[$priority][0] ?? ucfirst($priority);
    }

    public static function statusLabel(string $status): string
    {
        return self::STATUS_LABELS[$status] ?? ucfirst(str_replace('_', ' ', $status));
    }

    /** Hours of a per-priority timer (routine when unknown); null when it doesn't apply. @param array<string,int> $table */
    public static function hoursFor(array $table, string $priority): ?int
    {
        return $table[$priority] ?? null;
    }
}
