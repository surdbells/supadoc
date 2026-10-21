<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Infrastructure\Persistence\ClockRepair;
use DateTimeImmutable;
use DateTimeZone;
use PHPUnit\Framework\TestCase;

/**
 * The pure rules of prod-migrate step 13 (ClockRepair, spec §2.3–§2.6): the
 * provenance classes, the evidence overrides and their order, decisions,
 * slots, document shares, overlaps and holds — over rows shaped like the
 * step's queries, with no database. The process zone is Asia/Shanghai
 * (production's PRC) unless a test says otherwise.
 *
 * Notation: a "legacy" row holds the UTC wall-clock of its instant (what the
 * old code stored), a "marked" row the Shanghai wall-clock plus its epoch.
 */
final class ClockRepairRulesTest extends TestCase
{
    private const DOC   = '11111111-1111-4111-8111-111111111111';
    private const OTHER = '22222222-2222-4222-8222-222222222222';

    private string $zone = 'UTC';
    private DateTimeZone $z;
    private DateTimeImmutable $now;
    private int $seq = 0;

    protected function setUp(): void
    {
        $this->zone = date_default_timezone_get();
        date_default_timezone_set('Asia/Shanghai');
        $this->z   = new DateTimeZone('Asia/Shanghai');
        $this->now = new DateTimeImmutable('2026-10-20T12:00:00Z');
    }

    protected function tearDown(): void
    {
        date_default_timezone_set($this->zone);
        ClockRepair::resetCache();
    }

    // ----- Fixtures -----

    private function id(): string
    {
        return sprintf('6f1c2a3e-1111-4a2b-9c3d-%012d', ++$this->seq);
    }

    /** What the old code stored for this instant: its UTC wall-clock. */
    private function legacy(string $utcIso): string
    {
        return (new DateTimeImmutable($utcIso))->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d H:i:s');
    }

    /** What the new code stores: the process-zone wall-clock. */
    private function wall(string $utcIso): string
    {
        return (new DateTimeImmutable($utcIso))->setTimezone($this->z)->format('Y-m-d H:i:s');
    }

    private function ts(string $iso): int
    {
        return (new DateTimeImmutable($iso))->getTimestamp();
    }

    /** @param array<string,mixed> $o @return array<string,mixed> a Q1 row */
    private function appt(array $o = []): array
    {
        return $o + [
            'id'                    => $this->id(),
            'specialist_id'         => self::DOC,
            'status'                => 'confirmed',
            'proposed_by'           => null,
            'rescheduled_by'        => null,
            'parent_appointment_id' => null,
            'payment_status'        => 'paid',
            'amount'                => '10000.00',
            'refunded_amount'       => null,
            'closure_reason'        => null,
            'closed_at'             => null,
            'scheduled_at'          => $this->legacy('2026-10-25T09:00:00Z'),
            'scheduled_epoch'       => null,
            'expires_at'            => null,
            'created_at'            => $this->wall('2026-10-10T08:00:00Z'),
            'deleted'               => false,
            'priced_follow_up'      => false,
            'slot_minutes'          => 30,
        ];
    }

    /** A row the new code wrote at `$utcIso` (marked). @param array<string,mixed> $o @return array<string,mixed> */
    private function markedAppt(string $utcIso, array $o = []): array
    {
        return $this->appt($o + ['scheduled_at' => $this->wall($utcIso), 'scheduled_epoch' => $this->ts($utcIso)]);
    }

    /** @param array<string,mixed> $o @return array<string,mixed> a Q4 row */
    private function slot(array $o = []): array
    {
        return $o + [
            'id'            => $this->id(),
            'specialist_id' => self::DOC,
            'kind'          => 'open',
            'starts_at'     => $this->legacy('2026-10-25T09:00:00Z'),
            'ends_at'       => $this->legacy('2026-10-25T09:30:00Z'),
            'starts_epoch'  => null,
            'created_at'    => $this->wall('2026-10-09T08:00:00Z'),
        ];
    }

    /**
     * @param list<array<string,mixed>> $appointments
     * @param list<array<string,mixed>> $audit
     * @param list<array<string,mixed>> $payments
     * @param list<array<string,mixed>> $slots
     * @param array<string,string>      $decisions
     * @param array<string,mixed>|null  $recorded
     * @return array<string,mixed>
     */
    private function classify(array $appointments, array $audit = [], array $payments = [], array $slots = [], array $decisions = [], ?array $recorded = null): array
    {
        return ClockRepair::classify($appointments, $audit, $payments, $slots, $this->z, $this->now, $decisions, $recorded);
    }

