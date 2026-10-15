<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Entity\Specialist;
use App\Domain\Enum\SpecialistStatus;
use App\Domain\Exception\ValidationException;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\AvailabilitySlotRepository;
use App\Domain\Settings\BookingSettings;
use App\Infrastructure\Availability\BookingFrame;
use App\Infrastructure\Availability\CalendarQuery;
use App\Infrastructure\Availability\Schedule;
use App\Infrastructure\Availability\SlotGenerator;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use App\Infrastructure\Service\AvailabilityService;
use DateTimeImmutable;
use DateTimeZone;
use PHPUnit\Framework\TestCase;

/**
 * The availability engine: one pure generator behind the calendar, the
 * directory, the suggestions and the booking guard. A regression here shows
 * patients times they can't book (or books overlapping consultations), puts
 * times on the wrong day for a viewer abroad, or lets a suspended doctor be
 * booked.
 */
final class AvailabilityEngineTest extends TestCase
{
    /** Weekdays 09:00–12:00 UTC. */
    private const WEEKDAY_MORNINGS = [
        '1' => [['09:00', '12:00']],
        '2' => [['09:00', '12:00']],
        '3' => [['09:00', '12:00']],
        '4' => [['09:00', '12:00']],
        '5' => [['09:00', '12:00']],
    ];

    private function at(string $utc): int
    {
        return (new DateTimeImmutable($utc, new DateTimeZone('UTC')))->getTimestamp();
    }

    private function frame(string $nowUtc, string $tz = 'UTC', int $lead = 60, int $horizon = 60): BookingFrame
    {
        return new BookingFrame(new DateTimeZone($tz), $this->at($nowUtc), $lead, $horizon);
    }

    /**
     * Candidate starts ("Y-m-d H:i" UTC) in a state.
     *
     * @param list<array{start:int, end:int, state:string}> $candidates
     * @return list<string>
     */
    private function starts(array $candidates, string $state = SlotGenerator::OPEN): array
    {
        $out = [];
        foreach ($candidates as $c) {
            if ($c['state'] === $state) {
                $out[] = gmdate('Y-m-d H:i', $c['start']);
            }
        }

        return $out;
    }

    /** Generate one UTC day, with nothing too soon or too late. */
    private function day(Schedule $s, string $date): array
    {
        return SlotGenerator::generate($s, $this->at("$date 00:00"), $this->at("$date 00:00") + 86400, 0);
    }

    // ----- The generator -----

    public function testTheWeeklyGridStepsByTheDoctorsOwnConsultLength(): void
    {
        $hourly = new Schedule(60, ['1' => [['09:00', '12:00']]]);
        $this->assertSame(['2026-10-19 09:00', '2026-10-19 10:00', '2026-10-19 11:00'], $this->starts($this->day($hourly, '2026-10-19')));

        // A consult must end inside its window: 45-minute slots in 09:00–11:00.
        $long = new Schedule(45, ['1' => [['09:00', '11:00']]]);
        $this->assertSame(['2026-10-19 09:00', '2026-10-19 09:45'], $this->starts($this->day($long, '2026-10-19')));

        // Windows are UTC wall-clock and "24:00" closes the day.
        $late = new Schedule(30, ['1' => [['23:00', '24:00']]]);
        $this->assertSame(['2026-10-19 23:00', '2026-10-19 23:30'], $this->starts($this->day($late, '2026-10-19')));
        $this->assertSame([], $this->starts($this->day($late, '2026-10-20')), 'Tuesday has no hours');
    }

