<?php

declare(strict_types=1);

namespace App\Action\Call;

use App\Domain\Call\CallAccess;
use App\Domain\Entity\Appointment;
use App\Domain\Exception\EntityNotFoundException;
use App\Domain\Repository\AppointmentRepository;
use App\Infrastructure\Agora\AgoraTokenService;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\CallPresence;
use App\Infrastructure\Service\GuestConsent;
use App\Infrastructure\Service\GuestInvitations;
use App\Infrastructure\Service\JwtService;
use App\Infrastructure\Vitals\VitalsService;
use DateTimeImmutable;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/public/call/{token} — a preauthenticated way into the video room. The
 * token is the signed call-access JWT emailed to each party (patient, doctor,
 * guest); it carries the appointment, the party's display name, role and Agora
 * uid (a guest's also their guest id), so nobody has to log in to join. Public
 * by design — the token IS the credential, so it's validated here rather than
 * by auth middleware.
 *
 * Refused ({@see CallAccess::problem()}): a cancelled (410) or completed (410)
 * consultation, an unaccepted follow-up (409); a guest no longer invited (410),
 * too early (425 with `starts_at` / `opens_at`) or too late (410); and a guest
 * who hasn't accepted the recording + privacy notice while recording could
 * happen (403, `errors.code = consent_required` — POST .../consent first).
 *
 * Calling it again with the same token returns a fresh RTC token — how a call
 * screen renews on `token-privilege-will-expire`. A guest's lasts
 * CallAccess::GUEST_RTC_TTL (10 min), everyone else's an hour. A guest still
 * in the call (by heartbeat) renews past the end of their window — for at most
 * CallAccess::GUEST_OVERRUN_HOURS — so a consultation that runs over keeps its
 * guests, and renews without having accepted the notice while nothing is
 * being recorded (the patient may agree to recording mid-call).
 */
final class JoinCallAction
{
    use ApiResponse;

    private const TTL = 3600;

    public function __construct(
        private readonly JwtService $jwt,
        private readonly AppointmentRepository $appointments,
        private readonly AgoraTokenService $agora,
        private readonly GuestConsent $consent,
        private readonly CallPresence $presence,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $claims = $this->jwt->verifyCallAccess((string) ($args['token'] ?? ''));
        if ($claims === null) {
            return $this->error($response, 'This join link is invalid or has expired', 401);
        }

        /** @var Appointment|null $appointment */
        $appointment = $this->appointments->find($claims['appointment_id']);
        if ($appointment === null) {
            throw EntityNotFoundException::for(Appointment::class, $claims['appointment_id']);
        }
        $guest = CallAccess::guestFor($appointment, $claims);
        $now   = new DateTimeImmutable();
        // A guest in the call now (by heartbeat) is renewing their token.
        $inCall = $guest !== null
            && in_array((string) ($guest['id'] ?? ''), $this->presence->forAppointment($appointment)['guests'], true);
        // …and keeps a call that runs over (for at most GUEST_OVERRUN_HOURS).
        if (($problem = CallAccess::problem($appointment, $claims, $guest, $now, late: !$inCall)) !== null) {
            return $this->error($response, $problem[1], $problem[0], $problem[2])->withHeader('Cache-Control', 'no-store');
        }

        $meeting = self::meeting($appointment, $claims, $guest);
        if ($guest !== null) {
            $consent            = $this->consent->state($appointment, $guest);
            $meeting['consent'] = $consent;
            if (self::consentBlocks($consent, $inCall)) {
                $ask = 'Please read and accept the privacy and recording notice before you join.';

                return $this->error($response, $ask, 403, ['call' => $ask, 'code' => 'consent_required', 'consent' => $consent])
                    ->withHeader('Cache-Control', 'no-store');
            }
        }

        // The consulting doctor sees the patient's clinical summary for the visit.
        // Gated to the doctor role — a guest's token never carries patient health data.
        if (($claims['role'] ?? '') === 'doctor') {
            $patient = $appointment->getPatient();
            $pa      = $patient->toArray();
            $medical = $patient->getMedical();
            $meeting['patient'] = [
                'id'            => (string) $pa['id'],
                'name'          => trim(((string) $pa['first_name']) . ' ' . ((string) $pa['last_name'])),
                'date_of_birth' => $pa['date_of_birth'],
                'gender'        => $pa['gender'],
                'allergies'     => array_values($medical['allergies'] ?? []),
                'conditions'    => array_values($medical['conditions'] ?? []),
                'medications'   => array_values($medical['medications'] ?? []),
                'history'       => array_values($medical['history'] ?? []),
                // Latest reading of each type, who recorded it, and whether it is out of date.
                'vitals'        => VitalsService::latestList($patient->getLatestVitals(), new DateTimeImmutable()),
            ];
        }

        // The channel is the appointment id, so every party lands in the same room.
        $uid = $meeting['uid'];
        if ($this->agora->hasAppId()) {
            // Before a guest gets a way in: until it expires they may be in the
            // channel — the recording check counts them, and removing them (or
            // cancelling) puts them out (GuestInvitations). Re-checked against
            // what is saved now: removed or cancelled a moment ago, no way in.
            if ($guest !== null) {
                $fresh   = $this->appointments->updateGuestLocked($appointment, (string) $guest['id'], ['rtc_issued_at' => $now->format(DATE_ATOM)]);
                $problem = CallAccess::problem($appointment, $claims, $fresh, $now, late: !$inCall);
                if ($problem !== null) {
                    return $this->error($response, $problem[1], $problem[0], $problem[2])->withHeader('Cache-Control', 'no-store');
                }
            }
            $meeting['app_id']  = $this->agora->appId();
            $meeting['configured'] = true;
            if ($this->agora->hasStaticToken()) {
                // TEMPORARY (never in production — see AgoraTokenService): a fixed
                // Console token overrides minting; its bound channel wins, so all
                // parties share one room. The token is a wildcard (uid 0), so each
                // party's uid still works.
                $meeting['channel']    = $this->agora->staticChannel();
                $meeting['token']      = $this->agora->staticToken();
                $meeting['expires_in'] = null;
            } else {
                $channel            = $appointment->getId();
                $meeting['channel'] = $channel;
                // A guest's token is short-lived: each renewal re-checks their link.
                $ttl                = $guest !== null ? CallAccess::GUEST_RTC_TTL : self::TTL;
                // App-ID-only mode (certificate blank) → null token; join token-less.
                $meeting['token']   = $this->agora->isConfigured()
                    ? $this->agora->rtcToken($channel, $uid, $ttl)
                    : null;
                $meeting['expires_in'] = $meeting['token'] !== null ? $ttl : null;
            }
        } else {
            $meeting['configured'] = false;
        }

        return $this->success($response, $meeting, 'Ready to join')
            // Never let the browser reuse a cached (possibly expired) token.
            ->withHeader('Cache-Control', 'no-store');
    }

    /**
     * Whether a guest must accept the notice before getting a token: while
     * recording could happen — except one already in the call (renewing) while
     * nothing is being recorded: recording waits for them instead
     * (StartRecordingAction), and their heartbeat's `consent` lets their
     * screen ask.
     *
     * @param array{required:bool, given:bool, recording_active:bool} $consent {@see GuestConsent::state()}
     */
    public static function consentBlocks(array $consent, bool $inCall): bool
    {
        return $consent['required'] && !$consent['given'] && !($inCall && !$consent['recording_active']);
    }

    /**
     * What every call screen shows, for any role: the consultation, who you
     * are (a guest: the name they chose, their uid and guest id) and everyone
     * who may be in the call by uid (names only). A guest's also say who
     * invited them and when they can join. Never health data, never emails.
     *
     * @param array{role:string, name:string, uid:int} $claims
     * @param array<string,mixed>|null $guest
     * @return array<string,mixed>
     */
    public static function meeting(Appointment $appointment, array $claims, ?array $guest): array
    {
        $specialist = $appointment->getSpecialist();
        $you        = ['name' => $claims['name'], 'role' => $claims['role'], 'uid' => CallAccess::uidFor($claims, $guest)];
        if ($guest !== null) {
            $you['name'] = Appointment::guestDisplayName($guest);
            $you['id']   = (string) ($guest['id'] ?? '');
        }
        $meeting = [
            'appointment_id'   => $appointment->getId(),
            'scheduled_at'     => $appointment->getScheduledAt()->format(DATE_ATOM),
            'ends_at'          => CallAccess::endsAt($appointment)->format(DATE_ATOM),
            'duration_minutes' => $specialist->getSlotMinutes(),
            'status'           => $appointment->getStatus()->value,
            'specialist'       => [
                'name'      => $specialist->getName(),
                'specialty' => $specialist->getSpecialty(),
            ],
            'you'              => $you,
            'uid'              => $you['uid'],
            'participants'     => CallAccess::participants($appointment),
        ];
        if ($guest !== null) {
            $meeting['invited_by'] = ['first_name' => GuestInvitations::inviterFirstName($appointment)];
            $meeting['opens_at']   = CallAccess::guestOpensAt($appointment)->format(DATE_ATOM);
            $meeting['closes_at']  = CallAccess::guestClosesAt($appointment)->format(DATE_ATOM);
        }

        return $meeting;
    }
}
