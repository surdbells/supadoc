<?php

declare(strict_types=1);

namespace App\Action\Auth;

use App\Domain\Repository\StaffNotificationRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/** POST /api/me/notifications/read-all — mark all notifications read. */
final class MarkAllStaffNotificationsReadAction
{
    use ApiResponse;

    public function __construct(private readonly StaffNotificationRepository $notifications)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $userId = (string) $request->getAttribute('user_id');
        $this->notifications->markAllRead($userId);

        return $this->success($response, ['read' => true]);
    }
}