    /** @param array<string,mixed> $plan @return list<string> */
    private function codes(array $plan): array
    {
        return array_column($plan['refusals'], 'code');
    }

    /** @param array<string,mixed> $plan @return list<string> */
    private function refusedIds(array $plan, string $code): array
    {
        foreach ($plan['refusals'] as $r) {
            if ($r['code'] === $code) {
                return $r['ids'] ?? [];
            }
        }

        return [];
    }

    // ----- §2.3 Step A -----

    public function testStepAProvenanceClasses(): void
    {
        $n    = $this->legacy('2026-10-25T09:00:00Z');                 // "2026-10-25 09:00:00"
        $inZ  = (new DateTimeImmutable($n, $this->z))->getTimestamp(); // 01:00Z
        $utc  = $this->ts('2026-10-25T09:00:00Z');
        $sh   = '2026-10-25 17:00:00';
        $iso  = static fn (int $ts, string $zone): string => (new DateTimeImmutable('@' . $ts))->setTimezone(new DateTimeZone($zone))->format(DATE_ATOM);

        $rows = [
            'A1'  => $this->appt(['scheduled_epoch' => $inZ]),
            'A1p' => $this->appt(['scheduled_epoch' => $inZ + 60]),
            'A3a' => $this->appt(['proposed_by' => 'doctor', 'status' => 'proposed']),
            'A3b' => $this->appt(['proposed_by' => 'doctor', 'status' => 'proposed']),
            'A3c' => $this->appt(['proposed_by' => 'doctor']),
            'A3d' => $this->appt(['proposed_by' => 'doctor', 'status' => 'proposed', 'expires_at' => '2026-10-25 07:00:00']),
            'A3e' => $this->appt(['proposed_by' => 'doctor', 'status' => 'proposed', 'expires_at' => '2026-10-24 07:00:00']),
            'A4'  => $this->appt(['proposed_by' => 'doctor', 'rescheduled_by' => 'patient']),
            'A5'  => $this->appt(['rescheduled_by' => 'doctor']),
            'A6'  => $this->appt(['status' => 'rescheduled']),
            'A7'  => $this->appt(['proposed_by' => 'patient']),
            'A8'  => $this->appt(),
        ];
        foreach ($rows as $key => $row) {
            $rows[$key]['specialist_id'] = $this->id(); // one doctor each: no overlap rules in play here
        }
        $audit = [
            ['id' => $rows['A3a']['id'], 'action' => 'appointment.follow_up_proposed', 'iso' => $iso($inZ, 'Asia/Shanghai')],
            ['id' => $rows['A3b']['id'], 'action' => 'appointment.follow_up_proposed', 'iso' => $iso($utc, 'Asia/Shanghai')],
            ['id' => $rows['A3c']['id'], 'action' => 'appointment.follow_up_accepted', 'iso' => $iso($utc + 3600 * 3, 'Asia/Shanghai')],
        ];
        $plan = $this->classify(array_values($rows), $audit, [], [], [$rows['A1p']['id'] => 'keep', $rows['A3e']['id'] => 'shift']);

        $expect = [
            'A1'  => ['keep:marked', 'none', $n],
            'A1p' => ['review:marker_mismatch', 'keep', $n],
            'A3a' => ['keep:proposal_parsestart', 'mark', $n],
            'A3b' => ['shift:proposal_written_on_utc_clock', 'shift', $sh],
            'A3c' => ['shift:proposal_moved_after_accept', 'shift', $sh],
            'A3d' => ['keep:proposal_parsestart_by_expiry', 'mark', $n],
            'A3e' => ['review:proposal_unproven', 'shift', $sh],
            'A4'  => ['shift:proposal_then_rescheduled_by_patient', 'shift', $sh],
            'A5'  => ['shift:rescheduled_by_doctor', 'shift', $sh],
            'A6'  => ['shift:rescheduled_before_rescheduled_by_existed', 'shift', $sh],
            'A7'  => ['shift:patient_follow_up_booking', 'shift', $sh],
            'A8'  => ['shift:booking_patient_or_backoffice', 'shift', $sh],
        ];
        foreach ($expect as $key => [$class, $action, $to]) {
            $row = $plan['rows'][$rows[$key]['id']];
            $this->assertSame($class, $row['base_class'], $key);
            $this->assertSame($class, $row['class'], $key . ' (no override)');
            $this->assertSame($action, $row['action'], $key);
            $this->assertSame($to, $row['to'], $key);
        }
        $this->assertSame($utc, $plan['rows'][$rows['A8']['id']]['new_epoch'], 'shift: the marker is the intended instant');
        $this->assertSame($inZ, $plan['rows'][$rows['A3a']['id']]['new_epoch'], 'mark: the marker is the stored value read in Z');
        $this->assertSame($inZ, $plan['rows'][$rows['A1p']['id']]['new_epoch'], 'keep on a mismatch: the marker follows the stored value');
        $this->assertSame([], $plan['refusals'], 'everything decided');
        $this->assertSame('2026-10-25T17:00:00+08:00', $plan['rows'][$rows['A8']['id']]['to_iso']);
    }

