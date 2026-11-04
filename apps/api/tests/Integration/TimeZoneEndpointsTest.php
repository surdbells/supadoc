<?php

declare(strict_types=1);

namespace App\Tests\Integration;

use App\Action\Doctor\GetDoctorProfileAction;
use App\Action\Doctor\SetDoctorTimeZoneAction;
use App\Action\Patient\MyProfileAction;
use App\Action\Patient\SetMyTimeZoneAction;
use App\Domain\Entity\Appointment;
use App\Domain\Entity\AvailabilitySlot;
use App\Domain\Entity\Patient;
use App\Domain\Entity\Specialist;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Enum\ConsultationType;
use App\Domain\Enum\SlotKind;
use App\Domain\Settings\TimeZones;
use App\Tests\Integration\DocumentSharing\DocShareTestCase;
use DateTimeImmutable;
use DateTimeZone;
use DI\Container;
use Doctrine\ORM\EntityManagerInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * PUT /api/doctor/timezone and PUT /api/portal/me/timezone (spec §1.4): an
 * automatic detection writes only while nothing was ever set (and never a
 * UTC-like zone); a manual choice always writes and is audited; moving the
 * doctor's times keeps their wall clock, never moves a booked one, and judges
 * collisions against the new positions. A request re-reads the person under
 * the lock, so a change committed while it waited is where it starts from.
 */
final class TimeZoneEndpointsTest extends DocShareTestCase
{
    /** @param array<string,mixed> $body @return array{status:int, body:array<string,mixed>} */
    private function putDoctor(array $body, ?string $user = null): array
    {
        $res = $this->doctorAction(SetDoctorTimeZoneAction::class, $user ?? $this->userA, [], $body, [], 'PUT');
        unset($res['response']);

        return $res;
    }

    /** @return array{0:?string, 1:?string} the stored zone and source of a specialist */
    private function stored(string $specialistId): array
    {
        $row = $this->conn()->fetchAssociative('SELECT timezone, timezone_source FROM specialists WHERE id = ?', [$specialistId]);

        return [$row['timezone'] ?? null, $row['timezone_source'] ?? null];
    }

    private function slot(string $specialistId, string $startIso, int $minutes = 30, SlotKind $kind = SlotKind::OPEN): string
    {
        $em   = $this->em();
        $at   = new DateTimeImmutable($startIso);
        $slot = new AvailabilitySlot($this->doctor($em, $specialistId), $at, $at->modify('+' . $minutes . ' minutes'), $kind);
        $em->persist($slot);
        $em->flush();

        return $slot->getId();
    }

    /** @return array{0:int, 1:int, 2:?int} start, end (unix) and the start marker of a row */
    private function row(string $id): array
    {
        $r = $this->conn()->fetchAssociative('SELECT starts_at, ends_at, starts_epoch FROM availability_slots WHERE id = ?', [$id]);
        $this->assertIsArray($r);
        $zone = new DateTimeZone(date_default_timezone_get());

        return [
            (new DateTimeImmutable((string) $r['starts_at'], $zone))->getTimestamp(),
            (new DateTimeImmutable((string) $r['ends_at'], $zone))->getTimestamp(),
            $r['starts_epoch'] === null ? null : (int) $r['starts_epoch'],
        ];
    }

    private function bookAt(string $specialistId, string $iso): void
    {
        $em = $this->em();
        $a  = new Appointment($this->patient($em, $this->Q), $this->doctor($em, $specialistId), new DateTimeImmutable($iso), ConsultationType::VIDEO);
        $a->transitionTo(AppointmentStatus::CONFIRMED, true);
        $em->persist($a);
        $em->flush();
    }

    private function lagosTomorrow(): string
    {
        return (new DateTimeImmutable('now', new DateTimeZone('Africa/Lagos')))->modify('+1 day')->format('Y-m-d');
    }

