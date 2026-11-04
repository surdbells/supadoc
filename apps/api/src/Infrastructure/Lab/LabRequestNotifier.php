<?php

declare(strict_types=1);

namespace App\Infrastructure\Lab;

use App\Domain\Entity\LabRequest;
use App\Domain\Entity\Patient;
use App\Domain\Entity\Specialist;
use App\Domain\Enum\NotificationType;
use App\Domain\Lab\LabRequestRules;
use App\Domain\Repository\PatientRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Domain\Settings\WebUrls;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Email\MailService;
use App\Infrastructure\Service\PatientNotifier;
use App\Infrastructure\Service\StaffNotifier;

/**
 * Lab request notices (spec §2.6, §7): the patient's in-app notices and
 * emails, the requesting doctor's in-app notices (and the two doctor emails:
 * a STAT / urgent result at once, the review reminder), and the staff
 * escalation. All best effort — called after the commit, every failure
 * swallowed (logged with ids and the exception class only).
 *
 * The copy NEVER names a test, a condition, the clinical question, an
 * infection alert, pregnancy, a medicine or a review outcome
 * (LabRequestPrivacyTest); the doctor emails never name the patient.
 * Patient notices are `NotificationType::SYSTEM`, linking to
 * /dashboard/lab-requests/{id}; doctor notices are type `lab`, linking to
 * /prescriptions/labs/{id}.
 */
final class LabRequestNotifier
{
    public function __construct(
        private readonly PatientNotifier $patients,
        private readonly StaffNotifier $staff,
        private readonly MailService $mail,
        private readonly PatientRepository $patientRepo,
        private readonly SpecialistRepository $specialists,
        private readonly UserRepository $users,
    ) {
    }

    // ----- patient -----

    /** T2: in-app + email. */
    public function sent(LabRequest $r): void
    {
        $this->toPatient($r, 'sent');
        $this->emailPatient($r, 'lab_request_sent', fn (Patient $p): array => EmailTemplates::labRequestSent(
            $p->getFirstName(),
            self::doctorName($r),
            $r->getNumber(),
            LabRequestRules::priorityLabel($r->getPriority()),
            $r->getPriority() === 'stat',
            LabRequestRules::dateLabel($r->getValidUntil()),
            $this->patientUrl($p, $r),
        ));
    }

    /** T10: in-app + email (once). */
    public function reminder(LabRequest $r): void
    {
        $this->toPatient($r, 'reminder');
        $this->emailPatient($r, 'lab_request_reminder', fn (Patient $p): array => EmailTemplates::labRequestReminder(
            $p->getFirstName(),
            self::doctorName($r),
            $r->getNumber(),
            LabRequestRules::dateLabel($r->getValidUntil()),
            $this->patientUrl($p, $r),
        ));
    }

    /** T8: in-app + email. */
    public function cancelled(LabRequest $r): void
    {
        $this->toPatient($r, 'cancelled');
        $this->emailPatient($r, 'lab_request_cancelled', fn (Patient $p): array => EmailTemplates::labRequestCancelled(
            $p->getFirstName(),
            self::doctorName($r),
            $r->getNumber(),
            $this->patientUrl($p, $r),
        ));
    }

    /** T7: in-app + email, on every saved review (never the outcome). */
    public function reviewed(LabRequest $r): void
    {
        $this->toPatient($r, 'reviewed');
        $this->emailPatient($r, 'lab_result_reviewed', fn (Patient $p): array => EmailTemplates::labResultReviewed(
            $p->getFirstName(),
            self::doctorName($r),
            $r->getNumber(),
            $this->patientUrl($p, $r),
        ));
    }

    /** T9 (cron): the patient and the doctor in-app — nothing for a backlog older than 3 days (`$quiet`). */
    public function expired(LabRequest $r, bool $quiet): void
    {
        if ($quiet) {
            return;
        }
        $this->toPatient($r, 'expired');
        $this->doctorExpired($r);
    }

    /** C3 / C4: the patient in-app. */
    public function reopened(LabRequest $r): void
    {
        $this->toPatient($r, 'reopened');
    }

    /** T13 (cron): the patient in-app (once). */
    public function resultNudge(LabRequest $r): void
    {
        $this->toPatient($r, 'result_nudge');
    }

    // ----- doctor -----

    public function doctorAccepted(LabRequest $r): void
    {
        $this->toDoctor($r, 'doctor_accepted');
    }

    public function doctorDeclined(LabRequest $r): void
    {
        $this->toDoctor($r, 'doctor_declined');
    }

