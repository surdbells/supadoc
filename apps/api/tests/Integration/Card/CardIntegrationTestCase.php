<?php

declare(strict_types=1);

namespace App\Tests\Integration\Card;

use App\Domain\Entity\Appointment;
use App\Domain\Entity\Patient;
use App\Domain\Entity\PaymentIntent;
use App\Domain\Entity\Specialist;
use App\Domain\Entity\WalletTransaction;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Enum\ConsultationType;
use App\Domain\Repository\PaymentIntentRepository;
use App\Infrastructure\Service\AvailabilityService;
use App\Infrastructure\Service\PaymentIntentService;
use App\Infrastructure\Service\WalletService;
use App\Tests\Integration\Card\Support\CardHarness;
use App\Tests\Integration\Card\Support\FakeCardGateway;
use DateTimeImmutable;
use DI\Container;
use Doctrine\ORM\EntityManagerInterface;
use PHPUnit\Framework\TestCase;

/**
 * Base for the Postgres-backed card-payment tests: one throw-away schema per
 * test class (with the partial unique indexes), the app's real container per
 * "request", Paystack's verify faked from a per-test file. Skipped (not
 * failed) when the local database is unreachable.
 */
abstract class CardIntegrationTestCase extends TestCase
{
    protected static ?string $schema = null;

    private static ?string $skipReason = null;

    protected string $gatewayFile = '';

    /** @var list<EntityManagerInterface> */
    private array $opened = [];

    private string|false $errorLog = false;

    public static function setUpBeforeClass(): void
    {
        self::$skipReason = CardHarness::unavailableReason();
        static::$schema   = self::$skipReason === null ? CardHarness::createSchema() : null;
    }

    public static function tearDownAfterClass(): void
    {
        if (static::$schema !== null) {
            CardHarness::dropSchema(static::$schema);
            static::$schema = null;
        }
    }

    protected function setUp(): void
    {
        if (self::$skipReason !== null) {
            $this->markTestSkipped(self::$skipReason);
        }
        $this->gatewayFile = tempnam(sys_get_temp_dir(), 'card-it-gw-') ?: sys_get_temp_dir() . '/card-it-gw-' . bin2hex(random_bytes(4));
        file_put_contents($this->gatewayFile, '{}');
        // The services' operational error_log lines are expected here; keep them out of the output.
        $this->errorLog = ini_set('error_log', sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'card-it-error.log');
    }

    protected function tearDown(): void
    {
        foreach ($this->opened as $em) {
            $em->getConnection()->close();
        }
        $this->opened = [];
        foreach ([$this->gatewayFile, $this->gatewayFile . '.calls'] as $file) {
            if ($file !== '' && is_file($file)) {
                @unlink($file);
            }
        }
        if ($this->errorLog !== false) {
            ini_set('error_log', $this->errorLog);
        }
    }

    /** The app's container — a request of its own (own EntityManager / session). */
    protected function app(string $applicationName = 'card_it'): Container
    {
        $container      = CardHarness::container((string) static::$schema, $this->gatewayFile, $applicationName);
        $this->opened[] = $container->get(EntityManagerInterface::class);

        return $container;
    }

    /** A fresh session for looking at what the database holds. */
    protected function em(string $applicationName = 'card_it'): EntityManagerInterface
    {
        $em             = CardHarness::entityManager((string) static::$schema, $applicationName);
        $this->opened[] = $em;

        return $em;
    }

    /** @return array{0: string, 1: Specialist, 2: list<string>} [patientId, doctor, open slot ISO times] */
    protected function patientAndDoctor(string $fee = '10000.00'): array
    {
        $app        = $this->app();
        $em         = $app->get(EntityManagerInterface::class);
        $patient    = CardHarness::seedPatient($em);
        $specialist = CardHarness::seedSpecialist($em, $fee);
        $slots      = [];
        foreach ($app->get(AvailabilityService::class)->availableDays($specialist, 3) as $day) {
            foreach ($day['slots'] as $slot) {
                $slots[] = $slot['iso'];
            }
        }
        $this->assertGreaterThanOrEqual(3, count($slots), 'the doctor has open times to book');

        return [$patient->getId(), $specialist, $slots];
    }

    protected function anotherPatient(): string
    {
        return CardHarness::seedPatient($this->app()->get(EntityManagerInterface::class), 'other')->getId();
    }