    public function testBookingsTakeEveryTimeTheyOverlap(): void
    {
        // An off-grid 09:30 booking of a 60-minute doctor overlaps 09:00 and 10:00.
        $s = new Schedule(60, ['1' => [['09:00', '12:00']]], [], [], [$this->at('2026-10-19 09:30')]);
        $day = $this->day($s, '2026-10-19');
        $this->assertSame(['2026-10-19 09:00', '2026-10-19 10:00'], $this->starts($day, SlotGenerator::TAKEN));
        $this->assertSame(['2026-10-19 11:00'], $this->starts($day));

        // On the grid a booking takes just its own time.
        $s = new Schedule(30, ['1' => [['09:00', '10:30']]], [], [], [$this->at('2026-10-19 09:30')]);
        $this->assertSame(['2026-10-19 09:00', '2026-10-19 10:00'], $this->starts($this->day($s, '2026-10-19')));
    }

    public function testABookingLastsAsLongAsTheExplicitSlotItIsOn(): void
    {
        // 15-minute published slots on a doctor whose default length is 30.
        $open = [];
        for ($m = 0; $m < 60; $m += 15) {
            $start  = $this->at('2026-10-19 09:00') + $m * 60;
            $open[] = [$start, $start + 900];
        }
        $s = new Schedule(30, [], $open, [], [$this->at('2026-10-19 09:00')]);

        $this->assertSame(['2026-10-19 09:15', '2026-10-19 09:30', '2026-10-19 09:45'], $this->starts($this->day($s, '2026-10-19')));
    }

    public function testExplicitSlotsReplaceTheWeeklyGridOnTheirOwnDayOnly(): void
    {
        $open = [
            [$this->at('2026-10-20 14:00'), $this->at('2026-10-20 14:30')],
            [$this->at('2026-10-20 14:30'), $this->at('2026-10-20 15:00')],
        ];
        $s = new Schedule(30, self::WEEKDAY_MORNINGS, $open);

        $this->assertCount(6, $this->starts($this->day($s, '2026-10-19')), 'Monday keeps the weekly mornings');
        $this->assertSame(['2026-10-20 14:00', '2026-10-20 14:30'], $this->starts($this->day($s, '2026-10-20')), 'Tuesday is the published slots only');
        $this->assertCount(6, $this->starts($this->day($s, '2026-10-21')), 'Wednesday is back on the grid');
    }

    public function testBlocksSubtractFromBothLayersByOverlap(): void
    {
        $open   = [[$this->at('2026-10-20 14:00'), $this->at('2026-10-20 14:30')]];
        $blocks = [
            [$this->at('2026-10-19 10:15'), $this->at('2026-10-19 10:45')], // mid-slot: takes 10:00 and 10:30
            [$this->at('2026-10-20 14:10'), $this->at('2026-10-20 14:20')],
        ];
        $s = new Schedule(30, self::WEEKDAY_MORNINGS, $open, $blocks);

        $this->assertSame(['2026-10-19 10:00', '2026-10-19 10:30'], $this->starts($this->day($s, '2026-10-19'), SlotGenerator::BLOCKED));
        $this->assertSame(['2026-10-20 14:00'], $this->starts($this->day($s, '2026-10-20'), SlotGenerator::BLOCKED));
        $this->assertSame([], $this->starts($this->day($s, '2026-10-20')));
    }

    public function testTheLeadTimeAndHorizonBoundTheBookableWindow(): void
    {
        $frame = $this->frame('2026-10-19 08:30', 'UTC', 60, 7); // bookable [09:30 Mon, 08:30 next Mon)
        $s     = new Schedule(30, self::WEEKDAY_MORNINGS);

        $monday = SlotGenerator::generate($s, $this->at('2026-10-19'), $this->at('2026-10-20'), $frame->bookableFrom, $frame->bookableUntil);
        $this->assertSame(['2026-10-19 09:00'], $this->starts($monday, SlotGenerator::EARLY));
        $this->assertSame('2026-10-19 09:30', $this->starts($monday)[0]);

        $next = SlotGenerator::generate($s, $this->at('2026-10-26'), $this->at('2026-10-27'), $frame->bookableFrom, $frame->bookableUntil);
        $this->assertCount(6, $this->starts($next, SlotGenerator::LATE), 'past now + 7 days');
        $this->assertSame('2026-10-26', $frame->bookableUntilDate);
    }

