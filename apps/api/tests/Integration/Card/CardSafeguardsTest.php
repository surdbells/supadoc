<?php

declare(strict_types=1);

namespace App\Tests\Integration\Card;

use App\Action\Appointment\CancelMyAppointmentAction;
use App\Action\Appointment\CreateMyAppointmentAction;
use App\Action\Appointment\GetMyCardPaymentAction;
use App\Domain\Entity\Appointment;
use App\Domain\Entity\Patient;
use App\Domain\Entity\PaymentIntent;
use App\Domain\Entity\Specialist;
use App\Domain\Entity\WalletTransaction;
use App\Domain\Enum\ConsultationType;
use App\Domain\Repository\PaymentIntentRepository;
use App\Infrastructure\Persistence\CardPaymentAnomalies;
use App\Infrastructure\Persistence\RawIndexes;
use App\Infrastructure\Service\PaymentIntentService;
use App\Infrastructure\Service\SlotLock;
use App\Infrastructure\Service\WalletService;
use App\Tests\Integration\Card\Support\CardHarness;
use App\Tests\Integration\Card\Support\FakeCardGateway;
use DateTimeImmutable;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

/**
 * The second review of the card track: the sweep can't be starved by
 * payments it can't settle; a payment that can't be credited is held for
 * review instead of blocking the queue; "paid" is never recorded without its
 * audit; a reschedule can't revive a booking cancelled (and refunded) while
 * it waited; the index step never fails on live traffic; double-used card
 * payments are reported; the app can ask whether a payment was really made.
 */
final class CardSafeguardsTest extends CardIntegrationTestCase
{
    public function testFailingReVerifiesGoToTheBackAndCannotStarveANewCharge(): void
    {
        [$patientId, $doctor] = $this->patientAndDoctor();
        $context = ['specialist_id' => $doctor->getId()];
        $broken  = [];
        for ($i = 0; $i < 5; $i++) {
            // Paystack errors on these every time (e.g. checkouts that never reached it).
            $broken[] = $this->checkout($patientId, PaymentIntent::PURPOSE_BOOKING, $context, '10000.00')->getReference();
        }
        $missed = $this->checkout($patientId, PaymentIntent::PURPOSE_BOOKING, $context, '10000.00', '10000.00')->getReference();
        $sql    = $this->em()->getConnection();
        $sql->executeStatement(
            "UPDATE payment_intents SET created_at = NOW() - INTERVAL '40 minutes' WHERE reference IN (?, ?, ?, ?, ?)",
            $broken,
        );
        $sql->executeStatement("UPDATE payment_intents SET created_at = NOW() - INTERVAL '20 minutes' WHERE reference = ?", [$missed]);
        $sweep = fn (): array => $this->app()->get(PaymentIntentService::class)->sweep(null, [], 5);

        $first = $sweep();
        $this->assertSame(5, $first['errors'], json_encode($first));
        $this->assertSame(0, FakeCardGateway::calls($this->gatewayFile, $missed), 'the batch was full of failing ones');
        foreach ($broken as $ref) {
            $this->assertNotNull($this->intentRow($ref)['last_checked_at'], 'a failure still counts as asked: to the back of the queue');
        }

        $second = $sweep();
        $this->assertSame(PaymentIntent::STATUS_PAID, $this->intentRow($missed)['status'], 'the missed charge is found: ' . json_encode($second));
        $this->assertSame(1, FakeCardGateway::calls($this->gatewayFile, $missed));
    }

