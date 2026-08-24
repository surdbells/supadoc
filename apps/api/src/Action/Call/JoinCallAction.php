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
        if ($this->agora->hasAppId()) {
            $meeting['app_id']  = $this->agora->appId();
            $meeting['configured'] = true;
            if ($this->agora->hasStaticToken()) {
                // TEMPORARY: fixed Console token overrides minting; its bound channel
                // wins, so all parties share one room until the cert desync is fixed.
                // The token is a wildcard (uid 0), so each party's uid still works.
                $meeting['channel']    = $this->agora->staticChannel();
                $meeting['uid']        = $claims['uid'];
                $meeting['token']      = $this->agora->staticToken();
                $meeting['expires_in'] = null;
            } else {
                $channel            = $appointment->getId();
                $meeting['channel'] = $channel;
                $meeting['uid']     = $claims['uid'];
                // App-ID-only mode (certificate blank) → null token; join token-less.
                $meeting['token']   = $this->agora->isConfigured()
                    ? $this->agora->rtcToken($channel, $claims['uid'], self::TTL)
                    : null;
                $meeting['expires_in'] = $meeting['token'] !== null ? self::TTL : null;
            }
        } else {
            $meeting['configured'] = false;
        }

        return $this->success($response, $meeting, 'Ready to join')
            // Never let the browser reuse a cached (possibly expired) token.
            ->withHeader('Cache-Control', 'no-store');
    }
}
