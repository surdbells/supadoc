<?php

declare(strict_types=1);

namespace App\Tests\Integration\Card;

use App\Action\Appointment\InitAppointmentPaymentAction;
use App\Domain\Entity\PaymentIntent;
use App\Domain\Entity\Specialist;
use App\Domain\Repository\PaymentIntentRepository;
use App\Infrastructure\Service\PaymentIntentService;
use App\Tests\Integration\Card\Support\FakeCardGateway;
use DateTimeImmutable;
use Doctrine\ORM\EntityManagerInterface;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

/**
 * Audit M15 and the other card paths: every checkout is recorded before
 * Paystack sees its reference; an unused payment reaches the wallet (the
 * sweep), a charge whose webhook never came is still found; and the guest
 * and follow-up card paths pay once under concurrency too.
 */
final class CardLifecycleTest extends CardIntegrationTestCase
{
    public function testPayInitRecordsTheCheckoutBeforePaystackSeesTheReference(): void
    {
        [$patientId, $doctor, $slots] = $this->patientAndDoctor('10000.00');
        $request = (new ServerRequestFactory())->createServerRequest('POST', '/api/portal/appointments/pay-init')
            ->withAttribute('customer_id', $patientId)
            ->withParsedBody(['specialist_id' => $doctor->getId(), 'guest_count' => 1, 'scheduled_at' => $slots[0]]);

        // Paystack (a closed local port here) refuses: 502 — and the row says so.
        $res = $this->app()->get(InitAppointmentPaymentAction::class)($request, (new ResponseFactory())->createResponse());
        $this->assertSame(502, $res->getStatusCode());

        $row = $this->em()->getConnection()->fetchAssociative('SELECT * FROM payment_intents WHERE patient_id = ? ORDER BY created_at DESC LIMIT 1', [$patientId]);
        $this->assertIsArray($row, 'the checkout was recorded before Paystack was called');
        $this->assertSame(PaymentIntent::STATUS_FAILED, $row['status']);
        $this->assertSame(PaymentIntent::PURPOSE_BOOKING, $row['purpose']);
        $this->assertSame('15000.00', $row['amount'], 'fee + one guest');
        $this->assertStringStartsWith(PaymentIntentService::REFERENCE_PREFIX, $row['reference']);
        $context = json_decode((string) $row['context'], true);
        $this->assertSame($doctor->getId(), $context['specialist_id']);
        $this->assertSame(1, $context['guest_count']);
    }

    public function testTheSweepFindsAMissedChargeAndCreditsItOnceWhenUnused(): void
    {
        [$patientId, $doctor] = $this->patientAndDoctor();
        $ref     = $this->checkout($patientId, PaymentIntent::PURPOSE_BOOKING, ['specialist_id' => $doctor->getId()], '10000.00', '10000.00')->getReference();
        $service = fn (): PaymentIntentService => $this->app()->get(PaymentIntentService::class);
        $sql     = $this->em()->getConnection();

        // Started 20 minutes ago, no webhook: the sweep asks Paystack and finds it paid…
        $sql->executeStatement("UPDATE payment_intents SET created_at = NOW() - INTERVAL '20 minutes' WHERE reference = ?", [$ref]);
        $first = $service()->sweep();
        $this->assertSame(PaymentIntent::STATUS_PAID, $this->intentRow($ref)['status'], json_encode($first));
        $this->assertSame(0, $this->postings(PaymentIntentService::walletCreditKey($ref)), '…but leaves the patient time to use it');

        // …and once it has gone unused for CARD_INTENT_CREDIT_AFTER_MINUTES, credits it to the wallet.
        $sql->executeStatement("UPDATE payment_intents SET paid_at = NOW() - INTERVAL '31 minutes' WHERE reference = ?", [$ref]);
        $second = $service()->sweep();
        $this->assertGreaterThanOrEqual(1, $second['credited'], json_encode($second));
        $this->assertSame(PaymentIntent::STATUS_CREDITED, $this->intentRow($ref)['status']);
        $this->assertSame('10000.00', $this->balanceOf($patientId));
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM notifications WHERE patient_id = ? AND title = 'Card payment added to your wallet'", [$patientId]));

        $service()->sweep();
        $this->assertSame(1, $this->postings(PaymentIntentService::walletCreditKey($ref)), 'credited once');
        $this->assertSame('10000.00', $this->balanceOf($patientId));
    }

