<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\Payout;
use App\Domain\Repository\PayoutAccountRepository;
use App\Domain\Repository\PayoutRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\EarningsService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/doctor/payouts — request a payout of available earnings. Requires a
 * saved payout account, no open request, and an amount that is positive and no
 * more than the available balance. The beneficiary is snapshot onto the request.
 */
final class RequestPayoutAction
{
    use ApiResponse;
    use ResolvesDoctorSpecialist;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly PayoutRepository $payouts,
        private readonly PayoutAccountRepository $accounts,
        private readonly EarningsService $earnings,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $specialist = $this->doctorSpecialist($request, $this->users, $this->specialists);
        if ($specialist === null) {
            return $this->error($response, 'This account is not a doctor profile', 403);
        }

        $account = $this->accounts->forSpecialist($specialist->getId());
        if ($account === null) {
            return $this->error($response, 'Add your payout account details first', 422, [
                'account' => 'Payout account required',
            ]);
        }
        if ($this->payouts->hasOpenRequest($specialist->getId())) {
            return $this->error($response, 'You already have a payout request in progress', 422, [
                'amount' => 'A request is already pending',
            ]);
        }

        $summary   = $this->earnings->summary($specialist->getId());
        $available = (string) $summary['available_balance'];

        $body   = (array) $request->getParsedBody();
        $raw    = trim((string) ($body['amount'] ?? ''));
        if ($raw === '' || !is_numeric($raw) || bccomp($raw, '0', 2) <= 0) {
            return $this->error($response, 'Validation failed', 422, ['amount' => 'Enter an amount greater than zero']);
        }
        $amount = bcadd($raw, '0', 2);
        if (bccomp($amount, $available, 2) > 0) {
            return $this->error($response, 'Amount exceeds your available balance', 422, [
                'amount' => 'You can request at most ' . $available,
            ]);
        }

        $payout = new Payout(
            $specialist->getId(),
            $specialist->getName(),
            $amount,
            (string) $summary['currency'] === '₦' ? 'NGN' : (string) $summary['currency'],
            $account->toArray(),
            isset($body['note']) ? (string) $body['note'] : null,
        );
        $this->payouts->save($payout);

        return $this->created($response, $payout->toArray(), 'Payout requested');
    }
}