    /** A doctor's open follow-up proposal (₦10,000) of a completed consultation, at `$slot`. */
    protected function proposal(string $patientId, Specialist $doctor, string $slot): string
    {
        $em     = $this->em();
        $doctor = $em->find(Specialist::class, $doctor->getId());
        $parent = new Appointment($em->find(Patient::class, $patientId), $doctor, new DateTimeImmutable('-2 days'), ConsultationType::VIDEO);
        $parent->setAmount('20000.00');
        $parent->setPaymentStatus('paid');
        $parent->transitionTo(AppointmentStatus::CONFIRMED);
        $parent->transitionTo(AppointmentStatus::COMPLETED);
        $em->persist($parent);
        $proposal = Appointment::proposeFollowUp(
            $parent,
            new DateTimeImmutable($slot),
            ['base_fee' => '20000.00', 'amount' => '10000.00', 'rule' => 'percent', 'discount_percent' => 50, 'window_days' => 14, 'window_ends_at' => (new DateTimeImmutable('+12 days'))->format(DATE_ATOM), 'waived' => false],
            null,
            new DateTimeImmutable('+20 hours'),
        );
        $em->persist($proposal);
        $em->flush();

        return $proposal->getId();
    }

    /**
     * A card checkout as pay-init records it (no Paystack call), with what
     * Paystack will answer about it: `$paid` (major units) succeeded, or —
     * null — nothing (an unreachable gateway). `$markPaid` records it as paid
     * already (as the webhook would), so using it asks Paystack nothing.
     *
     * @param array<string,mixed> $context
     */
    protected function checkout(string $patientId, string $purpose, array $context, string $amount, ?string $paid = null, bool $markPaid = false): PaymentIntent
    {
        $intents = $this->app()->get(PaymentIntentService::class);
        $intent  = $intents->create($patientId, $purpose, $context, $amount, 'NGN');
        if ($paid !== null) {
            FakeCardGateway::answer($this->gatewayFile, $intent->getReference(), [
                'status'       => 'success',
                'amount_minor' => (int) bcmul($paid, '100', 0),
                'currency'     => 'NGN',
            ]);
            if ($markPaid) {
                $this->app()->get(PaymentIntentRepository::class)->markPaid($intent->getReference(), $paid, 'NGN', 'gw_test', new DateTimeImmutable());
            }
        }

        return $intent;
    }

    protected function fundWallet(string $patientId, string $amount): void
    {
        $this->app()->get(WalletService::class)->credit($patientId, 'NGN', $amount, WalletTransaction::TYPE_ADJUSTMENT, 'it_fund_' . bin2hex(random_bytes(6)), 'test funding', false);
    }

    /** @return array<string,mixed> */
    protected function intentRow(string $reference): array
    {
        $row = $this->em()->getConnection()->fetchAssociative('SELECT * FROM payment_intents WHERE reference = ?', [$reference]);
        $this->assertIsArray($row);

        return $row;
    }

    protected function balanceOf(string $patientId): string
    {
        return (string) ($this->em()->getConnection()->fetchOne("SELECT balance FROM wallets WHERE patient_id = ? AND currency = 'NGN'", [$patientId]) ?: '0.00');
    }

    /** Successful ledger entries posted under `$reference`. */
    protected function postings(string $reference): int
    {
        return (int) $this->em()->getConnection()->fetchOne("SELECT COUNT(*) FROM wallet_transactions WHERE reference = ? AND status = 'success'", [$reference]);
    }

    /** @param list<mixed> $params */
    protected function countRows(string $sql, array $params = []): int
    {
        return (int) $this->em()->getConnection()->fetchOne($sql, $params);
    }

    /**
     * Run `$jobs` as worker processes that all reach the point where they
     * contend — the lock `$hold` takes and keeps in an open transaction of
     * this test's own — then let them go together.
     *
     * @param list<array<string,mixed>>                $jobs
     * @param callable(EntityManagerInterface): void $hold takes the contended lock inside the open transaction
     * @return list<array<string,mixed>> the workers' results, in job order
     */
    protected function race(array $jobs, callable $hold, string $applicationName): array
    {
        $blocker = $this->em('card_it_blocker');
        $blocker->getConnection()->beginTransaction();
        $hold($blocker);

        $workers = [];
        $failure = null;
        try {
            foreach ($jobs as $job) {
                $workers[] = CardHarness::startWorker($job + [
                    'schema'       => static::$schema,
                    'gateway_file' => $this->gatewayFile,
                    'app'          => $applicationName,
                ]);
            }
            // Every worker has passed its own checks and now waits on our lock.
            CardHarness::awaitLockWaiters($this->em('card_it_observer'), $applicationName, count($jobs));
        } catch (\Throwable $e) {
            $failure = $e;
        }
        $blocker->getConnection()->commit(); // …and they all go at once
        $results = array_map(static fn (array $worker): array => CardHarness::finishWorker($worker), $workers);
        if ($failure !== null) {
            throw new \RuntimeException($failure->getMessage() . "\nworkers: " . json_encode($results), 0, $failure);
        }

        return $results;
    }
}