    /** The guard and the listing are one rule: every minute agrees. */
    public function testTheBookingGuardAgreesWithTheListingEveryMinute(): void
    {
        $frame = $this->frame('2026-10-19 09:10', 'UTC', 60, 3);
        $open  = [
            [$this->at('2026-10-20 14:00'), $this->at('2026-10-20 14:45')],
            [$this->at('2026-10-20 15:00'), $this->at('2026-10-20 15:15')],
        ];
        $s = new Schedule(
            45,
            self::WEEKDAY_MORNINGS + ['6' => [['22:00', '24:00']]],
            $open,
            [[$this->at('2026-10-21 10:00'), $this->at('2026-10-21 10:20')]],
            [$this->at('2026-10-19 11:15'), $this->at('2026-10-20 15:00'), $this->at('2026-10-21 09:40')],
        );
        $from = $this->at('2026-10-19 00:00');
        $to   = $this->at('2026-10-23 00:00');

        $listed = array_flip($this->starts(SlotGenerator::generate($s, $from, $to, $frame->bookableFrom, $frame->bookableUntil)));
        $this->assertNotEmpty($listed);
        for ($t = $from; $t < $to; $t += 60) {
            $this->assertSame(
                isset($listed[gmdate('Y-m-d H:i', $t)]),
                SlotGenerator::isOpenAt($s, $t, $frame->bookableFrom, $frame->bookableUntil),
                'disagree at ' . gmdate('Y-m-d H:i', $t),
            );
        }
    }

    // ----- Days in the viewer's zone -----

    public function testDaysAreTheViewersCalendarDaysAcrossMidnight(): void
    {
        // 22:00–24:00 UTC on Mondays is 23:00–01:00 in Lagos (UTC+1).
        $s     = new Schedule(30, ['1' => [['22:00', '24:00']]]);
        $lagos = $this->frame('2026-10-18 12:00', 'Africa/Lagos');

        $mon = AvailabilityService::firstOpeningIn($s, $lagos->days('2026-10-19', '2026-10-19'), $lagos);
        $this->assertSame(2, $mon['open_slots'] ?? null, 'Monday 23:00 and 23:30 local');
        $tue = AvailabilityService::firstOpeningIn($s, $lagos->days('2026-10-20', '2026-10-20'), $lagos);
        $this->assertSame(2, $tue['open_slots'] ?? null, '00:00 and 00:30 local are Tuesday');
        $this->assertSame($this->at('2026-10-19 23:00'), $tue['first_at']);

        // In UTC all four are Monday.
        $utc = $this->frame('2026-10-18 12:00');
        $this->assertSame(4, AvailabilityService::firstOpeningIn($s, $utc->days('2026-10-19', '2026-10-19'), $utc)['open_slots'] ?? null);

        $slot = $lagos->slot($this->at('2026-10-19 23:30'), $lagos->day('2026-10-20'));
        $this->assertSame(['iso' => '2026-10-19T23:30:00+00:00', 'time' => '00:30', 'label' => '12:30 AM', 'period' => 'evening'], $slot);
    }

    public function testDaylightSavingDaysKeepTheirRealLength(): void
    {
        $ny  = $this->frame('2026-10-30 12:00', 'America/New_York');
        $day = $ny->day('2026-11-01'); // clocks go back

        $this->assertSame(25 * 3600, $day['end'] - $day['start']);
        $this->assertSame('2026-11-02', $ny->days('2026-11-01', '2026-11-02')[1]['date']);
    }

