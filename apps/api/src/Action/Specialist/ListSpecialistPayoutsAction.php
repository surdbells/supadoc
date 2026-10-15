<?php

declare(strict_types=1);

namespace App\Action\Specialist;

use App\Domain\Entity\Payout;
use App\Domain\Entity\Specialist;
use App\Domain\Repository\PayoutAccountRepository;
use App\Domain\Repository\PayoutRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\EarningsService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/specialists/{id}/payouts — the doctor page's Earnings & payouts tab:
 * the earnings summary, their payout requests (newest first, up to 100) and
 * their payout account, account numbers masked to the last four digits
 * (approving and paying stays on the payouts screen, `payouts.manage`).
 * Needs `specialists.manage`.
 */
final class ListSpecialistPayoutsAction
{
    use ApiResponse;
    use MasksPayoutAccounts;

    public function __construct(
        private readonly SpecialistRepository $specialists,
        private readonly PayoutRepository $payouts,
        private readonly PayoutAccountRepository $accounts,
        private readonly EarningsService $earnings,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        /** @var Specialist $specialist */
        $specialist = $this->specialists->findOrFail((string) ($args['id'] ?? ''));
        $id         = $specialist->getId();

        return $this->success($response, [
            'earnings' => $this->earnings->summary($id),
            'payouts'  => array_map(static function (Payout $p): array {
                $row            = $p->toArray();
                $row['account'] = self::maskAccount(is_array($row['account'] ?? null) ? $row['account'] : null);

                return $row;
            }, $this->payouts->forSpecialist($id)),
            'payout_account' => self::maskAccount($this->accounts->forSpecialist($id)?->toArray()),
        ]);
    }
}