    public function testAnAutoDetectionWritesOnlyWhileNothingWasSet(): void
    {
        $res = $this->putDoctor(['timezone' => 'America/Chicago', 'source' => 'auto']);
        $this->assertSame(200, $res['status'], json_encode($res['body']));
        $this->assertSame('Time zone saved', $res['body']['message']);
        $this->assertSame(['timezone' => 'America/Chicago', 'timezone_source' => 'auto', 'changed' => true, 'shifted' => null], $res['body']['data']);
        $this->assertSame(['America/Chicago', 'auto'], $this->stored($this->A));

        // A second device can't flip it.
        $again = $this->putDoctor(['timezone' => 'Europe/London', 'source' => 'auto']);
        $this->assertSame(200, $again['status']);
        $this->assertSame(['timezone' => 'America/Chicago', 'timezone_source' => 'auto', 'changed' => false, 'shifted' => null], $again['body']['data']);

        $profile = $this->doctorAction(GetDoctorProfileAction::class, $this->userA, [], [], [], 'GET');
        $this->assertSame('America/Chicago', $profile['body']['data']['timezone']);
        $this->assertSame('auto', $profile['body']['data']['timezone_source']);
    }

    public function testUtcLikeDetectionsAreNoOps(): void
    {
        foreach (['UTC', 'Etc/UTC', 'Atlantic/Reykjavik', 'GMT'] as $tz) {
            $res = $this->putDoctor(['timezone' => $tz, 'source' => 'auto']);
            $this->assertSame(200, $res['status'], $tz);
            $this->assertFalse($res['body']['data']['changed'], $tz);
            $this->assertSame('Africa/Lagos', $res['body']['data']['timezone'], 'still the clinic default');
            $this->assertNull($res['body']['data']['timezone_source']);
        }
        $this->assertSame([null, null], $this->stored($this->A));

        foreach ([['timezone' => '+01:00', 'source' => 'manual'], ['timezone' => 'Mars/Base', 'source' => 'auto'], ['source' => 'manual']] as $body) {
            $bad = $this->putDoctor($body);
            $this->assertSame(422, $bad['status']);
            $this->assertSame(['timezone' => 'Choose a time zone from the list'], $bad['body']['errors']);
        }
        $bad = $this->putDoctor(['timezone' => 'Africa/Lagos', 'source' => 'browser']);
        $this->assertSame(['source' => 'Unknown source'], $bad['body']['errors']);
    }

    public function testAManualChoiceWritesAndIsAudited(): void
    {
        $this->putDoctor(['timezone' => 'Africa/Lagos', 'source' => 'auto']);
        $res = $this->putDoctor(['timezone' => 'Europe/London', 'source' => 'manual']);
        $this->assertSame(200, $res['status'], json_encode($res['body']));
        $this->assertSame(['timezone' => 'Europe/London', 'timezone_source' => 'manual', 'changed' => true, 'shifted' => null], $res['body']['data']);

        $audit = $this->conn()->fetchAssociative("SELECT actor_role, resource_type, resource_id, metadata FROM audit_events WHERE action = 'doctor.timezone_changed'");
        $this->assertIsArray($audit);
        $this->assertSame('doctor', $audit['actor_role']);
        $this->assertSame('specialist', $audit['resource_type']);
        $this->assertSame(strtolower($this->A), strtolower((string) $audit['resource_id']));
        $this->assertSame(['from' => 'Africa/Lagos', 'to' => 'Europe/London', 'shifted' => 0], json_decode((string) $audit['metadata'], true));

        // The same zone again: written as manual, nothing changed, nothing audited.
        $same = $this->putDoctor(['timezone' => 'Europe/London', 'source' => 'manual', 'shift_slots' => true]);
        $this->assertSame(['timezone' => 'Europe/London', 'timezone_source' => 'manual', 'changed' => false, 'shifted' => null], $same['body']['data']);
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM audit_events WHERE action = 'doctor.timezone_changed'"));
    }

    public function testMovingTimesKeepsTheirWallClockButNeverABookedOne(): void
    {
        $day    = $this->lagosTomorrow();
        $lagos  = new DateTimeZone('Africa/Lagos');
        $open   = $this->slot($this->A, (new DateTimeImmutable($day . ' 09:00', $lagos))->format(DATE_ATOM));
        $booked = $this->slot($this->A, (new DateTimeImmutable($day . ' 11:00', $lagos))->format(DATE_ATOM));
        $this->bookAt($this->A, (new DateTimeImmutable($day . ' 11:00', $lagos))->format(DATE_ATOM));
        $bookedBefore = $this->row($booked);

        $res = $this->putDoctor(['timezone' => 'America/Chicago', 'source' => 'manual', 'shift_slots' => true]);
        $this->assertSame(200, $res['status'], json_encode($res['body']));
        $this->assertSame(['moved' => 1, 'skipped' => 0], $res['body']['data']['shifted']);

        [$start, $end, $epoch] = $this->row($open);
        $this->assertSame(TimeZones::wallToInstant($day, 540, new DateTimeZone('America/Chicago')), $start, '09:00 in Chicago now');
        $this->assertSame(1800, $end - $start);
        $this->assertSame($start, $epoch, 'the clock-repair marker follows the move');
        $this->assertSame($bookedBefore, $this->row($booked), 'a booked time never moves');
        $this->assertSame(1, json_decode((string) $this->conn()->fetchOne("SELECT metadata FROM audit_events WHERE action = 'doctor.timezone_changed'"), true)['shifted']);
    }

