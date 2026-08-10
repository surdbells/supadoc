<?php

declare(strict_types=1);

namespace App\Action\Patient;

use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\SessionService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/me/sessions — the signed-in patient's active sessions
 * (devices), newest first, with the current one flagged.
 */
final class MySessionsAction
{
    use ApiResponse;

    public function __construct(private readonly SessionService $sessions)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $customerId = (string) $request->getAttribute('customer_id');
        $current    = (string) $request->getAttribute('session_id');

        $data = array_map(
            static fn ($s) => $s->toArray($current),
            $this->sessions->listForPatient($customerId),
        );

        return $this->success($response, $data);
    }
}
