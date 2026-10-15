<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Action\Wallet\PaystackWebhookAction;
use App\Domain\Entity\PaymentIntent;
use App\Domain\Repository\PaymentIntentRepository;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use App\Infrastructure\Persistence\RawIndexes;
use App\Infrastructure\Service\PaymentIntentService;
use App\Infrastructure\Service\PaymentUse;
use App\Infrastructure\Service\PaystackService;
use App\Infrastructure\Service\SlotLock;
use DateTimeImmutable;
use Doctrine\DBAL\Driver\Exception as DriverException;
use Doctrine\DBAL\Exception\UniqueConstraintViolationException;
use DomainException;
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Factory\StreamFactory;

/**
 * The card-payment rules that need no database (the races themselves are
 * proven against Postgres in tests/Integration/Card): a payment's state only
 * moves forward and is used or credited once; it pays only for what it was
 * started for; overpayments are measured in decimal strings; the webhook
 * refuses anything unsigned before reading it; the slot index is recognised.
 */
final class CardPaymentIntentTest extends TestCase
{
    private function intent(string $purpose = PaymentIntent::PURPOSE_BOOKING, array $context = ['specialist_id' => 'AAA-1']): PaymentIntent
    {
        $intent = new PaymentIntent('vma_test', 'patient-1', $purpose, $context, '10000', 'ngn');
        $intent->initTimestamps();

        return $intent;
    }

    public function testAPaymentMovesForwardOnlyAndSettlesOnce(): void
    {
        $intent = $this->intent();
        $this->assertSame(PaymentIntent::STATUS_INITIATED, $intent->getStatus());
        $this->assertSame('10000.00', $intent->getAmount());
        $this->assertSame('NGN', $intent->getCurrency());
        $this->assertFalse($intent->isUnusedPaid());

        foreach ([fn () => $intent->markConsumed('appt-1', null, new DateTimeImmutable()), fn () => $intent->markCredited('1.00', 'k', new DateTimeImmutable())] as $early) {
            try {
                $early();
                $this->fail('an unpaid payment can be neither used nor credited');
            } catch (DomainException) {
                $this->assertSame(PaymentIntent::STATUS_INITIATED, $intent->getStatus());
            }
        }

        $intent->markPaid('12000', 'ngn', 'gw_1', new DateTimeImmutable());
        $this->assertTrue($intent->isUnusedPaid());
        $this->assertSame('12000.00', $intent->getVerifiedAmount());
        $this->assertSame('NGN', $intent->getVerifiedCurrency());

        $intent->markConsumed('appt-1', '2000.00', new DateTimeImmutable());
        $this->assertSame(PaymentIntent::STATUS_CONSUMED, $intent->getStatus());
        $this->assertSame('appt-1', $intent->getConsumedBy());

        foreach ([
            'used again'      => fn () => $intent->markConsumed('appt-2', null, new DateTimeImmutable()),
            'credited too'    => fn () => $intent->markCredited('12000.00', 'k', new DateTimeImmutable()),
            'paid again'      => fn () => $intent->markPaid('12000', 'NGN', null, new DateTimeImmutable()),
            'expired after'   => fn () => $intent->markExpired(new DateTimeImmutable()),
        ] as $what => $again) {
            try {
                $again();
                $this->fail("$what must be refused");
            } catch (DomainException) {
                $this->assertSame('appt-1', $intent->getConsumedBy(), $what);
            }
        }
    }

    public function testALateSuccessStillCountsAfterExpiryOrAFailedStart(): void
    {
        $expired = $this->intent();
        $expired->markExpired(new DateTimeImmutable());
        $expired->markPaid('10000.00', 'NGN', null, new DateTimeImmutable());
        $this->assertTrue($expired->isUnusedPaid(), 'money we hold is never ignored');

        $failed = $this->intent();
        $failed->markFailed(str_repeat('x', 500));
        $this->assertSame(200, mb_strlen((string) $failed->getFailureReason()));
        $failed->markPaid('10000.00', 'NGN', null, new DateTimeImmutable());
        $this->assertSame(PaymentIntent::STATUS_PAID, $failed->getStatus());
    }

