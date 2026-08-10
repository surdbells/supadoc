<?php

declare(strict_types=1);

namespace App\Action\Patient;

use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\SessionService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * DELETE /api/portal/me/sessions/{id} — sign out one of the patient's own
 * sessions. Its token is rejected on the next request.
 */
final class RevokeSessionAction
{
    use ApiResponse;

    public function __construct(private readonly SessionService $sessions)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $customerId = (string) $request->getAttribute('customer_id');
        $id         = (string) ($args['id'] ?? '');

        if (!$this->sessions->revoke($id, $customerId)) {
            return $this->error($response, 'Session not found', 404);
        }

        return $this->success($response, ['revoked' => true], 'Signed out of that device');
    }
}
