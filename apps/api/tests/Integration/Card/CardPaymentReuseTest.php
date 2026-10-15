<?php

declare(strict_types=1);

namespace App\Tests\Integration\Card;

use App\Domain\Entity\PaymentIntent;
use App\Infrastructure\Service\PaymentIntentService;
use App\Tests\Integration\Card\Support\FakeCardGateway;
use Doctrine\ORM\EntityManagerInterface;

/**
 * Audit M3: one card payment must pay for one thing, once — even when two
 * requests use it at the same moment — and only for what it was started for.
 */
final class CardPaymentReuseTest extends CardIntegrationTestCase
{
    public function testTwoConcurrentBookingsOnOnePaymentBookExactlyOnce(): void
    {
        [$patientId, $doctor, $slots] = $this->patientAndDoctor();
        $intent = $this->checkout($patientId, PaymentIntent::PURPOSE_BOOKING, ['specialist_id' => $doctor->getId()], '10000.00', '10000.00', markPaid: true);
        $ref    = $intent->getReference();

        $book = static fn (string $slot): array => [
            'op'          => 'book',
            'customer_id' => $patientId,
            'body'        => ['specialist_id' => $doctor->getId(), 'scheduled_at' => $slot, 'type' => 'video', 'payment_reference' => $ref],
        ];
        // Both requests have checked the payment is paid and unused before
        // either can take it: each now waits on the payment's row lock.
        $results = $this->race(
            [$book($slots[0]), $book($slots[1])],
            static fn (EntityManagerInterface $em) => $em->getConnection()->fetchOne('SELECT id FROM payment_intents WHERE reference = ? FOR UPDATE', [$ref]),
            'card_it_reuse',
        );

        $statuses = array_column($results, 'status');
        sort($statuses);
        $this->assertSame([201, 422], $statuses, json_encode($results));
        $loser = $results[0]['status'] === 422 ? $results[0] : $results[1];
        $this->assertSame(PaymentIntentService::ALREADY_USED, $loser['body']['errors']['payment']);

        $this->assertSame(1, $this->countRows('SELECT COUNT(*) FROM appointments WHERE payment_reference = ?', [$ref]), 'one booking');
        $row = $this->intentRow($ref);
        $this->assertSame(PaymentIntent::STATUS_CONSUMED, $row['status']);
        $winner = $results[0]['status'] === 201 ? $results[0] : $results[1];
        $this->assertSame($winner['body']['data']['id'], $row['consumed_by']);
        $this->assertSame('0.00', $this->balanceOf($patientId), 'no money was created');
        $this->assertSame(0, $this->countRows('SELECT COUNT(*) FROM wallet_transactions WHERE patient_id = ?', [$patientId]));
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM audit_events WHERE action = 'payment.card_consumed' AND resource_id = ?", [$row['id']]));
    }

    public function testAUsedPaymentIsRefusedCleanlyAfterwards(): void
    {
        [$patientId, $doctor, $slots] = $this->patientAndDoctor();
        $ref = $this->checkout($patientId, PaymentIntent::PURPOSE_BOOKING, ['specialist_id' => $doctor->getId()], '10000.00', '10000.00')->getReference();

        $first = $this->book($patientId, $doctor->getId(), $slots[0], $ref);
        $this->assertSame(201, $first['status'], json_encode($first));
        $again = $this->book($patientId, $doctor->getId(), $slots[1], $ref);
        $this->assertSame(422, $again['status']);
        $this->assertSame('This payment has already been used.', $again['body']['errors']['payment']);

        $this->assertSame(1, FakeCardGateway::calls($this->gatewayFile, $ref), 'Paystack is asked once; the answer is kept on the payment');
        $this->assertSame(1, $this->countRows('SELECT COUNT(*) FROM appointments WHERE payment_reference = ?', [$ref]));
        $this->assertSame('10000.00', $this->intentRow($ref)['verified_amount']);
    }