    public function testACheckoutPaystackCannotBeAskedAboutStaysOpenUntilPaystackAnswers(): void
    {
        [$patientId, $doctor] = $this->patientAndDoctor();
        $ref = $this->checkout($patientId, PaymentIntent::PURPOSE_BOOKING, ['specialist_id' => $doctor->getId()], '10000.00')->getReference();
        $this->em()->getConnection()->executeStatement("UPDATE payment_intents SET created_at = NOW() - INTERVAL '25 hours' WHERE reference = ?", [$ref]);

        // Paystack can't be asked (the fake throws): a failed check is no answer, so it stays open.
        $result = $this->app()->get(PaymentIntentService::class)->sweep();
        $row    = $this->intentRow($ref);
        $this->assertSame(PaymentIntent::STATUS_INITIATED, $row['status'], json_encode($result));
        $this->assertGreaterThanOrEqual(1, $result['errors']);
        $this->assertSame(0, $result['expired']);
        $this->assertNotNull($row['last_checked_at'], 'asked: to the back of the queue');

        // Paystack answers that it was abandoned: on the next slow-cadence check it expires.
        FakeCardGateway::answer($this->gatewayFile, $ref, ['status' => 'abandoned', 'amount_minor' => 0, 'currency' => 'NGN']);
        $this->em()->getConnection()->executeStatement("UPDATE payment_intents SET last_checked_at = last_checked_at - INTERVAL '3 hours' WHERE reference = ?", [$ref]);
        $result = $this->app()->get(PaymentIntentService::class)->sweep();
        $this->assertSame(PaymentIntent::STATUS_EXPIRED, $this->intentRow($ref)['status'], json_encode($result));
        $this->assertGreaterThanOrEqual(1, $result['expired']);

        // A late success still counts (the webhook, or the patient's own request).
        FakeCardGateway::answer($this->gatewayFile, $ref, ['status' => 'success', 'amount_minor' => 1000000, 'currency' => 'NGN']);
        $this->assertSame('paid', $this->app()->get(PaymentIntentService::class)->recordCharge($ref));
    }

    public function testPaymentsThatCannotBeCreditedAreHeldForReviewAndNeverBlockTheRest(): void
    {
        [$patientId, $doctor] = $this->patientAndDoctor();
        $context = ['specialist_id' => $doctor->getId()];
        $repo    = $this->app()->get(PaymentIntentRepository::class);
        $stuck   = [];
        // Paid in a currency the wallet doesn't hold…
        for ($i = 0; $i < 3; $i++) {
            $ref = $this->checkout($patientId, PaymentIntent::PURPOSE_BOOKING, $context, '10000.00')->getReference();
            $repo->markPaid($ref, '10000.00', 'XYZ', 'gw', new DateTimeImmutable());
            $stuck[] = $ref;
        }
        // …and one whose wallet key already holds a different posting.
        $conflict = $this->checkout($patientId, PaymentIntent::PURPOSE_BOOKING, $context, '10000.00', '10000.00', markPaid: true)->getReference();
        $this->app()->get(WalletService::class)->credit($patientId, 'NGN', '1.00', WalletTransaction::TYPE_ADJUSTMENT, PaymentIntentService::walletCreditKey($conflict), 'unrelated', false);
        $stuck[] = $conflict;
        $good = $this->checkout($patientId, PaymentIntent::PURPOSE_BOOKING, $context, '10000.00', '10000.00', markPaid: true)->getReference();

        $sql = $this->em()->getConnection();
        $sql->executeStatement("UPDATE payment_intents SET paid_at = NOW() - INTERVAL '3 hours', last_checked_at = NOW() - INTERVAL '3 hours' WHERE reference IN (?, ?, ?, ?)", $stuck);
        $sql->executeStatement("UPDATE payment_intents SET paid_at = NOW() - INTERVAL '1 hour', last_checked_at = NOW() - INTERVAL '1 hour' WHERE reference = ?", [$good]);
        $sweep = fn (): array => $this->app()->get(PaymentIntentService::class)->sweep(null, [], 4);

        $first = $sweep();
        $this->assertSame(4, $first['review'], json_encode($first));
        foreach ($stuck as $ref) {
            $row = $this->intentRow($ref);
            $this->assertSame(PaymentIntent::STATUS_REVIEW, $row['status']);
            $this->assertNotEmpty($row['failure_reason']);
            $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM audit_events WHERE action = 'payment.card_held_for_review' AND resource_id = ?", [$row['id']]));
        }

        $second = $sweep();
        $this->assertSame(1, $second['credited'], 'the held ones left the queue: ' . json_encode($second));
        $this->assertSame(PaymentIntent::STATUS_CREDITED, $this->intentRow($good)['status']);
        $this->assertSame('10001.00', $this->balanceOf($patientId), 'the good payment + the unrelated posting — nothing for the held ones');
        $this->assertSame(0, $this->postings(PaymentIntentService::walletCreditKey($stuck[0])));
    }

