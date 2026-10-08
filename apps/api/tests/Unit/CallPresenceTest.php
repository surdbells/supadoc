<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Entity\Appointment;
use App\Domain\Entity\Patient;
use App\Domain\Entity\Specialist;
use App\Domain\Enum\AppointmentStatus;
use App\Infrastructure\Service\CallPresence;
use DateTimeImmutable;
use PHPUnit\Framework\TestCase;
use Predis\Client as RedisClient;
use Predis\Response\Status;
use Psr\Log\LoggerInterface;

/** "In the call" presence: heartbeats, leaving, expiry, the live sets, and Redis being down. */
final class CallPresenceTest extends TestCase
{
    private Patient $patient;
    private Specialist $doctor;
    /** The in-memory fake from fakeRedis(). */
    private RedisClient $redis;
    private CallPresence $presence;

    protected function setUp(): void
    {
        $this->patient  = new Patient('ada@example.test', 'Ada', 'Obi');
        $this->doctor   = new Specialist('Dr. Grace Bell', 'General Practice');
        $this->redis    = $this->fakeRedis();
        $this->presence = new CallPresence($this->redis);
    }

    private function appointment(): Appointment
    {
        return new Appointment($this->patient, $this->doctor, new DateTimeImmutable('+1 hour'));
    }

    private function heartbeatKey(Appointment $appointment, string $role): string
    {
        return "call:presence:{$appointment->getId()}:$role";
    }

    private function patientSet(): string
    {
        return 'call:live:patient:' . $this->patient->getId();
    }

    private function doctorSet(): string
    {
        return 'call:live:doctor:' . $this->doctor->getId();
    }

    public function testPatientHeartbeatShowsOnBothSides(): void
    {
        $appointment = $this->appointment();
        $this->presence->mark($appointment, 'patient');

        $expected = [$appointment->getId() => ['doctor' => false, 'patient' => true]];
        $this->assertSame($expected, $this->presence->forPatient($this->patient->getId()));
        $this->assertSame($expected, $this->presence->forSpecialist($this->doctor->getId()));
        $this->assertSame(CallPresence::TTL, $this->redis->ttls[$this->heartbeatKey($appointment, 'patient')], 'present until the heartbeat is TTL seconds old');
        $this->assertSame([], $this->presence->forPatient('someone-else'));
    }

    public function testDoctorAndPatientTogether(): void
    {
        $appointment = $this->appointment();
        $this->presence->mark($appointment, 'doctor');
        $this->presence->mark($appointment, 'patient');
        $this->presence->mark($appointment, 'patient'); // a repeat heartbeat changes nothing

        $expected = [$appointment->getId() => ['doctor' => true, 'patient' => true]];
        $this->assertSame($expected, $this->presence->forPatient($this->patient->getId()));
        $this->assertSame($expected, $this->presence->forSpecialist($this->doctor->getId()));
        $this->assertSame([$appointment->getId()], $this->redis->smembers($this->patientSet()), 'listed once');
    }

    public function testLeavingClearsThatParticipantAndTheLastOneOutDropsTheAppointment(): void
    {
        $appointment = $this->appointment();
        $this->presence->mark($appointment, 'patient');
        $this->presence->mark($appointment, 'doctor');

        $this->presence->clear($appointment, 'doctor');
        $this->assertSame(
            [$appointment->getId() => ['doctor' => false, 'patient' => true]],
            $this->presence->forSpecialist($this->doctor->getId()),
        );

        $this->presence->clear($appointment, 'patient');
        $this->assertSame([], $this->presence->forPatient($this->patient->getId()));
        $this->assertSame([], $this->presence->forSpecialist($this->doctor->getId()));
        $this->assertSame([], $this->redis->smembers($this->patientSet()));
        $this->assertSame([], $this->redis->smembers($this->doctorSet()));
    }

    public function testAnExpiredHeartbeatDropsOutOfTheLiveSet(): void
    {
        $gone = $this->appointment();
        $live = $this->appointment();
        $this->presence->mark($gone, 'patient');
        $this->presence->mark($live, 'doctor');

        // The fake never expires keys itself, so "TTL ran out" is a delete.
        $this->redis->del([$this->heartbeatKey($gone, 'patient')]);

        $expected = [$live->getId() => ['doctor' => true, 'patient' => false]];
        $this->assertSame($expected, $this->presence->forPatient($this->patient->getId()));
        $this->assertSame([$live->getId()], $this->redis->smembers($this->patientSet()), 'expired appointment is SREM\'d on read');
        // Each set is pruned when it is read, so the doctor's still lists it until then.
        $this->assertContains($gone->getId(), $this->redis->smembers($this->doctorSet()));
        $this->assertSame($expected, $this->presence->forSpecialist($this->doctor->getId()));
        $this->assertSame([$live->getId()], $this->redis->smembers($this->doctorSet()));
    }