    public function testAWholeLagosDayMovesToChicagoWithoutCollisions(): void
    {
        // D5: 16 OPEN rows 09:00–16:30 WAT tomorrow → 09:00–16:30 Chicago. 15:00Z is the
        // current start of the 16:00 WAT row, but that row moves too: nothing collides.
        $day   = $this->lagosTomorrow();
        $lagos = new DateTimeZone('Africa/Lagos');
        $ids   = [];
        for ($m = 540; $m < 1020; $m += 30) {
            $ids[] = $this->slot($this->A, (new DateTimeImmutable('@' . TimeZones::wallToInstant($day, $m, $lagos)))->format(DATE_ATOM));
        }
        $block = $this->slot($this->A, (new DateTimeImmutable($day . ' 00:00', $lagos))->format(DATE_ATOM), 24 * 60, SlotKind::BLOCK);

        $res = $this->putDoctor(['timezone' => 'America/Chicago', 'source' => 'manual', 'shift_slots' => true]);
        $this->assertSame(['moved' => 17, 'skipped' => 0], $res['body']['data']['shifted'], json_encode($res['body']));

        $chicago = new DateTimeZone('America/Chicago');
        $local   = array_map(fn (string $id): string => (new DateTimeImmutable('@' . $this->row($id)[0]))->setTimezone($chicago)->format('Y-m-d H:i'), $ids);
        $this->assertSame($day . ' 09:00', $local[0]);
        $this->assertSame($day . ' 16:30', $local[15]);
        $this->assertCount(16, array_unique($local));
        [$bs, $be] = $this->row($block);
        $this->assertSame(TimeZones::localDayBounds($day, $chicago), [$bs, $be], 'an entire-day block covers the same local day');
    }

    public function testCollisionsAreJudgedAgainstTheNewPositions(): void
    {
        $day   = $this->lagosTomorrow();
        $lagos = new DateTimeZone('Africa/Lagos');
        // A booked row at the instant 09:00 WAT will become in Chicago (09:00 Chicago).
        $target = TimeZones::wallToInstant($day, 540, new DateTimeZone('America/Chicago'));
        $booked = $this->slot($this->A, (new DateTimeImmutable('@' . $target))->format(DATE_ATOM));
        $this->bookAt($this->A, (new DateTimeImmutable('@' . $target))->format(DATE_ATOM));
        $open = $this->slot($this->A, (new DateTimeImmutable($day . ' 09:00', $lagos))->format(DATE_ATOM));
        $before = $this->row($open);

        $res = $this->putDoctor(['timezone' => 'America/Chicago', 'source' => 'manual', 'shift_slots' => true]);
        $this->assertSame(['moved' => 0, 'skipped' => 1], $res['body']['data']['shifted'], json_encode($res['body']));
        $this->assertSame($before, $this->row($open), 'left where it was');
        $this->assertSame($target, $this->row($booked)[0]);
    }

    public function testAFallBackHourMovesOnlyTheEarlierOfTwoRows(): void
    {
        // Chicago's 01:30 happens twice on 2027-11-07 (CDT, then CST). Moving to Lagos,
        // both map to 01:30 WAT: the earlier original moves, the later stays.
        $this->conn()->executeStatement("UPDATE specialists SET timezone = 'America/Chicago', timezone_source = 'manual' WHERE id = ?", [$this->A]);
        $first  = $this->slot($this->A, '2027-11-07T06:30:00Z');
        $second = $this->slot($this->A, '2027-11-07T07:30:00Z');

        $res = $this->putDoctor(['timezone' => 'Africa/Lagos', 'source' => 'manual', 'shift_slots' => true]);
        $this->assertSame(['moved' => 1, 'skipped' => 1], $res['body']['data']['shifted'], json_encode($res['body']));
        $this->assertSame((new DateTimeImmutable('2027-11-07T00:30:00Z'))->getTimestamp(), $this->row($first)[0], '01:30 WAT');
        $this->assertSame((new DateTimeImmutable('2027-11-07T07:30:00Z'))->getTimestamp(), $this->row($second)[0]);
    }