    public function testAPaymentPaysOnlyForWhatItWasStartedFor(): void
    {
        $booking = $this->intent(PaymentIntent::PURPOSE_BOOKING, ['specialist_id' => 'AAA-1', 'scheduled_at' => '2026-10-20T10:00:00+00:00']);
        $this->assertTrue($booking->matches(PaymentIntent::PURPOSE_BOOKING, ['specialist_id' => 'aaa-1', 'parent_appointment_id' => null]), 'ids compare case-insensitively; another time is fine');
        $this->assertFalse($booking->matches(PaymentIntent::PURPOSE_BOOKING, ['specialist_id' => 'BBB-2']), 'another doctor');
        $this->assertFalse($booking->matches(PaymentIntent::PURPOSE_BOOKING, ['specialist_id' => 'AAA-1', 'parent_appointment_id' => 'P-1']), 'not paid as this follow-up');
        $this->assertFalse($booking->matches(PaymentIntent::PURPOSE_GUEST, ['specialist_id' => 'AAA-1']), 'another purpose');

        $followUp = $this->intent(PaymentIntent::PURPOSE_FOLLOW_UP, ['appointment_id' => 'PROP-1']);
        $this->assertTrue($followUp->matches(PaymentIntent::PURPOSE_FOLLOW_UP, ['appointment_id' => 'prop-1']));
        $this->assertFalse($followUp->matches(PaymentIntent::PURPOSE_FOLLOW_UP, ['appointment_id' => 'PROP-2']), 'another proposal');

        // Adopted from before intents: held only to what its record knows.
        $adopted = $this->intent(PaymentIntent::PURPOSE_BOOKING, ['adopted' => true, 'specialist_id' => 'AAA-1']);
        $this->assertTrue($adopted->matches(PaymentIntent::PURPOSE_BOOKING, ['specialist_id' => 'AAA-1', 'parent_appointment_id' => 'P-1']), 'the old checkout never recorded the follow-up');
        $this->assertFalse($adopted->matches(PaymentIntent::PURPOSE_BOOKING, ['specialist_id' => 'BBB-2']), 'what it recorded still counts');
        $this->assertFalse($adopted->matches(PaymentIntent::PURPOSE_GUEST, ['specialist_id' => 'AAA-1']));
        $this->assertFalse($this->intent(PaymentIntent::PURPOSE_BOOKING, ['adopted' => 'yes', 'specialist_id' => 'AAA-1'])->matches(PaymentIntent::PURPOSE_BOOKING, ['parent_appointment_id' => 'P-1']), 'only a real adoption flag');

        $this->expectException(DomainException::class);
        new PaymentIntent('vma_x', 'p', 'top_up', [], '1', 'NGN');
    }

    public function testOverpaymentIsMeasuredInDecimalStrings(): void
    {
        $intent = $this->intent();
        $intent->markPaid(PaymentIntentService::fromMinor(1250050), 'NGN', null, new DateTimeImmutable());
        $this->assertSame('12500.50', $intent->getVerifiedAmount());
        $this->assertSame('2500.50', $intent->overpaidFor('10000'));
        $this->assertSame('0.00', $intent->overpaidFor('12500.50'));
        $this->assertSame('0.00', $intent->overpaidFor('20000.00'), 'underpaid is refused, never a negative credit');
        $this->assertSame('0.01', PaymentIntentService::fromMinor(1));
    }

    public function testEachMoneyMoveHasItsOwnStableLedgerKey(): void
    {
        $ref = PaymentIntentService::newReference();
        $this->assertMatchesRegularExpression('/^vma_[0-9a-f]{24}$/', $ref);
        $this->assertNotSame($ref, PaymentIntentService::newReference());
        $this->assertSame('fu_card_credit_' . $ref, PaymentIntentService::walletCreditKey($ref), 'the key credits used before intents existed');
        $this->assertSame('card_overpay_' . $ref, PaymentIntentService::overpaymentKey($ref));
    }

    public function testADeclineCanAskForTheWalletAndCarriesWhatHappened(): void
    {
        $used = PaymentUse::used('appt-1', ['x' => 1])->withOverpaidCredited('5.00');
        $this->assertTrue($used->used);
        $this->assertSame('appt-1', $used->usedBy);
        $this->assertSame('5.00', $used->overpaidCredited);
        $this->assertNull($used->credited);

        $declined = PaymentUse::declined('slot', creditToWallet: true)->withCredited('10000.00');
        $this->assertFalse($declined->used);
        $this->assertTrue($declined->creditToWallet);
        $this->assertSame('slot', $declined->value);
        $this->assertSame('10000.00', $declined->credited);
        $this->assertFalse(PaymentUse::declined('documents')->creditToWallet, 'kept for the retry by default');
    }

    public function testTheSweepRetriesOnAFreshEntityManagerAndAddsUp(): void
    {
        $runs   = [];
        $result = PaymentIntentService::sweepWithRetries(static function (array $skip, int $try) use (&$runs): array {
            $runs[] = $skip;

            return [
                'reverified' => 1, 'paid' => 0, 'expired' => 0, 'credited' => 1, 'credited_total' => '10.50', 'errors' => 1,
                'failed_refs' => ['vma_bad' . $try], 'em_closed' => $try < 1,
            ];
        });
        $this->assertSame([[], ['vma_bad0']], $runs, 'the second run skips what failed');
        $this->assertSame(2, $result['credited']);
        $this->assertSame('21.00', $result['credited_total']);
        $this->assertSame(['vma_bad0', 'vma_bad1'], $result['failed_refs']);
        $this->assertSame(1, $result['retries']);
    }