    public function testRowsWrittenAfterARecordedRepairAreNeverShiftedAutomatically(): void
    {
        $recorded = ['zone' => 'Asia/Shanghai', 'offset' => 28800, 'at' => '2026-10-15T10:00:00+08:00'];
        $after    = $this->appt(['created_at' => '2026-10-16 09:00:00']);
        $before   = $this->appt(['created_at' => '2026-10-14 09:00:00']);
        $plan     = $this->classify([$after, $before], recorded: $recorded);

        $this->assertSame('review:unmarked_after_repair', $plan['rows'][$after['id']]['class']);
        $this->assertSame('undecided', $plan['rows'][$after['id']]['action']);
        $this->assertSame('shift', $plan['rows'][$before['id']]['action']);
        $this->assertSame([$after['id']], $this->refusedIds($plan, 'undecided'));
    }

    // ----- §2.3 Step B -----

    public function testStepBOverridesFirstMatchWins(): void
    {
        $n   = $this->legacy('2026-10-25T09:00:00Z');
        $inZ = (new DateTimeImmutable($n, $this->z))->getTimestamp();
        $payProcess = (new DateTimeImmutable('@' . $inZ))->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d\TH:i:s.v\Z');

        $b1       = $this->appt();
        $b1p      = $this->appt(['proposed_by' => 'doctor', 'status' => 'proposed', 'expires_at' => '2026-10-25 07:00:00']);
        $b3       = $this->appt(['created_at' => '2026-10-25 20:00:00']); // booked "after" its UTC-clock start
        $b2b3     = $this->appt(['specialist_id' => self::OTHER, 'created_at' => '2026-10-25 20:00:00']);
        $b2b1     = $this->appt(['specialist_id' => '33333333-3333-4333-8333-333333333333']);
        $slotB2B3 = $this->slot(['specialist_id' => self::OTHER, 'starts_at' => '2026-10-25 17:00:00', 'ends_at' => '2026-10-25 17:30:00']);
        $slotB2B1 = $this->slot(['specialist_id' => '33333333-3333-4333-8333-333333333333', 'starts_at' => '2026-10-25 17:00:00', 'ends_at' => '2026-10-25 17:30:00']);
        $payments = [
            ['id' => $b1['id'], 'iso' => $payProcess],
            ['id' => $b1p['id'], 'iso' => '2026-10-25T09:00:00+00:00'],
            ['id' => $b2b1['id'], 'iso' => $payProcess],
        ];

        $plan = $this->classify([$b1, $b1p, $b3, $b2b3, $b2b1], [], $payments, [$slotB2B3, $slotB2B1]);
        $row  = static fn (array $a): array => $plan['rows'][$a['id']];

        $this->assertSame('review:payment_says_process_clock', $row($b1)['class']);
        $this->assertSame('shift:booking_patient_or_backoffice', $row($b1)['base_class']);
        $this->assertSame('process_clock', $row($b1)['evidence']['payment']);
        $this->assertSame('review:payment_says_utc_clock', $row($b1p)['class']);
        $this->assertSame('keep:proposal_parsestart_by_expiry', $row($b1p)['base_class']);
        $this->assertSame('utc_clock', $row($b1p)['evidence']['payment']);
        $this->assertSame('review:starts_before_booked', $row($b3)['class']);
        $this->assertTrue($row($b3)['evidence']['starts_before_booked']);

        // B2 wins over B3 and over B1; every signal is still listed.
        $this->assertSame('decide:published_slot', $row($b2b3)['class']);
        $this->assertTrue($row($b2b3)['evidence']['starts_before_booked']);
        $this->assertTrue($row($b2b3)['evidence']['published_slot']);
        $this->assertSame('decide:published_slot', $row($b2b1)['class']);
        $this->assertSame('process_clock', $row($b2b1)['evidence']['payment']);
        $this->assertSame(['shift' => '2026-10-25 17:00:00', 'slot' => '2026-10-26 01:00:00', 'keep' => $n], $row($b2b3)['candidates']);

        $this->assertEqualsCanonicalizing([$b1['id'], $b1p['id'], $b3['id'], $b2b3['id'], $b2b1['id']], $this->refusedIds($plan, 'undecided'));

        // A `slot` decision on the published-slot row is accepted: the doctor's published time (+16 h).
        $decided = $this->classify([$b2b3], [], [], [$slotB2B3], [$b2b3['id'] => 'slot']);
        $this->assertSame([], $decided['refusals']);
        $this->assertSame('slot', $decided['rows'][$b2b3['id']]['action']);
        $this->assertSame('2026-10-26 01:00:00', $decided['rows'][$b2b3['id']]['to']);
        $this->assertSame($this->ts('2026-10-25T17:00:00Z'), $decided['rows'][$b2b3['id']]['new_epoch']);
        $this->assertSame('slot', $decided['rows'][$b2b3['id']]['decided']);
    }

