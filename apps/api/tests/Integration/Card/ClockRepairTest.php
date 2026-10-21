<?php

declare(strict_types=1);

namespace App\Tests\Integration\Card;

use App\Domain\Document\DocumentSharingRules;
use App\Domain\Entity\Appointment;
use App\Domain\Entity\AvailabilitySlot;
use App\Domain\Entity\Patient;
use App\Domain\Entity\PaymentIntent;
use App\Domain\Entity\Specialist;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Enum\SlotKind;
use App\Domain\Repository\DocumentAccessGrantRepository;
use App\Domain\Settings\ClinicTime;
use App\Infrastructure\Persistence\ClockRepair;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use App\Infrastructure\Service\AuditLogger;
use App\Infrastructure\Service\FollowUpService;
use App\Tests\Integration\Card\Support\CardHarness;
use DateTimeImmutable;
use DateTimeZone;
use Doctrine\DBAL\Connection;

/**
 * prod-migrate step 13 (ClockRepair) against Postgres, on a PHP process zone
 * that is not UTC (Asia/Shanghai, like production's PRC). Legacy rows are
 * written as the old code stored them: the UTC wall-clock of the instant, no
 * marker; doctor proposals on the right clock (parseStart) with their audit row.
 */
final class ClockRepairTest extends CardIntegrationTestCase
{
    private const Z = 'Asia/Shanghai';

    private string $zone = 'UTC';
    private DateTimeImmutable $now;
    /** Five days ahead, 09:00 UTC. */
    private DateTimeImmutable $base;
    private ?Connection $db = null;

    protected function setUp(): void
    {
        $this->zone = date_default_timezone_get();
        date_default_timezone_set(self::Z);
        ClinicTime::configure('Africa/Lagos');
        ClockRepair::resetCache();
        parent::setUp();
        $this->db = null;
        $this->db()->executeStatement('TRUNCATE appointments, availability_slots, document_access_grants, audit_events, payment_intents CASCADE');
        $this->db()->executeStatement('DELETE FROM app_settings WHERE setting_key = ?', [ClockRepair::SETTING]);
        ClockRepair::resetCache();
        $this->now  = new DateTimeImmutable('@' . time());
        $this->base = (new DateTimeImmutable('now', new DateTimeZone('UTC')))->modify('+5 days')->setTime(9, 0);
    }

    protected function tearDown(): void
    {
        parent::tearDown();
        $this->db = null;
        date_default_timezone_set($this->zone);
        ClockRepair::resetCache();
        DoctrineEntityManagerFactory::reset();
    }

    // ----- Fixtures -----

    private function db(): Connection
    {
        return $this->db ??= $this->em('clock_it')->getConnection();
    }

    private function sql(DateTimeImmutable $at): string
    {
        return DocumentSharingRules::sql($at);
    }

    /** The UTC wall-clock of an instant: what the old code stored. */
    private function utcWall(DateTimeImmutable $at): string
    {
        return $at->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d H:i:s');
    }

    /** The process wall-clock of an instant: what the new code stores. */
    private function wall(DateTimeImmutable $at): string
    {
        return $at->setTimezone(new DateTimeZone(self::Z))->format('Y-m-d H:i:s');
    }

    private function doctor(): string
    {
        return CardHarness::seedSpecialist($this->em())->getId();
    }

    private function patient(): string
    {
        return CardHarness::seedPatient($this->em())->getId();
    }

    /** A booking at `$at`, written by the new code (marked). */
    private function book(string $patientId, string $doctorId, DateTimeImmutable $at): string
    {
        $em = $this->em();
        $a  = new Appointment($em->find(Patient::class, $patientId), $em->find(Specialist::class, $doctorId), $at);
        $a->transitionTo(AppointmentStatus::CONFIRMED, true);
        $em->persist($a);
        $em->flush();

        return $a->getId();
    }

    /** …and as the old code stored it: the UTC wall-clock, no marker, booked ten days ago. */
    private function legacyBooking(string $patientId, string $doctorId, DateTimeImmutable $at): string
    {
        $id = $this->book($patientId, $doctorId, $at);
        $this->db()->executeStatement(
            'UPDATE appointments SET scheduled_at = CAST(? AS TIMESTAMP(0)), scheduled_epoch = NULL, created_at = CAST(? AS TIMESTAMP(0)) WHERE id = ?',
            [$this->utcWall($at), $this->sql($this->now->modify('-10 days')), $id],
        );

        return $id;
    }

