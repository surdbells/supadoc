<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\PayoutAccount;
use App\Domain\Repository\PayoutAccountRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * PUT /api/doctor/payout-account — create/update the doctor's payout beneficiary
 * (international). Requires account holder, bank, country, currency and at least
 * one of IBAN / account number.
 */
final class SavePayoutAccountAction
{
    use ApiResponse;
    use ResolvesDoctorSpecialist;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly PayoutAccountRepository $accounts,
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

        $body     = (array) $request->getParsedBody();
        $holder   = trim((string) ($body['account_holder'] ?? ''));
        $bank     = trim((string) ($body['bank_name'] ?? ''));
        $country  = trim((string) ($body['country'] ?? ''));
        $currency = strtoupper(trim((string) ($body['currency'] ?? '')));
        $iban     = trim((string) ($body['iban'] ?? ''));
        $accNo    = trim((string) ($body['account_number'] ?? ''));

        $errors = [];
        if ($holder === '') {
            $errors['account_holder'] = 'Account holder is required';
        }
        if ($bank === '') {
            $errors['bank_name'] = 'Bank name is required';
        }
        if ($country === '') {
            $errors['country'] = 'Bank country is required';
        }
        if (strlen($currency) !== 3) {
            $errors['currency'] = 'A 3-letter currency code is required';
        }
        if ($iban === '' && $accNo === '') {
            $errors['account_number'] = 'Enter an IBAN or an account number';
        }
        if ($errors !== []) {
            return $this->error($response, 'Validation failed', 422, $errors);
        }

        $account = $this->accounts->forSpecialist($specialist->getId()) ?? new PayoutAccount($specialist->getId());
        $account->setAccountHolder($holder);
        $account->setBankName($bank);
        $account->setCountry($country);
        $account->setCurrency($currency);
        $account->setIban($iban !== '' ? $iban : null);
        $account->setAccountNumber($accNo !== '' ? $accNo : null);
        $account->setSwift(isset($body['swift']) ? (string) $body['swift'] : null);
        $account->setRoutingNumber(isset($body['routing_number']) ? (string) $body['routing_number'] : null);
        $this->accounts->save($account);

        return $this->success($response, $account->toArray(), 'Payout account saved');
    }
}