    public function testPaidIsNeverRecordedWithoutItsAudit(): void
    {
        [$patientId, $doctor] = $this->patientAndDoctor();
        $ref = $this->checkout($patientId, PaymentIntent::PURPOSE_BOOKING, ['specialist_id' => $doctor->getId()], '10000.00', '10000.00')->getReference();
        $sql = $this->em()->getConnection();
        // The audit write fails (here: refused by a constraint): the status change must roll back with it.
        $sql->executeStatement("ALTER TABLE audit_events ADD CONSTRAINT it_no_card_paid CHECK (action <> 'payment.card_paid') NOT VALID");
        try {
            try {
                $this->app()->get(PaymentIntentService::class)->recordCharge($ref);
                $this->fail('the audit could not be written');
            } catch (\Throwable $e) {
                $this->assertStringContainsString('it_no_card_paid', $e->getMessage());
            }
            $this->assertSame(PaymentIntent::STATUS_INITIATED, $this->intentRow($ref)['status'], 'not paid without its audit');
        } finally {
            $sql->executeStatement('ALTER TABLE audit_events DROP CONSTRAINT it_no_card_paid');
        }

        // A redelivery then records both, once.
        $this->assertSame('paid', $this->app()->get(PaymentIntentService::class)->recordCharge($ref));
        $this->assertSame('already', $this->app()->get(PaymentIntentService::class)->recordCharge($ref));
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM audit_events WHERE action = 'payment.card_paid' AND resource_id = ?", [$this->intentRow($ref)['id']]));
    }

    public function testARescheduleWaitingOnTheSlotLockCannotReviveACancelledRefundedBooking(): void
    {
        [$patientId, $doctor, $slots] = $this->patientAndDoctor('10000.00');
        $this->fundWallet($patientId, '10000.00');
        $booked = $this->request(CreateMyAppointmentAction::class, $patientId, ['specialist_id' => $doctor->getId(), 'scheduled_at' => $slots[0], 'type' => 'video']);
        $this->assertSame(201, $booked->getStatusCode(), (string) $booked->getBody());
        $id = (string) json_decode((string) $booked->getBody(), true)['data']['id'];
        $this->assertSame('0.00', $this->balanceOf($patientId));

        // The reschedule has passed its checks and waits on the doctor's slot lock…
        $blocker = $this->em('card_it_blocker');
        $blocker->getConnection()->beginTransaction();
        (new SlotLock($blocker))->lockDoctor($doctor->getId());
        $worker = CardHarness::startWorker([
            'op'             => 'reschedule',
            'customer_id'    => $patientId,
            'appointment_id' => $id,
            'body'           => ['scheduled_at' => $slots[1]],
            'schema'         => static::$schema,
            'gateway_file'   => $this->gatewayFile,
            'app'            => 'card_it_resched',
        ]);
        try {
            CardHarness::awaitLockWaiters($this->em('card_it_observer'), 'card_it_resched', 1);
            // …while the patient cancels (refunded to the wallet), which needs no slot lock.
            $cancel = $this->request(CancelMyAppointmentAction::class, $patientId, [], ['id' => $id]);
            $this->assertSame(200, $cancel->getStatusCode(), (string) $cancel->getBody());
        } finally {
            $blocker->getConnection()->commit();
        }
        $moved = CardHarness::finishWorker($worker);

        $this->assertSame(422, $moved['status'] ?? null, json_encode($moved));
        $row = $this->em()->getConnection()->fetchAssociative('SELECT status, payment_status, scheduled_at FROM appointments WHERE id = ?', [$id]);
        $this->assertSame('cancelled', $row['status'], 'not brought back to life');
        $this->assertSame('refunded', $row['payment_status']);
        $this->assertSame('10000.00', $this->balanceOf($patientId), 'refunded once, and no live booking on top');
    }