    /**
     * A doctor's follow-up proposal at `$at` as the old code stored it: on the
     * right clock (parseStart) but unmarked, with its audit row unless `$audit` is false.
     */
    private function legacyProposal(string $patientId, string $doctorId, DateTimeImmutable $at, ?DateTimeImmutable $expires = null, bool $audit = true): string
    {
        $em      = $this->em();
        $patient = $em->find(Patient::class, $patientId);
        $doctor  = $em->find(Specialist::class, $doctorId);
        $parent  = new Appointment($patient, $doctor, $this->now->modify('-20 days'));
        $parent->transitionTo(AppointmentStatus::CONFIRMED, true);
        $parent->transitionTo(AppointmentStatus::COMPLETED, true);
        $em->persist($parent);
        $expires ??= FollowUpService::expiresAt($at, $this->now);
        $proposal = Appointment::proposeFollowUp($parent, $at, ['base_fee' => '10000.00', 'amount' => '5000.00', 'rule' => 'percent', 'discount_percent' => 50, 'window_days' => 14, 'window_ends_at' => null, 'waived' => false], null, $expires);
        $em->persist($proposal);
        $em->flush();
        $this->db()->executeStatement(
            'UPDATE appointments SET scheduled_epoch = NULL, created_at = CAST(? AS TIMESTAMP(0)) WHERE id = ?',
            [$this->sql($this->now->modify('-1 day')), $proposal->getId()],
        );
        if ($audit) {
            $this->app()->get(AuditLogger::class)->record('Dr. Test', 'doctor', 'appointment.follow_up_proposed', $proposal->getId(), 'appointment', $proposal->getId(), [
                'scheduled_at' => $at->setTimezone(new DateTimeZone(self::Z))->format(DATE_ATOM),
                'expires_at'   => $expires->setTimezone(new DateTimeZone(self::Z))->format(DATE_ATOM),
            ]);
        }

        return $proposal->getId();
    }

    /** An availability slot [from, to), as the old code stored it (UTC wall-clock, unmarked). */
    private function legacySlot(string $doctorId, DateTimeImmutable $from, DateTimeImmutable $to, SlotKind $kind = SlotKind::OPEN): string
    {
        $em   = $this->em();
        $slot = new AvailabilitySlot($em->find(Specialist::class, $doctorId), $from, $to, $kind);
        $em->persist($slot);
        $em->flush();
        $this->db()->executeStatement(
            'UPDATE availability_slots SET starts_at = CAST(? AS TIMESTAMP(0)), ends_at = CAST(? AS TIMESTAMP(0)), starts_epoch = NULL, created_at = CAST(? AS TIMESTAMP(0)) WHERE id = ?',
            [$this->utcWall($from), $this->utcWall($to), $this->sql($this->now->modify('-10 days')), $slot->getId()],
        );

        return $slot->getId();
    }

    private function grant(string $appointmentId, string $patientId, string $doctorId, string $duration, DateTimeImmutable $expires): string
    {
        return (new DocumentAccessGrantRepository($this->em()))->insertGrant([
            'patient_id'     => $patientId,
            'specialist_id'  => $doctorId,
            'scope'          => 'selected',
            'source'         => 'booking',
            'surface'        => 'booking',
            'duration'       => $duration,
            'expires_at'     => $expires,
            'appointment_id' => $appointmentId,
        ], $this->now->modify('-10 days'));
    }

    /** @return array{0:string, 1:?int} the stored start and its marker */
    private function at(string $id): array
    {
        $row = $this->db()->fetchAssociative("SELECT to_char(scheduled_at, 'YYYY-MM-DD HH24:MI:SS') AS at, scheduled_epoch FROM appointments WHERE id = ?", [$id]);
        $this->assertIsArray($row, $id);

        return [(string) $row['at'], $row['scheduled_epoch'] === null ? null : (int) $row['scheduled_epoch']];
    }

    /** @return array{0:string, 1:string, 2:?int} */
    private function slotAt(string $id): array
    {
        $row = $this->db()->fetchAssociative("SELECT to_char(starts_at, 'YYYY-MM-DD HH24:MI:SS') AS s, to_char(ends_at, 'YYYY-MM-DD HH24:MI:SS') AS e, starts_epoch FROM availability_slots WHERE id = ?", [$id]);
        $this->assertIsArray($row, $id);

        return [(string) $row['s'], (string) $row['e'], $row['starts_epoch'] === null ? null : (int) $row['starts_epoch']];
    }

    /** @return array{0:string, 1:string, 2:string} expires_at, original_expires_at, status */
    private function grantAt(string $id): array
    {
        $row = $this->db()->fetchAssociative("SELECT to_char(expires_at, 'YYYY-MM-DD HH24:MI:SS') AS e, to_char(original_expires_at, 'YYYY-MM-DD HH24:MI:SS') AS o, status FROM document_access_grants WHERE id = ?", [$id]);
        $this->assertIsArray($row, $id);

        return [(string) $row['e'], (string) $row['o'], (string) $row['status']];
    }

