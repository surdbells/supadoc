<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Action\Doctor\AddAvailabilityAction;
use App\Action\Doctor\BlockAvailabilityAction;
use App\Action\Doctor\CreateCertificateAction;
use App\Action\Doctor\RescheduleDoctorAppointmentAction;
use App\Domain\Settings\ScheduleRules;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use DateTimeImmutable;
use DateTimeZone;
use DI\ContainerBuilder;
use PHPUnit\Framework\TestCase;

/**
 * "Calendars start from now": availability can't be published or blocked in
 * the past, and sick leave can only be backdated a short way. A regression here
 * lets a doctor save slots nobody can book, or certify leave from months ago.
 */
final class ScheduleRulesTest extends TestCase
{
    private function utc(string $at): DateTimeImmutable
    {
        return new DateTimeImmutable($at, new DateTimeZone('UTC'));
    }

    public function testAStartInTheCurrentMinuteHasNotPassed(): void
    {
        // The editor sends "HH:MM": typing the current minute must still count as now.
        $now = $this->utc('2026-10-14 10:05:42');

        $this->assertFalse(ScheduleRules::hasPassed($this->utc('2026-10-14 10:05'), $now));
        $this->assertFalse(ScheduleRules::hasPassed($this->utc('2026-10-14 10:30'), $now));
        $this->assertTrue(ScheduleRules::hasPassed($this->utc('2026-10-14 10:04'), $now));
        $this->assertTrue(ScheduleRules::hasPassed($this->utc('2026-10-13 23:59'), $now));
    }

    public function testHasPassedComparesInstantsAcrossTimezones(): void
    {
        $now = $this->utc('2026-10-14 10:00');

        // 10:30 in Lagos (UTC+1) is 09:30 UTC — already gone.
        $lagos = new DateTimeImmutable('2026-10-14 10:30', new DateTimeZone('Africa/Lagos'));
        $this->assertTrue(ScheduleRules::hasPassed($lagos, $now));
        // 11:30 in Lagos is 10:30 UTC — still ahead.
        $this->assertFalse(ScheduleRules::hasPassed($lagos->modify('+1 hour'), $now));
    }

    public function testOnlyEarlierUtcDaysArePast(): void
    {
        $now = $this->utc('2026-10-14 23:30');

        $this->assertTrue(ScheduleRules::isPastUtcDay($this->utc('2026-10-13'), $now));
        // Today (even late in the day) can still be blocked as a whole day.
        $this->assertFalse(ScheduleRules::isPastUtcDay($this->utc('2026-10-14'), $now));
        $this->assertFalse(ScheduleRules::isPastUtcDay($this->utc('2026-10-15'), $now));
    }

    public function testCertificatesMayBeBackdatedOneWeek(): void
    {
        $this->assertSame('2026-10-07', ScheduleRules::earliestCertificateStart('2026-10-14'));

        $this->assertFalse(ScheduleRules::isCertificateBackdatedTooFar(new DateTimeImmutable('2026-10-14'), '2026-10-14'));
        $this->assertFalse(ScheduleRules::isCertificateBackdatedTooFar(new DateTimeImmutable('2026-10-07'), '2026-10-14'));
        $this->assertTrue(ScheduleRules::isCertificateBackdatedTooFar(new DateTimeImmutable('2026-10-06'), '2026-10-14'));
        // Future leave (a planned procedure) is fine.
        $this->assertFalse(ScheduleRules::isCertificateBackdatedTooFar(new DateTimeImmutable('2026-11-01'), '2026-10-14'));
    }

    public function testTheBackdateWindowCrossesMonthBoundaries(): void
    {
        $this->assertSame('2026-02-25', ScheduleRules::earliestCertificateStart('2026-03-04'));
        $this->assertSame('2025-12-29', ScheduleRules::earliestCertificateStart('2026-01-05'));
    }

    /** The list's `meta` hands the client the same floor the POST enforces (clinic calendar). */
    public function testTheCertificateWindowMatchesTheBackdateRule(): void
    {
        $window = ScheduleRules::certificateWindow('2026-10-14');

        $this->assertSame(['earliest_from_date' => '2026-10-07', 'backdate_days' => 7], $window);
        $this->assertFalse(ScheduleRules::isCertificateBackdatedTooFar(new DateTimeImmutable($window['earliest_from_date']), '2026-10-14'));
        $this->assertTrue(ScheduleRules::isCertificateBackdatedTooFar(new DateTimeImmutable('2026-10-06'), '2026-10-14'));
        // With no date given it follows the clinic's "today", like the POST.
        $this->assertSame(ScheduleRules::earliestCertificateStart(), ScheduleRules::certificateWindow()['earliest_from_date']);
    }

    /** A range shorter than one slot publishes nothing — the API must say so, not "0 added". */
    public function testSlotsInRangeCountsWholeSlotsOnly(): void
    {
        $this->assertSame(6, ScheduleRules::slotsInRange(9 * 60, 12 * 60, 30));
        $this->assertSame(1, ScheduleRules::slotsInRange(23 * 60, 23 * 60 + 59, 30));
        // 23:30–23:59 can't hold a 30-minute slot (the day's last minute is 23:59).
        $this->assertSame(0, ScheduleRules::slotsInRange(23 * 60 + 30, 23 * 60 + 59, 30));
        $this->assertSame(0, ScheduleRules::slotsInRange(10 * 60, 10 * 60 + 15, 30));
        $this->assertSame(0, ScheduleRules::slotsInRange(12 * 60, 9 * 60, 30));
        $this->assertSame(0, ScheduleRules::slotsInRange(9 * 60, 12 * 60, 0));
    }

    /** The guarded actions still autowire (the reschedule now needs AvailabilityService). */
    public function testGuardedActionsResolveFromTheContainer(): void
    {
        $_ENV['DB_SERVER_VERSION'] = '16';
        DoctrineEntityManagerFactory::reset();
        $builder = new ContainerBuilder();
        $builder->addDefinitions(__DIR__ . '/../../config/container.php');
        $container = $builder->build();

        foreach ([
            RescheduleDoctorAppointmentAction::class,
            AddAvailabilityAction::class,
            BlockAvailabilityAction::class,
            CreateCertificateAction::class,
        ] as $action) {
            $this->assertInstanceOf($action, $container->get($action));
        }
    }
}