    public function testTheWebhookRefusesAnythingUnsignedBeforeReadingIt(): void
    {
        // Every dependency but the signature check is blank: touching one would fail loudly.
        $blank  = static fn (string $class): object => (new \ReflectionClass($class))->newInstanceWithoutConstructor();
        $action = new PaystackWebhookAction(
            $blank(\App\Infrastructure\Service\WalletService::class),
            $blank(\App\Domain\Repository\WalletTransactionRepository::class),
            new PaystackService('sk_unit_secret', '', 'http://127.0.0.1:9'),
            $blank(\App\Infrastructure\Service\PaystackCardGateway::class),
            $blank(PaymentIntentService::class),
        );
        $raw  = (string) json_encode(['event' => 'charge.success', 'data' => ['reference' => 'vma_x']]);
        $post = static fn (?string $sig): int => $action(
            (static function () use ($raw, $sig) {
                $r = (new ServerRequestFactory())->createServerRequest('POST', '/api/webhooks/paystack')->withBody((new StreamFactory())->createStream($raw));

                return $sig === null ? $r : $r->withHeader('x-paystack-signature', $sig);
            })(),
            (new ResponseFactory())->createResponse(),
        )->getStatusCode();

        $this->assertSame(401, $post(null), 'no signature header (accepted before)');
        $this->assertSame(401, $post(''));
        $this->assertSame(401, $post(hash_hmac('sha512', $raw, 'another_secret')));
        $this->assertSame(401, $post(hash_hmac('sha512', $raw . "\n", 'sk_unit_secret')), 'signed bytes must be the body');

        // An unconfigured Paystack can't verify anything either.
        $unconfigured = new PaystackService('', '', '');
        $this->assertFalse($unconfigured->verifySignature($raw, hash_hmac('sha512', $raw, '')));

        // A valid one gets past the gate (a non-charge event is acknowledged without settling anything).
        $ping = (string) json_encode(['event' => 'transfer.success', 'data' => []]);
        $res  = $action(
            (new ServerRequestFactory())->createServerRequest('POST', '/api/webhooks/paystack')
                ->withBody((new StreamFactory())->createStream($ping))
                ->withHeader('x-paystack-signature', hash_hmac('sha512', $ping, 'sk_unit_secret')),
            (new ResponseFactory())->createResponse(),
        );
        $this->assertSame(200, $res->getStatusCode());
    }

    public function testTheSlotIndexIsRecognisedAndTheIndexesAreLiveOnly(): void
    {
        $driverError = new class ('duplicate key value violates unique constraint "' . RawIndexes::SLOT . '"') extends \Exception implements DriverException {
            public function getSQLState(): ?string
            {
                return '23505';
            }
        };
        $this->assertTrue(SlotLock::isSlotTaken(new UniqueConstraintViolationException($driverError, null)));
        $this->assertTrue(SlotLock::isSlotTaken(new \RuntimeException('wrapped', 0, new UniqueConstraintViolationException($driverError, null))));

        $other = new class ('duplicate key value violates unique constraint "' . RawIndexes::PAYMENT_REFERENCE . '"') extends \Exception implements DriverException {
            public function getSQLState(): ?string
            {
                return '23505';
            }
        };
        $this->assertFalse(SlotLock::isSlotTaken(new UniqueConstraintViolationException($other, null)));
        $this->assertFalse(SlotLock::isSlotTaken(new \RuntimeException(RawIndexes::SLOT)));

        $defs = RawIndexes::definitions();
        $this->assertStringContainsString("WHERE status IN ('pending', 'confirmed', 'rescheduled') AND deleted_at IS NULL", $defs[RawIndexes::SLOT]['ddl']);
        $this->assertStringContainsString('(specialist_id, scheduled_at)', $defs[RawIndexes::SLOT]['ddl']);
        $this->assertStringContainsString('WHERE payment_reference IS NOT NULL', $defs[RawIndexes::PAYMENT_REFERENCE]['ddl']);
        foreach ($defs as $def) {
            $this->assertStringContainsString('IF NOT EXISTS', $def['ddl'], 're-runnable');
            $this->assertStringContainsString('HAVING COUNT(*) > 1', $def['violations']);
        }
    }

