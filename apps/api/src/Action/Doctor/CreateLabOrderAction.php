<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/doctor/appointments/{id}/lab-orders — retired (lab spec Q36): free-
 * text lab orders can no longer be created; doctors send a signed lab request
 * (POST /api/doctor/lab-requests) instead. Earlier orders stay readable
 * through the GET routes. Answers 410 `lab_orders_retired` to any caller, so an
 * old tab learns where the feature went; nothing is written.
 */
final class CreateLabOrderAction
{
    use ApiResponse;

    public const MESSAGE = 'Lab orders have moved. Use New lab request.';

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        return $this->error($response, self::MESSAGE, 410, ['code' => 'lab_orders_retired', 'message' => self::MESSAGE])
            ->withHeader('Cache-Control', 'no-store');
    }
}
