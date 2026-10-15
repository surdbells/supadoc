<?php

declare(strict_types=1);

namespace App\Action\Wallet;

use App\Domain\Entity\WalletTransaction;
use App\Domain\Repository\WalletTransactionRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\PaystackService;
use App\Infrastructure\Service\WalletService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/wallet/verify — confirm a top-up after the Paystack redirect
 * (or the inline pop-up's onSuccess).
 *
 * Re-verifies with Paystack (never trusts the client), then settles the entry
 * through {@see WalletService::settleTopup()}, which credits it at most once no
 * matter how many verifies / webhooks race, and only when Paystack's verified
 * amount and currency equal what the top-up asked for. Safe to repeat: an entry
 * that is already decided is answered from our ledger without calling Paystack
 * again (so retries and refreshes cost nothing), and only the call that credited
 * it triggers the receipt.
 *
 * Answers (non-2xx carry an honest message the apps show as-is):
 *  - 200 `status: success` + wallet + transaction — credited now ("Wallet funded")
 *    or earlier ("already in your wallet");
 *  - 402 — Paystack says the charge failed / was abandoned: nothing added;
 *  - 409 — still processing at the bank (it is credited when Paystack confirms),
 *    or paid with a different amount/currency and held for support;
 *  - 404 — no such top-up for this patient; 502 — Paystack unreachable.
 * A 402/409 built from Paystack's answer is only given after re-reading the
 * ledger: if a webhook (or another verify) credited the top-up while this
 * request was asking Paystack, the patient is told it is in their wallet.
 */
final class VerifyFundingAction
{
    use ApiResponse;

    /** Paystack statuses final enough to mark the entry failed (an abandoned checkout can still be paid). */
    private const GATEWAY_FAILED = ['failed', 'reversed'];

    public function __construct(
        private readonly WalletService $wallets,
        private readonly WalletTransactionRepository $txns,
        private readonly PaystackService $paystack,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $customerId = (string) $request->getAttribute('customer_id');
        $body       = (array) ($request->getParsedBody() ?? []);
        $reference  = trim((string) ($body['reference'] ?? ($request->getQueryParams()['reference'] ?? '')));

        if ($reference === '') {
            return $this->noStore($this->error($response, 'Missing payment reference', 422));
        }

        $txn = strlen($reference) <= 80 ? $this->txns->byReference($reference) : null;
        // Not found, not this patient's, or not a top-up — same opaque 404 either way.
        if ($txn === null || $txn->getPatientId() !== $customerId || !$txn->isTopup()) {
            return $this->noStore($this->error($response, 'Transaction not found', 404));
        }

        // Already decided (credited / held / resolved): answer from the ledger, no gateway call.
        if (!$txn->isSettleable()) {
            return $this->decided($response, $txn, false);
        }

        try {
            $result = $this->paystack->verify($reference);
        } catch (\RuntimeException) {
            return $this->noStore($this->error($response, 'Could not verify the payment. Please try again.', 502));
        }

        switch (self::gatewayOutcome($result['status'])) {
            case 'paid':
                try {
                    $posted = $this->wallets->settleTopup(
                        $reference,
                        (string) $result['amount_minor'],
                        $result['currency'],
                        $result['gateway_reference'],
                        [
                            'gross_amount_minor'     => $result['gross_amount_minor'] ?? null,
                            'fees_minor'             => $result['fees_minor'] ?? null,
                            'requested_amount_minor' => $result['requested_amount_minor'] ?? null,
                        ],
                    );
                } catch (\InvalidArgumentException $e) {
                    // A malformed verified amount: nothing was changed or credited.
                    error_log(sprintf('[wallet.verify] unusable Paystack amount for ref=%s: %s', $reference, $e->getMessage()));

                    return $this->noStore($this->error($response, 'Could not verify the payment. Please try again.', 502));
                }

                // settleTopup re-read this same entry under lock, so $txn is current.
                return $this->decided($response, $txn, $posted !== null);

            case 'not_paid':
                $marked = in_array(strtolower(trim($result['status'])), self::GATEWAY_FAILED, true)
                    && $this->wallets->failTopup($reference);
                if (!$marked && ($decided = $this->decidedMeanwhile($reference)) !== null) {
                    return $this->decided($response, $decided, false);
                }

                return $this->noStore($this->error(
                    $response,
                    "This payment wasn't completed, so nothing was added to your wallet. You can try again.",
                    402,
                ));

            default:
                // ongoing / pending / processing / queued…: leave it pending — the
                // webhook (or another verify) credits it once Paystack confirms.
                if (($decided = $this->decidedMeanwhile($reference)) !== null) {
                    return $this->decided($response, $decided, false);
                }

                return $this->noStore($this->error(
                    $response,
                    "Your payment is still being confirmed. You don't need to pay again — it will be added to your wallet as soon as Paystack confirms it.",
                    409,
                ));
        }
    }

    /**
     * What a Paystack verify status means for a top-up: `paid` (settle it),
     * `not_paid` (the charge did not complete) or `processing` (not final yet —
     * anything we don't recognise is treated as not final, never as paid).
     */
    public static function gatewayOutcome(string $paystackStatus): string
    {
        return WalletService::gatewayOutcome($paystackStatus);
    }

    /**
     * The entry as the database has it NOW, if something else decided it while
     * this request was asking Paystack (the webhook credited it, another verify
     * held it…); null while it is still open. Asked before answering "nothing
     * was added", so that answer is never given for money that was added.
     */
    private function decidedMeanwhile(string $reference): ?WalletTransaction
    {
        $fresh = $this->txns->byReferenceFresh($reference);

        return $fresh !== null && !$fresh->isSettleable() ? $fresh : null;
    }

    /** The answer for an entry whose outcome is already in the ledger. */
    private function decided(ResponseInterface $response, WalletTransaction $txn, bool $creditedNow): ResponseInterface
    {
        // A pre-fix row left `failed` after it was credited still holds its money
        // in the wallet (support restores its status): tell the patient so.
        if ($txn->isSuccess() || $txn->isPostedButNotSuccess()) {
            $wallet = $this->wallets->walletFor($txn->getPatientId(), $txn->getCurrency());

            return $this->noStore($this->success($response, [
                'status'      => 'success',
                'wallet'      => $wallet->toArray(),
                'transaction' => $txn->toArray(),
            ], $creditedNow ? 'Wallet funded' : 'This payment is already in your wallet'));
        }

        $message = match ($txn->getStatus()) {
            WalletTransaction::STATUS_REVIEW => sprintf(
                "We received your payment, but it doesn't match the amount of the top-up you started, so it hasn't been added to your wallet. It has been flagged for our support team to review — please contact support and quote reference %s.",
                $txn->getReference(),
            ),
            WalletTransaction::STATUS_RESOLVED => sprintf(
                'Our support team has already reviewed this payment (reference %s) — see your wallet history for the outcome.',
                $txn->getReference(),
            ),
            default => 'We could not add this payment to your wallet yet. Please try again in a moment.',
        };

        return $this->noStore($this->error($response, $message, 409));
    }

    private function noStore(ResponseInterface $response): ResponseInterface
    {
        return $response->withHeader('Cache-Control', 'no-store');
    }
}
