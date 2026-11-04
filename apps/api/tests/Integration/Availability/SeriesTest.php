<?php

declare(strict_types=1);

namespace App\Tests\Integration\Availability;

use App\Action\Doctor\AddAvailabilityAction;
use App\Action\Doctor\BlockAvailabilityAction;
use App\Action\Doctor\DeleteAvailabilityAction;
use App\Action\Doctor\ListAvailabilityAction;
use App\Domain\Entity\Appointment;
use App\Domain\Entity\Specialist;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Enum\ConsultationType;
use App\Infrastructure\Availability\BookingFrame;
use App\Infrastructure\Service\SlotLock;
use App\Tests\Integration\DocumentSharing\DocShareTestCase;
use App\Tests\Integration\DocumentSharing\Support\DocShareHarness;
use DateTimeImmutable;
use DateTimeZone;
use DI\Container;
use Doctrine\ORM\EntityManagerInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * Daily / chosen-days availability on the zone contract (spec §5, §1.7):
 * idempotent re-posts, overlap skips, the doctor's slot lock against parallel
 * publishing and a committing booking, "this and later times", the stale-zone
 * 409, the 12-month horizon, midnight ends — and the legacy UTC contract.
 * Doctor A works in America/Chicago.
 */
final class SeriesTest extends DocShareTestCase
{
    private const CHICAGO = 'America/Chicago';

    protected function setUp(): void
    {
        parent::setUp();
        $this->conn()->executeStatement("UPDATE specialists SET timezone = 'America/Chicago', timezone_source = 'manual' WHERE id = ?", [$this->A]);
    }

    private function day(int $days, string $tz = self::CHICAGO): string
    {
        return (new DateTimeImmutable('now', new DateTimeZone($tz)))->modify('+' . $days . ' days')->format('Y-m-d');
    }

    /** @param array<string,mixed> $body @return array{status:int, body:array<string,mixed>} */
    private function add(array $body): array
    {
        $res = $this->doctorAction(AddAvailabilityAction::class, $this->userA, [], $body);
        unset($res['response']);

        return $res;
    }

    /** @param array<string,string> $query @return array{status:int, body:array<string,mixed>} */
    private function get(string $class, array $query, array $args = [], string $method = 'GET'): array
    {
        $request = (new ServerRequestFactory())->createServerRequest($method, '/api/test')
            ->withAttribute('user_id', $this->userA)
            ->withAttribute('user_roles', ['doctor'])
            ->withQueryParams($query);

        return $this->decode($this->container()->get($class)($request, new Response(), $args));
    }

    /** @return list<array<string,mixed>> */
    private function rows(string $from, string $to): array
    {
        $res = $this->get(ListAvailabilityAction::class, ['from' => $from, 'to' => $to, 'tz' => self::CHICAGO]);
        $this->assertSame(200, $res['status'], json_encode($res['body']));

        return array_values(array_filter($res['body']['data']['slots'], static fn (array $r): bool => !str_starts_with((string) $r['id'], 'appt-')));
    }

    private function slotCount(): int
    {
        return $this->countRows('SELECT COUNT(*) FROM availability_slots WHERE specialist_id = ?', [$this->A]);
    }

    /** @param array<string,mixed> $extra */
    private function series(string $date, array $extra = []): array
    {
        return $extra + ['date' => $date, 'start' => '09:00', 'end' => '10:00', 'duration' => 30, 'repeat' => 'daily', 'weeks' => 1, 'tz' => self::CHICAGO];
    }

    private function book(string $iso): string
    {
        $em = $this->em();
        $a  = new Appointment($this->patient($em, $this->Q), $this->doctor($em, $this->A), new DateTimeImmutable($iso), ConsultationType::VIDEO);
        $a->transitionTo(AppointmentStatus::CONFIRMED, true);
        $em->persist($a);
        $em->flush();

        return $a->getId();
    }