    public function testFinishedAppointmentsAreNeverMarked(): void
    {
        $completed = $this->appointment();
        $completed->transitionTo(AppointmentStatus::CONFIRMED);
        $completed->transitionTo(AppointmentStatus::COMPLETED);
        $cancelled = $this->appointment();
        $cancelled->transitionTo(AppointmentStatus::CANCELLED);

        foreach ([$completed, $cancelled] as $appointment) {
            $this->presence->mark($appointment, 'patient');
            $this->presence->mark($appointment, 'doctor');
        }
        $this->assertSame([], $this->presence->forPatient($this->patient->getId()));
        $this->assertSame([], $this->presence->forSpecialist($this->doctor->getId()));
        $this->assertSame([], $this->redis->strings, 'nothing written');
        $this->assertSame([], $this->redis->sets);
    }

    public function testUnknownRolesAreIgnored(): void
    {
        $appointment = $this->appointment();
        $this->presence->mark($appointment, 'guest');
        $this->assertSame([], $this->redis->strings);
        $this->assertSame([], $this->redis->sets);

        $this->presence->mark($appointment, 'patient');
        $this->presence->clear($appointment, 'guest');
        $this->assertSame(
            [$appointment->getId() => ['doctor' => false, 'patient' => true]],
            $this->presence->forPatient($this->patient->getId()),
        );
    }

    public function testRedisFailuresAreSilentAndLoggedOnce(): void
    {
        $logger = $this->createMock(LoggerInterface::class);
        $logger->expects($this->once())->method('warning');
        $presence    = new CallPresence($this->brokenRedis(), $logger);
        $appointment = $this->appointment();

        // Neither throws — a call must never break because Redis is down.
        $presence->mark($appointment, 'patient');
        $presence->clear($appointment, 'doctor');
        $this->assertSame([], $presence->forPatient($this->patient->getId()));
        $this->assertSame([], $presence->forSpecialist($this->doctor->getId()));
    }

    /**
     * Just enough Redis for CallPresence, with Predis's reply shapes: MGET gives
     * null for a missing key, SMEMBERS a list of strings, and a set that loses
     * its last member is deleted. Predis\Client sends every command through
     * __call, so overriding it is the whole fake. TTLs are recorded, not enforced.
     */
    private function fakeRedis(): RedisClient
    {
        return new class extends RedisClient {
            /** @var array<string, string> */
            public array $strings = [];
            /** @var array<string, array<string, true>> */
            public array $sets = [];
            /** @var array<string, int> */
            public array $ttls = [];

            public function __construct()
            {
                // No connection: every command is answered in memory below.
            }

            public function __call($commandID, $arguments): mixed
            {
                $key = is_string($arguments[0] ?? null) ? $arguments[0] : '';
                // Predis takes a list either as one array or as trailing arguments.
                $list = static fn (array $args): array => array_map('strval', is_array($args[0] ?? null) ? $args[0] : $args);

                switch (strtolower((string) $commandID)) {
                    case 'setex':
                        $this->strings[$key] = (string) $arguments[2];
                        $this->ttls[$key]    = (int) $arguments[1];

                        return Status::get('OK');
                    case 'del':
                        $deleted = 0;
                        foreach ($list($arguments) as $k) {
                            $deleted += (int) (isset($this->strings[$k]) || isset($this->sets[$k]));
                            unset($this->strings[$k], $this->sets[$k], $this->ttls[$k]);
                        }

                        return $deleted;
                    case 'sadd':
                        $before = count($this->sets[$key] ?? []);
                        foreach ($list(array_slice($arguments, 1)) as $member) {
                            $this->sets[$key][$member] = true;
                        }

                        return count($this->sets[$key] ?? []) - $before;
                    case 'expire':
                        if (!isset($this->strings[$key]) && !isset($this->sets[$key])) {
                            return 0;
                        }
                        $this->ttls[$key] = (int) $arguments[1];

                        return 1;
                    case 'smembers':
                        return array_map('strval', array_keys($this->sets[$key] ?? []));
                    case 'mget':
                        return array_map(fn (string $k): ?string => $this->strings[$k] ?? null, $list($arguments));
                    case 'srem':
                        $removed = 0;
                        foreach ($list(array_slice($arguments, 1)) as $member) {
                            $removed += (int) isset($this->sets[$key][$member]);
                            unset($this->sets[$key][$member]);
                        }
                        if (($this->sets[$key] ?? null) === []) {
                            unset($this->sets[$key], $this->ttls[$key]);
                        }

                        return $removed;
                    default:
                        throw new \LogicException("The fake Redis does not support $commandID.");
                }
            }
        };
    }

    /** A Redis that is down: every command fails like a refused connection. */
    private function brokenRedis(): RedisClient
    {
        return new class extends RedisClient {
            public function __construct()
            {
            }

            public function __call($commandID, $arguments): mixed
            {
                throw new \RuntimeException('Connection refused [tcp://127.0.0.1:6379]');
            }
        };
    }
}
