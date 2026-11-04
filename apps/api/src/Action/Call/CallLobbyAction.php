<?php

declare(strict_types=1);

namespace App\Action\Call;

use App\Domain\Call\CallAccess;
use App\Domain\Entity\Appointment;
use App\Domain\Exception\EntityNotFoundException;
use App\Domain\Repository\AppointmentRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\GuestConsent;
use App\Infrastructure\Service\JwtService;
use DateTimeImmutable;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/public/call/{token}/lobby — what the pre-join screen shows, without
 * joining: the consultation (doctor, time, who invited a guest), who may be in
 * the call, a guest's consent state, whether joining is open now, and — for a
 * doctor's link only — the doctor portal's call page (`doctor_portal_url`). It
 * never mints Agora credentials (GET /public/call/{token} does) and never
 * carries health data or emails.
 *
 * The same refusals as joining (410 cancelled / ended / withdrawn, 409 not
 * confirmed) except "too early": an early guest gets the lobby with
 * `can_join: false` and `opens_at` to count down to.
 */
final class CallLobbyAction
{
    use ApiResponse;

    public function __construct(
        private readonly JwtService $jwt,
        private readonly AppointmentRepository $appointments,
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
        /** @var Appointment|null $appointment */
        $appointment = $this->appointments->find($claims['appointment_id']);
        if ($appointment === null) {
            throw EntityNotFoundException::for(Appointment::class, $claims['appointment_id']);
        }

        $now   = new DateTimeImmutable();
        $guest = CallAccess::guestFor($appointment, $claims);
        if (($problem = CallAccess::problem($appointment, $claims, $guest, $now, early: false)) !== null) {
            return $this->error($response, $problem[1], $problem[0], $problem[2])->withHeader('Cache-Control', 'no-store');
        }

        $lobby = JoinCallAction::meeting($appointment, $claims, $guest) + [
            'server_time' => $now->format(DATE_ATOM),
            'can_join'    => true,
        ];
        if ($guest !== null) {
            $lobby['consent']  = $this->consent->state($appointment, $guest);
            $lobby['can_join'] = $now >= CallAccess::guestOpensAt($appointment);
        }
        // A doctor's link opened on the patient app goes on to the doctor portal's
        // call page from here, without first asking the join (which mints Agora
        // credentials). Never on a patient's or a guest's link.
        if (($claims['role'] ?? '') === 'doctor') {
            $lobby['doctor_portal_url'] = JoinCallAction::doctorPortalUrl($appointment, (string) ($args['token'] ?? ''));
        }

        return $this->success($response, $lobby)->withHeader('Cache-Control', 'no-store');
    }
}
