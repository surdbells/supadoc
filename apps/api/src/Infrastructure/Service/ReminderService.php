<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Entity\Appointment;
use App\Domain\Entity\Notification;
use App\Domain\Enum\NotificationType;
use App\Domain\Repository\AppointmentReminderRepository;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\NotificationRepository;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Email\MailService;
use DateTimeImmutable;

/**
 * Sends "your consultation is coming up" reminders with each party's personal,
 * preauthenticated join link, at a set of configurable offsets before the start
 * (REMINDER_OFFSETS, minutes-before). Designed to be driven by cron
 * (`php bin/send-reminders.php`): for each offset it looks at a small catch-up
 * window ending at the offset mark and, guarded by a per-(appointment,offset)
 * dedupe record, emails patient + doctor + guests exactly once — so it is safe
 * to run frequently and to catch up after downtime.
 */
final class ReminderService
{
    /**
     * How far back from each offset mark the due window reaches. Must exceed the
     * cron interval so a reminder is never skipped between runs; the dedupe record
     * stops it ever sending twice.
     */
    private const CATCHUP_MINUTES = 20;

    /** @var list<int> minutes-before offsets, largest first */
    private array $offsets;

    /**
     * @param list<int> $offsets minutes-before offsets (e.g. [1440, 60])
     */
    public function __construct(
        private readonly AppointmentRepository $appointments,
        private readonly AppointmentReminderRepository $reminders,
        private readonly NotificationRepository $notifications,
        private readonly MailService $mail,
        private readonly JwtService $jwt,
        array $offsets,
    ) {
        $clean = array_values(array_unique(array_filter(
            array_map(static fn ($m): int => (int) $m, $offsets),
            static fn (int $m): bool => $m > 0,
        )));
        rsort($clean);
        $this->offsets = $clean !== [] ? $clean : [1440, 60];
    }

    /** @return list<int> the active offsets (minutes before start) */
    public function offsets(): array
    {
        return $this->offsets;
    }

    /**
     * Send every reminder now due. Returns a small summary for the CLI.
     *
     * @return array{offsets: list<int>, reminders_sent: int, recipients: int}
     */
    public function run(?DateTimeImmutable $now = null): array
    {
        $now    = $now ?? new DateTimeImmutable();
        $webUrl = rtrim((string) ($_ENV['APP_WEB_URL'] ?? 'http://localhost:4201'), '/');

        $sent       = 0;
        $recipients = 0;
        foreach ($this->offsets as $offset) {
            $lower = max(0, $offset - self::CATCHUP_MINUTES);
            $from  = $now->modify('+' . $lower . ' minutes');
            $to    = $now->modify('+' . $offset . ' minutes');

            foreach ($this->appointments->dueForReminder($from, $to) as $appointment) {
                if ($this->reminders->wasSent($appointment->getId(), $offset)) {
                    continue;
                }
                $recipients += $this->sendFor($appointment, $offset, $webUrl);
                $this->reminders->markSent($appointment->getId(), $offset);
                $sent++;
            }
        }

        return ['offsets' => $this->offsets, 'reminders_sent' => $sent, 'recipients' => $recipients];
    }

    /**
     * Email the join link to every party. Returns how many recipients were mailed.
     */
    private function sendFor(Appointment $appointment, int $offset, string $webUrl): int
    {
        $appt        = $appointment->toArray();
        $whenLabel   = $this->humanize($offset);
        $patient     = $appointment->getPatient();
        $specialist  = $appointment->getSpecialist();
        $p           = $patient->toArray();
        $patientName = trim((string) ($p['first_name'] ?? '') . ' ' . (string) ($p['last_name'] ?? ''));

        $count = 0;
        // uid must be unique per party in the shared Agora channel (matches booking).
        $send = function (string $email, string $name, string $role, int $uid) use ($appt, $whenLabel, $webUrl, &$count): void {
            if ($email === '') {
                return;
            }
            $token = $this->jwt->issueCallAccess((string) $appt['id'], $name, $role, $uid);
            $mail  = EmailTemplates::joinReminder($appt, $name, $whenLabel, $webUrl . '/call/join/' . $token);
            $this->mail->send($email, $name, $mail['subject'], $mail['html']);
            $count++;
        };

        try {
            $send((string) ($p['email'] ?? ''), $patientName, 'patient', 1);
            if ($specialist->getEmail() !== null) {
                $send($specialist->getEmail(), $specialist->getName(), 'doctor', 2);
            }
            $uid = 3;
            foreach ($appointment->getGuests() as $guest) {
                $send((string) $guest['email'], (string) $guest['name'], 'guest', $uid++);
            }
        } catch (\Throwable) {
            // logged inside MailService; keep going / still mark as sent.
        }

        // In-app companion notification for the patient.
        try {
            $this->notifications->save(new Notification(
                $patient,
                NotificationType::APPOINTMENT,
                'Consultation reminder',
                sprintf('Your %s with %s is %s.', $appt['type_label'], $appt['specialist']['name'], $whenLabel),
            ));
        } catch (\Throwable) {
            // non-fatal.
        }

        return $count;
    }

    /** "in 1 day" / "in 2 hours" / "in 10 minutes" from a minutes-before offset. */
    private function humanize(int $minutes): string
    {
        if ($minutes % 1440 === 0) {
            $d = intdiv($minutes, 1440);

            return 'in ' . $d . ' day' . ($d > 1 ? 's' : '');
        }
        if ($minutes % 60 === 0) {
            $h = intdiv($minutes, 60);

            return 'in ' . $h . ' hour' . ($h > 1 ? 's' : '');
        }

        return 'in ' . $minutes . ' minute' . ($minutes > 1 ? 's' : '');
    }
}