    public function testPartsOfTheDayFollowTheLocalClock(): void
    {
        $lagos = $this->frame('2026-10-18 12:00', 'Africa/Lagos');
        $day   = $lagos->day('2026-10-20');
        $local = fn (string $hm): int => (new DateTimeImmutable('2026-10-20 ' . $hm, new DateTimeZone('Africa/Lagos')))->getTimestamp();

        $this->assertSame('evening', BookingFrame::partOf($day, $local('04:59')), 'the small hours are the night before');
        $this->assertSame('morning', BookingFrame::partOf($day, $local('05:00')));
        $this->assertSame('morning', BookingFrame::partOf($day, $local('11:59')));
        $this->assertSame('afternoon', BookingFrame::partOf($day, $local('12:00')));
        $this->assertSame('afternoon', BookingFrame::partOf($day, $local('16:59')));
        $this->assertSame('evening', BookingFrame::partOf($day, $local('17:00')));
        $this->assertSame('evening', BookingFrame::partOf($day, $local('23:30')));

        // A part-of-day search skips a day that only has other parts.
        $s = new Schedule(30, ['2' => [['08:00', '09:00']], '3' => [['13:00', '14:00']]]); // 09:00 / 14:00 Lagos
        $afternoon = AvailabilityService::firstOpeningIn($s, $lagos->days('2026-10-20', '2026-10-21'), $lagos, 'afternoon');
        $this->assertSame('2026-10-21', $afternoon['date'] ?? null);
    }

    public function testTheFrameWindowAndDateHelpers(): void
    {
        $f = $this->frame('2026-10-15 08:00', 'UTC', 60, 60);
        $this->assertSame('2026-10-15', $f->today);
        $this->assertSame('2026-12-14', $f->bookableUntilDate);
        $this->assertSame('2026-10-15', $f->bookableFromDate);
        $this->assertTrue($f->isBookableDate('2026-12-14'));
        $this->assertFalse($f->isBookableDate('2026-12-15'));
        $this->assertFalse($f->isBookableDate('2026-10-14'));

        // Late at night the lead time pushes the first bookable time to tomorrow.
        $this->assertSame('2026-10-16', $this->frame('2026-10-15 23:30', 'UTC', 60)->bookableFromDate);

        $this->assertTrue(BookingFrame::isYmd('2026-02-28'));
        $this->assertFalse(BookingFrame::isYmd('2026-02-30'));
        $this->assertFalse(BookingFrame::isYmd('2026-2-3'));
        $this->assertSame('2027-01-01', BookingFrame::addDays('2026-12-31', 1));
        $this->assertSame(41, BookingFrame::daysBetween('2026-10-01', '2026-11-11'));
        $this->assertSame('Africa/Lagos', BookingFrame::zone('Not/AZone')->getName(), 'unknown zones fall back to the clinic zone');
        $this->assertSame('Europe/London', BookingFrame::zone('Europe/London')->getName());
    }

    // ----- The calendar -----

    public function testCalendarDayStatuses(): void
    {
        $frame  = $this->frame('2026-10-15 08:00', 'UTC', 60, 7); // Thu; bookable until Thu 22 Oct 08:00
        $booked = [];
        foreach (['09:00', '09:30', '10:00', '10:30'] as $hm) {
            $booked[] = $this->at("2026-10-16 $hm"); // Friday: 2 of 6 left
        }
        foreach (['09:00', '09:30', '10:00', '10:30', '11:00', '11:30'] as $hm) {
            $booked[] = $this->at("2026-10-19 $hm"); // Monday: fully booked
        }
        $blocks = [[$this->at('2026-10-20 00:00'), $this->at('2026-10-21 00:00')]]; // Tuesday off
        $s = new Schedule(30, self::WEEKDAY_MORNINGS, [], $blocks, $booked);

        $out    = AvailabilityService::calendarDays($s, '2026-10-14', '2026-10-23', $frame, 3);
        $status = array_column($out['days'], 'status', 'date');

        $this->assertSame([
            '2026-10-14' => 'past',
            '2026-10-15' => 'available',
            '2026-10-16' => 'few',
            '2026-10-17' => 'closed',
            '2026-10-18' => 'closed',
            '2026-10-19' => 'full',
            '2026-10-20' => 'blocked',
            '2026-10-21' => 'available',
            '2026-10-22' => 'closed', // its times are past the horizon instant
            '2026-10-23' => 'beyond',
        ], $status);
        $this->assertSame(2, $out['days'][2]['open']);
        $this->assertSame('2026-10-16T11:00:00+00:00', $out['days'][2]['first']);
        $this->assertSame($this->at('2026-10-15 09:00'), $out['next']);

        // No schedule (not bookable): nothing open, past/beyond still marked.
        $none = array_column(AvailabilityService::calendarDays(null, '2026-10-14', '2026-10-23', $frame, 3)['days'], 'status');
        $this->assertSame(['past', 'closed', 'closed', 'closed', 'closed', 'closed', 'closed', 'closed', 'closed', 'beyond'], $none);
    }

