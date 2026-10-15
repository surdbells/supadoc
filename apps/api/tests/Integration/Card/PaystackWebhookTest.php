<?php

declare(strict_types=1);

namespace App\Tests\Integration\Card;

use App\Action\Wallet\PaystackWebhookAction;
use App\Domain\Entity\PaymentIntent;
use App\Domain\Entity\WalletTransaction;
use App\Infrastructure\Service\PaymentIntentService;
use App\Infrastructure\Service\WalletService;
use App\Tests\Integration\Card\Support\CardHarness;
use App\Tests\Integration\Card\Support\FakeCardGateway;
use Doctrine\ORM\EntityManagerInterface;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Factory\StreamFactory;

/**
 * The Paystack webhook: a valid signature is required, charges are settled by
 * reference after re-verifying with Paystack, repeats change nothing, and a
 * webhook racing the patient's own confirmation settles the money once.
 */
final class PaystackWebhookTest extends CardIntegrationTestCase
{
    public function testASignatureIsRequiredAndNothingIsReadWithoutOne(): void
    {
        [$patientId, $doctor] = $this->patientAndDoctor();
        $ref = $this->checkout($patientId, PaymentIntent::PURPOSE_BOOKING, ['specialist_id' => $doctor->getId()], '10000.00', '10000.00')->getReference();
        $raw = $this->chargeSuccess($ref);

        foreach (['missing' => null, 'wrong' => hash_hmac('sha512', $raw, 'not-the-secret'), 'of another body' => $this->sign($raw . ' ')] as $case => $signature) {
            $res = $this->webhook($raw, $signature);
            $this->assertSame(401, $res['status'], $case);
        }
        $this->assertSame(0, FakeCardGateway::calls($this->gatewayFile, $ref), 'Paystack was never asked');
        $this->assertSame(PaymentIntent::STATUS_INITIATED, $this->intentRow($ref)['status']);

        $ok = $this->webhook($raw, $this->sign($raw));
        $this->assertSame(200, $ok['status'], json_encode($ok));
        $this->assertSame('card_paid', $ok['body']['data']['outcome']);
        $this->assertSame(PaymentIntent::STATUS_PAID, $this->intentRow($ref)['status']);
        $this->assertSame('10000.00', $this->intentRow($ref)['verified_amount']);

        // Repeated delivery: acknowledged, nothing asked or changed again.
        $again = $this->webhook($raw, $this->sign($raw));
        $this->assertSame(200, $again['status']);
        $this->assertSame('card_already', $again['body']['data']['outcome']);
        $this->assertSame(1, FakeCardGateway::calls($this->gatewayFile, $ref));
    }

    public function testATransientVerifyFailureAsksPaystackToRetry(): void
    {
        [$patientId, $doctor] = $this->patientAndDoctor();
        $ref = $this->checkout($patientId, PaymentIntent::PURPOSE_BOOKING, ['specialist_id' => $doctor->getId()], '10000.00')->getReference();
        FakeCardGateway::answer($this->gatewayFile, $ref, ['unreachable' => true]);
        $raw = $this->chargeSuccess($ref);

        $res = $this->webhook($raw, $this->sign($raw));
        $this->assertSame(503, $res['status'], 'not 200: Paystack must send it again');
        $this->assertSame(PaymentIntent::STATUS_INITIATED, $this->intentRow($ref)['status']);
    }

    public function testAChargeVerifyDoesNotCallFinalYetIsRetriedNotAcknowledged(): void
    {
        [$patientId, $doctor] = $this->patientAndDoctor();

        // A top-up: nothing else re-checks one the patient's browser never confirmed.
        $wallets = $this->app()->get(WalletService::class);
        $topup   = 'vmw_cardit_' . bin2hex(random_bytes(6));
        $wallets->beginTopup($patientId, 'NGN', '5000.00', $topup);
        FakeCardGateway::answer($this->gatewayFile, $topup, ['status' => 'ongoing']);
        $raw = $this->chargeSuccess($topup);
        $res = $this->webhook($raw, $this->sign($raw));
        $this->assertSame(503, $res['status'], 'not 200: Paystack must send it again');
        $this->assertSame(WalletTransaction::STATUS_PENDING, (string) $this->em()->getConnection()->fetchOne('SELECT status FROM wallet_transactions WHERE reference = ?', [$topup]));
        // …the retry, once Paystack confirms it, credits it.
        FakeCardGateway::answer($this->gatewayFile, $topup, ['status' => 'success', 'amount_minor' => 500000, 'currency' => 'NGN']);
        $this->assertSame('topup_settled', $this->webhook($raw, $this->sign($raw))['body']['data']['outcome']);
        $this->assertSame('5000.00', $this->balanceOf($patientId));
        // A final failure is acknowledged (nothing to retry for).
        $failed = 'vmw_cardit_' . bin2hex(random_bytes(6));
        $wallets->beginTopup($patientId, 'NGN', '5000.00', $failed);
        FakeCardGateway::answer($this->gatewayFile, $failed, ['status' => 'abandoned']);
        $rawFailed = $this->chargeSuccess($failed);
        $this->assertSame('topup_not_paid', $this->webhook($rawFailed, $this->sign($rawFailed))['body']['data']['outcome']);

        // A card checkout: the same.
        $ref = $this->checkout($patientId, PaymentIntent::PURPOSE_BOOKING, ['specialist_id' => $doctor->getId()], '10000.00')->getReference();
        FakeCardGateway::answer($this->gatewayFile, $ref, ['status' => 'pending']);
        $card = $this->chargeSuccess($ref);
        $this->assertSame(503, $this->webhook($card, $this->sign($card))['status']);
        $this->assertSame(PaymentIntent::STATUS_INITIATED, $this->intentRow($ref)['status']);
        FakeCardGateway::answer($this->gatewayFile, $ref, ['status' => 'failed']);
        $done = $this->webhook($card, $this->sign($card));
        $this->assertSame(200, $done['status']);
        $this->assertSame('card_not_paid', $done['body']['data']['outcome']);
    }