    public function testAPaymentForAnotherTimeIsMovedSincePaymentAndOverridesNothing(): void
    {
        $a    = $this->appt();
        $plan = $this->classify([$a], [], [['id' => $a['id'], 'iso' => '2026-10-26T09:00:00Z']]);

        $this->assertSame('moved_since_payment', $plan['rows'][$a['id']]['evidence']['payment']);
        $this->assertSame('shift:booking_patient_or_backoffice', $plan['rows'][$a['id']]['class']);
        $this->assertSame('shift', $plan['rows'][$a['id']]['action']);
    }

    // ----- §2.3 Step C -----

    public function testDecisionsAreCheckedAgainstTheRows(): void
    {
        $marked   = $this->markedAppt('2026-10-26T09:00:00Z');
        $plain    = $this->appt();
        $unproven = $this->appt(['proposed_by' => 'doctor', 'status' => 'proposed', 'expires_at' => '2030-01-01 00:00:00']);

        $bad = $this->classify([$marked, $plain, $unproven], decisions: [
            $plain['id']  => 'slot',                                        // slot on a non-published row
            $marked['id'] => 'keep',                                        // a marked, consistent row
            '9f1c2a3e-1111-4a2b-9c3d-000000000999' => 'shift',              // no such row
        ]);
        $this->assertEqualsCanonicalizing([$plain['id'], $marked['id'], '9f1c2a3e-1111-4a2b-9c3d-000000000999'], $this->refusedIds($bad, 'bad_decision'));
        $this->assertSame([$unproven['id']], $this->refusedIds($bad, 'undecided'), 'a review row without a decision');
        $this->assertNull($bad['rows'][$unproven['id']]['new_ts'], 'undecided rows have no final time');

        // An override of an automatic class is allowed: `keep` on a shift row is a mark.
        $ok = $this->classify([$plain], decisions: [$plain['id'] => 'keep']);
        $this->assertSame([], $ok['refusals']);
        $this->assertSame('mark', $ok['rows'][$plain['id']]['action']);
        $this->assertSame('keep', $ok['rows'][$plain['id']]['decided']);
    }

    public function testRepeatedDecisionsOnRowsTheRecordedRepairCorrectedChangeNothing(): void
    {
        // Step 4 run again with the same DECIDE: the decided rows are now marked.
        $recorded = ['zone' => 'Asia/Shanghai', 'offset' => 28800, 'at' => '2026-10-15T10:00:00+08:00'];
        $shifted  = $this->markedAppt('2026-10-26T09:00:00Z');
        $slotted  = $this->markedAppt('2026-10-27T09:00:00Z');
        $kept     = $this->markedAppt('2026-10-28T09:00:00Z');
        $inZ      = (new DateTimeImmutable('2026-10-25 17:00:00', $this->z))->getTimestamp();
        $slot     = $this->slot(['starts_at' => '2026-10-25 17:00:00', 'ends_at' => '2026-10-25 17:30:00', 'starts_epoch' => $inZ]);
        $decisions = [$shifted['id'] => 'shift', $slotted['id'] => 'slot', $kept['id'] => 'keep', $slot['id'] => 'shift'];

        $plan = $this->classify([$shifted, $slotted, $kept], slots: [$slot], decisions: $decisions, recorded: $recorded);
        $this->assertSame([], $plan['refusals']);
        foreach ([$shifted, $slotted, $kept] as $row) {
            $this->assertSame('none', $plan['rows'][$row['id']]['action']);
            $this->assertNull($plan['rows'][$row['id']]['decided']);
            $this->assertSame($row['scheduled_at'], $plan['rows'][$row['id']]['to']);
        }
        $this->assertSame('none', $plan['slot_rows'][$slot['id']]['action']);
        $this->assertSame('2026-10-25 17:00:00', $plan['slot_rows'][$slot['id']]['to']);

        // Still refused: before any repair, for a repair recorded for another zone, and `slot` on a slot id.
        $this->assertCount(4, $this->refusedIds($this->classify([$shifted, $slotted, $kept], slots: [$slot], decisions: $decisions), 'bad_decision'));
        $this->assertCount(4, $this->refusedIds($this->classify([$shifted, $slotted, $kept], slots: [$slot], decisions: $decisions, recorded: ['zone' => 'UTC'] + $recorded), 'bad_decision'));
        $this->assertSame([$slot['id']], $this->refusedIds($this->classify([], slots: [$slot], decisions: [$slot['id'] => 'slot'], recorded: $recorded), 'bad_decision'));
    }