    private function setting(): ?string
    {
        $value = $this->db()->fetchOne('SELECT value FROM app_settings WHERE setting_key = ?', [ClockRepair::SETTING]);

        return $value === false ? null : (string) $value;
    }

    private function pending(): bool
    {
        ClockRepair::resetCache();

        return ClockRepair::isPending($this->db());
    }

    /** @param array<string,string> $decisions @return array<string,mixed> */
    private function repair(?string $fixZone, array $decisions = [], bool $dryRun = false, string $lockTimeout = ClockRepair::LOCK_TIMEOUT, ?\Closure $beforeWrite = null): array
    {
        return ClockRepair::run($this->em('clock_it_run'), $fixZone, $decisions, $dryRun, null, $lockTimeout, $beforeWrite);
    }

    /** @param array<string,mixed> $report @return list<string> */
    private function codes(array $report): array
    {
        return array_column($report['refusals'] ?? [], 'code');
    }

    /** @param array<string,mixed> $report @return list<string> */
    private function refused(array $report, string $code): array
    {
        foreach ($report['refusals'] ?? [] as $r) {
            if ($r['code'] === $code) {
                return $r['ids'] ?? [];
            }
        }

        return [];
    }

    private function auditCount(string $action): int
    {
        return (int) $this->db()->fetchOne('SELECT COUNT(*) FROM audit_events WHERE action = ?', [$action]);
    }

    /** @return array<string,string> id => xmin */
    private function xmins(): array
    {
        $out = [];
        foreach ($this->db()->fetchAllAssociative('SELECT id, xmin::text AS x FROM appointments UNION ALL SELECT id, xmin::text FROM availability_slots UNION ALL SELECT id, xmin::text FROM document_access_grants') as $row) {
            $out[(string) $row['id']] = (string) $row['x'];
        }
        ksort($out);

        return $out;
    }

    // ----- Tests -----

    public function testNothingOnTheWrongClockIsRecordedOnlyByAFixRun(): void
    {
        $this->book($this->patient(), $this->doctor(), $this->base);

        $plain = $this->repair(null);
        $this->assertSame('would_record', $plain['status'], json_encode($plain));
        $this->assertNull($this->setting(), 'a plain run never records');
        $this->assertTrue($this->pending());

        $fix = $this->repair(self::Z);
        $this->assertSame('recorded', $fix['status'], json_encode($fix));
        $recorded = json_decode((string) $this->setting(), true);
        $this->assertSame(self::Z, $recorded['zone']);
        $this->assertSame(28800, $recorded['offset']);
        $this->assertTrue($recorded['nothing_to_repair']);
        $this->assertFalse($this->pending());
    }