    public function testTheDirectorySummaryShape(): void
    {
        $day = ['date' => '2026-10-16', 'open_slots' => 4, 'first_at' => $this->at('2026-10-16 09:00'), 'slots' => [
            $this->at('2026-10-16 09:00'), $this->at('2026-10-16 09:30'), $this->at('2026-10-16 10:00'), $this->at('2026-10-16 10:30'),
        ]];
        $next = ['first_at' => $this->at('2026-10-15 13:00')];

        $this->assertSame([
            'date'              => '2026-10-16',
            'open_slots'        => 4,
            'first_slot_at'     => '2026-10-16T09:00:00+00:00',
            'slots_preview'     => ['2026-10-16T09:00:00+00:00', '2026-10-16T09:30:00+00:00', '2026-10-16T10:00:00+00:00'],
            'next_available_at' => '2026-10-15T13:00:00+00:00',
        ], AvailabilityService::summary($day, $next));
        $this->assertSame(
            ['date' => null, 'open_slots' => 0, 'first_slot_at' => null, 'slots_preview' => [], 'next_available_at' => null],
            AvailabilityService::summary(null, null),
        );
    }

    // ----- The service's rules (no database touched) -----

    private function service(?BookingSettings $settings = null): AvailabilityService
    {
        $_ENV['DB_SERVER_VERSION'] = '16';
        DoctrineEntityManagerFactory::reset();
        $em = DoctrineEntityManagerFactory::create();

        return new AvailabilityService(new AppointmentRepository($em), new AvailabilitySlotRepository($em), $settings);
    }

    private function approved(): Specialist
    {
        $s = new Specialist('Dr. Ada', 'GP');
        $s->setStatus(SpecialistStatus::APPROVED);

        return $s;
    }

    public function testTheWeekdayDefaultIsOnlyForApprovedDoctorsWhoPublishNothing(): void
    {
        $service = $this->service();
        $hours   = new \ReflectionMethod(AvailabilityService::class, 'weeklyHours');

        $this->assertNotSame([], $hours->invoke($service, $this->approved(), false));
        $this->assertSame([], $hours->invoke($service, $this->approved(), true), 'publishing slots: those, not made-up hours');
        $this->assertSame([], $hours->invoke($service, new Specialist('Dr. New', 'GP'), false), 'no hours while onboarding');

        $own = $this->approved();
        $own->setWeeklyHours(['2' => [['10:00', '11:00']]]);
        $this->assertSame(['2' => [['10:00', '11:00']]], $hours->invoke($service, $own, true), 'their own hours always apply');
    }

    public function testDoctorsWhoCannotPractiseAreNeverBookable(): void
    {
        $service = $this->service();
        $when    = new DateTimeImmutable('+2 days 10:00');

        foreach ([SpecialistStatus::INVITED, SpecialistStatus::PENDING_REVIEW, SpecialistStatus::REJECTED, SpecialistStatus::SUSPENDED] as $status) {
            $s = $this->approved();
            $s->setStatus($status);
            $this->assertFalse($service->isSlotAvailable($s, $when), $status->value . ' must have no times');
            $this->assertFalse($service->isSlotAvailable($s, $when, false), $status->value . ' must have no times for staff either');
        }
        $removed = $this->approved();
        $removed->softDelete();
        $this->assertFalse($service->isSlotAvailable($removed, $when));
    }

