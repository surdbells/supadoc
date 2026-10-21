<?php

declare(strict_types=1);

namespace App\Tests\Integration\Card;

use App\Action\Appointment\CreateAppointmentAction;
use App\Action\Appointment\CreateMyAppointmentAction;
use App\Action\Appointment\ReschedulePortalAppointmentAction;
use App\Domain\Entity\Appointment;
use App\Domain\Entity\PaymentIntent;
use App\Domain\Entity\Specialist;
use App\Domain\Exception\ValidationException;
use App\Domain\Settings\ClinicTime;
use App\Infrastructure\Persistence\ClockRepair;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use App\Infrastructure\Service\AvailabilityService;
use App\Infrastructure\Service\PaymentIntentService;
use App\Infrastructure\Service\SlotLock;
use DateTimeImmutable;
use DateTimeZone;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

/**
 * The clock fix, end to end on a PHP process that does NOT run on UTC (Asia/
 * Shanghai, like production's PRC): a booking's instant is stored on the
 * process clock and marked, reads back as the same instant, takes its slot
 * out of the calendar, and the patient's notices name it on the clinic's
 * clock. The actions run in-process (worker processes run on php.ini's zone).
 */
final class ProcessZoneBookingTest extends CardIntegrationTestCase
{
    private string $zone = 'UTC';

