<?php

declare(strict_types=1);

namespace App\Action\Notification;

use App\Domain\Repository\NotificationRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/** POST /api/portal/notifications/read-all — mark all as read. */
final class MarkAllNotificationsReadAction
{
    use ApiResponse;

    public function __construct(private readonly NotificationRepository $repo)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $customerId = (string) $request->getAttribute('customer_id');
        $this->repo->markAllRead($customerId);

        return $this->success($response, ['unread' => 0], 'All notifications marked as read');
    }
}
