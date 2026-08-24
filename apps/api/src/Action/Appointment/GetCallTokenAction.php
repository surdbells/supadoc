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
        if (!$this->agora->hasAppId()) {
            return $this->error($response, 'Video calling is not configured', 503);
        }

        // TEMPORARY: a fixed Console token overrides minting (its bound channel wins,
        // so everyone shares one room) while the certificate desync is unresolved.
        if ($this->agora->hasStaticToken()) {
            return $this->success($response, [
                'app_id'     => $this->agora->appId(),
                'channel'    => $this->agora->staticChannel(),
                'uid'        => 0,
                'token'      => $this->agora->staticToken(),
                'expires_in' => null,
            ], 'Call token issued')
                ->withHeader('Cache-Control', 'no-store');
        }

        $channel = $appointment->getId();
        // App-ID-only mode (certificate blank) → null token; client joins token-less.
        $token = $this->agora->isConfigured()
            ? $this->agora->rtcToken($channel, 0, self::TTL)
            : null;

        return $this->success($response, [
            'app_id'     => $this->agora->appId(),
            'channel'    => $channel,
            'uid'        => 0,
            'token'      => $token,
            'expires_in' => $token !== null ? self::TTL : null,
        ], 'Call token issued')
            // Never let the browser reuse a cached (possibly expired) token.
            ->withHeader('Cache-Control', 'no-store');
    }
}