    public function testUndecidedRowsAreLeftOutOfTheOverlapRules(): void
    {
        $markedLive = $this->markedAppt('2026-10-25T09:00:00Z');
        $unproven   = $this->appt(['proposed_by' => 'doctor', 'status' => 'proposed', 'expires_at' => '2030-01-01 00:00:00']);
        $plan       = $this->classify([$markedLive, $unproven]);

        $this->assertSame([], $plan['hold_collisions']);
        $this->assertSame(['undecided'], $this->codes($plan));
    }

    // ----- §2.4 Slots -----

    public function testSlotClasses(): void
    {
        $recorded = ['zone' => 'Asia/Shanghai', 'at' => '2026-10-15T10:00:00+08:00'];
        $start    = $this->legacy('2026-10-25T09:00:00Z');
        $inZ      = (new DateTimeImmutable($start, $this->z))->getTimestamp();
        $marked   = $this->slot(['starts_epoch' => $inZ, 'created_at' => '2026-10-16 00:00:00']);
        $mismatch = $this->slot(['starts_epoch' => $inZ - 3600]);
        $late     = $this->slot(['created_at' => '2026-10-16 00:00:00']);
        $legacy   = $this->slot();
        $plan     = $this->classify([], slots: [$marked, $mismatch, $late, $legacy], recorded: $recorded);
        $s        = static fn (array $x): array => $plan['slot_rows'][$x['id']];

        $this->assertSame('none', $s($marked)['action']);
        $this->assertSame('review:marker_mismatch', $s($mismatch)['class']);
        $this->assertSame('undecided', $s($mismatch)['action']);
        $this->assertSame('review:unmarked_after_repair', $s($late)['class']);
        $this->assertSame('shift', $s($legacy)['action']);
        $this->assertSame('2026-10-25 17:00:00', $s($legacy)['to']);
        $this->assertSame('2026-10-25 17:30:00', $s($legacy)['ends_to']);
        $this->assertSame($this->ts('2026-10-25T09:00:00Z'), $s($legacy)['new_epoch']);
        $this->assertEqualsCanonicalizing([$mismatch['id'], $late['id']], $this->refusedIds($plan, 'undecided'));

        $decided = $this->classify([], slots: [$mismatch, $legacy], decisions: [$mismatch['id'] => 'shift', $legacy['id'] => 'slot']);
        $this->assertSame('shift', $decided['slot_rows'][$mismatch['id']]['action']);
        $this->assertSame([$legacy['id']], $this->refusedIds($decided, 'bad_decision'), '`slot` is for appointments only');
    }

    // ----- Pure helpers -----

    public function testHelpers(): void
    {
        $this->assertSame('2026-10-21 17:00:00', ClockRepair::shiftNaive('2026-10-21 09:00:00', new DateTimeZone('PRC')));
        $this->assertSame('2026-10-21 09:00:00', ClockRepair::shiftNaive('2026-10-21 09:00:00', new DateTimeZone('UTC')));

        $from = $this->ts('2026-01-01T00:00:00Z');
        $to   = $this->ts('2027-12-31T00:00:00Z');
        $this->assertSame([28800], ClockRepair::offsets(new DateTimeZone('PRC'), $from, $to));
        $this->assertSame([0], ClockRepair::offsets(new DateTimeZone('UTC'), $from, $to));
        $this->assertCount(2, ClockRepair::offsets(new DateTimeZone('Europe/London'), $from, $to), 'a DST zone: zone_has_transitions');

        $this->assertSame(['checked' => 2, 'mismatched' => 1], ClockRepair::zoneHistory(['2026-10-21T17:00:00+08:00', '2026-10-21T09:00:00+00:00'], new DateTimeZone('PRC')));

        foreach (['55P03', '40P01', '40001'] as $state) {
            $this->assertTrue(ClockRepair::isBusyState($state), $state);
        }
        $this->assertFalse(ClockRepair::isBusyState('23505'));
        $this->assertFalse(ClockRepair::isBusyState(null));
    }

