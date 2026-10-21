<?php

declare(strict_types=1);

namespace App\Tests\Integration\DocumentSharing;

use App\Action\Appointment\AcceptFollowUpAction;
use App\Action\Doctor\AddAvailabilityAction;
use App\Action\Doctor\BlockAvailabilityAction;
use App\Action\Doctor\DeleteAvailabilityAction;
use App\Action\Doctor\ListAvailabilityAction;
use App\Action\Doctor\ProposeFollowUpAction;
use App\Action\Doctor\RescheduleDoctorAppointmentAction;
use App\Domain\Exception\ValidationException;
use App\Domain\Settings\ClinicTime;
use App\Infrastructure\Persistence\ClockRepair;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use DateTimeImmutable;
use DateTimeZone;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * The doctor's side of the clock fix on a PHP process that does NOT run on
 * UTC (Asia/Shanghai, like production's PRC): a reschedule, a follow-up
 * proposal and its moved acceptance store the instants sent; availability is
 * published from UTC wall-clock input, stored on the process clock (marked)
 * and listed back in UTC.
 */
final class ProcessZoneDoctorTest extends DocShareTestCase
{
    private string $zone = 'UTC';

    protected function setUp(): void
    {
        $this->zone = date_default_timezone_get();
        date_default_timezone_set('Asia/Shanghai'); // before the fixtures are made
        ClinicTime::configure('Africa/Lagos');
        ClockRepair::resetCache();
        parent::setUp();
    }

    protected function tearDown(): void
    {
        parent::tearDown();
        date_default_timezone_set($this->zone);
        ClockRepair::resetCache();
        DoctrineEntityManagerFactory::reset();
    }

    private function utcDay(int $days): string
    {
        return (new DateTimeImmutable('now', new DateTimeZone('UTC')))->modify('+' . $days . ' days')->format('Y-m-d');
    }

    private function wall(string $iso): string
    {
        return (new DateTimeImmutable($iso))->setTimezone(new DateTimeZone('Asia/Shanghai'))->format('Y-m-d H:i:s');
    }

    /** @return array{0:string, 1:?int} */
    private function stored(string $table, string $column, string $epochColumn, string $id): array
    {
        $row = $this->conn()->fetchAssociative(
            "SELECT to_char({$column}, 'YYYY-MM-DD HH24:MI:SS') AS at, {$epochColumn} AS epoch FROM {$table} WHERE id = ?",
            [$id],
        );
        $this->assertIsArray($row);

        return [(string) $row['at'], $row['epoch'] === null ? null : (int) $row['epoch']];
    }

    /** Publish doctor A's open slots on a UTC day. @return array<string,mixed> */
    private function publish(string $date, string $start, string $end): array
    {
        $res = $this->doctorAction(AddAvailabilityAction::class, $this->userA, [], ['date' => $date, 'start' => $start, 'end' => $end, 'duration' => 30]);
        $this->assertSame(200, $res['status'], json_encode($res['body']));

        return $res['body']['data'];
    }

    /** @return list<array<string,mixed>> doctor A's availability rows for [from, to] */
    private function listing(string $from, string $to): array
    {
        $request = (new ServerRequestFactory())->createServerRequest('GET', '/api/test')
            ->withAttribute('user_id', $this->userA)
            ->withAttribute('user_roles', ['doctor'])
            ->withQueryParams(['from' => $from, 'to' => $to]);
        $res = $this->decode($this->container()->get(ListAvailabilityAction::class)($request, new Response()));
        $this->assertSame(200, $res['status']);

        return $res['body']['data']['slots'];
    }

    public function testADoctorRescheduleStoresTheInstantSent(): void
    {
        $day = $this->utcDay(5);
        $this->publish($day, '10:00', '12:00');
        $target = $day . 'T10:00:00Z';

        $res = $this->doctorAction(RescheduleDoctorAppointmentAction::class, $this->userA, ['id' => $this->apNext], ['scheduled_at' => $target]);
        $this->assertSame(200, $res['status'], json_encode($res['body']));
        $this->assertSame([$this->wall($target), (new DateTimeImmutable($target))->getTimestamp()], $this->stored('appointments', 'scheduled_at', 'scheduled_epoch', $this->apNext));
        $this->assertSame((new DateTimeImmutable($target))->getTimestamp(), (new DateTimeImmutable((string) $res['body']['data']['scheduled_at']))->getTimestamp());

        // That slot is booked now: it can't be removed.
        $booked = null;
        foreach ($this->listing($day, $day) as $row) {
            if ($row['starts_at'] === $day . 'T10:00:00+00:00' && !str_starts_with((string) $row['id'], 'appt-')) {
                $booked = $row;
            }
        }
        $this->assertNotNull($booked, 'the published slot is listed');
        $this->assertSame('booked', $booked['status']);
        $delete = $this->doctorAction(DeleteAvailabilityAction::class, $this->userA, ['id' => (string) $booked['id']], [], [], 'DELETE');
        $this->assertSame(409, $delete['status'], json_encode($delete['body']));
    }

    public function testAProposalAndItsMovedAcceptanceStoreTheInstantsSent(): void
    {
        $day = $this->utcDay(5);
        $this->publish($day, '10:00', '12:00');
        $proposedAt = $day . 'T10:30:00Z';
        $acceptedAt = $day . 'T11:00:00Z';

        $proposed = $this->doctorAction(ProposeFollowUpAction::class, $this->userA, ['id' => $this->apPast], ['scheduled_at' => $proposedAt, 'waive_fee' => true]);
        $this->assertContains($proposed['status'], [200, 201], json_encode($proposed['body']));
        $proposalId = (string) $proposed['body']['data']['id'];
        $this->assertSame([$this->wall($proposedAt), (new DateTimeImmutable($proposedAt))->getTimestamp()], $this->stored('appointments', 'scheduled_at', 'scheduled_epoch', $proposalId));

        try {
            $accepted = $this->patientAction(AcceptFollowUpAction::class, $this->P, ['scheduled_at' => $acceptedAt], ['id' => $proposalId]);
        } catch (ValidationException $e) {
            $this->fail('refused: ' . json_encode($e->getErrors()));
        }
        $this->assertSame(200, $accepted['status'], json_encode($accepted['body']));
        $this->assertSame('confirmed', $accepted['body']['data']['status']);
        $this->assertSame([$this->wall($acceptedAt), (new DateTimeImmutable($acceptedAt))->getTimestamp()], $this->stored('appointments', 'scheduled_at', 'scheduled_epoch', $proposalId));
    }

    public function testAvailabilityIsStoredOnTheProcessClockAndListedInUtc(): void
    {
        $tomorrow = $this->utcDay(1);
        $created  = $this->publish($tomorrow, '22:00', '23:00');
        $this->assertSame(2, $created['created']);
        $ids = array_column($created['slots'], 'id');
        // Stored as the Shanghai wall-clock of 22:00Z / 22:30Z (06:00 / 06:30 the next day), marked.
        $this->assertSame([$this->wall($tomorrow . 'T22:00:00Z'), (new DateTimeImmutable($tomorrow . 'T22:00:00Z'))->getTimestamp()], $this->stored('availability_slots', 'starts_at', 'starts_epoch', (string) $ids[0]));
        $this->assertSame([$this->wall($tomorrow . 'T22:30:00Z'), (new DateTimeImmutable($tomorrow . 'T22:30:00Z'))->getTimestamp()], $this->stored('availability_slots', 'starts_at', 'starts_epoch', (string) $ids[1]));
        $this->assertSame([$this->wall($tomorrow . 'T23:00:00Z'), (new DateTimeImmutable($tomorrow . 'T22:30:00Z'))->getTimestamp()], $this->stored('availability_slots', 'ends_at', 'starts_epoch', (string) $ids[1]));

        $listed = array_values(array_filter($this->listing($tomorrow, $tomorrow), static fn (array $r): bool => !str_starts_with((string) $r['id'], 'appt-')));
        $this->assertSame([$tomorrow . 'T22:00:00+00:00', $tomorrow . 'T22:30:00+00:00'], array_column($listed, 'starts_at'), 'UTC, in order, on their UTC day');
        $this->assertSame([$tomorrow . 'T22:30:00+00:00', $tomorrow . 'T23:00:00+00:00'], array_column($listed, 'ends_at'));

        $this->assertSame(0, $this->publish($tomorrow, '22:00', '23:00')['created'], 'adding them again is a no-op');

        $blockDay = $this->utcDay(6);
        $block    = $this->doctorAction(BlockAvailabilityAction::class, $this->userA, [], ['date' => $blockDay, 'entire_day' => true]);
        $this->assertSame(200, $block['status'], json_encode($block['body']));
        $blockId = (string) $block['body']['data']['id'];
        $this->assertSame([$this->wall($blockDay . 'T00:00:00Z'), (new DateTimeImmutable($blockDay . 'T00:00:00Z'))->getTimestamp()], $this->stored('availability_slots', 'starts_at', 'starts_epoch', $blockId));
        $next = (new DateTimeImmutable($blockDay . 'T00:00:00Z'))->modify('+1 day');
        $this->assertSame($this->wall($next->format(DATE_ATOM)), $this->stored('availability_slots', 'ends_at', 'starts_epoch', $blockId)[0]);
        $rows = array_values(array_filter($this->listing($blockDay, $blockDay), static fn (array $r): bool => $r['id'] === $blockId));
        $this->assertCount(1, $rows);
        $this->assertSame($blockDay . 'T00:00:00+00:00', $rows[0]['starts_at']);
        $this->assertSame($next->format('Y-m-d') . 'T00:00:00+00:00', $rows[0]['ends_at']);
        $this->assertSame('blocked', $rows[0]['status']);
    }
}