    public function testARepostIsIdempotentAndOverlapsAreSkipped(): void
    {
        $date  = $this->day(3);
        $first = $this->add($this->series($date));
        $this->assertSame(200, $first['status'], json_encode($first['body']));
        $this->assertSame(14, $first['body']['data']['created']);
        $this->assertSame('14 times added', $first['body']['message']);

        $again = $this->add($this->series($date));
        $this->assertSame(200, $again['status']);
        $this->assertSame(0, $again['body']['data']['created']);
        $this->assertSame(14, $again['body']['data']['existing']);
        $this->assertNull($again['body']['data']['series_id'], 'nothing new, no series');
        $this->assertSame(14, $this->slotCount());

        // 09:15–10:15 at 60 min on the first day overlaps 09:00 and 09:30 (different starts).
        $overlap = $this->add(['date' => $date, 'start' => '09:15', 'end' => '10:15', 'duration' => 60, 'tz' => self::CHICAGO]);
        $this->assertSame(200, $overlap['status'], json_encode($overlap['body']));
        $this->assertSame(0, $overlap['body']['data']['created']);
        $this->assertSame(1, $overlap['body']['data']['overlapping']);

        // A time under a block is made, and counted.
        $this->assertSame(200, $this->doctorAction(BlockAvailabilityAction::class, $this->userA, [], ['date' => $date, 'start' => '11:00', 'end' => '12:00', 'tz' => self::CHICAGO])['status']);
        $blocked = $this->add(['date' => $date, 'start' => '11:00', 'end' => '12:00', 'duration' => 30, 'tz' => self::CHICAGO]);
        $this->assertSame(2, $blocked['body']['data']['created']);
        $this->assertSame(2, $blocked['body']['data']['blocked']);
        $this->assertSame('none', $blocked['body']['data']['repeat']);
        $this->assertNull($blocked['body']['data']['series_id']);
    }

    public function testTwoParallelPostsMakeNoDuplicates(): void
    {
        $date    = $this->day(4);
        $blocker = $this->container()->get(EntityManagerInterface::class);
        $blocker->getConnection()->beginTransaction();
        (new SlotLock($blocker))->lockDoctor($this->A); // as a booking committing would

        $app     = 'avail_race_' . bin2hex(random_bytes(3));
        $job     = ['op' => 'doctor_action', 'class' => AddAvailabilityAction::class, 'user_id' => $this->userA, 'body' => $this->series($date), 'schema' => self::$schema, 'app' => $app];
        $workers = [DocShareHarness::startWorker($job), DocShareHarness::startWorker($job)];
        try {
            DocShareHarness::awaitLockWaiters($this->em(), $app, 2);
        } finally {
            $blocker->getConnection()->commit();
        }
        $results = array_map(static fn (array $w): array => DocShareHarness::finishWorker($w), $workers);
        $created = array_map(static fn (array $r): int => (int) ($r['result']['body']['data']['created'] ?? -1), $results);
        sort($created);
        $this->assertSame([0, 14], $created, json_encode($results));
        $this->assertSame(14, $this->slotCount(), 'no duplicates');
        $this->assertSame(0, $this->countRows('SELECT COUNT(*) FROM (SELECT starts_at FROM availability_slots WHERE specialist_id = ? GROUP BY starts_at HAVING COUNT(*) > 1) d', [$this->A]));
    }

