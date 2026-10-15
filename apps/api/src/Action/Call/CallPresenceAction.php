<?php

declare(strict_types=1);

namespace App\Action\Call;

use App\Domain\Call\CallAccess;
use App\Domain\Entity\Appointment;
use App\Domain\Repository\AppointmentRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\CallPresence;
use App\Infrastructure\Service\GuestConsent;
use App\Infrastructure\Service\GuestInvitations;
use App\Infrastructure\Service\JwtService;
use DateTimeImmutable;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/public/call/{token}/presence — heartbeat from a call screen that
 * joined with a preauthenticated link (the doctor cockpit, the emailed-link
 * page, a guest). `{"state":"in"}` every ~15 s while in the call,
 * `{"state":"out"}` on leaving (a `?state=` query works too, for unload-time
 * requests). The signed token is the credential and names the role; a guest
 * is tracked by their guest id, and their (re)joins are audited.
 *
 * An "in" answers who is in the call now and everyone who may be (so a call
 * screen can label a new tile and show live states) and, to a guest, their
 * consent state; or refuses like joining does — 410 once the consultation was
 * cancelled or completed or the guest was removed (the call screen should
 * leave), 409 for an unaccepted follow-up, 425 before a guest's window opens
 * — without the end of the guest join window: a call that runs over keeps its
 * guests (for at most CallAccess::GUEST_OVERRUN_HOURS). An "out" is always
 * accepted.
 */
final class CallPresenceAction
{
    use ApiResponse;

    public function __construct(
        private readonly JwtService $jwt,
        private readonly AppointmentRepository $appointments,
        private readonly CallPresence $presence,
        private readonly GuestInvitations $guests,
        private readonly GuestConsent $consent,
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
        $appointment = $this->appointments->find($claims['appointment_id']);
        if (!$appointment instanceof Appointment) {
            return $this->error($response, 'Appointment not found', 404);
        }

        $guest   = CallAccess::guestFor($appointment, $claims);
        $guestId = $claims['role'] === 'guest' ? (string) ($guest['id'] ?? $claims['gid'] ?? '') : null;
        $state   = self::state($request);
        $now     = new DateTimeImmutable();
        if ($state === 'out') {
            $this->presence->clear($appointment, $claims['role'], $guestId);
            if ($guest !== null && CallAccess::guestMayBeConnected($guest, $now)) {
                // Left cleanly: no longer counted in the call by their token (GuestConsent).
                $this->appointments->updateGuestLocked($appointment, (string) $guest['id'], ['left_at' => $now->format(DATE_ATOM)]);
            }

            return $this->success($response, ['state' => $state])->withHeader('Cache-Control', 'no-store');
        }

        // A guest's window opens before any heartbeat can (joining needs it).
        $problem = CallAccess::problem($appointment, $claims, $guest, $now, early: true, late: false);
        if ($problem !== null) {
            $this->presence->clear($appointment, $claims['role'], $guestId);

            return $this->error($response, $problem[1], $problem[0], $problem[2])->withHeader('Cache-Control', 'no-store');
        }

        $joined = $this->presence->mark($appointment, $claims['role'], $guestId);
        if ($guest !== null) {
            $this->guests->markJoined($appointment, $guest, $joined);
        }

        return $this->success($response, self::beat(
            $state,
            $this->presence->forAppointment($appointment),
            $appointment,
            $guest !== null ? $this->consent->state($appointment, $guest) : null,
        ))->withHeader('Cache-Control', 'no-store');
    }

    /** "in" unless the body or query says "out". */
    public static function state(ServerRequestInterface $request): string
    {
        $body  = (array) ($request->getParsedBody() ?? []);
        $state = $body['state'] ?? ($request->getQueryParams()['state'] ?? 'in');

        return $state === 'out' ? 'out' : 'in';
    }

    /**
     * An "in" heartbeat's answer: who is in the call now and everyone who may
     * be, by uid (names only) — and to a guest, their consent state
     * ({@see GuestConsent::state()}), so their screen can ask for it when the
     * patient agrees to recording mid-call.
     *
     * @param array{doctor:bool, patient:bool, guests:list<string>} $presence
     * @param array<string,mixed>|null $consent
     * @return array<string,mixed>
     */
    public static function beat(string $state, array $presence, Appointment $appointment, ?array $consent = null): array
    {
        $beat = [
            'state'        => $state,
            'presence'     => $presence,
            'participants' => CallAccess::participants($appointment),
        ];
        if ($consent !== null) {
            $beat['consent'] = $consent;
        }

        return $beat;
    }
}