    public function testATopUpIsCreditedOnceByTwoDeliveriesAtOnce(): void
    {
        [$patientId] = $this->patientAndDoctor();
        $wallets     = $this->app()->get(WalletService::class);
        $ref         = 'vmw_cardit_' . bin2hex(random_bytes(6));
        $txn         = $wallets->beginTopup($patientId, 'NGN', '5000.00', $ref);
        FakeCardGateway::answer($this->gatewayFile, $ref, ['status' => 'success', 'amount_minor' => 500000, 'currency' => 'NGN']);
        $raw = $this->chargeSuccess($ref);

        $delivery = ['op' => 'webhook', 'raw' => $raw, 'signature' => $this->sign($raw)];
        $results  = $this->race(
            [$delivery, $delivery],
            static fn (EntityManagerInterface $em) => $em->getConnection()->fetchOne('SELECT id FROM wallets WHERE id = ? FOR UPDATE', [$txn->getWalletId()]),
            'card_it_topup',
        );

        $this->assertSame([200, 200], array_column($results, 'status'), json_encode($results));
        $outcomes = array_map(static fn (array $r): string => (string) $r['body']['data']['outcome'], $results);
        sort($outcomes);
        $this->assertSame(['topup_not_credited', 'topup_settled'], $outcomes);
        $this->assertSame('5000.00', $this->balanceOf($patientId), 'credited once');
        $this->assertSame(WalletTransaction::STATUS_SUCCESS, (string) $this->em()->getConnection()->fetchOne('SELECT status FROM wallet_transactions WHERE reference = ?', [$ref]));
    }

    public function testTheWebhookAndThePatientsConfirmationRacingSettleOnce(): void
    {
        [$patientId, $doctor, $slots] = $this->patientAndDoctor('10000.00');
        // Not yet known to be paid: the webhook and the booking both ask Paystack.
        $ref = $this->checkout($patientId, PaymentIntent::PURPOSE_BOOKING, ['specialist_id' => $doctor->getId()], '10000.00', '10000.00')->getReference();
        $raw = $this->chargeSuccess($ref);

        $results = $this->race([
            ['op' => 'webhook', 'raw' => $raw, 'signature' => $this->sign($raw)],
            ['op' => 'book', 'customer_id' => $patientId, 'body' => ['specialist_id' => $doctor->getId(), 'scheduled_at' => $slots[0], 'type' => 'video', 'payment_reference' => $ref]],
        ], $this->holdIntent($ref), 'card_it_webhook_book');

        [$hook, $booking] = $results;
        $this->assertSame(200, $hook['status'], json_encode($hook));
        $this->assertSame(201, $booking['status'], json_encode($booking));
        $row = $this->intentRow($ref);
        $this->assertSame(PaymentIntent::STATUS_CONSUMED, $row['status']);
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM audit_events WHERE action = 'payment.card_paid' AND resource_id = ?", [$row['id']]), 'recorded paid once');
        $this->assertSame(1, $this->countRows('SELECT COUNT(*) FROM appointments WHERE payment_reference = ?', [$ref]));
        $this->assertSame('0.00', $this->balanceOf($patientId), 'nothing credited on top');
    }

    public function testTheSweepCreditAndTheBookingRacingUseThePaymentOnce(): void
    {
        [$patientId, $doctor, $slots] = $this->patientAndDoctor('10000.00');
        $ref = $this->checkout($patientId, PaymentIntent::PURPOSE_BOOKING, ['specialist_id' => $doctor->getId()], '10000.00', '10000.00', markPaid: true)->getReference();

        [$credit, $booking] = $this->race([
            ['op' => 'settle', 'reference' => $ref],
            ['op' => 'book', 'customer_id' => $patientId, 'body' => ['specialist_id' => $doctor->getId(), 'scheduled_at' => $slots[0], 'type' => 'video', 'payment_reference' => $ref]],
        ], $this->holdIntent($ref), 'card_it_settle_book');

        $booked   = $this->countRows('SELECT COUNT(*) FROM appointments WHERE payment_reference = ?', [$ref]);
        $credited = $this->postings(PaymentIntentService::walletCreditKey($ref));
        $this->assertSame(1, $booked + $credited, 'booked or credited — never both, never neither: ' . json_encode([$credit, $booking]));
        if ($booked === 1) {
            $this->assertSame(201, $booking['status']);
            $this->assertNull($credit['result']);
            $this->assertSame('0.00', $this->balanceOf($patientId));
        } else {
            $this->assertSame('10000.00', $credit['result']);
            $this->assertSame(422, $booking['status']);
            $this->assertSame('credited_to_wallet', $booking['body']['errors']['card_payment']);
            $this->assertSame('10000.00', $this->balanceOf($patientId));
        }
    }

