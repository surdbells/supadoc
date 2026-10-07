<?php

declare(strict_types=1);

namespace App\Infrastructure\Prescription;

use App\Domain\Entity\Patient;
use App\Domain\Enum\NotificationType;
use App\Domain\Repository\PatientRepository;
use App\Domain\Repository\PrescriptionRepository;
use App\Domain\Settings\ClinicTime;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Email\MailService;
use App\Infrastructure\Service\PatientNotifier;
use DateTimeImmutable;

/**
 * Nightly prescription housekeeping, run from the reminders cron
 * (bin/send-reminders.php):
 *
 *  - stores `expired` on active prescriptions past their valid-until date (the
 *    API already reports them as expired from the day after; this keeps the
 *    stored status — and reports — in step), and
 *  - sends "Your prescription [number] expires on [date]. Book a consultation
 *    if you need more." `reminder_days` before expiry, to prescriptions that
 *    allow repeats (GVM-RX-02 AC30), once each.
 */
final class PrescriptionExpiryService
{
    public function __construct(
        private readonly PrescriptionRepository $prescriptions,
        private readonly PatientRepository $patients,
        private readonly PrescriptionSettings $settings,
        private readonly PatientNotifier $notifier,
        private readonly MailService $mail,
        private readonly string $webUrl,
    ) {
    }

    /** @return array{expired: int, reminded: int} */
    public function run(?DateTimeImmutable $now = null): array
    {
        $now   ??= new DateTimeImmutable();
        // The clinic's calendar day, whatever the server timezone.
        $today   = new DateTimeImmutable($now->setTimezone(ClinicTime::zone())->format('Y-m-d'));
        $expired = 0;
        foreach ($this->prescriptions->pastValidity($today) as $rx) {
            $rx->markExpired();
            $this->prescriptions->persist($rx);
            ++$expired;
        }
        if ($expired > 0) {
            $this->prescriptions->flush();
        }

        $reminded = 0;
        $target   = $today->modify('+' . $this->settings->get('reminder_days') . ' days');
        foreach ($this->prescriptions->dueForExpiryReminder($target) as $rx) {
            $patient = $this->patients->find($rx->getPatientId());
            $rx->markExpiryReminderSent($now);
            $this->prescriptions->save($rx);
            if (!$patient instanceof Patient) {
                continue;
            }
            $expiresOn = $rx->getValidUntil()?->format('j M Y') ?? '';
            $this->notifier->notify(
                $patient,
                NotificationType::PRESCRIPTION,
                'Prescription expiring soon',
                sprintf('Your prescription %s expires on %s. Book a consultation if you need more.', $rx->getNumber(), $expiresOn),
                '/dashboard/prescriptions/' . $rx->getId(),
            );
            try {
                if (($patient->getSettings()['delivery']['email'] ?? true) && $this->mail->isConfigured()) {
                    $tpl = EmailTemplates::prescriptionExpiring(
                        $patient->getFirstName(),
                        $rx->getNumber(),
                        $expiresOn,
                        $this->webUrl . '/dashboard/specialists',
                    );
                    $this->mail->send($patient->getEmail(), $patient->getFullName(), $tpl['subject'], $tpl['html']);
                }
            } catch (\Throwable) {
                // best-effort; the in-app reminder already landed
            }
            ++$reminded;
        }

        return ['expired' => $expired, 'reminded' => $reminded];
    }
}
