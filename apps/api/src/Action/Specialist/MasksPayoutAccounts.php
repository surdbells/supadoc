<?php

declare(strict_types=1);

namespace App\Action\Specialist;

/**
 * Bank details as the doctor-management pages show them (`specialists.manage`):
 * holder, bank and country, with account numbers cut to their last four
 * digits. The full numbers stay on the payouts screen (`payouts.manage`).
 */
trait MasksPayoutAccounts
{
    /**
     * @param array<string,mixed>|null $account PayoutAccount::toArray() / a payout's snapshot
     * @return array<string,mixed>|null
     */
    private static function maskAccount(?array $account): ?array
    {
        if ($account === null) {
            return null;
        }
        foreach (['account_number', 'iban', 'routing_number'] as $key) {
            $value = preg_replace('/\s+/', '', (string) ($account[$key] ?? ''));
            if ($value !== null && $value !== '') {
                $account[$key] = '•••• ' . substr($value, -4);
            }
        }

        return $account;
    }
}
