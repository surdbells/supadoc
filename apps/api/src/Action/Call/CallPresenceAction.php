<?php

declare(strict_types=1);

namespace App\Action\Call;

use App\Domain\Entity\Appointment;
use App\Domain\Repository\AppointmentRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\CallPresence;
use App\Infrastructure\Service\JwtService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/public/call/{token}/presence — heartbeat from a call screen that
 * joined with a preauthenticated link (the doctor cockpit, the emailed-link
 * page). `{"state":"in"}` every ~15 s while in the call, `{"state":"out"}` on
 * leaving (a `?state=` query works too, for unload-time requests). The signed
 * token is the credential and names the role; guests are not tracked.
 */
final class CallPresenceAction
{
    use ApiResponse;

    public function __construct(
        private readonly JwtService $jwt,
        private readonly AppointmentRepository $appointments,
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
        $appointment = $this->appointments->find($claims['appointment_id']);
        if (!$appointment instanceof Appointment) {
            return $this->error($response, 'Appointment not found', 404);
        }

        $state = self::state($request);
        if ($state === 'out') {
            $this->presence->clear($appointment, $claims['role']);
        } else {
            $this->presence->mark($appointment, $claims['role']);
        }

        return $this->success($response, ['state' => $state])->withHeader('Cache-Control', 'no-store');
    }

    /** "in" unless the body or query says "out". */
    public static function state(ServerRequestInterface $request): string
    {
        $body  = (array) ($request->getParsedBody() ?? []);
        $state = $body['state'] ?? ($request->getQueryParams()['state'] ?? 'in');

        return $state === 'out' ? 'out' : 'in';
    }
}