    public function testThisAndLaterTimesWaitsForACommittingBookingAndKeepsIt(): void
    {
        $date = $this->day(5);
        $res  = $this->add($this->series($date));
        $this->assertSame(14, $res['body']['data']['created']);
        $rows = $this->rows($date, BookingFrame::addDays($date, 6));
        $this->assertCount(14, $rows);

        // A booking of the 3rd time is committing (it holds the doctor's slot lock)…
        $em = $this->container()->get(EntityManagerInterface::class);
        $em->getConnection()->beginTransaction();
        (new SlotLock($em))->lockDoctor($this->A);
        $booking = new Appointment($this->patient($em, $this->Q), $this->doctor($em, $this->A), new DateTimeImmutable((string) $rows[2]['starts_at']), ConsultationType::VIDEO);
        $booking->transitionTo(AppointmentStatus::CONFIRMED, true);
        $em->persist($booking);
        $em->flush();

        // …while the doctor removes "this and later times" from the 2nd.
        $app    = 'avail_del_' . bin2hex(random_bytes(3));
        $worker = DocShareHarness::startWorker([
            'op' => 'doctor_action', 'class' => DeleteAvailabilityAction::class, 'user_id' => $this->userA, 'method' => 'DELETE',
            'query' => ['scope' => 'following', 'tz' => self::CHICAGO], 'args' => ['id' => (string) $rows[1]['id']],
            'schema' => self::$schema, 'app' => $app,
        ]);
        try {
            DocShareHarness::awaitLockWaiters($this->em(), $app, 1);
        } finally {
            $em->getConnection()->commit();
        }
        $result = DocShareHarness::finishWorker($worker);
        $this->assertSame(200, $result['result']['status'] ?? null, json_encode($result));
        $this->assertSame(['deleted' => 12, 'kept_booked' => 1], $result['result']['body']['data']);
        $this->assertSame('12 times removed', $result['result']['body']['message']);

        $left = array_column($this->rows($date, BookingFrame::addDays($date, 6)), 'id');
        $this->assertEqualsCanonicalizing([(string) $rows[0]['id'], (string) $rows[2]['id']], $left, 'the earlier time and the booked one stay');
    }

    public function testOneKeepsTheBookedRefusalAndFollowingOnlyTouchesItsSeries(): void
    {
        $date  = $this->day(6);
        $s1    = $this->add($this->series($date, ['weeks' => 1]));
        $other = $this->add(['date' => $date, 'start' => '13:00', 'end' => '14:00', 'duration' => 30, 'repeat' => 'weekly', 'weeks' => 2, 'tz' => self::CHICAGO]);
        $this->assertSame(2 * 2, $other['body']['data']['created']);
        $rows  = $this->rows($date, BookingFrame::addDays($date, 13));
        $mine  = array_values(array_filter($rows, static fn (array $r): bool => $r['series_id'] === $s1['body']['data']['series_id']));
        $this->book((string) $mine[0]['starts_at']);

        $one = $this->get(DeleteAvailabilityAction::class, ['tz' => self::CHICAGO], ['id' => (string) $mine[0]['id']], 'DELETE');
        $this->assertSame(409, $one['status']);
        $this->assertSame('This slot is booked — decline the appointment first', $one['body']['message']);

        $following = $this->get(DeleteAvailabilityAction::class, ['scope' => 'following', 'tz' => self::CHICAGO], ['id' => (string) $mine[0]['id']], 'DELETE');
        $this->assertSame(['deleted' => 13, 'kept_booked' => 1], $following['body']['data']);
        $this->assertSame(4 + 1, $this->slotCount(), 'the other series is untouched');

        $bad = $this->get(DeleteAvailabilityAction::class, ['scope' => 'all'], ['id' => (string) $mine[0]['id']], 'DELETE');
        $this->assertSame(422, $bad['status']);
    }