    public function testTheRepair(): void
    {
        $patient = $this->patient();
        $doctor  = $this->doctor();
        $b       = $this->base;

        $booking     = $this->legacyBooking($patient, $doctor, $b);
        $rescheduled = $this->legacyBooking($patient, $doctor, $b->modify('+1 hour'));
        $this->db()->executeStatement("UPDATE appointments SET rescheduled_by = 'patient' WHERE id = ?", [$rescheduled]);
        $proposal    = $this->legacyProposal($patient, $doctor, $b->modify('+3 hours'));
        $marked      = $this->book($patient, $doctor, $b->modify('+5 hours'));
        $markedRow   = $this->at($marked);
        $slotFrom    = $b->modify('+1 day')->modify('+6 hours');
        $slot        = $this->legacySlot($doctor, $slotFrom, $slotFrom->modify('+30 minutes'));
        $past        = $this->legacyBooking($patient, $doctor, (new DateTimeImmutable('now', new DateTimeZone('UTC')))->modify('-3 days')->setTime(9, 0));
        $pastAt      = (new DateTimeImmutable('now', new DateTimeZone('UTC')))->modify('-3 days')->setTime(9, 0);

        // Shares of the first booking: after_7d worked out from the wrong reading (8 h early) and from the right one.
        $wrongBase = $this->grant($booking, $patient, $doctor, 'after_7d', $b->modify('-8 hours')->modify('+30 minutes')->modify('+7 days'));
        $rightBase = $this->grant($booking, $patient, $doctor, 'after_7d', $b->modify('+30 minutes')->modify('+7 days'));
        $rightRow  = $this->grantAt($rightBase);
        // An after_24h share of the past booking that already lapsed (the cron never swept it).
        $lapsed    = $this->grant($past, $patient, $doctor, 'after_24h', $pastAt->modify('-8 hours')->modify('+30 minutes')->modify('+24 hours'));
        $lapsedRow = $this->grantAt($lapsed);

        // A plain run (the one-liner) lists everything and changes nothing.
        $before = $this->xmins();
        $plain  = $this->repair(null);
        $this->assertSame('pending', $plain['status'], json_encode($plain));
        $this->assertEqualsCanonicalizing([$booking, $rescheduled, $past, $proposal], array_column($plain['appointments'], 'id'));
        $this->assertSame([$slot], array_column($plain['slots'], 'id'));
        $this->assertSame($before, $this->xmins(), 'nothing written');
        $this->assertNull($this->setting());
        $this->assertTrue($this->pending());

        // A dry run inside an outer transaction (as prod-migrate's) is rolled back with it.
        $em = $this->em('clock_it_dry');
        $em->getConnection()->beginTransaction();
        $dry = ClockRepair::run($em, self::Z, [], true);
        $em->getConnection()->rollBack();
        $this->assertSame('would_repair', $dry['status'], json_encode($dry));
        $this->assertSame($before, $this->xmins(), 'rolled back');
        $this->assertNull($this->setting());

        $fix = $this->repair(self::Z);
        $this->assertSame('repaired', $fix['status'], json_encode($fix));

        $this->assertSame([$this->wall($b), $b->getTimestamp()], $this->at($booking), 'shifted +8 h, marked with the instant');
        $this->assertSame([$this->wall($b->modify('+1 hour')), $b->modify('+1 hour')->getTimestamp()], $this->at($rescheduled));
        $this->assertSame([$this->wall($pastAt), $pastAt->getTimestamp()], $this->at($past));
        $this->assertSame([$this->wall($b->modify('+3 hours')), $b->modify('+3 hours')->getTimestamp()], $this->at($proposal), 'the proposal kept and marked');
        $this->assertSame($markedRow, $this->at($marked), 'written by the new code: untouched');
        $this->assertSame([$this->wall($slotFrom), $this->wall($slotFrom->modify('+30 minutes')), $slotFrom->getTimestamp()], $this->slotAt($slot));

        $moved = $this->wall($b->modify('+30 minutes')->modify('+7 days'));
        $this->assertSame([$moved, $moved, 'active'], $this->grantAt($wrongBase), 'recomputed from the right time');
        $this->assertSame($rightRow, $this->grantAt($rightBase), 'already right');
        $this->assertSame($lapsedRow, $this->grantAt($lapsed), 'a lapsed share is never revived');
        $this->assertSame([$lapsed], array_column($fix['grants_expired_early'], 'id'));
        $this->assertFalse($fix['grants_expired_early'][0]['would_still_be_open']);

        $this->assertSame(3, $this->auditCount('appointment.time_corrected'));
        $this->assertSame(1, $this->auditCount('availability.time_corrected'));
        $this->assertSame(2, $this->auditCount('document_access.expiry_corrected'));
        $this->assertSame(1, $this->auditCount('maintenance.clock_repaired'));
        $recorded = json_decode((string) $this->setting(), true);
        $this->assertSame(self::Z, $recorded['zone']);
        $this->assertSame(3, $recorded['appointments_shifted']);
        $this->assertSame(1, $recorded['appointments_marked']);
        $this->assertSame(1, $recorded['slots_shifted']);
        $this->assertSame(2, $recorded['grants_shifted']);
        $this->assertFalse($this->pending());

        // No PHI in what is printed.
        foreach ([$plain, $dry, $fix] as $report) {
            $json = (string) json_encode($report);
            $this->assertStringNotContainsString('@', $json);
            $this->assertStringNotContainsString('Ada', $json);
            $this->assertStringNotContainsString('Card Test', $json);
        }

        // Again: nothing to do, nothing written.
        $audits = (int) $this->db()->fetchOne('SELECT COUNT(*) FROM audit_events');
        $after  = $this->xmins();
        $again  = $this->repair(self::Z);
        $this->assertSame('done', $again['status'], json_encode($again));
        $this->assertSame($after, $this->xmins());
        $this->assertSame($audits, (int) $this->db()->fetchOne('SELECT COUNT(*) FROM audit_events'));
        $this->assertSame('done', $this->repair(null)['status']);
    }

    public function testAMarkedRowChangedBehindTheMarkersBackNeedsADecision(): void
    {
        $patient = $this->patient();
        $doctor  = $this->doctor();
        $marked  = $this->book($patient, $doctor, $this->base);
        $legacy  = $this->legacyBooking($patient, $doctor, $this->base->modify('+2 hours'));
        $this->db()->executeStatement("UPDATE appointments SET scheduled_at = scheduled_at + interval '1 hour' WHERE id = ?", [$marked]);
        [$changed] = $this->at($marked);

        $refused = $this->repair(self::Z);
        $this->assertSame('refused', $refused['status']);
        $this->assertSame([$marked], $this->refused($refused, 'undecided'));
        $this->assertSame('review:marker_mismatch', $refused['review'][0]['class']);
        $this->assertSame([$this->utcWall($this->base->modify('+2 hours')), null], $this->at($legacy), 'nothing changed');

        $fix = $this->repair(self::Z, [$marked => 'keep']);
        $this->assertSame('repaired', $fix['status'], json_encode($fix));
        $this->assertSame([$changed, $this->base->modify('+1 hour')->getTimestamp()], $this->at($marked), 'kept as it is, the marker follows it');
        $this->assertSame([$this->wall($this->base->modify('+2 hours')), $this->base->modify('+2 hours')->getTimestamp()], $this->at($legacy));
    }