    public function testAPaymentOnlyPaysForWhatItWasStartedFor(): void
    {
        [$patientId, $doctor, $slots] = $this->patientAndDoctor();
        [, $otherDoctor]              = $this->patientAndDoctor();
        $ref = $this->checkout($patientId, PaymentIntent::PURPOSE_BOOKING, ['specialist_id' => $doctor->getId()], '10000.00', '10000.00', markPaid: true)->getReference();

        // Someone else's request with this patient's payment reference.
        $stranger = $this->book($this->anotherPatient(), $doctor->getId(), $slots[0], $ref);
        $this->assertSame(422, $stranger['status']);
        $this->assertSame(PaymentIntentService::NOT_YOURS, $stranger['body']['errors']['payment']);

        // Another doctor than the one it was paid for.
        $elsewhere = $this->book($patientId, $otherDoctor->getId(), $slots[0], $ref);
        $this->assertSame(422, $elsewhere['status']);
        $this->assertStringStartsWith(PaymentIntentService::OTHER_PURPOSE, $elsewhere['body']['errors']['payment']);

        // A guest invitation's payment can't book a consultation.
        $guestRef = $this->checkout($patientId, PaymentIntent::PURPOSE_GUEST, ['appointment_id' => '00000000-0000-4000-8000-000000000000'], '10000.00', '10000.00', markPaid: true)->getReference();
        $this->assertSame(422, $this->book($patientId, $doctor->getId(), $slots[0], $guestRef)['status']);

        $this->assertSame(0, $this->countRows('SELECT COUNT(*) FROM appointments WHERE payment_reference IN (?, ?)', [$ref, $guestRef]));
        $this->assertSame(PaymentIntent::STATUS_PAID, $this->intentRow($ref)['status'], 'still the patient\'s, unused');
    }

    public function testPayingAboveThePriceBooksAndCreditsTheDifferenceOnce(): void
    {
        [$patientId, $doctor, $slots] = $this->patientAndDoctor('10000.00');
        $ref = $this->checkout($patientId, PaymentIntent::PURPOSE_BOOKING, ['specialist_id' => $doctor->getId()], '10000.00', '12500.00', markPaid: true)->getReference();

        $res = $this->book($patientId, $doctor->getId(), $slots[0], $ref);
        $this->assertSame(201, $res['status'], json_encode($res));
        $this->assertStringContainsString('₦2,500.00', $res['body']['message']);
        $this->assertSame('2500.00', $this->balanceOf($patientId));
        $this->assertSame(1, $this->postings(PaymentIntentService::overpaymentKey($ref)));
        $this->assertSame('2500.00', $this->intentRow($ref)['overpaid_amount']);
    }

    public function testPayingBelowThePriceIsRefusedAndTheMoneyStaysThePatients(): void
    {
        [$patientId, $doctor, $slots] = $this->patientAndDoctor('10000.00');
        $ref = $this->checkout($patientId, PaymentIntent::PURPOSE_BOOKING, ['specialist_id' => $doctor->getId()], '10000.00', '5000.00', markPaid: true)->getReference();

        $res = $this->book($patientId, $doctor->getId(), $slots[0], $ref);
        $this->assertSame(422, $res['status']);
        $this->assertStringStartsWith(PaymentIntentService::UNDERPAID, $res['body']['errors']['payment']);
        $this->assertStringContainsString('added to your VideoMed wallet automatically', $res['body']['errors']['payment']);
        $this->assertSame(0, $this->countRows('SELECT COUNT(*) FROM appointments WHERE payment_reference = ?', [$ref]));
        $this->assertSame(PaymentIntent::STATUS_PAID, $this->intentRow($ref)['status'], 'left for the sweep to credit');
    }

    public function testAPaymentForATimeTakenMeanwhileGoesToTheWallet(): void
    {
        [$patientId, $doctor, $slots] = $this->patientAndDoctor('10000.00');
        // Someone else books the slot (from their wallet) while this patient pays.
        $other = $this->anotherPatient();
        $this->fundWallet($other, '10000.00');
        $this->assertSame(201, $this->book($other, $doctor->getId(), $slots[0], '')['status']);

        $ref = $this->checkout($patientId, PaymentIntent::PURPOSE_BOOKING, ['specialist_id' => $doctor->getId()], '10000.00', '10000.00')->getReference();
        $res = $this->book($patientId, $doctor->getId(), $slots[0], $ref);
        $this->assertSame(422, $res['status']);
        $this->assertSame('credited_to_wallet', $res['body']['errors']['card_payment']);
        $this->assertArrayHasKey('scheduled_at', $res['body']['errors']);
        $this->assertStringContainsString('₦10,000.00', $res['body']['message']);
        $this->assertSame('10000.00', $this->balanceOf($patientId));
        $this->assertSame(PaymentIntent::STATUS_CREDITED, $this->intentRow($ref)['status']);

        // …and it can't then book too.
        $again = $this->book($patientId, $doctor->getId(), $slots[1], $ref);
        $this->assertSame(422, $again['status']);
        $this->assertSame('credited_to_wallet', $again['body']['errors']['card_payment']);
        $this->assertSame(1, $this->postings(PaymentIntentService::walletCreditKey($ref)));
    }

