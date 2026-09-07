<?php

declare(strict_types=1);

namespace App\Action\Admin;

use App\Domain\Entity\Payout;
use App\Domain\Repository\PayoutRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\StaffNotifier;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/** POST /api/admin/payouts/{id}/mark-paid — mark an approved/pending payout paid. */
final class MarkPayoutPaidAction
{
    use ApiResponse;

    public function __construct(
        private readonly PayoutRepository $payouts,
        private readonly UserRepository $users,
        private readonly StaffNotifier $notifier,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $payout = $this->payouts->find((string) $args['id']);
        if (!$payout instanceof Payout) {
            return $this->error($response, 'Payout not found', 404);
        }
        if (!in_array($payout->getStatus(), [Payout::STATUS_PENDING, Payout::STATUS_APPROVED], true)) {
            return $this->error($response, 'This payout cannot be marked paid', 422, ['status' => 'Not payable']);
        }

        $body  = (array) $request->getParsedBody();
        $actor = $this->actorName((string) $request->getAttribute('user_id'));
        $payout->markPaid($actor, isset($body['reference']) ? (string) $body['reference'] : null);
        $this->payouts->save($payout);

        $this->notifier->notifyDoctor($payout->getSpecialistId(), 'payout', 'Payout paid', 'Your payout has been sent.', '/payouts');

        return $this->success($response, $payout->toArray(), 'Payout marked paid');
    }

    private function actorName(string $userId): string
    {
        $user = $this->users->find($userId);
        if ($user === null) {
            return 'Admin';
        }
        $a = $user->toArray();

        return trim(((string) $a['first_name']) . ' ' . ((string) $a['last_name'])) ?: 'Admin';
    }
}
