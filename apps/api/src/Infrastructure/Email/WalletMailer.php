<?php

declare(strict_types=1);

namespace App\Infrastructure\Email;

use App\Domain\Entity\WalletTransaction;
use App\Domain\Repository\PatientRepository;

/**
 * Emails a receipt for a wallet posting (funding / consultation debit / refund).
 * Best-effort: a mail failure never affects the ledger, so callers can invoke
 * this right after a successful posting without a try/catch of their own.
 */
final class WalletMailer
{
    public function __construct(
        private readonly PatientRepository $patients,
        private readonly MailService $mail,
    ) {
    }

    /** Send the transaction receipt to the wallet owner. */
    public function sendReceipt(WalletTransaction $txn): void
    {
        try {
            $patient = $this->patients->find($txn->getPatientId());
            if ($patient === null) {
                return;
            }
            $p      = $patient->toArray();
            $email  = (string) ($p['email'] ?? '');
            if ($email === '') {
                return;
            }
            $name   = trim((string) ($p['first_name'] ?? '') . ' ' . (string) ($p['last_name'] ?? ''));
            $symbol = $txn->getCurrency() === 'NGN' ? '₦' : $txn->getCurrency() . ' ';
            $webUrl = rtrim((string) ($_ENV['APP_WEB_URL'] ?? 'http://localhost:4201'), '/');

            $mail = EmailTemplates::walletReceipt($txn->toArray(), (string) ($p['first_name'] ?? ''), $symbol, $webUrl);
            $this->mail->send($email, $name, $mail['subject'], $mail['html']);
        } catch (\Throwable) {
            // logged inside MailService; the posting already succeeded.
        }
    }
}