    public function testAPaymentStartedBeforeIntentsStillBooksOnce(): void
    {
        // Paid on the old code (no intent; its webhook went to the old code),
        // confirmed on this one: adopted for the patient confirming it.
        [$patientId, $doctor, $slots] = $this->patientAndDoctor('10000.00');
        $legacy = 'vma_' . bin2hex(random_bytes(12));
        $booked = 'vma_' . bin2hex(random_bytes(12));
        foreach ([$legacy, $booked] as $ref) {
            // What the old pay-init recorded with Paystack: the payer and the purpose.
            FakeCardGateway::answer($this->gatewayFile, $ref, ['status' => 'success', 'amount_minor' => 1000000, 'currency' => 'NGN', 'metadata' => [
                'patient_id' => $patientId, 'purpose' => 'appointment_booking', 'specialist_id' => $doctor->getId(),
            ]]);
        }

        $first = $this->book($patientId, $doctor->getId(), $slots[0], $legacy);
        $this->assertSame(201, $first['status'], json_encode($first));
        $row = $this->intentRow($legacy);
        $this->assertSame(PaymentIntent::STATUS_CONSUMED, $row['status']);
        $this->assertSame($patientId, $row['patient_id']);
        $this->assertTrue(json_decode((string) $row['context'], true)['adopted']);
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM audit_events WHERE action = 'payment.card_adopted' AND resource_id = ?", [$row['id']]));

        $again = $this->book($patientId, $doctor->getId(), $slots[1], $legacy);
        $this->assertSame(422, $again['status']);
        $this->assertSame(PaymentIntentService::ALREADY_USED, $again['body']['errors']['payment']);

        // One the old code already booked with is recorded as used — it books nothing more.
        $em  = $this->em();
        $old = new \App\Domain\Entity\Appointment(
            $em->find(\App\Domain\Entity\Patient::class, $patientId),
            $em->find(\App\Domain\Entity\Specialist::class, $doctor->getId()),
            new \DateTimeImmutable($slots[2]),
            \App\Domain\Enum\ConsultationType::VIDEO,
        );
        $old->setAmount('10000.00');
        $old->payByCard($booked);
        $em->persist($old);
        $em->flush();
        $reuse = $this->book($patientId, $doctor->getId(), $slots[1], $booked);
        $this->assertSame(422, $reuse['status']);
        $this->assertSame(PaymentIntentService::ALREADY_USED, $reuse['body']['errors']['payment']);
        $this->assertSame(PaymentIntent::STATUS_CONSUMED, $this->intentRow($booked)['status']);
        $this->assertSame(1, $this->countRows('SELECT COUNT(*) FROM appointments WHERE payment_reference = ?', [$booked]));

        // Anything else unknown is not found — and Paystack isn't asked about it.
        $unknown = $this->book($patientId, $doctor->getId(), $slots[1], 'not_a_checkout_ref');
        $this->assertSame(422, $unknown['status']);
        $this->assertSame(PaymentIntentService::NOT_FOUND, $unknown['body']['errors']['payment']);
        $this->assertSame(0, FakeCardGateway::calls($this->gatewayFile, 'not_a_checkout_ref'));
        $this->assertSame('0.00', $this->balanceOf($patientId));
    }

