<?php

declare(strict_types=1);

namespace App\Tests\Integration\Dashboard;

use App\Domain\Dashboard\DashboardPeriod;
use App\Domain\Entity\Appointment;
use App\Domain\Entity\AuditEvent;
use App\Domain\Entity\Patient;
use App\Domain\Entity\Payout;
use App\Domain\Entity\Review;
use App\Domain\Entity\Specialist;
use App\Domain\Entity\SupportTicket;
use App\Domain\Entity\Wallet;
use App\Domain\Entity\WalletTransaction;
use App\Domain\Enum\AppointmentStatus;
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
 * The dashboard's aggregate SQL against real Postgres (a throw-away schema in
 * the local database; skipped when it is unreachable): seeded figures come
 * back right, and each part only for the permissions that unlock it.
 * The cache is off (Redis points at a closed port), so every figure is live.
 */
final class AdminDashboardQueriesTest extends TestCase
{
    private static ?string $schema = null;

    private static ?string $skipReason = null;

    private ?EntityManagerInterface $em = null;

    public static function setUpBeforeClass(): void
    {
        self::$skipReason = WalletHarness::unavailableReason();
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
        $this->em = WalletHarness::entityManager((string) self::$schema, 'dashboard_it');
    }

    protected function tearDown(): void
    {
        $this->em?->getConnection()->close();
        $this->em = null;
    }

    /**
     * Older free-text spellings that differ only in case or spacing are one
     * specialty in "Top specialties" (named by the most-booked spelling),
     * matching the Reference data page's usage counts. Seeded far in the
     * future, and removed again, so the other test's figures are untouched.
     */
    public function testTopSpecialtiesMergeSpellingsOfTheSameSpecialty(): void
    {
        $em = $this->em;
        \assert($em instanceof EntityManagerInterface);

        $a = new Specialist('Dr. Neu One', 'Neurology');
        $b = new Specialist('Dr. Neu Two', ' neurology  ');
        $c = new Specialist('Dr. Skin', 'Dermatology');
        $patient = new Patient('dash-sp-' . bin2hex(random_bytes(4)) . '@example.com', 'Pat', 'Patient');
        foreach ([$a, $b, $c, $patient] as $e) {
            $em->persist($e);
        }
        $day    = new DateTimeImmutable('2099-03-02 09:00');
        $booked = [];
        foreach ([[$a, 0], [$a, 1], [$b, 2], [$c, 3], [$c, 4]] as [$doctor, $h]) {
            $booked[] = $appt = new Appointment($patient, $doctor, $day->modify("+{$h} hours"));
            $em->persist($appt);
        }
        $em->flush();

        try {
            $rows = (new AdminDashboardRepository($em))->topSpecialties(
                new DateTimeImmutable('2099-03-02 00:00'),
                new DateTimeImmutable('2099-03-03 00:00'),
            );

            $this->assertSame(
                [['Neurology', 3], ['Dermatology', 2]],
                array_map(static fn (array $r): array => [$r['specialty'], $r['bookings']], $rows),
            );
        } finally {
            foreach ([...$booked, $a, $b, $c, $patient] as $e) {
                $em->remove($e);
            }
            $em->flush();
        }
    }

    private function service(EntityManagerInterface $em): AdminDashboardService
    {
        // A closed port: no cache, and presence reads as "unknown" (nobody live).
        $redis = new RedisClient(['scheme' => 'tcp', 'host' => '127.0.0.1', 'port' => 1, 'timeout' => 0.5]);

        return new AdminDashboardService(
            new AdminDashboardRepository($em),
            new AppointmentRepository($em),
            new SpecialistRepository($em),
            new SupportTicketRepository($em),
            new CallPresence($redis),
            new PricingService(new AppSettingRepository($em)),
            $redis,
        );
    }