    public function testASuspendedDoctorCanFixTheirZoneButNotMoveTimes(): void
    {
        $this->suspend($this->A, $this->now->modify('-1 hour'));
        $refused = $this->putDoctor(['timezone' => 'America/Chicago', 'source' => 'manual', 'shift_slots' => true]);
        $this->assertSame(422, $refused['status']);
        $this->assertSame(['shift_slots' => "Your account is suspended, so your open times can't be moved. Change the time zone without moving them."], $refused['body']['errors']);
        $this->assertSame([null, null], $this->stored($this->A), 'nothing written');

        $ok = $this->putDoctor(['timezone' => 'America/Chicago', 'source' => 'manual']);
        $this->assertSame(200, $ok['status'], json_encode($ok['body']));
        $this->assertSame(['America/Chicago', 'manual'], $this->stored($this->A));
    }

    // ----- Re-read under the lock: a change committed while a request waited -----

    /**
     * A "request" that has already loaded doctor A (its action's first step,
     * before the slot lock), to be run after another request commits.
     */
    private function loadedDoctorRequest(): Container
    {
        $c = $this->container();
        $c->get(EntityManagerInterface::class)->find(Specialist::class, $this->A);

        return $c;
    }

    /** @param array<string,mixed> $body @return array{status:int, body:array<string,mixed>} */
    private function putDoctorIn(Container $c, array $body): array
    {
        $request = (new ServerRequestFactory())->createServerRequest('PUT', '/api/test')
            ->withAttribute('user_id', $this->userA)
            ->withAttribute('user_roles', ['doctor'])
            ->withParsedBody($body);

        return $this->decode($c->get(SetDoctorTimeZoneAction::class)($request, new Response()));
    }

    public function testADoubleSubmittedSaveMovesTimesOnlyOnce(): void
    {
        $day  = (new DateTimeImmutable('now', new DateTimeZone('Africa/Lagos')))->modify('+2 days')->format('Y-m-d');
        $open = $this->slot($this->A, (new DateTimeImmutable('@' . TimeZones::wallToInstant($day, 540, new DateTimeZone('Africa/Lagos'))))->format(DATE_ATOM));
        $save = ['timezone' => 'America/Chicago', 'source' => 'manual', 'shift_slots' => true];

        $second = $this->loadedDoctorRequest();                 // the second click has read the doctor (Lagos)…
        $first  = $this->putDoctor($save);                      // …when the first commits
        $this->assertSame(['moved' => 1, 'skipped' => 0], $first['body']['data']['shifted'], json_encode($first['body']));
        $again = $this->putDoctorIn($second, $save);
        $this->assertSame(200, $again['status'], json_encode($again['body']));
        $this->assertSame(['timezone' => 'America/Chicago', 'timezone_source' => 'manual', 'changed' => false, 'shifted' => null], $again['body']['data']);

        $this->assertSame(TimeZones::wallToInstant($day, 540, new DateTimeZone('America/Chicago')), $this->row($open)[0], 'still 09:00 in Chicago, not moved twice');
        $audits = $this->conn()->fetchFirstColumn("SELECT CAST(metadata AS TEXT) FROM audit_events WHERE action = 'doctor.timezone_changed'");
        $this->assertSame([['from' => 'Africa/Lagos', 'to' => 'America/Chicago', 'shifted' => 1]], array_map(static fn (string $m): array => json_decode($m, true), $audits));
    }