    public function testAPreIntentPaymentIsAdoptedOnlyForItsPayerAndPurposeAndOnlyAroundTheDeploy(): void
    {
        [$patientId, $doctor, $slots] = $this->patientAndDoctor('10000.00');
        $meta = static fn (string $payer, string $purpose = 'appointment_booking'): array => [
            'patient_id' => $payer, 'purpose' => $purpose, 'specialist_id' => $doctor->getId(),
        ];
        $paid = fn (string $ref, array $metadata, ?string $paidAt = null) => FakeCardGateway::answer($this->gatewayFile, $ref, [
            'status' => 'success', 'amount_minor' => 1000000, 'currency' => 'NGN', 'metadata' => $metadata,
        ] + ($paidAt !== null ? ['paid_at' => $paidAt] : []));

        // Patient A's unused old payment, offered by patient B: refused, nothing recorded for B.
        $theirs = 'vma_' . bin2hex(random_bytes(12));
        $paid($theirs, $meta($patientId));
        $other  = $this->anotherPatient();
        $this->fundWallet($other, '0.01'); // B has a wallet; nothing may land in it
        $stolen = $this->book($other, $doctor->getId(), $slots[0], $theirs);
        $this->assertSame(422, $stolen['status'], json_encode($stolen));
        $this->assertSame(PaymentIntentService::NOT_YOURS, $stolen['body']['errors']['payment']);
        $this->assertSame(0, $this->countRows('SELECT COUNT(*) FROM payment_intents WHERE reference = ?', [$theirs]), 'not adopted for anyone');
        // …and A can still use it.
        $mine = $this->book($patientId, $doctor->getId(), $slots[0], $theirs);
        $this->assertSame(201, $mine['status'], json_encode($mine));

        // Paid for something else (a guest invitation): can't book.
        $guestPay = 'vma_' . bin2hex(random_bytes(12));
        $paid($guestPay, $meta($patientId, 'guest_invite'));
        $asBooking = $this->book($patientId, $doctor->getId(), $slots[1], $guestPay);
        $this->assertSame(PaymentIntentService::OTHER_PURPOSE, $asBooking['body']['errors']['payment']);

        // Paid days before the deploy (the old code may have settled it in a way that left
        // no trace on the reference — e.g. a removed guest's refund): support's, not automatic.
        $old = 'vma_' . bin2hex(random_bytes(12));
        $paid($old, $meta($patientId), (new \DateTimeImmutable('-5 days'))->format(DATE_ATOM));
        $tooOld = $this->book($patientId, $doctor->getId(), $slots[1], $old);
        $this->assertSame(422, $tooOld['status']);
        $this->assertSame(PaymentIntentService::LEGACY_SUPPORT, $tooOld['body']['errors']['payment']);
        $this->assertSame(0, $this->countRows('SELECT COUNT(*) FROM payment_intents WHERE reference = ?', [$old]));

        // No payer on Paystack's record: support's too.
        $anonymous = 'vma_' . bin2hex(random_bytes(12));
        $paid($anonymous, []);
        $this->assertSame(PaymentIntentService::LEGACY_SUPPORT, $this->book($patientId, $doctor->getId(), $slots[1], $anonymous)['body']['errors']['payment']);

        $this->assertSame(1, $this->countRows('SELECT COUNT(*) FROM appointments WHERE patient_id = ?', [$patientId]), 'only the legitimate booking');
        $this->assertSame('0.01', $this->balanceOf($other));
        $this->assertSame('0.00', $this->balanceOf($patientId));
    }

