<?php

declare(strict_types=1);

namespace App\Tests\Integration\Dashboard;

use App\Domain\Dashboard\DashboardPeriod;
use App\Domain\Entity\Appointment;
use App\Domain\Entity\Patient;
use App\Domain\Entity\Specialist;
use App\Domain\Enum\SpecialistStatus;
use App\Domain\Repository\AdminDashboardRepository;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\AppSettingRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\SupportTicketRepository;
use App\Infrastructure\Service\AdminDashboardService;
use App\Infrastructure\Service\CallPresence;
use App\Infrastructure\Service\PricingService;
use App\Tests\Integration\Wallet\Support\WalletHarness;
use DateTimeImmutable;
use DateTimeZone;
use Doctrine\ORM\EntityManagerInterface;
use PHPUnit\Framework\TestCase;
use Predis\Client as RedisClient;

/**
 * The dashboard's "Live now" against real Postgres and Redis (call presence
 * under a throw-away key prefix; skipped when either is unreachable): a
 * booking a few minutes away whose call has started is listed — and counted —
 * as in progress only, and stale never-closed bookings can't crowd a running
 * call out of the presence check.
 */
final class AdminDashboardLiveTest extends TestCase
{
    private static ?string $schema = null;

    private static ?string $skipReason = null;

    private ?EntityManagerInterface $em = null;

    private ?RedisClient $redis = null;

    public static function setUpBeforeClass(): void
    {
        self::$skipReason = WalletHarness::unavailableReason() ?? self::redisUnavailable();
        self::$schema     = self::$skipReason === null ? WalletHarness::createSchema() : null;
    }

    public static function tearDownAfterClass(): void
    {
        if (self::$schema !== null) {
            WalletHarness::dropSchema(self::$schema);
            self::$schema = null;
        }
    }

    protected function setUp(): void
    {
        if (self::$skipReason !== null) {
            $this->markTestSkipped(self::$skipReason);
        }
        $this->em    = WalletHarness::entityManager((string) self::$schema, 'dashboard_live_it');
        $this->redis = self::redis('dash-live-it-' . bin2hex(random_bytes(4)) . ':');
    }

    protected function tearDown(): void
    {
        $this->em?->getConnection()->close();
        $this->em    = null;
        $this->redis = null;
    }

    private static function redis(string $prefix = ''): RedisClient
    {
        WalletHarness::loadEnv();
        $password = (string) ($_ENV['REDIS_PASSWORD'] ?? '');

        return new RedisClient(
            [
                'scheme'   => 'tcp',
                'host'     => (string) ($_ENV['REDIS_HOST'] ?? '127.0.0.1'),
                'port'     => (int) ($_ENV['REDIS_PORT'] ?? 6379),
                'password' => $password !== '' ? $password : null,
                'timeout'  => 1.0,
            ],
            $prefix !== '' ? ['prefix' => $prefix] : [],
        );
    }

    private static function redisUnavailable(): ?string
    {
        try {
            self::redis()->ping();

            return null;
        } catch (\Throwable $e) {
            return 'Redis unreachable: ' . $e->getMessage();
        }
    }

    public function testEachCallIsListedOnceAndRunningCallsAreNeverCrowdedOut(): void
    {
        $em    = $this->em;
        $redis = $this->redis;
        \assert($em instanceof EntityManagerInterface && $redis instanceof RedisClient);
        // The process zone, to the second — what the naive timestamp columns hold.
        $zone = new DateTimeZone(date_default_timezone_get());
        $now  = new DateTimeImmutable(date('Y-m-d H:i:s'), $zone);

        $doctor = new Specialist('Dr. Live Test', 'Cardiology');
        $doctor->setStatus(SpecialistStatus::APPROVED);
        $patient = new Patient('dash-live-' . bin2hex(random_bytes(4)) . '@example.com', 'Liv', 'Patient');
        $em->persist($doctor);
        $em->persist($patient);

        $earlyInCall   = new Appointment($patient, $doctor, $now->modify('+10 minutes')); // patient already waiting
        $runningCall   = new Appointment($patient, $doctor, $now->modify('-5 minutes'));
        $soonNoCall    = new Appointment($patient, $doctor, $now->modify('+30 minutes'));
        $staleUnclosed = new Appointment($patient, $doctor, $now->modify('-200 minutes')); // ended, never closed
        foreach ([$earlyInCall, $runningCall, $soonNoCall, $staleUnclosed] as $a) {
            $em->persist($a);
        }
        $em->flush();

        $presence = new CallPresence($redis);
        $this->assertTrue($presence->mark($earlyInCall, 'patient'));
        $this->assertTrue($presence->mark($runningCall, 'doctor'));

        try {
            // Newest first: with room for two, the stale booking is the one left out.
            $repo = new AdminDashboardRepository($em);
            $this->assertSame(
                [$earlyInCall->getId(), $runningCall->getId()],
                array_map(static fn (Appointment $a): string => $a->getId(), $repo->liveCandidates($now, 240, 15, 2)),
            );

            $service = new AdminDashboardService(
                $repo,
                new AppointmentRepository($em),
                new SpecialistRepository($em),
                new SupportTicketRepository($em),
                $presence,
                new PricingService(new AppSettingRepository($em)),
                $redis,
            );
            $data = $service->build(DashboardPeriod::of('today', $zone), ['live'], ['monitoring.view'], true);
            $this->assertSame(['live'], $data['sections']);
            $live = $data['live'];

            $this->assertSame([$earlyInCall->getId(), $runningCall->getId()], array_column($live['in_progress'], 'id'));
            $this->assertSame(2, $live['in_progress_count']);
            $this->assertSame(['doctor' => false, 'patient' => true, 'guests' => 0], $live['in_progress'][0]['in_call']);

            // The early call is not "starting soon" too — in the list or the count.
            $this->assertSame([$soonNoCall->getId()], array_column($live['starting_soon'], 'id'));
            $this->assertSame(1, $live['starting_soon_count']);
            $this->assertNull($live['starting_soon'][0]['in_call']);
        } finally {
            $presence->clear($earlyInCall, 'patient');
            $presence->clear($runningCall, 'doctor');
        }
    }
}