    public function testAStaleZoneIsRefusedBeforeAnythingIsWritten(): void
    {
        $date = $this->day(3);
        $this->assertSame(200, $this->add($this->series($date, ['repeat' => 'none']))['status']);
        $before = $this->slotCount();
        $id     = (string) $this->rows($date, $date)[0]['id'];
        $stale  = [
            $this->add($this->series($date, ['tz' => 'Africa/Lagos'])),
            $this->doctorAction(BlockAvailabilityAction::class, $this->userA, [], ['date' => $date, 'entire_day' => true, 'tz' => 'Africa/Lagos']),
            $this->get(ListAvailabilityAction::class, ['tz' => 'Africa/Lagos']),
            $this->get(DeleteAvailabilityAction::class, ['tz' => 'Africa/Lagos'], ['id' => $id], 'DELETE'),
        ];
        foreach ($stale as $i => $res) {
            $this->assertSame(409, $res['status'], "#{$i} " . json_encode($res['body']));
            $this->assertSame('Your time zone was changed. Reload to continue.', $res['body']['message']);
            $this->assertSame(['code' => 'timezone_changed', 'timezone' => self::CHICAGO], $res['body']['errors']);
        }
        $this->assertSame($before, $this->slotCount(), 'nothing written or removed');

        $bad = $this->add($this->series($date, ['tz' => '+01:00']));
        $this->assertSame(422, $bad['status']);
        $this->assertSame(['tz' => 'Choose a time zone from the list'], $bad['body']['errors']);
    }

    public function testAZoneChangeCommittedWhileAWriteWaitedForTheLockRefusesIt(): void
    {
        $date = $this->day(3);
        // Each write's request has loaded the doctor (Chicago) and passed the zone check…
        $add   = $this->container();
        $block = $this->container();
        foreach ([$add, $block] as $c) {
            $c->get(EntityManagerInterface::class)->find(Specialist::class, $this->A);
        }
        // …when a change to Lagos commits, before either takes the slot lock.
        $this->conn()->executeStatement("UPDATE specialists SET timezone = 'Africa/Lagos', timezone_source = 'manual' WHERE id = ?", [$this->A]);

        $stale = [
            'add'   => $this->actIn($add, AddAvailabilityAction::class, $this->series($date)),
            'block' => $this->actIn($block, BlockAvailabilityAction::class, ['date' => $date, 'start' => '11:00', 'end' => '12:00', 'tz' => self::CHICAGO]),
        ];
        foreach ($stale as $what => $res) {
            $this->assertSame(409, $res['status'], $what . ' ' . json_encode($res['body']));
            $this->assertSame('Your time zone was changed. Reload to continue.', $res['body']['message']);
            $this->assertSame(['code' => 'timezone_changed', 'timezone' => 'Africa/Lagos'], $res['body']['errors'], $what);
        }
        $this->assertSame(0, $this->slotCount(), 'nothing written');
    }

    public function testATimeRangeInsideTheSpringForwardGapIsRefusedAsARange(): void
    {
        // The next night Chicago springs forward (02:00 → 03:00 CDT), within the horizon.
        $chicago = new DateTimeZone(self::CHICAGO);
        $now     = new DateTimeImmutable();
        $gapDay  = null;
        foreach ($chicago->getTransitions($now->getTimestamp(), $now->modify('+400 days')->getTimestamp()) as $i => $t) {
            if ($i > 0 && $t['isdst']) {
                $gapDay = (new DateTimeImmutable('@' . $t['ts']))->setTimezone($chicago)->format('Y-m-d');
                break;
            }
        }
        $this->assertNotNull($gapDay);
        $ahead = BookingFrame::daysBetween($this->day(0), $gapDay);
        if ($ahead < 1 || $ahead > 365) {
            $this->markTestSkipped('The next spring-forward night is today or beyond the 12-month horizon');
        }

        // A block from 02:30 (rolls forward to 03:30) to 03:00 would end before it starts.
        $block = $this->doctorAction(BlockAvailabilityAction::class, $this->userA, [], ['date' => $gapDay, 'start' => '02:30', 'end' => '03:00', 'tz' => self::CHICAGO]);
        $this->assertSame(422, $block['status'], json_encode($block['body']));
        $this->assertSame(['end' => 'End time must be after the start time'], $block['body']['errors']);

        // One day's 02:00–03:00 holds no time at all: said about the range, not the days.
        $add = $this->add(['date' => $gapDay, 'start' => '02:00', 'end' => '03:00', 'duration' => 30, 'tz' => self::CHICAGO]);
        $this->assertSame(422, $add['status'], json_encode($add['body']));
        $this->assertSame(['end' => 'The time range must fit at least one 30-minute slot'], $add['body']['errors']);
        $this->assertSame(0, $this->slotCount());

        // A span reaching past the gap is fine: 03:30–04:00 CDT.
        $ok = $this->doctorAction(BlockAvailabilityAction::class, $this->userA, [], ['date' => $gapDay, 'start' => '02:30', 'end' => '04:00', 'tz' => self::CHICAGO]);
        $this->assertSame(200, $ok['status'], json_encode($ok['body']));
        $this->assertSame(1800, (new DateTimeImmutable((string) $ok['body']['data']['ends_at']))->getTimestamp() - (new DateTimeImmutable((string) $ok['body']['data']['starts_at']))->getTimestamp());
    }