    public function testAChangeStartsFromTheZoneCommittedWhileItWaited(): void
    {
        $day  = (new DateTimeImmutable('now', new DateTimeZone('Africa/Lagos')))->modify('+2 days')->format('Y-m-d');
        $open = $this->slot($this->A, (new DateTimeImmutable('@' . TimeZones::wallToInstant($day, 540, new DateTimeZone('Africa/Lagos'))))->format(DATE_ATOM));

        $chicago = $this->loadedDoctorRequest();               // read the doctor in Lagos…
        $this->putDoctor(['timezone' => 'Asia/Kolkata', 'source' => 'manual', 'shift_slots' => true]); // …Kolkata commits
        $res = $this->putDoctorIn($chicago, ['timezone' => 'America/Chicago', 'source' => 'manual', 'shift_slots' => true]);
        $this->assertSame(['moved' => 1, 'skipped' => 0], $res['body']['data']['shifted'], json_encode($res['body']));

        // 09:00 Lagos → 09:00 Kolkata (03:30Z) → 09:00 Chicago; starting from Lagos
        // again would read 03:30Z as 04:30 and move it to 04:30 Chicago.
        $this->assertSame(TimeZones::wallToInstant($day, 540, new DateTimeZone('America/Chicago')), $this->row($open)[0]);
        $audits  = $this->conn()->fetchFirstColumn("SELECT CAST(metadata AS TEXT) FROM audit_events WHERE action = 'doctor.timezone_changed'");
        $changes = array_map(static fn (string $m): string => json_decode($m, true)['from'] . ' > ' . json_decode($m, true)['to'], $audits);
        sort($changes);
        $this->assertSame(['Africa/Lagos > Asia/Kolkata', 'Asia/Kolkata > America/Chicago'], $changes, 'the audit names the zone it really changed from');
    }

    public function testADetectionNeverOverwritesAZoneChosenWhileItWaited(): void
    {
        $detect = $this->loadedDoctorRequest();               // read with no zone set…
        $this->putDoctor(['timezone' => 'Europe/London', 'source' => 'manual']); // …a choice commits
        $res = $this->putDoctorIn($detect, ['timezone' => 'America/New_York', 'source' => 'auto']);
        $this->assertSame(200, $res['status'], json_encode($res['body']));
        $this->assertSame(['timezone' => 'Europe/London', 'timezone_source' => 'manual', 'changed' => false, 'shifted' => null], $res['body']['data']);
        $this->assertSame(['Europe/London', 'manual'], $this->stored($this->A));
    }

    public function testAPatientDetectionNeverOverwritesAZoneChosenOnAnotherDevice(): void
    {
        $detect = $this->container();
        $detect->get(EntityManagerInterface::class)->find(Patient::class, $this->P); // read with no zone set…
        $this->patientAction(SetMyTimeZoneAction::class, $this->P, ['timezone' => 'Europe/London', 'source' => 'manual'], [], [], 'PUT'); // …a choice commits

        $request = (new ServerRequestFactory())->createServerRequest('PUT', '/api/test')
            ->withAttribute('customer_id', $this->P)
            ->withParsedBody(['timezone' => 'America/New_York', 'source' => 'auto']);
        $res = $this->decode($detect->get(SetMyTimeZoneAction::class)($request, new Response()));
        $this->assertSame(200, $res['status'], json_encode($res['body']));
        $this->assertSame(['timezone' => 'Europe/London', 'timezone_source' => 'manual', 'changed' => false], $res['body']['data']);
        $row = $this->conn()->fetchAssociative('SELECT timezone, timezone_source FROM patients WHERE id = ?', [$this->P]);
        $this->assertSame(['timezone' => 'Europe/London', 'timezone_source' => 'manual'], $row);
    }

    public function testThePatientEndpointFollowsTheSameRules(): void
    {
        $put = fn (array $body): array => $this->patientAction(SetMyTimeZoneAction::class, $this->P, $body, [], [], 'PUT');

        $this->assertSame(['timezone' => 'Africa/Lagos', 'timezone_source' => null, 'changed' => false], $put(['timezone' => 'UTC', 'source' => 'auto'])['body']['data']);
        $this->assertSame(['timezone' => 'America/New_York', 'timezone_source' => 'auto', 'changed' => true], $put(['timezone' => 'America/New_York', 'source' => 'auto'])['body']['data']);
        $this->assertSame(['timezone' => 'America/New_York', 'timezone_source' => 'auto', 'changed' => false], $put(['timezone' => 'Europe/London', 'source' => 'auto'])['body']['data']);
        $this->assertSame(['timezone' => 'Europe/London', 'timezone_source' => 'manual', 'changed' => true], $put(['timezone' => 'Europe/London', 'source' => 'manual'])['body']['data']);
        $this->assertSame(422, $put(['timezone' => '+01:00', 'source' => 'manual'])['status']);

        $me = $this->patientAction(MyProfileAction::class, $this->P, [], [], [], 'GET');
        $this->assertSame('Europe/London', $me['body']['data']['timezone']);
        $this->assertSame('manual', $me['body']['data']['timezone_source']);
    }
}
