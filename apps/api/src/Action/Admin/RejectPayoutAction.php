<?php

declare(strict_types=1);

namespace App\Action\Admin;

use App\Domain\Entity\Payout;
use App\Domain\Repository\PayoutRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/** POST /api/admin/payouts/{id}/reject — reject a pending/approved payout. */
final class RejectPayoutAction
{
    use ApiResponse;

    public function __construct(
        private readonly PayoutRepository $payouts,
        private readonly UserRepository $users,
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
            return $this->error($response, 'This payout cannot be rejected', 422, ['status' => 'Not rejectable']);
        }

        $body  = (array) $request->getParsedBody();
        $actor = $this->actorName((string) $request->getAttribute('user_id'));
        $payout->reject($actor, isset($body['admin_note']) ? (string) $body['admin_note'] : null);
        $this->payouts->save($payout);

        return $this->success($response, $payout->toArray(), 'Payout rejected');
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