    public function doctorSampleGiven(LabRequest $r): void
    {
        $this->toDoctor($r, 'doctor_sample_given');
    }

    /**
     * T6 / T6b / T6c: in-app — plus, for a STAT or urgent request, an email at
     * once (no PHI; works without the cron).
     */
    public function doctorResultAdded(LabRequest $r, string $shareOutcome, bool $viewable = true): void
    {
        $this->toDoctor($r, 'doctor_result_added', ['share_outcome' => $shareOutcome, 'viewable' => $viewable]);
        if (in_array($r->getPriority(), ['stat', 'urgent'], true)) {
            $this->emailDoctor($r, 'lab_result_added', fn (Specialist $d): array => EmailTemplates::labResultAdded(
                $d->getName(),
                $r->getNumber(),
                $this->doctorUrl($d, $r),
                LabRequestRules::priorityLabel($r->getPriority()),
            ));
        }
    }

    public function doctorExpired(LabRequest $r): void
    {
        $this->toDoctor($r, 'doctor_expired');
    }

    /** C1–C4: the doctor learns that support changed it — never the reason. */
    public function doctorCorrected(LabRequest $r, string $to): void
    {
        $this->toDoctor($r, 'doctor_corrected', ['to' => $to]);
    }

    /** T11 (cron, STAT / urgent). */
    public function doctorNotAccepted(LabRequest $r): void
    {
        $this->toDoctor($r, 'doctor_not_accepted');
    }

    /** T12 reminder (cron): in-app + email. */
    public function doctorReviewReminder(LabRequest $r): void
    {
        $this->toDoctor($r, 'doctor_review_reminder');
        $this->emailDoctor($r, 'lab_review_reminder', fn (Specialist $d): array => EmailTemplates::labReviewReminder(
            $d->getName(),
            $r->getNumber(),
            $this->doctorUrl($d, $r),
        ));
    }

    // ----- staff -----

    /** T12 escalation (cron): every `labs.manage` holder; the link opens the patient page. */
    public function staffReviewEscalation(LabRequest $r): void
    {
        [$title, $body] = self::copy('staff_escalation', $r);
        $this->staff->notifyPermission('labs.manage', 'lab', $title, $body, '/patients/' . $r->getPatientId());
    }

    // ----- the copy (spec §7) -----

    /** Every in-app notice: patient (`sent` …), doctor (`doctor_*`) and staff (`staff_escalation`). */
    public const KEYS = [
        'sent', 'reminder', 'cancelled', 'reviewed', 'expired', 'reopened', 'result_nudge',
        'doctor_accepted', 'doctor_declined', 'doctor_sample_given', 'doctor_result_added', 'doctor_expired',
        'doctor_corrected', 'doctor_not_accepted', 'doctor_review_reminder', 'staff_escalation',
    ];

    /**
     * [title, body] of one in-app notice. Names the doctor (to the patient)
     * or the patient (to the doctor) and the request number — never a test,
     * a condition, a flag or a review outcome.
     *
     * @param array{share_outcome?: string, viewable?: bool, to?: string} $extra
     * @return array{0: string, 1: string}
     */
    public static function copy(string $key, LabRequest $r, array $extra = []): array
    {
        $number  = $r->getNumber();
        $doctor  = self::doctorName($r);
        $patient = self::patientName($r);

        return match ($key) {
            'sent'                   => ['New lab request', sprintf('%s sent you lab request %s. Open it to review and accept.', $doctor, $number)
                . ($r->getPriority() === 'stat' ? " It's marked STAT (most urgent)." : '')],
            'reminder'               => ['Lab request waiting', sprintf("%s's lab request %s is waiting for your answer.", $doctor, $number)],
            'cancelled'              => ['Lab request cancelled', sprintf('%s cancelled lab request %s.', $doctor, $number)],
            'reviewed'               => ['Your doctor reviewed your result', sprintf('%s reviewed a result for lab request %s. Open it to read their note.', $doctor, $number)],
            'expired'                => ['Lab request expired', sprintf('Lab request %s from %s has expired.', $number, $doctor)],
            'reopened'               => ['Lab request open again', sprintf('Lab request %s is open again.', $number)],
            'result_nudge'           => ['Waiting for your result?', sprintf('When the lab gives you the result for lab request %s, add it so %s can review it.', $number, $doctor)],
            'doctor_accepted'        => ['Lab request accepted', sprintf('%s accepted lab request %s.', $patient, $number)],
            'doctor_declined'        => ['Lab request declined', sprintf('%s declined lab request %s.', $patient, $number)],
            'doctor_sample_given'    => ['Sample given', sprintf("%s says they've given their sample for lab request %s.", $patient, $number)],
            'doctor_result_added'    => ['Result ready for review', sprintf('%s added a result to lab request %s.', $patient, $number)
                . (($extra['share_outcome'] ?? 'shared') !== 'shared'
                    ? " They haven't shared it with you."
                    : (($extra['viewable'] ?? true) ? '' : " You can't open this file type, so ask them for a PDF or photo."))],
            'doctor_expired'         => ['Lab request expired', sprintf('Lab request %s for %s expired without a result.', $number, $patient)],
            'doctor_corrected'       => ['Lab request updated', sprintf('VideoMed support changed lab request %s to %s.', $number, LabRequestRules::statusLabel((string) ($extra['to'] ?? $r->getStatus())))],
            'doctor_not_accepted'    => ['Lab request not accepted yet', sprintf("%s hasn't accepted lab request %s yet.", $patient, $number)],
            'doctor_review_reminder' => ['Result waiting for your review', sprintf('A result on lab request %s is waiting for your review.', $number)],
            'staff_escalation'       => ['Lab result not reviewed', sprintf('Lab request %s has a result waiting more than %d days.', $number, LabRequestRules::REVIEW_ESCALATE_DAYS)],
            default                  => throw new \InvalidArgumentException('Unknown lab notice ' . $key),
        };
    }

