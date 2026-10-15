<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Doctor\DoctorCredentials;
use App\Domain\Entity\Specialist;
use App\Domain\Entity\SpecialistCredential;
use App\Domain\Repository\SpecialistCredentialRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Domain\Settings\ClinicTime;
use App\Domain\Settings\WebUrls;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Email\MailService;
use DateTimeImmutable;

/**
 * The licence cron (run from bin/send-reminders.php):
 *
 *  - practising licences: each verified licence gets a reminder at each of
 *    LICENCE_REMINDER_DAYS before it expires (default 30, 14, 7, 1 — only the
 *    most urgent stage reached, each once); once past its last valid day it is
 *    marked expired, and LICENCE_GRACE_DAYS after that (default 0) a doctor
 *    who is still approved with no other current licence is suspended
 *    automatically (code licence_expired, by "System");
 *  - doctors approved before documents existed (no approval snapshot) are
 *    given 30 days from the first run to upload them (`credentials_due_at`),
 *    reminded at the same stages, and flagged "Credentials missing" in the
 *    back office — never suspended automatically: a reviewer decides.
 *
 * Dates are the clinic's calendar ({@see ClinicTime}). Safe to run every few
 * minutes: stages are recorded before the email goes, a licence marked expired
 * is never picked again, and the suspension itself is idempotent. A licence
 * is marked expired only once its doctor's suspension is complete: one a
 * failed booking batch left part-way (reviewers are told once) is finished by
 * a later run. Expiries run last, and the run stops once a failure has closed
 * the database session.
 */
final class CredentialExpiryService
{
    /** Days a doctor approved before documents existed has to upload them. */
    public const LEGACY_DUE_DAYS = 30;

    /** @var list<int> */
    private array $stages;

    /** @param list<int> $reminderDays */
    public function __construct(
        private readonly SpecialistRepository $specialists,
        private readonly SpecialistCredentialRepository $credentials,
        private readonly SpecialistSuspensionService $suspensions,
        private readonly DoctorOnboardingService $onboarding,
        private readonly StaffNotifier $notifier,
        private readonly MailService $mail,
        private readonly UserRepository $users,
        array $reminderDays = [30, 14, 7, 1],
        private readonly int $graceDays = 0,
    ) {
        $this->stages = self::cleanStages($reminderDays);
    }

    /**
     * LICENCE_REMINDER_DAYS → the reminder stages, largest first (default 30, 14, 7, 1).
     *
     * @param list<int|string> $days
     * @return list<int>
     */
    public static function cleanStages(array $days): array
    {
        $clean = array_values(array_unique(array_filter(
            array_map(static fn ($d): int => (int) trim((string) $d), $days),
            static fn (int $d): bool => $d > 0 && $d <= 365,
        )));
        rsort($clean);

        return $clean !== [] ? $clean : [30, 14, 7, 1];
    }

    /** @return list<int> */
    public function stages(): array
    {
        return $this->stages;
    }

    /** Whether a licence whose last valid day was `$expiresYmd` is past its grace on `$todayYmd` (suspend). */
    public static function pastGrace(string $expiresYmd, string $todayYmd, int $graceDays): bool
    {
        return DoctorCredentials::daysUntil($expiresYmd, $todayYmd) < -max(0, $graceDays);
    }

    /**
     * What to do with a doctor whose licence is past its grace:
     *  - 'suspend': still approved with no other current licence;
     *  - 'finish': already suspended for an expired licence — an automatic
     *    suspension a failed booking batch left part-way (or one a reviewer
     *    made) is run again, which only cancels what is still live;
     *  - 'mark': nothing to suspend — the licence is just marked expired.
     *
     * @return 'suspend'|'finish'|'mark'
     */
    public static function expiryStep(Specialist $doctor, bool $hasCurrentLicence): string
    {
        if ($hasCurrentLicence) {
            return 'mark';
        }
        if ($doctor->isApproved()) {
            return 'suspend';
        }

        return $doctor->isSuspended() && $doctor->getSuspensionCode() === 'licence_expired' ? 'finish' : 'mark';
    }

