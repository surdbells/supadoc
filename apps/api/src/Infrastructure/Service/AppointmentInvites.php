<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Entity\Appointment;
use App\Domain\Settings\WebUrls;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Email\MailService;

/**
 * The "your video consultation & join link" emails sent once a consultation is
 * booked (or a follow-up proposal is accepted): the patient, the doctor and
 * each invited guest get their own preauthenticated link into the call. Never
 * lets a mail failure break the booking.
 */
final class AppointmentInvites
{
    public function __construct(
        private readonly MailService $mail,
        private readonly JwtService $jwt,
        private readonly PricingService $pricing,
    ) {
    }

    public function send(Appointment $appointment): void
    {
        try {
            $patient    = $appointment->getPatient();
            $specialist = $appointment->getSpecialist();
            $guests     = $appointment->getGuests();
            // Each party's join link opens on their own site (see WebUrls).
            $patientBase = WebUrls::forPatient($patient);
            $doctorBase  = WebUrls::patientAppForSpecialist($specialist);
            $currency    = $this->pricing->currency() === 'NGN' ? '₦' : $this->pricing->currency();
            $appt        = $appointment->toArray();
            $p           = $patient->toArray();

            $patientName = trim((string) $p['first_name'] . ' ' . (string) $p['last_name']);
            $attendees   = array_merge(
                [$patientName, $specialist->getName()],
                array_map(static fn (array $g): string => $g['name'], $guests),
            );

            // uid must be unique per party in the shared Agora channel.
            $send = function (string $email, string $name, string $role, int $uid) use ($appt, $attendees, $patientBase, $doctorBase, $currency): void {
                $token = $this->jwt->issueCallAccess((string) $appt['id'], $name, $role, $uid);
                $mail  = EmailTemplates::sessionInvite($appt, $name, $role, ($role === 'doctor' ? $doctorBase : $patientBase) . '/call/join/' . $token, $attendees, $currency);
                $this->mail->send($email, $name, $mail['subject'], $mail['html']);
            };

            $send((string) $p['email'], $patientName, 'patient', 1);

            if ($specialist->getEmail() !== null) {
                $send($specialist->getEmail(), $specialist->getName(), 'doctor', 2);
            }

            $uid = 3;
            foreach ($guests as $guest) {
                $send($guest['email'], $guest['name'], 'guest', $uid++);
            }
        } catch (\Throwable) {
            // logged inside MailService; the booking already succeeded.
        }
    }
}