    public function testTheIndexStepNeverFailsOnLiveTrafficAndADryRunCreatesNothing(): void
    {
        $conn = $this->em()->getConnection();
        $conn->executeStatement('DROP INDEX ' . RawIndexes::SLOT);
        try {
            $dry = RawIndexes::ensure($conn, true);
            $this->assertSame('would_create', $dry[RawIndexes::SLOT]['status']);
            $this->assertSame('exists', $dry[RawIndexes::PAYMENT_REFERENCE]['status']);
            $this->assertFalse(RawIndexes::exists($conn, RawIndexes::SLOT), 'a dry run creates nothing');

            // A write in flight on appointments (old code still serving): the step waits its
            // lock timeout, then reports "busy" — it never fails the deploy.
            $writer = $this->em('card_it_writer')->getConnection();
            $writer->beginTransaction();
            $writer->executeStatement('LOCK TABLE appointments IN ROW EXCLUSIVE MODE');
            try {
                $busy = RawIndexes::ensure($conn, false, '300ms');
                $this->assertSame('busy', $busy[RawIndexes::SLOT]['status'], json_encode($busy));
                $this->assertFalse(RawIndexes::exists($conn, RawIndexes::SLOT));
                $this->assertFalse($conn->isTransactionActive(), 'its own transaction is closed');
            } finally {
                $writer->rollBack();
            }

            $run = RawIndexes::ensure($conn);
            $this->assertSame('created', $run[RawIndexes::SLOT]['status']);
        } finally {
            if (!RawIndexes::exists($conn, RawIndexes::SLOT)) {
                RawIndexes::ensure($conn);
            }
        }
        $this->assertTrue(RawIndexes::exists($conn, RawIndexes::SLOT));
    }

    public function testCardPaymentsThatMovedMoneyTwiceAreReported(): void
    {
        [$patientId, $doctor, $slots] = $this->patientAndDoctor();
        $em      = $this->em();
        $patient = $em->find(Patient::class, $patientId);
        $doc     = $em->find(Specialist::class, $doctor->getId());
        $reused  = 'vma_dup' . bin2hex(random_bytes(6));
        $both    = 'vma_both' . bin2hex(random_bytes(6));

        // Old code: one reference on a booking AND on a guest entry of another booking…
        $a = $this->appointment($patient, $doc, $slots[0]);
        $a->payByCard($reused);
        $b = $this->appointment($patient, $doc, $slots[1]);
        $b->addGuest('Guest One', 'guest-one@example.com', '5000.00', 'card', $reused, new DateTimeImmutable());
        // …and one booked AND credited to the wallet as unused.
        $c = $this->appointment($patient, $doc, $slots[2]);
        $c->payByCard($both);
        $em->persist($a);
        $em->persist($b);
        $em->persist($c);
        $em->flush();
        $wallets = $this->app()->get(WalletService::class);
        $wallets->credit($patientId, 'NGN', '10000.00', WalletTransaction::TYPE_REFUND, PaymentIntentService::walletCreditKey($both), 'old double', false);

        // The intent invariant: consumed AND credited.
        $broken = $this->checkout($patientId, PaymentIntent::PURPOSE_BOOKING, ['specialist_id' => $doctor->getId()], '10000.00', '10000.00', markPaid: true)->getReference();
        $this->em()->getConnection()->executeStatement("UPDATE payment_intents SET status = 'consumed', consumed_by = 'x' WHERE reference = ?", [$broken]);
        $wallets->credit($patientId, 'NGN', '10000.00', WalletTransaction::TYPE_REFUND, PaymentIntentService::walletCreditKey($broken), 'broken', false);

        $report = CardPaymentAnomalies::report($this->em()->getConnection());
        $refs   = static fn (string $check): array => array_column($report[$check], 'reference');
        $this->assertContains($reused, $refs('reference_used_twice'));
        $twice = $report['reference_used_twice'][array_search($reused, $refs('reference_used_twice'), true)];
        $this->assertSame(2, (int) $twice['uses']);
        $this->assertStringContainsString('appointment:' . $a->getId(), $twice['used_by']);
        $this->assertStringContainsString('guest:' . $b->getId(), $twice['used_by']);
        $this->assertContains($both, $refs('used_and_credited'));
        $this->assertNotContains($reused, $refs('used_and_credited'));
        $this->assertContains($broken, $refs('intent_consumed_and_credited'));
        $this->assertSame(['reference_used_twice', 'used_and_credited', 'intent_consumed_and_credited', 'intents_in_review'], array_keys($report));
        $this->assertSame(['found' => [['x' => 1]]], CardPaymentAnomalies::findings(['found' => [['x' => 1]], 'nothing' => []]), 'only checks with findings are reported');

        // Inside a dry run's open transaction, a check that errors is reported — it neither
        // stops the run nor poisons the transaction.
        $conn = $this->em()->getConnection();
        $conn->beginTransaction();
        try {
            $conn->executeStatement('ALTER TABLE payment_intents RENAME TO payment_intents_hidden');
            $broken = CardPaymentAnomalies::report($conn);
            $this->assertArrayHasKey('error', $broken['intents_in_review'][0]);
            $this->assertContains($reused, array_column($broken['reference_used_twice'], 'reference'), 'the other checks still ran');
            $this->assertSame(1, (int) $conn->fetchOne('SELECT 1'), 'the transaction is still usable');
        } finally {
            $conn->rollBack();
        }
    }