    /** @return array{licence_reminders:int, licences_expired:int, suspended:int, suspensions_incomplete:int, legacy_due_set:int, legacy_reminders:int} */
    public function run(?DateTimeImmutable $now = null): array
    {
        $now   ??= new DateTimeImmutable();
        $todayYmd = $now->setTimezone(ClinicTime::zone())->format('Y-m-d');
        // A hydrated `date` column is midnight in the process timezone (see ClinicTime).
        $today = new DateTimeImmutable($todayYmd);

        $result = ['licence_reminders' => 0, 'licences_expired' => 0, 'suspended' => 0, 'suspensions_incomplete' => 0, 'legacy_due_set' => 0, 'legacy_reminders' => 0];

        $expired = [];
        $horizon = $today->modify('+' . max($this->stages) . ' days');
        foreach ($this->credentials->verifiedLicencesExpiringBy($horizon) as $licence) {
            $doctor = $this->specialists->find($licence->getSpecialistId());
            if (!$doctor instanceof Specialist || $doctor->isDeleted()) {
                continue;
            }
            $daysLeft = DoctorCredentials::daysUntil((string) $licence->expiresYmd(), $todayYmd);
            if ($daysLeft < 0) {
                $expired[] = [$doctor, $licence];
                continue;
            }
            $stage = DoctorCredentials::dueStage($daysLeft, $this->stages, $licence->getReminderStage());
            if ($stage === null || !$doctor->isApproved()) {
                continue;
            }
            // Recorded first: a mail failure must not resend it on every run.
            $licence->setReminderStage($stage);
            $this->credentials->save($licence);
            $this->remindLicence($doctor, $licence, $daysLeft);
            $result['licence_reminders']++;
        }

        [$set, $reminded]          = $this->legacyDoctors($today, $todayYmd);
        $result['legacy_due_set']   = $set;
        $result['legacy_reminders'] = $reminded;

        // Expiries last: a suspension whose booking batch fails closes the
        // entity manager, so nothing after it in this run can be saved. First
        // suspensions go before re-runs of an unfinished one, so one that keeps
        // failing never holds the others back.
        usort($expired, static fn (array $a, array $b): int => (int) $a[0]->isSuspended() <=> (int) $b[0]->isSuspended());
        foreach ($expired as [$doctor, $licence]) {
            try {
                $outcome = $this->expire($doctor, $licence, $todayYmd);
            } catch (\Throwable $e) {
                error_log('[licences] expiring ' . $licence->getId() . ' failed: ' . $e::class . ': ' . $e->getMessage());
                $outcome = 'failed';
            }
            if ($outcome === 'incomplete') {
                $result['suspensions_incomplete']++;
            } elseif ($outcome !== 'none' && $outcome !== 'failed') {
                $result['licences_expired']++;
                $result['suspended'] += $outcome === 'suspended' ? 1 : 0;
            }
            if (!$this->credentials->isWritable()) {
                error_log('[licences] stopping: the database session closed after a failure — the next run carries on');
                break;
            }
        }

        return $result;
    }

    /**
     * A lapsed licence past its grace: suspend the doctor if they still
     * practise on it ({@see expiryStep()}), then mark it expired. It is
     * marked only once the suspension is complete — one left part-way keeps
     * it verified, so the next run picks it again and finishes the job.
     *
     * @return 'none'|'marked'|'suspended'|'finished'|'incomplete'
     */
    private function expire(Specialist $doctor, SpecialistCredential $licence, string $todayYmd): string
    {
        if (!self::pastGrace((string) $licence->expiresYmd(), $todayYmd, $this->graceDays)) {
            return 'none'; // within the grace: still verified, picked again tomorrow
        }
        $expiredOn = self::dateLabel((string) $licence->expiresYmd());
        $current   = DoctorCredentials::currentLicence($this->credentials->forSpecialist($doctor->getId()), $todayYmd);
        $step      = self::expiryStep($doctor, $current !== null);

        $outcome = 'marked';
        if ($step !== 'mark') {
            $affected = $this->suspensions->suspend(
                $doctor,
                'licence_expired',
                'Your annual practising licence expired on ' . $expiredOn . ' and no renewed licence has been verified. Upload your current licence to be reinstated.',
                null,
                'System',
            );
            if (($affected['incomplete'] ?? false) === true) {
                $left = (int) ($affected['failed'] ?? 0);
                $what = $left > 0
                    ? sprintf('%d of their upcoming bookings are still live (not cancelled or refunded)', $left)
                    : 'some of their follow-up proposals are still open';
                // Told once (a re-run that fails again is only logged); the licence stays verified.
                if ($step === 'suspend') {
                    $this->onboarding->notifyReviewers(
                        $doctor,
                        'Suspension incomplete: ' . $doctor->getName(),
                        sprintf(
                            '%s was suspended automatically because their practising licence expired on %s, but %s. Open the doctor and press Suspend again to finish.',
                            $doctor->getName(),
                            $expiredOn,
                            $what,
                        ),
                    );
                }
                error_log('[licences] suspending ' . $doctor->getId() . ' is incomplete: ' . $what);

                return 'incomplete';
            }
            $inProgress = (int) ($affected['in_progress'] ?? 0) > 0 ? ' A consultation in progress was left to finish.' : '';
            if ($step === 'suspend') {
                $this->onboarding->notifyReviewers(
                    $doctor,
                    'Doctor suspended: licence expired',
                    $doctor->getName() . ' was suspended automatically because their practising licence expired on ' . $expiredOn . '. Their upcoming bookings were cancelled and refunded.' . $inProgress,
                );
                $outcome = 'suspended';
            } else {
                // Finishing one left part-way: say so only when something was still live.
                if ((int) ($affected['cancelled'] ?? 0) + (int) ($affected['proposals_withdrawn'] ?? 0) > 0) {
                    $this->onboarding->notifyReviewers(
                        $doctor,
                        'Suspension finished: ' . $doctor->getName(),
                        'The automatic suspension of ' . $doctor->getName() . ' is complete: their remaining upcoming bookings were cancelled and refunded.' . $inProgress,
                    );
                }
                $outcome = 'finished';
            }
        }

        $licence->markExpired();
        $this->credentials->save($licence);

        return $outcome;
    }

