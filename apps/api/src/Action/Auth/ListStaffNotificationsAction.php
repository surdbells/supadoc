<?php

declare(strict_types=1);

namespace App\Action\Auth;

use App\Domain\Entity\StaffNotification;
use App\Domain\Repository\StaffNotificationRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/** GET /api/me/notifications — the signed-in staff user's notifications (paginated). */
final class ListStaffNotificationsAction
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
        $query  = $request->getQueryParams();
        $params = $this->getPaginationParams($query);
        $unread = ($query['unread'] ?? '') === 'true' || ($query['unread'] ?? '') === '1';

        $page  = $this->notifications->paginatedForUser($params['offset'], $params['per_page'], $userId, $unread);
        $items = array_map(static fn (StaffNotification $n): array => $n->toArray(), $page['items']);

        return $this->paginated($response, $items, $page['total'], $params['page'], $params['per_page']);
    }
}
