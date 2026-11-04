<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Appointment\RecipientZones;
use App\Domain\Entity\Appointment;
use App\Domain\Settings\WebUrls;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Email\MailService;

/**
 * The "your video consultation & join link" emails sent once a consultation is
 * booked (or a follow-up proposal is accepted): the patient, the doctor and
 * each invited guest get their own preauthenticated link into the call. A
 * guest's invitation names who invited them and carries their own stable
 * link ({@see GuestInvitations::sendInvite()}). The doctor's link opens the
 * doctor portal's call page (with the patient's records); the patient's the
 * patient app's join page. Each mail is on its recipient's clock. Never lets a
 * mail failure break the booking.
 */
final class AppointmentInvites
{
    public function __construct(
        private readonly MailService $mail,
        private readonly JwtService $jwt,
        private readonly PricingService $pricing,
        private readonly GuestInvitations $guests,
    ) {
    }

    public function send(Appointment $appointment): void
    {
        try {
            $patient    = $appointment->getPatient();
            $specialist = $appointment->getSpecialist();
            $guests     = $appointment->getGuests();
            // Each party's join link opens on their own site (see WebUrls).
            $currency    = $this->pricing->currency() === 'NGN' ? '₦' : $this->pricing->currency();
            $appt        = $appointment->toArray();
            $p           = $patient->toArray();

            $patientName = trim((string) $p['first_name'] . ' ' . (string) $p['last_name']);
            $attendees   = array_merge(
                [$patientName, $specialist->getName()],
                array_map(static fn (array $g): string => (string) $g['name'], $guests),
            );

            // uid must be unique per party in the appointment's Agora channel.
            $send = function (string $email, string $name, string $role, int $uid) use ($appointment, $appt, $attendees, $currency): void {
                $token = $this->jwt->issueCallAccess((string) $appt['id'], $name, $role, $uid);
                [$zone, $otherZone, $whose] = $role === 'doctor' ? RecipientZones::doctor($appointment) : RecipientZones::patient($appointment);
                $mail  = EmailTemplates::sessionInvite($appt, $name, $role, self::joinLink($appointment, $role, $token), $attendees, $currency, $zone, $otherZone, $whose);
                $this->mail->send($email, $name, $mail['subject'], $mail['html']);
            };

            $send((string) $p['email'], $patientName, 'patient', Appointment::PATIENT_UID);

            if ($specialist->getEmail() !== null) {
                $send($specialist->getEmail(), $specialist->getName(), 'doctor', Appointment::DOCTOR_UID);
            }

            foreach ($guests as $guest) {
                $this->guests->sendInvite($appointment, $guest);
            }
        } catch (\Throwable) {
            // logged inside MailService; the booking already succeeded.
        }
    }

    /**
     * A party's join link for a call-access `$token`: a doctor's opens the doctor
     * portal's `/call/{token}` (records panel, in-call documents); anyone else's
     * the patient app's `/call/join/{token}`.
     */
    public static function joinLink(Appointment $appointment, string $role, string $token): string
    {
        return $role === 'doctor'
            ? WebUrls::forSpecialist($appointment->getSpecialist()) . '/call/' . $token
            : WebUrls::forPatient($appointment->getPatient()) . '/call/join/' . $token;
    }
}
