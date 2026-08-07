<?php

declare(strict_types=1);

namespace App\Action\Notification;

use App\Domain\Repository\NotificationRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/notifications — the signed-in patient's notifications,
 * newest first, with an `unread` count in `meta`. `?unread=true` filters to
 * unread only.
 */
final class ListNotificationsAction
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
        $query      = $request->getQueryParams();
        $p          = $this->getPaginationParams($query);

        $unreadOnly = array_key_exists('unread', $query)
            ? filter_var($query['unread'], FILTER_VALIDATE_BOOLEAN)
            : null;

        $result = $this->repo->paginated($p['offset'], $p['per_page'], $customerId, $unreadOnly);

        return $this->json($response, [
            'status'  => 'success',
            'message' => 'OK',
            'data'    => array_map(static fn ($n) => $n->toArray(), $result['items']),
            'meta'    => [
                'total'       => $result['total'],
                'page'        => $p['page'],
                'per_page'    => $p['per_page'],
                'total_pages' => $p['per_page'] > 0 ? (int) ceil($result['total'] / $p['per_page']) : 0,
                'unread'      => $this->repo->unreadCount($customerId),
            ],
        ]);
    }
}