    public function testUnprovenProposalsAndPublishedSlotBookingsWaitForADecision(): void
    {
        $patient = $this->patient();
        $doctor  = $this->doctor();
        // The doctor published 12:00 (stored "12:00", read 04:00Z); the engine offered it 8 h early
        // (04:00Z) and the patient booked that (stored "04:00").
        $slotAt   = $this->base->modify('+1 day')->setTime(12, 0);
        $slot     = $this->legacySlot($doctor, $slotAt, $slotAt->modify('+30 minutes'));
        $booking  = $this->legacyBooking($patient, $doctor, $slotAt->modify('-8 hours'));
        $unproven = $this->legacyProposal($patient, $doctor, $this->base->modify('+2 days'), audit: false);

        $refused = $this->repair(self::Z);
        $this->assertSame('refused', $refused['status'], json_encode($refused));
        $this->assertEqualsCanonicalizing([$booking, $unproven], $this->refused($refused, 'undecided'));
        $classes = array_column($refused['review'], 'class', 'id');
        $this->assertSame('decide:published_slot', $classes[$booking]);
        $this->assertSame('review:proposal_unproven', $classes[$unproven]);
        $this->assertNull($this->setting());

        $this->assertSame('refused', $this->repair(self::Z, [$unproven => 'slot', $booking => 'slot'])['status'], '`slot` only on a published-slot row');

        $fix = $this->repair(self::Z, [$booking => 'slot', $unproven => 'keep']);
        $this->assertSame('repaired', $fix['status'], json_encode($fix));
        $this->assertSame([$this->wall($slotAt), $slotAt->getTimestamp()], $this->at($booking), "the doctor's published time: +16 h");
        $this->assertSame([$this->wall($slotAt), $this->wall($slotAt->modify('+30 minutes')), $slotAt->getTimestamp()], $this->slotAt($slot));
        $this->assertSame($this->base->modify('+2 days')->getTimestamp(), $this->at($unproven)[1]);

        // Step 4 run again with the same DECIDE (dry and real): the decisions were applied, nothing to do.
        $after  = $this->xmins();
        $audits = (int) $this->db()->fetchOne('SELECT COUNT(*) FROM audit_events');
        $em     = $this->em('clock_it_dry_again');
        $em->getConnection()->beginTransaction();
        $dry = ClockRepair::run($em, self::Z, [$booking => 'slot', $unproven => 'keep'], true);
        $em->getConnection()->rollBack();
        $this->assertSame('done', $dry['status'], json_encode($dry));
        $again = $this->repair(self::Z, [$booking => 'slot', $unproven => 'keep']);
        $this->assertSame('done', $again['status'], json_encode($again));
        $this->assertSame($after, $this->xmins(), 'nothing written');
        $this->assertSame($audits, (int) $this->db()->fetchOne('SELECT COUNT(*) FROM audit_events'));
        $this->assertSame('refused', $this->repair(self::Z, [$slot => 'slot'])['status'], '`slot` on a slot id is still refused');
    }

    public function testACorrectionOntoAnotherBookingIsRefused(): void
    {
        $patient = $this->patient();
        $doctor  = $this->doctor();
        $this->book($patient, $doctor, $this->base);
        $legacy = $this->legacyBooking($this->patient(), $doctor, $this->base->modify('+15 minutes'));

        $refused = $this->repair(self::Z);
        $this->assertSame('refused', $refused['status'], json_encode($refused));
        $this->assertSame(['new_collision'], $this->codes($refused));
        $this->assertCount(1, $refused['new_collisions']);
        $this->assertSame([$this->utcWall($this->base->modify('+15 minutes')), null], $this->at($legacy), 'nothing changed');
        $this->assertNull($this->setting());
    }