    public function testAPreIntentGuestPaymentOnAnAppointmentThatLostAGuestIsHeldForReview(): void
    {
        // Before the release: a guest paid by card (vma_X), then removed — refunded to the wallet
        // and the guest entry (the only place vma_X was kept) deleted. vma_X must not pay again.
        [$patientId, $doctor, $slots] = $this->patientAndDoctor('10000.00');
        $em          = $this->em();
        $appointment = new \App\Domain\Entity\Appointment(
            $em->find(\App\Domain\Entity\Patient::class, $patientId),
            $em->find(\App\Domain\Entity\Specialist::class, $doctor->getId()),
            new \DateTimeImmutable($slots[2]),
            \App\Domain\Enum\ConsultationType::VIDEO,
        );
        $appointment->setAmount('10000.00');
        $em->persist($appointment);
        $em->flush();
        $guestId = \Ramsey\Uuid\Uuid::uuid4()->toString();
        $this->app()->get(\App\Infrastructure\Service\AuditLogger::class)->record('Ada Card', 'patient', 'appointment.guest_removed', $appointment->getId(), 'guest', $guestId, ['guest_id' => $guestId, 'refunded' => '5000.00']);
        $this->app()->get(\App\Infrastructure\Service\WalletService::class)->credit($patientId, 'NGN', '5000.00', \App\Domain\Entity\WalletTransaction::TYPE_REFUND, 'appt_guest_refund_' . $guestId, 'Refund for a withdrawn guest invitation', false);

        $ref = 'vma_' . bin2hex(random_bytes(12));
        FakeCardGateway::answer($this->gatewayFile, $ref, ['status' => 'success', 'amount_minor' => 500000, 'currency' => 'NGN', 'metadata' => [
            'patient_id' => $patientId, 'purpose' => 'guest_invite', 'appointment_id' => $appointment->getId(), 'specialist_id' => $doctor->getId(),
        ]]);

        // Its webhook arriving now: recorded, but held for support — never paid out on its own.
        $service = $this->app()->get(PaymentIntentService::class);
        $this->assertSame('adopted', $service->recordCharge($ref));
        $row = $this->intentRow($ref);
        $this->assertSame(PaymentIntent::STATUS_REVIEW, $row['status']);
        $this->assertStringContainsString('guest', (string) $row['failure_reason']);

        // The sweep leaves it alone, however long it waits…
        $this->em()->getConnection()->executeStatement("UPDATE payment_intents SET paid_at = NOW() - INTERVAL '3 hours' WHERE reference = ?", [$ref]);
        $swept = $this->app()->get(PaymentIntentService::class)->sweep();
        $this->assertSame(0, $this->postings(PaymentIntentService::walletCreditKey($ref)), json_encode($swept));
        $this->assertSame('5000.00', $this->balanceOf($patientId), 'the earlier refund only');
        $this->assertSame(PaymentIntent::STATUS_REVIEW, $this->intentRow($ref)['status']);
        // …and nothing can be paid with it meanwhile.
        $this->assertSame(PaymentIntentService::UNDER_REVIEW, $this->book($patientId, $doctor->getId(), $slots[0], $ref)['body']['errors']['payment']);
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM audit_events WHERE action = 'payment.card_adopted' AND resource_id = ?", [$row['id']]));

        // Support closes it (here: already refunded — no credit); it stays settled.
        $closed = $this->app()->get(PaymentIntentService::class)->closeReview($ref, null, 'Refunded as appt_guest_refund_' . $guestId, 'Support: test');
        $this->assertNotNull($closed);
        $this->assertSame(PaymentIntent::STATUS_CONSUMED, $this->intentRow($ref)['status']);
        $this->assertNull($this->app()->get(PaymentIntentService::class)->closeReview($ref, '5000.00', 'again', 'Support: test'), 'closed once');
        $this->assertSame('5000.00', $this->balanceOf($patientId));
    }

    public function testRepeatingABookingThatWentThroughAnswersWithThatBooking(): void
    {
        // The answer was lost (or "Complete your paid booking" after a reload): the same request again.
        [$patientId, $doctor, $slots] = $this->patientAndDoctor();
        $ref = $this->checkout($patientId, PaymentIntent::PURPOSE_BOOKING, ['specialist_id' => $doctor->getId()], '10000.00', '10000.00')->getReference();

        $first = $this->book($patientId, $doctor->getId(), $slots[0], $ref);
        $this->assertSame(201, $first['status'], json_encode($first));
        $again = $this->book($patientId, $doctor->getId(), $slots[0], $ref);
        $this->assertSame(200, $again['status'], json_encode($again));
        $this->assertSame($first['body']['data']['id'], $again['body']['data']['id'], 'the same booking — not "time taken"');

        // Another time on the same payment is still "already used".
        $this->assertSame(PaymentIntentService::ALREADY_USED, $this->book($patientId, $doctor->getId(), $slots[1], $ref)['body']['errors']['payment']);
        // Someone else sending it gets neither that booking nor a new one.
        $stranger = $this->anotherPatient();
        $copied   = $this->book($stranger, $doctor->getId(), $slots[0], $ref);
        $this->assertSame(422, $copied['status'], json_encode($copied));
        $this->assertArrayNotHasKey('data', $copied['body']);
        $this->assertSame(PaymentIntentService::NOT_YOURS, $this->book($stranger, $doctor->getId(), $slots[2], $ref)['body']['errors']['payment']);
        $this->assertSame(1, $this->countRows('SELECT COUNT(*) FROM appointments WHERE payment_reference = ?', [$ref]));
        $this->assertSame('0.00', $this->balanceOf($patientId));
    }