    /** @param array<string,mixed> $body @return array{status:int, body:array<string,mixed>} */
    private function actIn(Container $c, string $class, array $body): array
    {
        $request = (new ServerRequestFactory())->createServerRequest('POST', '/api/test')
            ->withAttribute('user_id', $this->userA)
            ->withAttribute('user_roles', ['doctor'])
            ->withParsedBody($body);

        return $this->decode($c->get($class)($request, new Response(), []));
    }

    public function testNothingBeyondTwelveMonths(): void
    {
        $tooFar = $this->add($this->series($this->day(366), ['repeat' => 'none']));
        $this->assertSame(422, $tooFar['status']);
        $this->assertSame(['date' => 'Choose a date within the next 12 months'], $tooFar['body']['errors']);

        // Day 360, weekly for 2 weeks: the second time is day 367.
        $passes = $this->add($this->series($this->day(360), ['repeat' => 'weekly', 'weeks' => 2]));
        $this->assertSame(422, $passes['status']);
        $this->assertSame(['date' => 'Choose a date within the next 12 months'], $passes['body']['errors']);

        $block = $this->doctorAction(BlockAvailabilityAction::class, $this->userA, [], ['date' => $this->day(366), 'entire_day' => true, 'tz' => self::CHICAGO]);
        $this->assertSame(422, $block['status']);
        $this->assertSame(0, $this->slotCount());

        $this->assertSame(200, $this->add($this->series($this->day(365), ['repeat' => 'none']))['status'], 'day 365 itself is fine');

        $many = $this->add(['date' => $this->day(2), 'start' => '07:00', 'end' => '21:00', 'duration' => 15, 'repeat' => 'daily', 'weeks' => 26, 'tz' => self::CHICAGO]);
        $this->assertSame(422, $many['status']);
        $this->assertStringStartsWith('That adds 10,192 times', (string) $many['body']['errors']['end']);
    }

    public function testATimeCanRunToMidnight(): void
    {
        $date = $this->day(7);
        $next = (new DateTimeImmutable(BookingFrame::addDays($date, 1) . ' 00:00', new DateTimeZone(self::CHICAGO)))->getTimestamp();
        foreach (['24:00', '00:00'] as $i => $end) {
            $day = BookingFrame::addDays($date, $i * 2);
            $res = $this->add(['date' => $day, 'start' => '22:00', 'end' => $end, 'duration' => 60, 'tz' => self::CHICAGO]);
            $this->assertSame(200, $res['status'], json_encode($res['body']));
            $this->assertSame(2, $res['body']['data']['created'], $end);
        }
        $rows = $this->rows($date, $date);
        $this->assertSame($next, (new DateTimeImmutable((string) end($rows)['ends_at']))->getTimestamp(), 'the last ends at the next local midnight');

        $bad = $this->add(['date' => $date, 'start' => '22:00', 'end' => '24:30', 'duration' => 30, 'tz' => self::CHICAGO]);
        $this->assertSame(422, $bad['status']);
        $this->assertArrayHasKey('end', $bad['body']['errors']);

        $span = $this->doctorAction(BlockAvailabilityAction::class, $this->userA, [], ['date' => BookingFrame::addDays($date, 5), 'start' => '20:00', 'end' => '24:00', 'tz' => self::CHICAGO]);
        $this->assertSame(200, $span['status'], json_encode($span['body']));
        $this->assertFalse($span['body']['data']['entire_day']);
    }

