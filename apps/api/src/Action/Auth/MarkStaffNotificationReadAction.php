<?php

declare(strict_types=1);

namespace App\Action\Auth;

use App\Domain\Entity\StaffNotification;
use App\Domain\Repository\StaffNotificationRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/** POST /api/me/notifications/{id}/read — mark one notification read. */
final class MarkStaffNotificationReadAction
{
    use ApiResponse;

    public function __construct(private readonly StaffNotificationRepository $notifications)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $userId       = (string) $request->getAttribute('user_id');
        $notification = $this->notifications->find((string) $args['id']);
        if (!$notification instanceof StaffNotification || $notification->getUserId() !== $userId) {
            return $this->error($response, 'Notification not found', 404);
        }

        $notification->markRead();
        $this->notifications->save($notification);

        return $this->success($response, $notification->toArray());
    }
}