    public function testATopUpReferenceIsInTheWalletOnlyWhenItsMoneyIs(): void
    {
        [$patientId, $doctor, $slots] = $this->patientAndDoctor();
        $wallets = $this->app()->get(\App\Infrastructure\Service\WalletService::class);
        $pending = 'vmw_cardit_' . bin2hex(random_bytes(6));
        $wallets->beginTopup($patientId, 'NGN', '10000.00', $pending);

        // Never credited: refused without "already in your wallet" and without the wallet flag.
        $res = $this->book($patientId, $doctor->getId(), $slots[0], $pending);
        $this->assertSame(422, $res['status']);
        $this->assertSame(PaymentIntentService::TOPUP_PENDING, $res['body']['errors']['payment']);
        $this->assertArrayNotHasKey('card_payment', $res['body']['errors']);

        // Credited: now it is in the wallet.
        $wallets->settleTopup($pending, '1000000', 'NGN');
        $credited = $this->book($patientId, $doctor->getId(), $slots[0], $pending);
        $this->assertSame(PaymentIntentService::ALREADY_IN_WALLET, $credited['body']['errors']['payment']);
        $this->assertSame('credited_to_wallet', $credited['body']['errors']['card_payment']);

        // Credited, then left `failed` by the pre-fix late-failure race: its
        // money is in the wallet too, so it says so — not "hasn't been added".
        $leftFailed = 'vmw_cardit_' . bin2hex(random_bytes(6));
        $wallets->beginTopup($patientId, 'NGN', '5000.00', $leftFailed);
        $this->assertNotNull($wallets->settleTopup($leftFailed, '500000', 'NGN'));
        $this->em()->getConnection()->executeStatement("UPDATE wallet_transactions SET status = 'failed' WHERE reference = ?", [$leftFailed]);
        $posted = $this->book($patientId, $doctor->getId(), $slots[0], $leftFailed);
        $this->assertSame(422, $posted['status'], json_encode($posted));
        $this->assertSame(PaymentIntentService::ALREADY_IN_WALLET, $posted['body']['errors']['payment']);
        $this->assertSame('credited_to_wallet', $posted['body']['errors']['card_payment']);

        // Failed without ever moving money: not in the wallet, and not said to be.
        $neverPaid = 'vmw_cardit_' . bin2hex(random_bytes(6));
        $wallets->beginTopup($patientId, 'NGN', '2000.00', $neverPaid);
        $this->assertTrue($wallets->failTopup($neverPaid));
        $failed = $this->book($patientId, $doctor->getId(), $slots[0], $neverPaid);
        $this->assertSame(422, $failed['status'], json_encode($failed));
        $this->assertSame(PaymentIntentService::TOPUP_NOT_CREDITED, $failed['body']['errors']['payment']);
        $this->assertArrayNotHasKey('card_payment', $failed['body']['errors']);
        $this->assertSame('15000.00', $this->balanceOf($patientId), 'the two credited top-ups, nothing else');

        // Another patient's top-up reference: not found, nothing said about it.
        $this->assertSame(PaymentIntentService::NOT_FOUND, $this->book($this->anotherPatient(), $doctor->getId(), $slots[0], $pending)['body']['errors']['payment']);
        $this->assertSame(0, $this->countRows('SELECT COUNT(*) FROM appointments WHERE patient_id = ?', [$patientId]));
    }

    /** @return array{status:int, body:array<string,mixed>} */
    private function book(string $patientId, string $doctorId, string $slot, string $reference): array
    {
        $action  = $this->app()->get(\App\Action\Appointment\CreateMyAppointmentAction::class);
        $request = (new \Slim\Psr7\Factory\ServerRequestFactory())
            ->createServerRequest('POST', '/api/portal/appointments')
            ->withAttribute('customer_id', $patientId)
            ->withParsedBody(array_filter(['specialist_id' => $doctorId, 'scheduled_at' => $slot, 'type' => 'video', 'payment_reference' => $reference]));
        try {
            $res = $action($request, (new \Slim\Psr7\Factory\ResponseFactory())->createResponse());

            return ['status' => $res->getStatusCode(), 'body' => (array) json_decode((string) $res->getBody(), true)];
        } catch (\App\Domain\Exception\ValidationException $e) {
            return ['status' => 422, 'body' => ['message' => $e->getMessage(), 'errors' => $e->getErrors()]];
        }
    }
}