    public function testAChargeFromBeforeIntentsIsAdoptedButNeverPaidOutTwice(): void
    {
        [$patientId, $doctor] = $this->patientAndDoctor();
        // In flight at the deploy: Paystack has it, we have no intent.
        $fresh = 'vma_legacy' . bin2hex(random_bytes(6));
        $used  = 'vma_legacy' . bin2hex(random_bytes(6));
        foreach ([$fresh, $used] as $ref) {
            FakeCardGateway::answer($this->gatewayFile, $ref, ['status' => 'success', 'amount_minor' => 1000000, 'currency' => 'NGN']);
        }
        // …one of them already booked under the old code.
        $em = $this->em();
        $a  = new \App\Domain\Entity\Appointment(
            $em->find(\App\Domain\Entity\Patient::class, $patientId),
            $em->find(\App\Domain\Entity\Specialist::class, $doctor->getId()),
            new \DateTimeImmutable('+3 days 10:00'),
            \App\Domain\Enum\ConsultationType::VIDEO,
        );
        $a->setAmount('10000.00');
        $a->payByCard($used);
        $em->persist($a);
        $em->flush();

        $meta = ['patient_id' => $patientId, 'purpose' => 'appointment_booking', 'specialist_id' => $doctor->getId()];
        foreach ([$fresh => PaymentIntent::STATUS_PAID, $used => PaymentIntent::STATUS_CONSUMED] as $ref => $status) {
            $raw = $this->chargeSuccess($ref, $meta);
            $res = $this->webhook($raw, $this->sign($raw));
            $this->assertSame('card_adopted', $res['body']['data']['outcome'], json_encode($res));
            $this->assertSame($status, $this->intentRow($ref)['status']);
        }

        // One paid days before the deploy is not adopted from a (re)delivered event: support's.
        $old = 'vma_legacy' . bin2hex(random_bytes(6));
        FakeCardGateway::answer($this->gatewayFile, $old, ['status' => 'success', 'amount_minor' => 1000000, 'currency' => 'NGN', 'paid_at' => (new \DateTimeImmutable('-4 days'))->format(DATE_ATOM)]);
        $rawOld = $this->chargeSuccess($old, $meta);
        $late   = $this->webhook($rawOld, $this->sign($rawOld));
        $this->assertSame(200, $late['status']);
        $this->assertSame('card_too_old', $late['body']['data']['outcome']);
        $this->assertSame(0, $this->countRows('SELECT COUNT(*) FROM payment_intents WHERE reference = ?', [$old]));

        // The sweep later credits the unused one only.
        $this->em()->getConnection()->executeStatement("UPDATE payment_intents SET paid_at = paid_at - INTERVAL '2 hours', created_at = created_at - INTERVAL '2 hours'");
        $this->app()->get(PaymentIntentService::class)->sweep();
        $this->assertSame(1, $this->postings(PaymentIntentService::walletCreditKey($fresh)));
        $this->assertSame(0, $this->postings(PaymentIntentService::walletCreditKey($used)));
    }

    /** @return callable(EntityManagerInterface): void holding the payment's row lock */
    private function holdIntent(string $reference): callable
    {
        return static function (EntityManagerInterface $em) use ($reference): void {
            $em->getConnection()->fetchOne('SELECT id FROM payment_intents WHERE reference = ? FOR UPDATE', [$reference]);
        };
    }

    /** @param array<string,mixed> $metadata */
    private function chargeSuccess(string $reference, array $metadata = []): string
    {
        return (string) json_encode([
            'event' => 'charge.success',
            'data'  => ['reference' => $reference, 'status' => 'success', 'amount' => 999999999, 'currency' => 'NGN', 'metadata' => $metadata],
        ]);
    }

    private function sign(string $raw): string
    {
        return hash_hmac('sha512', $raw, CardHarness::SECRET);
    }

    /** @return array{status:int, body:array<string,mixed>} */
    private function webhook(string $raw, ?string $signature): array
    {
        $request = (new ServerRequestFactory())->createServerRequest('POST', '/api/webhooks/paystack')
            ->withHeader('Content-Type', 'application/json')
            ->withBody((new StreamFactory())->createStream($raw));
        if ($signature !== null) {
            $request = $request->withHeader('x-paystack-signature', $signature);
        }
        $res = $this->app()->get(PaystackWebhookAction::class)($request, (new ResponseFactory())->createResponse());

        return ['status' => $res->getStatusCode(), 'body' => (array) json_decode((string) $res->getBody(), true)];
    }
}