    public function testPlainStatus(): void
    {
        $this->assertSame('would_record', ClockRepair::plainStatus(false, false, null, 'PRC'));
        $this->assertSame('pending', ClockRepair::plainStatus(true, false, null, 'PRC'));
        $this->assertSame('pending', ClockRepair::plainStatus(false, true, null, 'PRC'));
        $this->assertSame('done', ClockRepair::plainStatus(false, false, ['zone' => 'PRC'], 'PRC'));
        $this->assertSame('stragglers', ClockRepair::plainStatus(true, false, ['zone' => 'PRC'], 'PRC'));
        $this->assertSame('refused', ClockRepair::plainStatus(false, false, ['zone' => 'UTC'], 'PRC'));
    }

    public function testParseDecisions(): void
    {
        $this->assertSame(
            [
                '6f1c2a3e-1111-4a2b-9c3d-000000000001' => 'shift',
                '6f1c2a3e-1111-4a2b-9c3d-000000000002' => 'slot',
                '3f2504e0-4f89-41d3-9a0c-0305e82c3301' => 'keep',
            ],
            ClockRepair::parseDecisions([
                '6f1c2a3e-1111-4a2b-9c3d-000000000001:shift,6f1c2a3e-1111-4a2b-9c3d-000000000002:slot',
                '3F2504E0-4F89-41D3-9A0C-0305E82C3301:keep',
            ]),
        );
        $this->assertSame([], ClockRepair::parseDecisions(['', ' , ']));
        $this->assertSame(
            ['6f1c2a3e-1111-4a2b-9c3d-000000000001' => 'keep'],
            ClockRepair::parseDecisions(['6f1c2a3e-1111-4a2b-9c3d-000000000001:keep', '6F1C2A3E-1111-4A2B-9C3D-000000000001:keep']),
            'the same action twice is fine',
        );

        foreach ([
            ['6f1c2a3e-1111-4a2b-9c3d-000000000001:move'],
            ['notauuid:keep'],
            ['x:move'],
            ['6f1c2a3e-1111-4a2b-9c3d-000000000001:shift', '6f1c2a3e-1111-4a2b-9c3d-000000000001:keep'],
        ] as $args) {
            try {
                ClockRepair::parseDecisions($args);
                $this->fail('accepted ' . implode(' ', $args));
            } catch (\InvalidArgumentException) {
                $this->addToAssertionCount(1);
            }
        }
    }

    // ----- §2.5 Document shares -----

    public function testGrantChanges(): void
    {
        // A future legacy booking (25 Oct 09:00Z, stored "09:00", read 01:00Z).
        $future = $this->appt();
        // Two past ones: their after_24h shares have lapsed (one would still be open at the corrected end).
        $past     = $this->appt(['scheduled_at' => $this->legacy('2026-10-18T09:00:00Z')]);
        $recent   = $this->appt(['scheduled_at' => $this->legacy('2026-10-19T13:00:00Z')]);
        $marked   = $this->markedAppt('2026-10-27T09:00:00Z');
        $plan     = $this->classify([$future, $past, $recent, $marked]);

        $g = static fn (string $id, string $appointment, string $duration, ?string $expires, array $o = []): array => $o + [
            'id' => $id, 'appointment_id' => $appointment, 'duration' => $duration, 'status' => 'active',
            'end_reason' => null, 'expires_at' => $expires, 'original_expires_at' => $expires, 'ended_at' => null,
        ];
        $grants = [
            // after_7d from the wrong base: 25 Oct 01:00Z + 30 min + 7 d = 1 Nov 01:30Z = "2026-11-01 09:30:00".
            $g('g-old', $future['id'], 'after_7d', '2026-11-01 09:30:00'),
            // …from the right base (the booking request's in-memory instant).
            $g('g-new', $future['id'], 'after_7d', '2026-11-01 17:30:00'),
            // …capped by something else.
            $g('g-odd', $future['id'], 'after_7d', '2026-10-28 12:00:00'),
            // Lapsed (active, expires_at past now) — never written, listed.
            $g('g-lapsed', $past['id'], 'after_24h', '2026-10-19 09:30:00'),
            $g('g-lapsed-open', $recent['id'], 'after_24h', '2026-10-20 13:30:00'),
            // Ended as expired before the corrected end.
            $g('g-ended', $past['id'], 'after_24h', '2026-10-19 09:30:00', ['status' => 'ended', 'end_reason' => 'expired', 'ended_at' => '2026-10-19 09:31:00']),
            // A marked booking's share is not touched.
            $g('g-marked', $marked['id'], 'after_7d', '2026-11-03 17:30:00'),
        ];
        $out = ClockRepair::grantChanges($grants, $plan['rows'], $this->z, $this->now);

        $changes = [];
        foreach ($out['changes'] as $c) {
            $changes[$c['id'] . ':' . $c['column']] = [$c['from'], $c['to']];
        }
        $this->assertSame([
            'g-old:expires_at'          => ['2026-11-01 09:30:00', '2026-11-01 17:30:00'],
            'g-old:original_expires_at' => ['2026-11-01 09:30:00', '2026-11-01 17:30:00'],
        ], $changes);
        $this->assertSame(2, $out['keep'], 'g-new, both columns');
        $this->assertSame(['g-odd', 'g-odd'], array_column($out['review'], 'id'));

        $early = [];
        foreach ($out['expired_early'] as $e) {
            $early[$e['id']] = $e;
        }
        $this->assertSame(['g-lapsed', 'g-lapsed-open', 'g-ended'], array_keys($early));
        $this->assertFalse($early['g-lapsed']['would_still_be_open']);
        $this->assertTrue($early['g-lapsed-open']['would_still_be_open']);
        $this->assertSame('2026-10-19T17:30:00+08:00', $early['g-lapsed']['corrected_end_iso']);
        $this->assertSame('2026-10-19T09:30:00+08:00', $early['g-lapsed']['ended_iso']);
    }

