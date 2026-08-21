<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Entity\Appointment;
use App\Domain\Exception\EntityNotFoundException;
use App\Domain\Repository\AppointmentRepository;
use App\Infrastructure\Agora\AgoraTokenService;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/appointments/{id}/call-token — an Agora RTC token for the
 * consultation. The channel is the appointment id, so patient and specialist
 * join the same room. Scoped to the signed-in patient (a foreign id → 404).
 */
final class GetCallTokenAction
{
    use ApiResponse;

    private const TTL = 3600;

    public function __construct(
        private readonly AppointmentRepository $repo,
        private readonly AgoraTokenService $agora,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $customerId  = (string) $request->getAttribute('customer_id');
        $id          = (string) $args['id'];
        $appointment = $this->repo->findForPatient($id, $customerId);

        if ($appointment === null) {
            throw EntityNotFoundException::for(Appointment::class, $id);
        }
        if (!$this->agora->isConfigured()) {
            return $this->error($response, 'Video calling is not configured', 503);
        }

        $channel = $appointment->getId();
        $token   = $this->agora->rtcToken($channel, 0, self::TTL);

        return $this->success($response, [
            'app_id'     => $this->agora->appId(),
            'channel'    => $channel,
            'uid'        => 0,
            'token'      => $token,
            'expires_in' => self::TTL,
        ], 'Call token issued')
            // Never let the browser reuse a cached (possibly expired) token.
            ->withHeader('Cache-Control', 'no-store');
    }
}