    public function testBookingsThatAlreadyOverlappedMoveTogetherAndAreReported(): void
    {
        $doctor = $this->doctor();
        $a      = $this->legacyBooking($this->patient(), $doctor, $this->base);
        $b      = $this->legacyBooking($this->patient(), $doctor, $this->base->modify('+15 minutes'));
        // 8 h apart: the first moves onto the second's stored time (the live-slot index is there).
        $c = $this->legacyBooking($this->patient(), $doctor, $this->base->modify('+1 day'));
        $d = $this->legacyBooking($this->patient(), $doctor, $this->base->modify('+1 day')->modify('+8 hours'));

        $fix = $this->repair(self::Z);
        $this->assertSame('repaired', $fix['status'], json_encode($fix));
        $this->assertCount(1, $fix['live_overlaps_after']);
        $pair = implode(' ', $fix['live_overlaps_after'][0]['rows']);
        $this->assertStringContainsString($a, $pair);
        $this->assertStringContainsString($b, $pair);
        foreach ([$a => $this->base, $b => $this->base->modify('+15 minutes'), $c => $this->base->modify('+1 day'), $d => $this->base->modify('+1 day')->modify('+8 hours')] as $id => $at) {
            $this->assertSame([$this->wall($at), $at->getTimestamp()], $this->at($id));
        }
    }

    public function testAnOpenProposalOnACorrectedBookingIsRefusedUntilItIsGone(): void
    {
        $patient  = $this->patient();
        $doctor   = $this->doctor();
        $proposal = $this->legacyProposal($patient, $doctor, $this->base, $this->now->modify('+1 day'));
        $booking  = $this->legacyBooking($this->patient(), $doctor, $this->base);

        $refused = $this->repair(self::Z);
        $this->assertSame('refused', $refused['status'], json_encode($refused));
        $this->assertSame(['hold_collision'], $this->codes($refused));
        $this->assertSame([$this->utcWall($this->base), null], $this->at($booking));

        $this->db()->executeStatement("UPDATE appointments SET status = 'cancelled' WHERE id = ?", [$proposal]); // as the withdrawal does
        $fix = $this->repair(self::Z);
        $this->assertSame('repaired', $fix['status'], json_encode($fix));
        $this->assertSame([$this->wall($this->base), $this->base->getTimestamp()], $this->at($booking));
    }

    public function testABookingInsideTheDoctorsBlockIsReported(): void
    {
        $doctor  = $this->doctor();
        $block   = $this->legacySlot($doctor, $this->base->modify('-1 hour'), $this->base->modify('+2 hours'), SlotKind::BLOCK);
        $booking = $this->legacyBooking($this->patient(), $doctor, $this->base);

        $fix = $this->repair(self::Z);
        $this->assertSame('repaired', $fix['status'], json_encode($fix));
        $this->assertCount(1, $fix['blocked_after']);
        $this->assertSame($booking, $fix['blocked_after'][0]['id']);
        $this->assertSame($block, $fix['blocked_after'][0]['block_id']);
    }

    public function testARowChangedBeforeItsWriteRollsEverythingBack(): void
    {
        $doctor = $this->doctor();
        $first  = $this->legacyBooking($this->patient(), $doctor, $this->base);
        $second = $this->legacyBooking($this->patient(), $doctor, $this->base->modify('+2 hours'));
        $before = [$this->at($first), $this->at($second)];

        $fix = $this->repair(self::Z, beforeWrite: static function (Connection $conn) use ($first): void {
            $conn->executeStatement("UPDATE appointments SET scheduled_at = scheduled_at + interval '1 minute' WHERE id = ?", [$first]);
        });
        $this->assertSame('conflict', $fix['status'], json_encode($fix));
        $this->assertSame($first, $fix['conflict']['id']);
        $this->assertSame($before, [$this->at($first), $this->at($second)], 'everything rolled back, the change on the way too');
        $this->assertNull($this->setting());
        $this->assertSame(0, $this->auditCount('maintenance.clock_repaired'));
    }

    public function testATableHeldByOtherWorkIsBusyNotAFailure(): void
    {
        $doctor  = $this->doctor();
        $booking = $this->legacyBooking($this->patient(), $doctor, $this->base);
        $before  = $this->at($booking);

        $blocker = $this->em('clock_it_blocker')->getConnection();
        $blocker->beginTransaction();
        try {
            $blocker->fetchOne('SELECT id FROM appointments WHERE id = ? FOR UPDATE', [$booking]);
            $fix = $this->repair(self::Z, lockTimeout: '1s');
        } finally {
            $blocker->rollBack();
        }
        $this->assertSame('busy', $fix['status'], json_encode($fix));
        $this->assertSame($before, $this->at($booking));
        $this->assertNull($this->setting());
    }

