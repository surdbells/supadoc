<?php

declare(strict_types=1);

namespace App\Action\Auth;

use App\Domain\Repository\StaffNotificationRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/** GET /api/me/notifications/unread — unread notification count (for the badge). */
final class UnreadStaffNotificationsAction
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

        return $this->success($response, ['count' => $this->notifications->unreadCountForUser($userId)]);
    }
}