    public function testFiguresAndPermissions(): void
    {
        $em   = $this->em;
        \assert($em instanceof EntityManagerInterface);
        $zone = new DateTimeZone(date_default_timezone_get());

        // ----- seed -----
        $grace = new Specialist('Dr. Grace Bell', 'Cardiology');
        $grace->setStatus(SpecialistStatus::APPROVED);
        $grace->setAvailable(true);
        $grace->setConsultationFee('15000.00');
        $ada = new Specialist('Dr. Ada Obi', 'Dermatology');
        $ada->setStatus(SpecialistStatus::PENDING_REVIEW);
        $ada->setConsultationFee('9000.00');
        $patient = new Patient('dash-it-' . bin2hex(random_bytes(4)) . '@example.com', 'Pat', 'Patient');
        foreach ([$grace, $ada, $patient] as $e) {
            $em->persist($e);
        }

        $start = (new DateTimeImmutable('today 09:00'));
        $completed = new Appointment($patient, $grace, $start);
        $completed->setPaymentStatus('paid');
        $completed->transitionTo(AppointmentStatus::CONFIRMED);
        $completed->transitionTo(AppointmentStatus::COMPLETED);

        $missed = new Appointment($patient, $grace, $start->modify('+1 hour'));
        $missed->setAmount('10000.00');
        $missed->setPaymentStatus('paid');
        $missed->transitionTo(AppointmentStatus::CONFIRMED);
        $missed->transitionTo(AppointmentStatus::MISSED, true);
        $missed->setNoShow('doctor');
        $missed->recordRefund('10000.00'); // fully refunded → no revenue

        $cancelled = new Appointment($patient, $ada, $start->modify('+2 hours'));
        $cancelled->transitionTo(AppointmentStatus::CANCELLED);

        $yesterday = new Appointment($patient, $grace, $start->modify('-1 day'));
        $yesterday->setAmount('5000.00');
        $yesterday->setPaymentStatus('paid');

        foreach ([$completed, $missed, $cancelled, $yesterday] as $a) {
            $em->persist($a);
        }

        $wallet = new Wallet($patient->getId(), 'NGN');
        $em->persist($wallet);
        $topup = new WalletTransaction($wallet->getId(), $patient->getId(), WalletTransaction::TYPE_TOPUP, WalletTransaction::DIR_CREDIT, '20000.00', 'NGN', 'DASH-TOPUP-1', WalletTransaction::STATUS_SUCCESS);
        $refund = new WalletTransaction($wallet->getId(), $patient->getId(), WalletTransaction::TYPE_REFUND, WalletTransaction::DIR_CREDIT, '10000.00', 'NGN', 'DASH-REFUND-1', WalletTransaction::STATUS_SUCCESS);
        $held = new WalletTransaction($wallet->getId(), $patient->getId(), WalletTransaction::TYPE_TOPUP, WalletTransaction::DIR_CREDIT, '700.00', 'NGN', 'DASH-HELD-1', WalletTransaction::STATUS_REVIEW);
        foreach ([$topup, $refund, $held] as $t) {
            $em->persist($t);
        }

        $em->persist(new Review($grace->getId(), $patient->getId(), 'Pat Patient', 4, 'Great', $completed->getId()));
        $em->persist(new Payout($grace->getId(), $grace->getName(), '3000.00', 'NGN'));
        $em->persist(new SupportTicket($patient->getId(), 'Pat Patient', $patient->getEmail(), 'Help', 'billing'));
        $em->persist(new AuditEvent('Ada Admin', 'admin', 'specialist.approved', null, 'specialist', $grace->getId(), ['doctor' => $grace->getName()]));
        $em->persist(new AuditEvent('Dr. Grace Bell', 'doctor', 'prescription.viewed', null, 'prescription', 'rx-1'));
        $em->flush();

        // The yesterday booking was made yesterday (just inside the previous window).
        $p     = DashboardPeriod::of('today', $zone);
        $madeAt = $p->previousTo->modify('-1 second');
        $em->getConnection()->executeStatement(
            'UPDATE appointments SET created_at = :at WHERE id = :id',
            ['at' => $madeAt->format('Y-m-d H:i:s'), 'id' => $yesterday->getId()],
        );

        // ----- everything (an admin) -----
        $all  = AdminDashboardService::grantedParts(['admin'], ['monitoring.view', 'appointments.view', 'specialists.manage', 'payouts.manage', 'support.manage']);
        $data = $this->service($em)->build(DashboardPeriod::of('today', $zone), $all, ['monitoring.view', 'appointments.view', 'specialists.manage']);

        $this->assertSame([], $data['unavailable'], 'every section loads');
        $this->assertSame(['kpis', 'live', 'attention', 'trends', 'breakdowns'], $data['sections']);
        $this->assertSame('NGN', $data['currency']);

        $kpi = array_column($data['kpis'], null, 'key');
        $this->assertSame(['bookings', 'consultations_completed', 'revenue', 'wallet_topups', 'refunds', 'new_patients', 'active_doctors', 'cancellations', 'missed', 'average_rating'], array_keys($kpi));
        $this->assertSame(3, $kpi['bookings']['value']);
        $this->assertSame(1, $kpi['bookings']['previous']);
        $this->assertSame(200.0, $kpi['bookings']['change_pct']);
        $this->assertSame('15000.00', $kpi['revenue']['value']);
        $this->assertSame('5000.00', $kpi['revenue']['previous']);
        $this->assertSame(1, $kpi['consultations_completed']['value']);
        $this->assertSame('20000.00', $kpi['wallet_topups']['value']);
        $this->assertSame(1, $kpi['wallet_topups']['count']);
        $this->assertSame('10000.00', $kpi['refunds']['value']);
        $this->assertSame(1, $kpi['new_patients']['value']);
        $this->assertSame(1, $kpi['active_doctors']['value']);
        $this->assertNull($kpi['active_doctors']['previous']);
        $this->assertSame(1, $kpi['cancellations']['value']);
        $this->assertSame(1, $kpi['missed']['value']);
        $this->assertSame(['patient' => 0, 'doctor' => 1, 'both' => 0, 'unknown' => 0], $kpi['missed']['breakdown']);
        $this->assertEquals(4.0, $kpi['average_rating']['value']);
        $this->assertSame(1, $kpi['average_rating']['count']);

        $att = array_column($data['attention'], null, 'key');
        // Yesterday's booking is still pending after its slot: it needs settling.
        $this->assertSame(1, $att['appointments_attention']['count']);
        $this->assertSame(['path' => '/appointments', 'query' => ['when' => 'attention']], json_decode((string) json_encode($att['appointments_attention']['link']), true));
        $this->assertSame(1, $att['doctor_reviews_pending']['count']);
        $this->assertSame(['path' => '/specialists', 'query' => ['filter' => 'review']], json_decode((string) json_encode($att['doctor_reviews_pending']['link']), true));
        $this->assertSame(1, $att['payouts_awaiting_approval']['count']);
        $this->assertSame('3000.00', $att['payouts_awaiting_approval']['amount']);
        $this->assertSame(1, $att['support_open']['count']);
        $this->assertSame(1, $att['topups_held']['count']);
        $this->assertSame('700.00', $att['topups_held']['amount']);
        $this->assertNull($att['topups_held']['link']);
        $this->assertSame(0, $att['card_payments_review']['count']);

        $days = $data['trends']['days'];
        $this->assertCount(DashboardPeriod::TREND_DAYS, $days);
        $today = $days[DashboardPeriod::TREND_DAYS - 1];
        $this->assertSame((new DateTimeImmutable('now', $zone))->format('Y-m-d'), $today['date']);
        $this->assertSame(3, $today['bookings']);
        $this->assertSame(1, $today['completed']);
        $this->assertSame('15000.00', $today['revenue']);
        $this->assertSame(4, $data['trends']['totals']['bookings']);
        $this->assertSame('20000.00', $data['trends']['totals']['revenue']);

        $status = array_column($data['breakdowns']['by_status'], 'count', 'status');
        $this->assertSame(1, $status['completed']);
        $this->assertSame(1, $status['missed']);
        $this->assertSame(1, $status['cancelled']);
        $this->assertSame('Cardiology', $data['breakdowns']['top_specialties'][0]['specialty']);
        $this->assertSame(2, $data['breakdowns']['top_specialties'][0]['bookings']);
        $top = $data['breakdowns']['top_doctors'][0];
        $this->assertSame($grace->getId(), $top['id']);
        $this->assertSame(1, $top['consultations']);
        $this->assertSame(1, $top['doctor_no_shows']);
        $this->assertSame('15000.00', $top['revenue']);

        $activity = $data['breakdowns']['recent_activity'];
        $this->assertCount(1, $activity, 'routine reads are left out');
        $this->assertSame('Doctor approved · Dr. Grace Bell', $activity[0]['summary']);
        $this->assertSame('/specialists/' . $grace->getId(), $activity[0]['link']['path']);

        // ----- support staff: their queue (and held money), nothing else -----
        $support = $this->service($em)->build(DashboardPeriod::of('today', $zone), AdminDashboardService::grantedParts(['staff'], ['support.manage']), ['support.manage']);
        $this->assertSame(['attention'], $support['sections']);
        foreach (['kpis', 'live', 'trends', 'breakdowns'] as $absent) {
            $this->assertArrayNotHasKey($absent, $support);
        }
        $this->assertSame(['support_open', 'topups_held', 'card_payments_review'], array_column($support['attention'], 'key'));

        // ----- doctor management without money: no revenue figures -----
        $doctors = $this->service($em)->build(DashboardPeriod::of('today', $zone), AdminDashboardService::grantedParts(['staff'], ['specialists.manage']), ['specialists.manage']);
        $this->assertSame(['active_doctors'], array_column($doctors['kpis'], 'key'));
        $this->assertNull($doctors['breakdowns']['top_doctors'][0]['revenue']);
        $this->assertArrayNotHasKey('by_status', $doctors['breakdowns']);
        $this->assertArrayNotHasKey('recent_activity', $doctors['breakdowns']);

        // ----- payouts staff: money but no activity figures -----
        $payouts = $this->service($em)->build(DashboardPeriod::of('7d', $zone), AdminDashboardService::grantedParts(['staff'], ['payouts.manage']), ['payouts.manage']);
        $this->assertSame(['revenue', 'wallet_topups', 'refunds'], array_column($payouts['kpis'], 'key'));
        $this->assertSame(['revenue'], $payouts['trends']['series']);
        $this->assertNull($payouts['trends']['days'][0]['bookings']);
        $this->assertSame('20000.00', $payouts['trends']['totals']['revenue']);
    }
}