    public function testAPaymentThatCantBePlacedIsHeldForReviewUntilSupportClosesIt(): void
    {
        $initiated = $this->intent();
        try {
            $initiated->markForReview('x', new DateTimeImmutable());
            $this->fail('only a paid payment can be held for review');
        } catch (DomainException) {
            $this->assertSame(PaymentIntent::STATUS_INITIATED, $initiated->getStatus());
        }

        $held = $this->intent();
        $held->markPaid('10000.00', 'NGN', null, new DateTimeImmutable());
        $held->markForReview(str_repeat('r', 300), new DateTimeImmutable());
        $this->assertSame(PaymentIntent::STATUS_REVIEW, $held->getStatus());
        $this->assertSame(200, mb_strlen((string) $held->getFailureReason()));
        $this->assertFalse($held->isUnusedPaid(), 'nothing may use or credit it on its own');
        $this->assertNotContains(PaymentIntent::STATUS_REVIEW, PaymentIntent::PAYABLE, 'and a webhook cannot re-open it');
        foreach ([
            'used'     => fn () => $held->markConsumed('appt-1', null, new DateTimeImmutable()),
            'credited' => fn () => $held->markCredited('10000.00', 'k', new DateTimeImmutable()),
        ] as $what => $move) {
            try {
                $move();
                $this->fail("a held payment can't be $what automatically");
            } catch (DomainException) {
                $this->assertSame(PaymentIntent::STATUS_REVIEW, $held->getStatus());
            }
        }

        $held->closeReviewCredited('9999.5', 'fu_card_credit_vma_test', new DateTimeImmutable());
        $this->assertSame(PaymentIntent::STATUS_CREDITED, $held->getStatus());
        $this->assertSame('9999.50', $held->getCreditedAmount());
        $this->expectException(DomainException::class);
        $held->closeReviewSettled('support', new DateTimeImmutable()); // closed once
    }

    public function testOnlyAFinalGatewayAnswerEndsTheWait(): void
    {
        foreach (['success', 'failed', 'abandoned', 'reversed', 'FAILED '] as $final) {
            $this->assertFalse(PaymentIntentService::isStillOpen($final), $final);
        }
        foreach (['ongoing', 'pending', 'processing', 'queued', '', 'not_found', 'something-new'] as $open) {
            $this->assertTrue(PaymentIntentService::isStillOpen($open), "'$open' may still succeed: Paystack is asked again");
        }

        // Paystack's "no transaction under this reference" is an answer, not an outage.
        $this->assertTrue(\App\Infrastructure\Service\PaystackCardGateway::isNotFound(new \RuntimeException('Paystack: Transaction reference not found')));
        $this->assertFalse(\App\Infrastructure\Service\PaystackCardGateway::isNotFound(new \RuntimeException('Payment service unreachable')));
        $this->assertFalse(\App\Infrastructure\Service\PaystackCardGateway::isNotFound(new \RuntimeException('reference not found')), 'only Paystack\'s own answer');
    }

    public function testTheSweepCountsHeldPaymentsAcrossRetries(): void
    {
        $result = PaymentIntentService::sweepWithRetries(static fn (array $skip, int $try): array => [
            'reverified' => 0, 'paid' => 0, 'expired' => 0, 'credited' => 0, 'credited_total' => '0.00', 'review' => 2, 'errors' => 1,
            'failed_refs' => ['vma_' . $try], 'em_closed' => $try < 1,
        ]);
        $this->assertSame(4, $result['review']);
    }

    public function testTheIndexStepTakesOnlyASaneLockTimeout(): void
    {
        $conn = (new \ReflectionClass(\Doctrine\DBAL\Connection::class))->newInstanceWithoutConstructor();
        $this->expectException(\InvalidArgumentException::class);
        RawIndexes::ensure($conn, false, "1s'; DROP TABLE appointments; --");
    }

    public function testThePaymentQueriesCompile(): void
    {
        $_ENV['DB_SERVER_VERSION'] = '16';
        DoctrineEntityManagerFactory::reset();
        $repo = new PaymentIntentRepository(DoctrineEntityManagerFactory::create());
        $now  = new DateTimeImmutable();

        $this->assertStringContainsString('payment_intents', $repo->byReferenceQuery('vma_x')->getSQL());
        $cas = $repo->markPaidQuery('vma_x', '10.00', 'NGN', null, $now)->getSQL();
        $this->assertStringContainsString('UPDATE payment_intents', $cas);
        $this->assertStringContainsString('status IN', $cas, 'a compare-and-set on the status');
        $reverify = $repo->dueForReverifyQuery($now, $now->modify('-2 hours'), $now, $now->modify('-2 hours'), 10, ['vma_a'])->getSQL();
        $this->assertStringContainsString('last_checked_at', $reverify);
        $this->assertMatchesRegularExpression('/ORDER BY .*CASE|ORDER BY \w+ ASC, \w+\.last_checked_at ASC/i', $reverify, 'never-asked first, then least recently asked');
        $credit = $repo->dueForCreditQuery($now, 10)->getSQL();
        $this->assertStringContainsString('paid_at', $credit);
        $this->assertMatchesRegularExpression('/COALESCE\(\w+\.last_checked_at, \w+\.paid_at\)/i', $credit, 'least recently tried first: a failing payment goes to the back');
    }
}