    public function testTheAppCanAskWhetherAPaymentWasReallyMade(): void
    {
        [$patientId, $doctor, $slots] = $this->patientAndDoctor();
        $context = ['specialist_id' => $doctor->getId()];

        // Opened the pop-up, never paid: Paystack says abandoned.
        $abandoned = $this->checkout($patientId, PaymentIntent::PURPOSE_BOOKING, $context, '10000.00')->getReference();
        FakeCardGateway::answer($this->gatewayFile, $abandoned, ['status' => 'abandoned']);
        $this->assertSame('not_paid', $this->paymentStatus($patientId, $abandoned)['data']['status']);

        // Paystack unreachable: we can't say.
        $unknown = $this->checkout($patientId, PaymentIntent::PURPOSE_BOOKING, $context, '10000.00')->getReference();
        $this->assertSame('unconfirmed', $this->paymentStatus($patientId, $unknown)['data']['status']);

        // Paid: it can still book, else it reaches the wallet at credit_due_at.
        $paid  = $this->checkout($patientId, PaymentIntent::PURPOSE_BOOKING, $context, '10000.00', '10000.00')->getReference();
        $state = $this->paymentStatus($patientId, $paid)['data'];
        $this->assertSame('paid', $state['status']);
        $this->assertSame('10000.00', $state['amount']);
        $this->assertSame($doctor->getId(), $state['specialist_id']);
        $this->assertNotNull($state['credit_due_at']);
        $this->assertSame(30, $state['credit_after_minutes']);

        // Someone else's payment: not found.
        $this->assertSame(404, $this->paymentStatus($this->anotherPatient(), $paid)['code']);

        // Used for a booking: says which.
        $booked = $this->request(CreateMyAppointmentAction::class, $patientId, ['specialist_id' => $doctor->getId(), 'scheduled_at' => $slots[0], 'type' => 'video', 'payment_reference' => $paid]);
        $this->assertSame(201, $booked->getStatusCode(), (string) $booked->getBody());
        $used = $this->paymentStatus($patientId, $paid)['data'];
        $this->assertSame('used', $used['status']);
        $this->assertSame(json_decode((string) $booked->getBody(), true)['data']['id'], $used['used_for']);
    }

    /** @return array{code:int, data:array<string,mixed>} */
    private function paymentStatus(string $patientId, string $reference): array
    {
        $request = (new ServerRequestFactory())->createServerRequest('GET', '/api/portal/card-payments/' . $reference)->withAttribute('customer_id', $patientId);
        $res     = $this->app()->get(GetMyCardPaymentAction::class)($request, (new ResponseFactory())->createResponse(), ['reference' => $reference]);
        $this->assertSame('no-store', $res->getHeaderLine('Cache-Control'));

        return ['code' => $res->getStatusCode(), 'data' => (array) (json_decode((string) $res->getBody(), true)['data'] ?? [])];
    }

    /**
     * @param class-string         $action
     * @param array<string,mixed>  $body
     * @param array<string,string> $args
     */
    private function request(string $action, string $patientId, array $body, array $args = []): \Psr\Http\Message\ResponseInterface
    {
        $request = (new ServerRequestFactory())->createServerRequest('POST', '/api/portal/appointments')
            ->withAttribute('customer_id', $patientId)
            ->withParsedBody($body);
        $handler = $this->app()->get($action);

        return $args === [] ? $handler($request, (new ResponseFactory())->createResponse()) : $handler($request, (new ResponseFactory())->createResponse(), $args);
    }

    private function appointment(Patient $patient, Specialist $doctor, string $slot): Appointment
    {
        $appointment = new Appointment($patient, $doctor, new DateTimeImmutable($slot), ConsultationType::VIDEO);
        $appointment->setAmount('10000.00');

        return $appointment;
    }
}