    protected function setUp(): void
    {
        $this->zone = date_default_timezone_get();
        date_default_timezone_set('Asia/Shanghai');
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

    /** @param array<string,mixed> $body @param array<string,string> $args @return array{status:int, body:array<string,mixed>} */
    private function call(string $class, array $body, array $attributes, array $args = []): array
    {
        $request = (new ServerRequestFactory())->createServerRequest('POST', '/api/test')->withParsedBody($body);
        foreach ($attributes as $name => $value) {
            $request = $request->withAttribute($name, $value);
        }
        try {
            $res = $this->app()->get($class)($request, (new ResponseFactory())->createResponse(), $args);
        } catch (ValidationException $e) {
            return ['status' => 422, 'body' => ['message' => $e->getMessage(), 'errors' => $e->getErrors()]];
        }

        return ['status' => $res->getStatusCode(), 'body' => (array) json_decode((string) $res->getBody(), true)];
    }

    /** @return array{status:int, body:array<string,mixed>} */
    private function book(string $patientId, Specialist $doctor, string $slot, string $reference = ''): array
    {
        return $this->call(
            CreateMyAppointmentAction::class,
            array_filter(['specialist_id' => $doctor->getId(), 'scheduled_at' => $slot, 'type' => 'video', 'payment_reference' => $reference]),
            ['customer_id' => $patientId],
        );
    }

    /** @return array{0:string, 1:?int} the stored naive start and its marker */
    private function stored(string $id): array
    {
        $row = $this->em()->getConnection()->fetchAssociative(
            "SELECT to_char(scheduled_at, 'YYYY-MM-DD HH24:MI:SS') AS at, scheduled_epoch FROM appointments WHERE id = ?",
            [$id],
        );
        $this->assertIsArray($row);

        return [(string) $row['at'], $row['scheduled_epoch'] === null ? null : (int) $row['scheduled_epoch']];
    }

    private function wall(string $iso): string
    {
        return (new DateTimeImmutable($iso))->setTimezone(new DateTimeZone('Asia/Shanghai'))->format('Y-m-d H:i:s');
    }

    private function clinicTime(string $iso): string
    {
        return (new DateTimeImmutable($iso))->setTimezone(ClinicTime::zone())->format('g:i A T');
    }

    /** @return list<string> the open times the patient calendar offers */
    private function offered(Specialist $doctor): array
    {
        $app    = $this->app();
        $fresh  = $app->get(\Doctrine\ORM\EntityManagerInterface::class)->find(Specialist::class, $doctor->getId());
        $times  = [];
        foreach ($app->get(AvailabilityService::class)->availableDays($fresh, 3) as $day) {
            foreach ($day['slots'] as $slot) {
                $times[] = (new DateTimeImmutable($slot['iso']))->getTimestamp();
            }
        }

        return array_map(static fn (int $ts): string => (string) $ts, $times);
    }

    public function testAPatientBookingIsStoredOnTheProcessClockAndReadsBackAsTheSameInstant(): void
    {
        [$patientId, $doctor, $slots] = $this->patientAndDoctor('10000.00');
        $this->fundWallet($patientId, '30000.00');
        $instant = (new DateTimeImmutable($slots[0]))->getTimestamp();

        $res = $this->book($patientId, $doctor, $slots[0]);
        $this->assertSame(201, $res['status'], json_encode($res));
        $id = (string) $res['body']['data']['id'];

        [$at, $epoch] = $this->stored($id);
        $this->assertSame($this->wall($slots[0]), $at, 'the Shanghai wall-clock of the slot');
        $this->assertSame($instant, $epoch, 'marked with the instant');
        $fresh = $this->em()->find(Appointment::class, $id);
        $this->assertNotNull($fresh);
        $this->assertSame($instant, $fresh->getScheduledAt()->getTimestamp(), 'reads back as the same instant');
        $this->assertSame($instant, (new DateTimeImmutable((string) $res['body']['data']['scheduled_at']))->getTimestamp());

        $bodies = $this->em()->getConnection()->fetchFirstColumn('SELECT body FROM notifications WHERE patient_id = ?', [$patientId]);
        $this->assertNotEmpty(array_filter($bodies, fn (string $b): bool => str_contains($b, $this->clinicTime($slots[0]))), 'the notice names the clinic-clock time');

        $this->assertNotContains((string) $instant, $this->offered($doctor), 'the booked time is no longer offered');

        // Another patient, the same instant: refused.
        $other = $this->book($this->anotherPatient(), $doctor, $slots[0]);
        $this->assertContains($other['status'], [409, 422], json_encode($other));
        $message = json_encode($other['body']);
        $this->assertTrue(str_contains((string) $message, 'no longer available') || str_contains((string) $message, json_encode(SlotLock::TAKEN) ?: SlotLock::TAKEN), (string) $message);
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM appointments WHERE specialist_id = ? AND status IN ('pending','confirmed','rescheduled')", [$doctor->getId()]));
    }

    public function testARescheduleIsStoredOnTheProcessClockAndTheNoticesUseTheClinicClock(): void
    {
        [$patientId, $doctor, $slots] = $this->patientAndDoctor('10000.00');
        $this->fundWallet($patientId, '30000.00');
        $booked = $this->book($patientId, $doctor, $slots[0]);
        $this->assertSame(201, $booked['status'], json_encode($booked));
        $id = (string) $booked['body']['data']['id'];

        $res = $this->call(ReschedulePortalAppointmentAction::class, ['scheduled_at' => $slots[1]], ['customer_id' => $patientId], ['id' => $id]);
        $this->assertSame(200, $res['status'], json_encode($res));
        $this->assertSame([$this->wall($slots[1]), (new DateTimeImmutable($slots[1]))->getTimestamp()], $this->stored($id));
        $this->assertContains((string) (new DateTimeImmutable($slots[0]))->getTimestamp(), $this->offered($doctor), 'the old time is offered again');

        $bodies = $this->em()->getConnection()->fetchFirstColumn('SELECT body FROM notifications WHERE patient_id = ?', [$patientId]);
        $timed  = array_values(array_filter($bodies, static fn (string $b): bool => preg_match('/\d{1,2}:\d{2} (AM|PM)/', $b) === 1));
        $this->assertGreaterThanOrEqual(2, count($timed), 'the booking and the reschedule notices');
        foreach ($timed as $body) {
            $this->assertStringNotContainsString(' UTC', $body);
            $this->assertTrue(
                str_contains($body, $this->clinicTime($slots[0])) || str_contains($body, $this->clinicTime($slots[1])),
                'names the clinic-clock time of the instant',
            );
        }
        $this->assertNotEmpty(array_filter($timed, fn (string $b): bool => str_contains($b, $this->clinicTime($slots[1]))));
    }

    public function testABackOfficeBookingStoresTheInstantSent(): void
    {
        [$patientId, $doctor, $slots] = $this->patientAndDoctor('10000.00');
        $iso = (new DateTimeImmutable($slots[2]))->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d\TH:i:s.000\Z'); // toISOString()

        $res = $this->call(CreateAppointmentAction::class, ['patient_id' => $patientId, 'specialist_id' => $doctor->getId(), 'scheduled_at' => $iso], []);
        $this->assertSame(201, $res['status'], json_encode($res));
        [$at, $epoch] = $this->stored((string) $res['body']['data']['id']);
        $this->assertSame($this->wall($slots[2]), $at);
        $this->assertSame((new DateTimeImmutable($iso))->getTimestamp(), $epoch);
    }

    public function testARepeatedCardBookingIsMatchedByItsInstantOnly(): void
    {
        [$patientId, $doctor, $slots] = $this->patientAndDoctor('10000.00');
        // Open all day (UTC), so the time 8 hours later is bookable too.
        $em    = $this->em();
        $fresh = $em->find(Specialist::class, $doctor->getId());
        $this->assertNotNull($fresh);
        $fresh->setWeeklyHours(array_fill_keys(['0', '1', '2', '3', '4', '5', '6'], [['00:00', '23:30']]));
        $em->flush();
        $slot = null;
        foreach ($slots as $candidate) {
            $hour = (int) (new DateTimeImmutable($candidate))->setTimezone(new DateTimeZone('UTC'))->format('G');
            if ($hour >= 1 && $hour <= 14) {
                $slot = $candidate;
                break;
            }
        }
        $this->assertNotNull($slot);
        $ref = $this->checkout($patientId, PaymentIntent::PURPOSE_BOOKING, ['specialist_id' => $doctor->getId()], '10000.00', '10000.00')->getReference();

        $first = $this->book($patientId, $doctor, $slot, $ref);
        $this->assertSame(201, $first['status'], json_encode($first));
        $again = $this->book($patientId, $doctor, $slot, $ref);
        $this->assertSame(200, $again['status'], json_encode($again));
        $this->assertSame($first['body']['data']['id'], $again['body']['data']['id'], 'the same booking');

        // The same reference, 8 hours later (the old wall-clock fallback would have matched it).
        $later = (new DateTimeImmutable($slot))->modify('+8 hours')->setTimezone(new DateTimeZone('UTC'))->format(DATE_ATOM);
        $moved = $this->book($patientId, $doctor, $later, $ref);
        $this->assertSame(422, $moved['status'], json_encode($moved));
        $this->assertArrayNotHasKey('data', $moved['body']);
        $this->assertSame(PaymentIntentService::ALREADY_USED, $moved['body']['errors']['payment'] ?? null, json_encode($moved));
        $this->assertSame(1, $this->countRows('SELECT COUNT(*) FROM appointments WHERE payment_reference = ?', [$ref]));
    }
}