    public function testThePreviewSqlClassifiesLikeTheStep(): void
    {
        $patient = $this->patient();
        $doctor  = $this->doctor();
        $b       = $this->base;
        $ids     = [];

        $ids[] = $this->legacyBooking($patient, $doctor, $b);
        $ids[] = $r2 = $this->legacyBooking($patient, $doctor, $b->modify('+1 hour'));
        $this->db()->executeStatement("UPDATE appointments SET rescheduled_by = 'patient' WHERE id = ?", [$r2]);
        $ids[] = $r3 = $this->legacyBooking($patient, $doctor, $b->modify('+2 hours'));
        $this->db()->executeStatement("UPDATE appointments SET status = 'rescheduled' WHERE id = ?", [$r3]);
        $ids[] = $r4 = $this->legacyBooking($patient, $doctor, $b->modify('+3 hours'));
        $this->db()->executeStatement("UPDATE appointments SET proposed_by = 'patient' WHERE id = ?", [$r4]);
        $ids[] = $this->legacyProposal($patient, $doctor, $b->modify('+4 hours'));
        $ids[] = $this->legacyProposal($patient, $doctor, $b->modify('+5 hours'), $b->modify('+3 hours'), audit: false);
        $ids[] = $this->legacyProposal($patient, $doctor, $b->modify('+6 hours'), audit: false);
        // A proposal stored on the UTC clock (its audit names the instant).
        $ids[] = $r8 = $this->legacyProposal($patient, $doctor, $b->modify('+7 hours'));
        $this->db()->executeStatement('UPDATE appointments SET scheduled_at = CAST(? AS TIMESTAMP(0)) WHERE id = ?', [$this->utcWall($b->modify('+7 hours')), $r8]);
        // A booking of a published slot offered 8 h early.
        $slotAt = $b->modify('+1 day')->setTime(12, 0);
        $this->legacySlot($doctor, $slotAt, $slotAt->modify('+30 minutes'));
        $ids[] = $this->legacyBooking($patient, $doctor, $slotAt->modify('-8 hours'));
        // Card payments naming the slot: on the UTC clock, and on the process clock.
        $ids[] = $r10 = $this->legacyBooking($patient, $doctor, $b->modify('+9 hours'));
        $ids[] = $r11 = $this->legacyBooking($patient, $doctor, $b->modify('+10 hours'));
        foreach ([[$r10, $b->modify('+9 hours')->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d\TH:i:s.000\Z')], [$r11, $b->modify('+10 hours')->modify('-8 hours')->format(DATE_ATOM)]] as [$id, $iso]) {
            $ref = $this->checkout($patient, PaymentIntent::PURPOSE_BOOKING, ['specialist_id' => $doctor, 'scheduled_at' => $iso], '10000.00')->getReference();
            $this->db()->executeStatement('UPDATE payment_intents SET consumed_by = ? WHERE reference = ?', [$id, $ref]);
        }
        // A proposal the doctor then moved (stored unconverted), and one moved as it was accepted.
        $ids[] = $r12 = $this->legacyProposal($patient, $doctor, $b->modify('+11 hours'));
        $this->db()->executeStatement(
            "UPDATE appointments SET rescheduled_by = 'doctor', status = 'confirmed', scheduled_at = CAST(? AS TIMESTAMP(0)) WHERE id = ?",
            [$this->utcWall($b->modify('+11 hours')), $r12],
        );
        $ids[] = $r13 = $this->legacyProposal($patient, $doctor, $b->modify('+12 hours'));
        $this->db()->executeStatement("UPDATE appointments SET status = 'confirmed', scheduled_at = CAST(? AS TIMESTAMP(0)) WHERE id = ?", [$this->wall($b->modify('+14 hours')), $r13]);
        $this->app()->get(AuditLogger::class)->record('Patient', 'patient', 'appointment.follow_up_accepted', $r13, 'appointment', $r13, [
            'scheduled_at' => $b->modify('+13 hours')->setTimezone(new DateTimeZone(self::Z))->format(DATE_ATOM),
        ]);

        $plan = ClockRepair::plan($this->db(), new DateTimeZone(self::Z), new DateTimeImmutable(), []);

        $sql   = (string) file_get_contents(CardHarness::apiDir() . '/resources/sql/clock-repair-preview.sql');
        $start = strpos($sql, '\echo \'== 2.');
        $this->assertNotFalse($start);
        $start = (int) strpos($sql, "\n", $start) + 1;
        $end   = strpos($sql, '\echo', $start);
        $this->assertNotFalse($end);
        $query = rtrim(trim(substr($sql, $start, $end - $start)), ';');
        $query = (string) preg_replace('/(?<![:\w]):off\b/', '28800', $query);
        $preview = [];
        foreach ($this->db()->fetchAllAssociative($query) as $row) {
            $preview[trim((string) $row['id'])] = $row;
        }

        $seen = [];
        foreach ($ids as $id) {
            $this->assertArrayHasKey($id, $preview);
            $row = $plan['rows'][$id];
            $this->assertSame($row['base_class'], $preview[$id]['class'], $id);
            $this->assertSame($row['evidence']['published_slot'], in_array($preview[$id]['on_published_slot'], [true, 't', 1, '1'], true), $id);
            $this->assertSame($row['evidence']['payment'], $preview[$id]['pay_check'], $id);
            $seen[$row['base_class']] = true;
        }
        $this->assertCount(10, $seen, 'every Step A class but the marker ones is covered: ' . implode(', ', array_keys($seen)));
    }

    public function testOffsetsPhpDidNotWriteOnThisZoneAreRefused(): void
    {
        $booking = $this->legacyBooking($this->patient(), $this->doctor(), $this->base);
        $this->db()->executeStatement('UPDATE appointments SET guests = CAST(? AS JSON) WHERE id = ?', ['[{"id":"g1","invited_at":"2026-10-01T09:00:00+00:00"}]', $booking]);

        $fix = $this->repair(self::Z);
        $this->assertSame('refused', $fix['status'], json_encode($fix));
        $this->assertContains('zone_history', $this->codes($fix));
        $this->assertSame(1, $fix['zone_history']['mismatched']);
        $this->assertSame([$this->utcWall($this->base), null], $this->at($booking));
    }

    public function testTheFixZoneMustBeTheCliZone(): void
    {
        $this->legacyBooking($this->patient(), $this->doctor(), $this->base);

        $fix = $this->repair('UTC');
        $this->assertSame('refused', $fix['status']);
        $this->assertSame(['zone_mismatch'], $this->codes($fix));
        $this->assertNull($this->setting());
    }

    public function testAZoneWithDaylightSavingIsRefused(): void
    {
        date_default_timezone_set('Europe/London');
        ClockRepair::resetCache();
        $booking = $this->legacyBooking($this->patient(), $this->doctor(), $this->base);

        $fix = $this->repair('Europe/London');
        $this->assertSame('refused', $fix['status'], json_encode($fix));
        $this->assertContains('zone_has_transitions', $this->codes($fix));
        $this->assertSame([$this->utcWall($this->base), null], $this->at($booking), 'nothing changed');
        $this->assertNull($this->setting());
    }

    public function testOnAUtcProcessThereIsNothingToRepair(): void
    {
        $booking = $this->legacyBooking($this->patient(), $this->doctor(), $this->base);
        $before  = $this->at($booking);
        date_default_timezone_set('UTC');
        ClockRepair::resetCache();

        $this->assertSame('not_needed', $this->repair(null)['status']);
        $this->assertSame('not_needed', $this->repair('UTC')['status']);
        $this->assertSame($before, $this->at($booking));
        $this->assertNull($this->setting());
        $this->assertFalse(ClockRepair::isPending($this->db()));
    }

    /**
     * date.timezone changed to UTC (or the ini line went missing, so PHP fell
     * back to UTC) after the repair was recorded for PRC: the stored values are
     * on the PRC clock and read 8 h late here, so everything stops.
     */
    public function testAUtcProcessAfterARepairRecordedForAnotherZoneIsPaused(): void
    {
        $booking = $this->legacyBooking($this->patient(), $this->doctor(), $this->base);
        $this->assertSame('repaired', $this->repair(self::Z)['status']);
        $setting = $this->setting();
        $this->assertNotNull($setting);
        $before  = $this->xmins();

        date_default_timezone_set('UTC');
        ClockRepair::resetCache();

        $this->assertSame('pending', ClockRepair::state($this->db()));
        $this->assertTrue($this->pending(), 'the gate and the cron guard stop');

        $plain = $this->repair(null);
        $this->assertSame('refused', $plain['status'], json_encode($plain));
        $this->assertSame([['code' => 'recorded_for_other_zone', 'recorded_zone' => self::Z]], $plain['refusals']);
        $fix = $this->repair('UTC');
        $this->assertSame('refused', $fix['status'], json_encode($fix));
        $this->assertSame(['recorded_for_other_zone'], $this->codes($fix));
        $this->assertSame('refused', $this->repair('UTC', dryRun: true)['status']);

        $this->assertSame($before, $this->xmins(), 'nothing written');
        $this->assertSame($setting, $this->setting(), 'the record is untouched');
        $this->assertSame([$this->wall($this->base), $this->base->getTimestamp()], $this->at($booking));

        // A record naming a UTC-equivalent zone is no reason to stop a UTC process.
        $this->db()->executeStatement('UPDATE app_settings SET value = ? WHERE setting_key = ?', ['{"zone":"Etc/UTC","offset":0}', ClockRepair::SETTING]);
        $this->assertSame('not_needed', ClockRepair::state($this->db()));
        $this->assertFalse($this->pending());
        $this->assertSame('not_needed', $this->repair('UTC')['status']);
    }
}