    public function testTooSoonAndPatientHorizonAreRefusedBeforeAnyLookup(): void
    {
        $service = $this->service(); // defaults: lead 60 min, horizon 60 days
        $now     = new DateTimeImmutable('2026-10-15 08:00', new DateTimeZone('UTC'));

        $this->assertFalse($service->isSlotAvailable($this->approved(), $now->modify('+30 minutes'), true, $now));
        $this->assertFalse($service->isSlotAvailable($this->approved(), $now->modify('+60 days'), true, $now));
        $this->assertTrue($service->isBeyondHorizon($now->modify('+60 days'), $now));
        $this->assertFalse($service->isBeyondHorizon($now->modify('+59 days'), $now));
        $this->assertSame('an hour', $service->leadLabel());
    }

    public function testBookingSettingsDefaultsAndValidation(): void
    {
        $settings = new BookingSettings();
        $this->assertSame([
            'horizon_days'                         => 60,
            'lead_minutes'                         => 60,
            'few_left'                             => 3,
            'missed_after_hours'                   => 12,
            'unconfirmed_expiry_minutes_after_end' => 0,
            'noshow_patient_refund_pct'            => 0,
            'noshow_both_refund_pct'               => 0,
            'late_cancel_hours'                    => 0,
            'late_cancel_refund_pct'               => 100,
            'doctor_noshow_alert_threshold'        => 2,
        ], $settings->all());

        foreach ([['horizon_days' => 6], ['horizon_days' => 181], ['lead_minutes' => 7.5], ['few_left' => 'lots'], ['lead_minutes' => 1441]] as $patch) {
            try {
                $settings->update($patch);
                $this->fail('accepted ' . json_encode($patch));
            } catch (ValidationException $e) {
                $this->assertArrayHasKey((string) array_key_first($patch), $e->getErrors());
            }
        }
        $this->assertSame(60, $settings->update(['horizon_days' => 90])['horizon_days'], 'nothing stored without a repository');

        $service = $this->service(new BookingSettings());
        $this->assertSame(60, $service->horizonDays());
        $this->assertSame(3, $service->fewLeft());
    }

    // ----- Bounded calendar requests -----

    /** Walking dates as strings never ended past year 9999 ("10000-01-01" sorts first) and exhausted memory. */
    public function testAYear9999RangeEndsAndIsRefused(): void
    {
        $frame = $this->frame('2026-10-15 08:00');

        $this->assertSame(
            [['date' => '9999-12-31', 'status' => 'beyond', 'open' => 0, 'first' => null]],
            AvailabilityService::calendarDays(null, '9999-12-31', '9999-12-31', $frame, 3)['days'],
        );
        $this->assertCount(2, AvailabilityService::calendarDays(null, '9999-12-30', '9999-12-31', $frame, 3)['days']);
        $this->assertSame([], $frame->days('2026-10-20', '2026-10-19'));
        $this->assertSame(['2026-12-31', '2027-01-01'], array_column($frame->days('2026-12-31', '2027-01-01'), 'date'));

        foreach ([['from' => '9999-12-31', 'to' => '9999-12-31'], ['from' => '9999-12-31']] as $query) {
            try {
                CalendarQuery::range($query, $frame);
                $this->fail('accepted ' . json_encode($query));
            } catch (ValidationException $e) {
                $this->assertSame(['from' => 'Choose a start date from 2026-09-03 to 2026-12-14'], $e->getErrors());
            }
        }
    }

