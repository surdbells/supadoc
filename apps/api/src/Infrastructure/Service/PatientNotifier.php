<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Entity\Appointment;
use App\Domain\Entity\Notification;
use App\Domain\Entity\Patient;
use App\Domain\Enum\NotificationType;
use App\Domain\Repository\NotificationRepository;
use App\Domain\Settings\ClinicTime;
use DateTimeImmutable;

/**
 * Writes in-app notifications to a patient's feed. Best-effort — a notification
 * failure must never break the action that triggered it, so it swallows errors
 * (mirrors {@see StaffNotifier} for staff). Use this everywhere a patient-facing
 * transactional event occurs (appointment lifecycle, clinical documents, etc.)
 * so the feed stays consistent with the emails those actions already send.
 */
final class PatientNotifier
{
    public function __construct(private readonly NotificationRepository $notifications)
    {
    }

    public function notify(Patient $patient, NotificationType $type, string $title, string $body = '', ?string $link = null): void
    {
        try {
            $this->notifications->save(new Notification($patient, $type, $title, $body, $link));
        } catch (\Throwable) {
            // non-fatal
        }
    }

    /** "Wed, 21 Oct 2026 · 10:00 AM WAT" — the clinic's clock. */
    public static function timeLabel(DateTimeImmutable $at): string
    {
        return $at->setTimezone(ClinicTime::zone())->format('D, j M Y · g:i A T');
    }

    /**
     * Convenience for the appointment lifecycle: writes an APPOINTMENT notification
     * whose body names the consultation type, specialist and the time on the
     * clinic's clock (e.g. "Wed, 21 Oct 2026 · 10:00 AM WAT"), optionally
     * prefixed with a status-specific sentence, and opens `$link` when tapped.
     */
    public function appointment(Appointment $appointment, string $title, string $detail = '', ?string $link = null): void
    {
        $appt = $appointment->toArray();
        $when = '';
        try {
            $when = self::timeLabel($appointment->getScheduledAt());
        } catch (\Throwable) {
            // leave the time out if it can't be formatted
        }

        $body = trim(
            ($detail !== '' ? $detail . ' ' : '')
            . 'Your ' . (string) $appt['type_label'] . ' with ' . (string) $appt['specialist']['name']
            . ($when !== '' ? ' on ' . $when : '') . '.',
        );

        $this->notify($appointment->getPatient(), NotificationType::APPOINTMENT, $title, $body, $link);
    }
}
