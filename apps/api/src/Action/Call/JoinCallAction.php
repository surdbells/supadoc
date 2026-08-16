<?php

declare(strict_types=1);

namespace App\Action\Call;

use App\Domain\Entity\Appointment;
use App\Domain\Exception\EntityNotFoundException;
use App\Domain\Repository\AppointmentRepository;
use App\Infrastructure\Agora\AgoraTokenService;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\JwtService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/public/call/{token} — a preauthenticated way into the video room. The
 * token is the signed call-access JWT emailed to each party (patient, doctor,
 * guest); it carries the appointment, the party's display name, role and Agora
 * uid, so nobody has to log in to join. Public by design — the token IS the
 * credential, so it's validated here rather than by auth middleware.
 */
final class JoinCallAction
{
    use ApiResponse;

    private const TTL = 3600;

    public function __construct(
        private readonly JwtService $jwt,
        private readonly AppointmentRepository $appointments,
        private readonly AgoraTokenService $agora,
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

        $specialist = $appointment->getSpecialist();
        $meeting    = [
            'appointment_id' => $appointment->getId(),
            'scheduled_at'   => $appointment->getScheduledAt()->format(DATE_ATOM),
            'specialist'     => [
                'name'      => $specialist->getName(),
                'specialty' => $specialist->getSpecialty(),
            ],
            'you'            => ['name' => $claims['name'], 'role' => $claims['role']],
        ];

        // The channel is the appointment id, so every party lands in the same room.
        if ($this->agora->isConfigured()) {
            $channel            = $appointment->getId();
            $meeting['app_id']  = $this->agora->appId();
            $meeting['channel'] = $channel;
            $meeting['uid']     = $claims['uid'];
            $meeting['token']   = $this->agora->rtcToken($channel, $claims['uid'], self::TTL);
            $meeting['expires_in'] = self::TTL;
            $meeting['configured'] = true;
        } else {
            $meeting['configured'] = false;
        }

        return $this->success($response, $meeting, 'Ready to join');
    }
}