    public function testCalendarQueriesAreBoundedMonthGrids(): void
    {
        $frame = $this->frame('2026-10-15 08:00'); // bookable until 2026-12-14

        $this->assertSame(['2026-10-15', '2026-11-25'], CalendarQuery::range([], $frame), 'today + 41 days by default');
        $this->assertSame(['2026-09-28', '2026-11-08'], CalendarQuery::range(['from' => '2026-09-28', 'to' => '2026-11-08'], $frame), "this month's grid starts before today");
        $this->assertSame(['2026-12-14', '2027-01-24'], CalendarQuery::range(['from' => '2026-12-14'], $frame), 'the last bookable date may start a grid');

        $cases = [
            [['from' => '2026-9-28'], 'from'],
            [['from' => '2026-10-01', 'to' => 'soon'], 'to'],
            [['from' => '2026-09-02'], 'from'],                       // more than 42 days ago
            [['from' => '2026-12-15'], 'from'],                       // after bookable_until
            [['from' => '2026-10-20', 'to' => '2026-10-19'], 'to'],
            [['from' => '2026-10-01', 'to' => '2026-11-12'], 'to'],   // 43 dates
        ];
        foreach ($cases as [$query, $field]) {
            try {
                CalendarQuery::range($query, $frame);
                $this->fail('accepted ' . json_encode($query));
            } catch (ValidationException $e) {
                $this->assertSame([$field], array_keys($e->getErrors()), json_encode($query));
            }
        }

        $this->assertSame('2026-10-16', CalendarQuery::date(['date' => ' 2026-10-16 ']));
        $this->expectException(ValidationException::class);
        CalendarQuery::date(['date' => ['2026-10-16']]);
    }

    // ----- The staff / doctor calendar -----

    public function testTheStaffCalendarReachesAYearAndIgnoresTheBookingsSwitch(): void
    {
        $service = $this->service(); // defaults: lead 60 min, horizon 60 days
        $utc     = new DateTimeZone('UTC');
        $now     = new DateTimeImmutable('2026-10-15 08:00', $utc);
        $patient = $service->frame($utc, $now);
        $staff   = $service->frame($utc, $now, false);

        $this->assertTrue($patient->enforceHorizon);
        $this->assertSame('2026-12-14', $patient->bookableUntilDate);
        $this->assertFalse($staff->enforceHorizon);
        $this->assertSame(AvailabilityService::STAFF_HORIZON_DAYS, $staff->horizonDays);
        $this->assertSame('2027-10-15', $staff->bookableUntilDate);
        $this->assertSame($patient->bookableFrom, $staff->bookableFrom, 'the same minimum notice');

        // A follow-up 90 days out (Wed 13 Jan 2027): beyond for patients, open to staff and the doctor.
        $s = new Schedule(30, self::WEEKDAY_MORNINGS);
        $this->assertSame('beyond', AvailabilityService::calendarDays($s, '2027-01-13', '2027-01-13', $patient, 3)['days'][0]['status']);
        $this->assertSame('available', AvailabilityService::calendarDays($s, '2027-01-13', '2027-01-13', $staff, 3)['days'][0]['status']);

        $live = new \ReflectionMethod(AvailabilityService::class, 'isLive');
        $off  = $this->approved();
        $off->setAvailable(false);
        $this->assertFalse($live->invoke(null, $off, $patient), 'switched off: no times for patients');
        $this->assertTrue($live->invoke(null, $off, $staff), 'staff and the doctor still book them (as the guard lets them)');
        $suspended = $this->approved();
        $suspended->setStatus(SpecialistStatus::SUSPENDED);
        $this->assertFalse($live->invoke(null, $suspended, $staff), 'a doctor who cannot practise has no times for anyone');

        // Nothing to look up for them: every day closed, no next opening.
        $range = $service->range($suspended, '2026-10-15', '2026-10-21', $staff);
        $this->assertSame(365, $range['horizon_days']);
        $this->assertSame('2027-10-15', $range['bookable_until']);
        $this->assertNull($range['next_available']);
        $this->assertSame(['closed'], array_values(array_unique(array_column($range['days'], 'status'))));
    }
}