    /**
     * Doctors approved before documents existed: give each a due date once,
     * then remind them at the stages. Returns [due dates set, reminders sent].
     *
     * @return array{0:int, 1:int}
     */
    private function legacyDoctors(DateTimeImmutable $today, string $todayYmd): array
    {
        $set      = 0;
        $reminded = 0;
        foreach ($this->specialists->legacyWithoutCredentialsDue() as $doctor) {
            if (DoctorCredentials::complete($this->credentials->forSpecialist($doctor->getId()), $todayYmd)) {
                continue;
            }
            $doctor->setCredentialsDueAt($today->modify('+' . self::LEGACY_DUE_DAYS . ' days'));
            $this->specialists->persist($doctor);
            $set++;
        }
        if ($set > 0) {
            $this->specialists->flush();
        }

        foreach ($this->specialists->withCredentialsDue() as $doctor) {
            $due   = (string) $doctor->getCredentialsDueAt()?->format('Y-m-d');
            $stage = DoctorCredentials::dueStage(DoctorCredentials::daysUntil($due, $todayYmd), $this->stages, $doctor->getCredentialsReminderStage());
            if ($stage === null) {
                continue;
            }
            // Both uploaded and waiting for a reviewer: nothing more to ask of the doctor.
            $documents = $this->credentials->forSpecialist($doctor->getId());
            if (DoctorCredentials::mdcnProvided($documents) && DoctorCredentials::licenceProvided($documents, $todayYmd)) {
                continue;
            }
            $doctor->setCredentialsReminderStage($stage);
            $this->specialists->save($doctor);
            $this->remindLegacy($doctor, DoctorCredentials::daysUntil($due, $todayYmd), $due);
            $reminded++;
        }

        return [$set, $reminded];
    }

    private function remindLicence(Specialist $doctor, SpecialistCredential $licence, int $daysLeft): void
    {
        $expires = self::dateLabel((string) $licence->expiresYmd());
        $this->notifier->notifyDoctor(
            $doctor->getId(),
            'onboarding',
            'Practising licence expiring',
            sprintf('Your practising licence expires on %s. Upload your renewed licence so it can be verified in time.', $expires),
            '/onboarding',
        );
        $this->emailDoctor($doctor, EmailTemplates::doctorLicenceExpiring($doctor->getName(), $daysLeft, $expires, WebUrls::forSpecialist($doctor), $this->graceDays));
    }

    private function remindLegacy(Specialist $doctor, int $daysLeft, string $dueYmd): void
    {
        $due = self::dateLabel($dueYmd);
        $this->notifier->notifyDoctor(
            $doctor->getId(),
            'onboarding',
            'Upload your licensing documents',
            sprintf('Please upload your MDCN full-registration certificate and current practising licence by %s.', $due),
            '/onboarding',
        );
        $this->emailDoctor($doctor, EmailTemplates::doctorCredentialsDue($doctor->getName(), max(0, $daysLeft), $due, WebUrls::forSpecialist($doctor)));
    }

    /** @param array{subject:string, html:string} $tpl */
    private function emailDoctor(Specialist $doctor, array $tpl): void
    {
        try {
            $email = $this->users->findBySpecialist($doctor->getId())?->getEmail() ?? $doctor->getEmail();
            if ($email !== null && $email !== '') {
                $this->mail->send($email, $doctor->getName(), $tpl['subject'], $tpl['html']);
            }
        } catch (\Throwable) {
            // logged inside MailService; the stage is recorded.
        }
    }

    /** "15 Oct 2026". */
    private static function dateLabel(string $ymd): string
    {
        try {
            return (new DateTimeImmutable($ymd))->format('j M Y');
        } catch (\Throwable) {
            return $ymd;
        }
    }
}