    // ----- §2.6 Overlaps and holds -----

    public function testANewOverlapWithAMarkedBookingIsRefused(): void
    {
        $marked = $this->markedAppt('2026-10-25T09:00:00Z');
        $later  = $this->appt(['scheduled_at' => $this->legacy('2026-10-25T09:15:00Z')]);
        $plan   = $this->classify([$marked, $later]);
        $this->assertSame(['new_collision'], $this->codes($plan));
        $this->assertCount(1, $plan['new_collisions']);
        $this->assertSame(self::DOC, $plan['new_collisions'][0]['specialist_id']);
        $this->assertSame($marked['id'] . ':confirmed:2026-10-25T17:00:00+08:00', $plan['new_collisions'][0]['rows'][0]);

        $same = $this->appt(['scheduled_at' => $this->legacy('2026-10-25T09:00:00Z')]);
        $this->assertSame(['new_collision'], $this->codes($this->classify([$marked, $same])), 'landing exactly on it');
    }

    public function testOverlapsThatAlreadyExistedAreReportedNotRefused(): void
    {
        $a = $this->appt(['scheduled_at' => $this->legacy('2026-10-25T09:00:00Z')]);
        $b = $this->appt(['scheduled_at' => $this->legacy('2026-10-25T09:15:00Z')]);
        $plan = $this->classify([$a, $b]);
        $this->assertSame([], $plan['refusals']);
        $this->assertCount(1, $plan['live_overlaps_after']);
        $this->assertSame([], $plan['live_slot_duplicates_after']);

        $c = $this->appt(['scheduled_at' => $this->legacy('2026-10-25T09:00:00Z')]);
        $dup = $this->classify([$a, $c]);
        $this->assertSame([], $dup['refusals']);
        $this->assertCount(1, $dup['live_overlaps_after']);
        $this->assertSame([['specialist_id' => self::DOC, 'at' => '2026-10-25 17:00:00', 'ids' => [min($a['id'], $c['id']) . ':confirmed', max($a['id'], $c['id']) . ':confirmed']]], $dup['live_slot_duplicates_after']);

        $d = $this->appt(['scheduled_at' => $this->legacy('2026-10-25T09:30:00Z')]);
        $apart = $this->classify([$a, $d]);
        $this->assertSame([], $apart['live_overlaps_after'], 'exactly one slot apart: half-open, no overlap');

        $marked    = $this->markedAppt('2026-10-25T09:00:00Z');
        $cancelled = $this->appt(['status' => 'cancelled', 'scheduled_at' => $this->legacy('2026-10-25T09:00:00Z')]);
        $deleted   = $this->appt(['deleted' => true, 'scheduled_at' => $this->legacy('2026-10-25T09:10:00Z')]);
        $none      = $this->classify([$marked, $cancelled, $deleted]);
        $this->assertSame([], $none['refusals'], 'cancelled and soft-deleted rows never count');
        $this->assertSame([], $none['new_collisions']);
    }

