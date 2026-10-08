<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\CallPresence;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/appointments/presence — who is in the call right now, for the
 * signed-in patient's appointments that have anyone in them:
 * `{ "<appointment id>": { "doctor": true, "patient": false } }`. Polled by the
 * appointment list / page while they are open.
 */
final class MyCallPresenceAction
{
    use ApiResponse;

    public function __construct(private readonly CallPresence $presence)
    {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $map = $this->presence->forPatient((string) $request->getAttribute('customer_id'));

        // An object even when empty, so the client always gets a map.
        return $this->success($response, (object) $map)->withHeader('Cache-Control', 'no-store');
    }
}