    // ----- plumbing -----

    private function toPatient(LabRequest $r, string $key): void
    {
        [$title, $body] = self::copy($key, $r);
        try {
            $patient = $this->patientRepo->find($r->getPatientId());
            if ($patient instanceof Patient && !$patient->isDeleted()) {
                $this->patients->notify($patient, NotificationType::SYSTEM, $title, $body, '/dashboard/lab-requests/' . $r->getId());
            }
        } catch (\Throwable $e) {
            error_log('[lab] patient notice failed for request ' . $r->getId() . ': ' . $e::class);
        }
    }

    /** @param array<string,mixed> $extra */
    private function toDoctor(LabRequest $r, string $key, array $extra = []): void
    {
        [$title, $body] = self::copy($key, $r, $extra);
        $this->staff->notifyDoctor($r->getSpecialistId(), 'lab', $title, $body, '/prescriptions/labs/' . $r->getId());
    }

    /** @param callable(Patient): array{subject:string, html:string} $template */
    private function emailPatient(LabRequest $r, string $key, callable $template): void
    {
        try {
            $patient = $this->patientRepo->find($r->getPatientId());
            if (!$patient instanceof Patient || $patient->isDeleted()) {
                return;
            }
            $settings = $patient->getSettings();
            if (!($settings['delivery']['email'] ?? true)) {
                return;
            }
            $tpl = $template($patient);
            // MailService is a no-op (logged, hashed) while ZeptoMail isn't configured.
            $this->mail->send($patient->getEmail(), $patient->getFullName(), $tpl['subject'], $tpl['html'], $key);
        } catch (\Throwable $e) {
            error_log('[lab] patient email failed for request ' . $r->getId() . ': ' . $e::class);
        }
    }

    /** @param callable(Specialist): array{subject:string, html:string} $template */
    private function emailDoctor(LabRequest $r, string $key, callable $template): void
    {
        try {
            $doctor = $this->specialists->find($r->getSpecialistId());
            if (!$doctor instanceof Specialist || $doctor->isDeleted()) {
                return;
            }
            $email = $this->users->findBySpecialist($doctor->getId())?->getEmail() ?? $doctor->getEmail();
            if ($email === null || $email === '') {
                return;
            }
            $tpl = $template($doctor);
            $this->mail->send($email, $doctor->getName(), $tpl['subject'], $tpl['html'], $key);
        } catch (\Throwable $e) {
            error_log('[lab] doctor email failed for request ' . $r->getId() . ': ' . $e::class);
        }
    }

    private static function doctorName(LabRequest $r): string
    {
        $name = trim((string) ($r->getPrescriber()['name'] ?? ''));

        return $name !== '' ? $name : 'Your doctor';
    }

    private static function patientName(LabRequest $r): string
    {
        $name = trim((string) ($r->getPatientSnapshot()['name'] ?? ''));

        return $name !== '' ? $name : 'Your patient';
    }

    private function patientUrl(Patient $p, LabRequest $r): string
    {
        return WebUrls::forPatient($p) . '/dashboard/lab-requests/' . $r->getId();
    }

    private function doctorUrl(Specialist $d, LabRequest $r): string
    {
        return WebUrls::forSpecialist($d) . '/prescriptions/labs/' . $r->getId();
    }
}