    public function testAnAcceptableProposalOnACorrectedBookingIsRefused(): void
    {
        $proposalAt = $this->ts('2026-10-25T09:00:00Z');
        $iso        = (new DateTimeImmutable('@' . $proposalAt))->setTimezone($this->z)->format(DATE_ATOM);
        $hold = $this->appt(['proposed_by' => 'doctor', 'status' => 'proposed', 'scheduled_at' => $this->wall('2026-10-25T09:00:00Z'), 'expires_at' => $this->wall('2026-10-21T09:00:00Z')]);
        $live = $this->appt(['scheduled_at' => $this->legacy('2026-10-25T09:15:00Z')]);
        $audit = [['id' => $hold['id'], 'action' => 'appointment.follow_up_proposed', 'iso' => $iso]];

        $plan = $this->classify([$hold, $live], $audit);
        $this->assertSame('mark', $plan['rows'][$hold['id']]['action']);
        $this->assertSame(['hold_collision'], $this->codes($plan));
        $this->assertCount(1, $plan['hold_collisions']);

        $stale = $hold;
        $stale['expires_at'] = $this->wall('2026-10-19T09:00:00Z');
        $plan = $this->classify([$stale, $live], $audit);
        $this->assertSame([], $plan['refusals'], 'a proposal past its expiry can no longer be accepted');
        $this->assertCount(1, $plan['holds_overlap_after']);

        $second = $this->appt(['proposed_by' => 'doctor', 'status' => 'proposed', 'scheduled_at' => $this->legacy('2026-10-25T09:10:00Z'), 'expires_at' => $this->wall('2026-10-21T09:00:00Z')]);
        $plan = $this->classify([$hold, $second], [...$audit, ['id' => $second['id'], 'action' => 'appointment.follow_up_proposed', 'iso' => '2026-10-25T09:10:00+00:00']]);
        $this->assertSame('shift', $plan['rows'][$second['id']]['action'], 'written on the UTC clock');
        $this->assertSame(['hold_collision'], $this->codes($plan), 'two acceptable proposals that overlap');
    }

    public function testBookingsInsideABlockAreReported(): void
    {
        $block  = $this->slot(['kind' => 'block', 'starts_at' => $this->legacy('2026-10-25T08:00:00Z'), 'ends_at' => $this->legacy('2026-10-25T12:00:00Z')]);
        $inside = $this->appt(['scheduled_at' => $this->legacy('2026-10-25T09:00:00Z')]);
        $past   = $this->appt(['scheduled_at' => $this->legacy('2026-10-19T09:00:00Z')]);
        $pastBlock = $this->slot(['kind' => 'block', 'starts_at' => $this->legacy('2026-10-19T08:00:00Z'), 'ends_at' => $this->legacy('2026-10-19T12:00:00Z')]);
        $other  = $this->appt(['specialist_id' => self::OTHER, 'scheduled_at' => $this->legacy('2026-10-25T10:00:00Z')]);

        $plan = $this->classify([$inside, $past, $other], slots: [$block, $pastBlock]);
        $this->assertSame([], $plan['refusals']);
        $this->assertCount(1, $plan['blocked_after']);
        $this->assertSame($inside['id'], $plan['blocked_after'][0]['id']);
        $this->assertSame($block['id'], $plan['blocked_after'][0]['block_id']);
        $this->assertSame('2026-10-25T16:00:00+08:00', $plan['blocked_after'][0]['block_from_iso']);
        $this->assertSame('2026-10-25T20:00:00+08:00', $plan['blocked_after'][0]['block_to_iso']);
    }

    public function testDerivedReports(): void
    {
        $parent = $this->appt(['status' => 'cancelled', 'payment_status' => 'paid', 'refunded_amount' => '0.00', 'closed_at' => '2026-10-25 12:00:00']);
        $child  = $this->markedAppt('2026-11-01T09:00:00Z', ['parent_appointment_id' => $parent['id'], 'priced_follow_up' => true, 'status' => 'proposed', 'expires_at' => '2026-10-30 00:00:00']);
        $live   = $this->appt(['scheduled_at' => $this->legacy('2026-10-26T09:00:00Z')]);
        $plan   = $this->classify([$parent, $child, $live]);

        $this->assertSame([['id' => $child['id'], 'parent_appointment_id' => $parent['id']]], $plan['follow_up_pricing_review']);
        $this->assertCount(1, $plan['money_review']);
        $this->assertTrue($plan['money_review'][0]['closed_before_real_start'], 'closed at 12:00 PRC, the real start was 17:00 PRC');
        $this->assertSame([$live['id']], array_column($plan['upcoming_changed'], 'id'));
        $this->assertSame('2026-10-26T09:00:00+08:00', $plan['upcoming_changed'][0]['from_iso']);
        $this->assertSame('2026-10-26T17:00:00+08:00', $plan['upcoming_changed'][0]['to_iso']);
    }
}
