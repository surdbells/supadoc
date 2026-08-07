<?php

declare(strict_types=1);

namespace App\Action\Notification;

use App\Domain\Entity\Notification;
use App\Domain\Exception\EntityNotFoundException;
use App\Domain\Repository\NotificationRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/** POST /api/portal/notifications/{id}/read — mark one notification read. */
final class MarkNotificationReadAction
{
    use ApiResponse;

    public function __construct(private readonly NotificationRepository $repo)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $customerId   = (string) $request->getAttribute('customer_id');
        $id           = (string) $args['id'];
        $notification = $this->repo->findForPatient($id, $customerId);

        if ($notification === null) {
            throw EntityNotFoundException::for(Notification::class, $id);
        }

        $notification->markRead();
        $this->repo->save($notification);

        return $this->success($response, $notification->toArray(), 'Marked as read');
    }
}