    public function testAnUnpaidCheckoutExpiresAfterADayYetALateSuccessStillCounts(): void
    {
        [$patientId, $doctor] = $this->patientAndDoctor();
        $ref = $this->checkout($patientId, PaymentIntent::PURPOSE_BOOKING, ['specialist_id' => $doctor->getId()], '10000.00')->getReference();
        FakeCardGateway::answer($this->gatewayFile, $ref, ['status' => 'abandoned', 'amount_minor' => 1000000, 'currency' => 'NGN']);
        $this->em()->getConnection()->executeStatement("UPDATE payment_intents SET created_at = NOW() - INTERVAL '25 hours' WHERE reference = ?", [$ref]);

        $this->app()->get(PaymentIntentService::class)->sweep();
        $this->assertSame(PaymentIntent::STATUS_EXPIRED, $this->intentRow($ref)['status']);

        FakeCardGateway::answer($this->gatewayFile, $ref, ['status' => 'success', 'amount_minor' => 1000000, 'currency' => 'NGN']);
        $this->assertSame('paid', $this->app()->get(PaymentIntentService::class)->recordCharge($ref));
        $this->assertSame(PaymentIntent::STATUS_PAID, $this->intentRow($ref)['status']);
    }

    public function testAnAbandonedCheckoutIsAskedLessOftenAndNeverCrowdsOutANewOne(): void
    {
        [$patientId, $doctor] = $this->patientAndDoctor();
        // [started, last asked Paystack] ago, per checkout — all still unconfirmed.
        $ages = [
            'fresh'     => ['16 minutes', null],          // never asked yet
            'young'     => ['40 minutes', '16 minutes'],  // its first two hours: every 15 minutes
            'oldRecent' => ['3 hours', '30 minutes'],     // older: every two hours — not yet…
            'oldStale'  => ['3 hours', '150 minutes'],    // …and now
        ];
        $refs = [];
        $sql  = $this->em()->getConnection();
        foreach ($ages as $name => [$started, $asked]) {
            $refs[$name] = $this->checkout($patientId, PaymentIntent::PURPOSE_BOOKING, ['specialist_id' => $doctor->getId()], '10000.00')->getReference();
            FakeCardGateway::answer($this->gatewayFile, $refs[$name], ['status' => 'abandoned', 'amount_minor' => 0, 'currency' => 'NGN']);
            $sql->executeStatement(
                'UPDATE payment_intents SET created_at = NOW() - CAST(? AS INTERVAL), last_checked_at = '
                    . ($asked === null ? 'NULL' : 'NOW() - CAST(? AS INTERVAL)') . ' WHERE reference = ?',
                $asked === null ? [$started, $refs[$name]] : [$started, $asked, $refs[$name]],
            );
        }

        // Never asked first, then the least recently asked; the recently asked old one waits.
        $now   = new DateTimeImmutable();
        $due   = $this->app()->get(PaymentIntentRepository::class)->dueForReverify(
            $now->modify('-15 minutes'),
            $now->modify('-2 hours'),
            $now->modify('-15 minutes'),
            $now->modify('-2 hours'),
            500,
        );
        $order = array_values(array_filter(
            array_map(static fn (PaymentIntent $i): string => $i->getReference(), $due),
            static fn (string $ref): bool => in_array($ref, $refs, true),
        ));
        $this->assertSame([$refs['fresh'], $refs['oldStale'], $refs['young']], $order);

        $calls = fn (): array => array_map(fn (string $ref): int => FakeCardGateway::calls($this->gatewayFile, $ref), $refs);
        $this->app()->get(PaymentIntentService::class)->sweep();
        $this->assertSame(['fresh' => 1, 'young' => 1, 'oldRecent' => 0, 'oldStale' => 1], $calls());
        $this->app()->get(PaymentIntentService::class)->sweep();
        $this->assertSame(['fresh' => 1, 'young' => 1, 'oldRecent' => 0, 'oldStale' => 1], $calls(), 'none is due again straight away');
        foreach ($refs as $ref) {
            $this->assertSame(PaymentIntent::STATUS_INITIATED, $this->intentRow($ref)['status'], 'unpaid, not yet a day old');
        }
    }