    public function testWithoutTzTheLegacyUtcContractHolds(): void
    {
        $date = $this->day(3, 'UTC');
        $res  = $this->add(['date' => $date, 'start' => '09:00', 'end' => '10:00', 'duration' => 30, 'recurring' => true, 'weeks' => 2]);
        $this->assertSame(200, $res['status'], json_encode($res['body']));
        $this->assertSame(4, $res['body']['data']['created'], 'weekly × 2');
        $this->assertSame('UTC', $res['body']['data']['tz']);
        $this->assertSame('weekly', $res['body']['data']['repeat']);
        $this->assertSame($date . 'T09:00:00+00:00', (new DateTimeImmutable((string) $res['body']['data']['first_at']))->format(DATE_ATOM), '09:00 UTC, whatever the doctor\'s zone');

        $legacyList = $this->get(ListAvailabilityAction::class, ['from' => $date, 'to' => $date]);
        $this->assertSame(200, $legacyList['status']);
        $this->assertArrayNotHasKey('tz', $legacyList['body']['data'], 'an old editor never sees the zone contract');
        $this->assertSame($date . 'T09:00:00+00:00', $legacyList['body']['data']['slots'][0]['starts_at']);

        $block = $this->doctorAction(BlockAvailabilityAction::class, $this->userA, [], ['date' => $date, 'entire_day' => true]);
        $this->assertSame($date . 'T00:00:00+00:00', $block['body']['data']['starts_at'], 'a UTC day');

        // The legacy contract keeps the strict 00:00–23:59 end.
        $this->assertSame(422, $this->add(['date' => $date, 'start' => '22:00', 'end' => '24:00', 'duration' => 30])['status']);
    }

    public function testTheZoneContractListing(): void
    {
        $date = $this->day(3);
        $this->add($this->series($date, ['weeks' => 1]));
        $res = $this->get(ListAvailabilityAction::class, ['from' => $date, 'to' => $date, 'tz' => self::CHICAGO]);
        $this->assertSame(self::CHICAGO, $res['body']['data']['tz']);
        $this->assertSame($date, $res['body']['data']['from']);
        $this->assertNull($res['body']['data']['regular_hours_source'], 'no own hours and publishing times: no weekday default either');
        $this->assertNull($res['body']['data']['regular_hours']);

        $this->conn()->executeStatement('UPDATE specialists SET weekly_hours = ? WHERE id = ?', [json_encode(['1' => [['09:00', '17:00']]]), $this->A]);
        $own = $this->get(ListAvailabilityAction::class, ['from' => $date, 'to' => $date, 'tz' => self::CHICAGO]);
        $this->assertSame('own', $own['body']['data']['regular_hours_source']);
        $this->assertSame(['1' => [['09:00', '17:00']]], $own['body']['data']['regular_hours']);

        // A doctor publishing nothing in the booking window gets the labelled weekday default.
        $this->conn()->executeStatement('DELETE FROM availability_slots WHERE specialist_id = ?', [$this->A]);
        $this->conn()->executeStatement('UPDATE specialists SET weekly_hours = NULL WHERE id = ?', [$this->A]);
        $default = $this->get(ListAvailabilityAction::class, ['from' => $date, 'to' => $date, 'tz' => self::CHICAGO]);
        $this->assertSame('default', $default['body']['data']['regular_hours_source']);
        $this->assertSame([['09:00', '17:00']], $default['body']['data']['regular_hours']['1']);
    }
}
