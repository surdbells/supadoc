<?php

declare(strict_types=1);

namespace App\Action\Notification;

use App\Domain\Enum\NotificationType;
use App\Domain\Repository\NotificationRepository;
use App\Infrastructure\Service\ApiResponse;
use DateTimeImmutable;
use DateTimeZone;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/notifications — the signed-in patient's notifications,
 * newest first, with an `unread` count in `meta` and `meta.counts` — the
 * total / unread per type, for the filter tabs (always for the whole account,
 * whatever the filters). `?unread=true` filters to unread only,
 * `?type=prescription` (etc.) to one type, and `?before=` pages by time.
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
        // An unknown type is ignored rather than rejected (lists everything).
        $type   = is_string($query['type'] ?? null) ? NotificationType::tryFrom($query['type']) : null;
        $before = $this->parseBefore($query['before'] ?? null);

        $result = $this->repo->paginated($p['offset'], $p['per_page'], $customerId, $unreadOnly, $type, $before);
        $counts = $this->repo->countsByType($customerId);

        return $this->json($response, [
            'status'  => 'success',
            'message' => 'OK',
            'data'    => array_map(static fn ($n) => $n->toArray(), $result['items']),
            'meta'    => [
                'total'       => $result['total'],
                'page'        => $p['page'],
                'per_page'    => $p['per_page'],
                'total_pages' => $p['per_page'] > 0 ? (int) ceil($result['total'] / $p['per_page']) : 0,
                'unread'      => array_sum(array_column($counts, 'unread')),
                'counts'      => $counts,
            ],
        ]);
    }

    /**
     * `?before=` — a notification's `created_at` (ISO 8601): only that moment and
     * older are listed, so "load more" carries on from the last one shown even as
     * new ones arrive or unread ones are read. Unparseable values are ignored.
     */
    private function parseBefore(mixed $raw): ?DateTimeImmutable
    {
        if (!is_string($raw) || trim($raw) === '') {
            return null;
        }
        // An unencoded "+01:00" offset arrives as " 01:00" — put the plus back.
        $value = (string) preg_replace('/ (\d{2}:?\d{2})$/', '+$1', trim($raw));
        try {
            // Stored timestamps are naive, in the process timezone.
            return (new DateTimeImmutable($value))->setTimezone(new DateTimeZone(date_default_timezone_get()));
        } catch (\Exception) {
            return null;
        }
    }
}