    public function testTwoGuestsOnOneCardPaymentAtOnceAddOne(): void
    {
        [$patientId, $doctor, $slots] = $this->patientAndDoctor('10000.00');
        $this->fundWallet($patientId, '10000.00');
        $appointmentId = $this->bookFromWallet($patientId, $doctor, $slots[0]);
        $ref = $this->checkout($patientId, PaymentIntent::PURPOSE_GUEST, ['appointment_id' => $appointmentId], '5000.00', '5000.00', markPaid: true)->getReference();

        $guest = static fn (string $email): array => [
            'op'             => 'guest',
            'customer_id'    => $patientId,
            'appointment_id' => $appointmentId,
            'body'           => ['name' => 'Guest ' . $email, 'email' => $email, 'payment_method' => 'card', 'payment_reference' => $ref],
        ];
        $results = $this->race([$guest('bola@example.com'), $guest('chidi@example.com')], $this->holdIntent($ref), 'card_it_guest');

        $statuses = array_column($results, 'status');
        sort($statuses);
        $this->assertSame([201, 422], $statuses, json_encode($results));
        $guests = json_decode((string) $this->em()->getConnection()->fetchOne('SELECT guests FROM appointments WHERE id = ?', [$appointmentId]), true);
        $this->assertCount(1, $guests, 'one guest per payment');
        $this->assertSame($ref, $guests[0]['payment_reference']);
        $this->assertSame('15000.00', (string) $this->em()->getConnection()->fetchOne('SELECT amount FROM appointments WHERE id = ?', [$appointmentId]));
        $this->assertSame($guests[0]['id'], $this->intentRow($ref)['consumed_by']);
        $this->assertSame('0.00', $this->balanceOf($patientId), 'the wallet paid the booking; nothing was credited');
    }

    public function testADoubleCardAcceptanceOfAFollowUpConfirmsItOnce(): void
    {
        [$patientId, $doctor, $slots] = $this->patientAndDoctor('20000.00');
        $proposalId = $this->proposal($patientId, $doctor, $slots[1]);
        $ref        = $this->checkout($patientId, PaymentIntent::PURPOSE_FOLLOW_UP, ['appointment_id' => $proposalId], '10000.00', '10000.00', markPaid: true)->getReference();

        $accept  = ['op' => 'accept', 'customer_id' => $patientId, 'appointment_id' => $proposalId, 'body' => ['payment_method' => 'card', 'payment_reference' => $ref]];
        $results = $this->race([$accept, $accept], $this->holdIntent($ref), 'card_it_accept');

        $this->assertSame([200, 200], array_column($results, 'status'), json_encode($results));
        $messages = array_map(static fn (array $r): string => (string) $r['body']['message'], $results);
        sort($messages);
        $this->assertSame(['Follow-up already accepted', 'Follow-up confirmed'], $messages);
        $row = $this->em()->getConnection()->fetchAssociative('SELECT status, payment_reference, payment_status FROM appointments WHERE id = ?', [$proposalId]);
        $this->assertSame(['status' => 'confirmed', 'payment_reference' => $ref, 'payment_status' => 'paid'], $row);
        $this->assertSame(PaymentIntent::STATUS_CONSUMED, $this->intentRow($ref)['status']);
        $this->assertSame('0.00', $this->balanceOf($patientId), 'nothing credited, nothing charged twice');
    }

    /** @return callable(EntityManagerInterface): void */
    private function holdIntent(string $reference): callable
    {
        return static function (EntityManagerInterface $em) use ($reference): void {
            $em->getConnection()->fetchOne('SELECT id FROM payment_intents WHERE reference = ? FOR UPDATE', [$reference]);
        };
    }

    private function bookFromWallet(string $patientId, Specialist $doctor, string $slot): string
    {
        $request = (new ServerRequestFactory())->createServerRequest('POST', '/api/portal/appointments')
            ->withAttribute('customer_id', $patientId)
            ->withParsedBody(['specialist_id' => $doctor->getId(), 'scheduled_at' => $slot, 'type' => 'video']);
        $res  = $this->app()->get(\App\Action\Appointment\CreateMyAppointmentAction::class)($request, (new ResponseFactory())->createResponse());
        $body = json_decode((string) $res->getBody(), true);
        $this->assertSame(201, $res->getStatusCode(), (string) json_encode($body));

        return (string) $body['data']['id'];
    }
}
