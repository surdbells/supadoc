<?php

declare(strict_types=1);

namespace App\Infrastructure\Persistence;

use App\Domain\Document\DocumentSharingRules;
use App\Domain\Document\ShareDuration;
use App\Domain\Entity\Appointment;
use App\Domain\Entity\AvailabilitySlot;
use App\Domain\Settings\ProcessClock;
use App\Infrastructure\Service\FollowUpService;
use App\Infrastructure\Service\SlotLock;
use DateTimeImmutable;
use DateTimeZone;
use Doctrine\DBAL\Connection;
use Doctrine\DBAL\Exception\DriverException;
use Doctrine\ORM\EntityManagerInterface;
use Ramsey\Uuid\Uuid;

/**
 * prod-migrate step 13 — the clock repair (DEPLOY.md "One-time: the clock fix").
 *
 * Every timestamp column is naive and is read back on the PHP process clock
 * (php.ini date.timezone — PRC in production). Before the clock fix, the
 * booking paths stored client UTC instants WITHOUT converting them, so those
 * appointments and every availability slot hold the UTC wall-clock of their
 * instant and read back 8 hours early. This step moves them onto the process
 * clock (and the document shares worked out from them), and records that it
 * ran (`app_settings[prod_migrate.clock_repair]`).
 *
 *  - Rows the new code writes carry a marker (`appointments.scheduled_epoch`,
 *    `availability_slots.starts_epoch`: the unix time the writer meant), so a
 *    marked row is never touched and a re-run changes nothing.
 *  - Legacy rows are classified from provenance evidence ({@see classify()});
 *    anything ambiguous needs a person's decision (`--clock-decide`), and a
 *    correction that would make two bookings of one doctor overlap is refused.
 *  - Only a run with `--fix-clock=<zone>` writes anything (rows, audit, the
 *    record) — under the app's slot locks and an EXCLUSIVE table lock, every
 *    write a compare-and-set, all in one transaction.
 *
 * {@see state()} / {@see isPending()} drive the scheduling gate
 * (ClockRepairGateMiddleware), /health/ready and the cron's guard. All time
 * conversion happens in PHP: SQL only moves naive strings (never a Postgres
 * zone name — the 'PRC' alias may be missing there). Reports carry ids,
 * statuses, times and amounts only.
 */
final class ClockRepair
{
    public const SETTING        = 'prod_migrate.clock_repair';
    public const LOCK_TIMEOUT   = '10s';
    public const TOLERANCE      = 60; // seconds, B3
    public const BUSY_SQLSTATES = ['55P03', '40P01', '40001']; // lock timeout, deadlock, serialization failure

    private const NAIVE    = 'YYYY-MM-DD HH24:MI:SS';
    private const ISO      = '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2}|Z)$';
    private const PAY_ISO  = '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:?\d{2}|Z)$';
    private const UUID     = '/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/';
    private const ACTIONS  = ['shift', 'keep', 'slot'];
    private const LIVE     = RawIndexes::LIVE_STATUSES;
    /** The grant columns step 13 may move (a fixed whitelist: the name is spliced into SQL). */
    private const GRANT_COLUMNS = ['expires_at', 'original_expires_at'];
    /** What a report carries, in this order (everything else in a plan is internal). */
    private const REPORT_KEYS = [
        'recorded', 'refusals', 'zone_history', 'counts', 'appointments', 'review', 'slots', 'grants',
        'grants_review', 'grants_expired_early', 'new_collisions', 'hold_collisions', 'live_overlaps_after',
        'live_slot_duplicates_after', 'holds_overlap_after', 'blocked_after', 'upcoming_changed',
        'follow_up_pricing_review', 'money_review',
    ];

    /** @var array<string,string> zone name => 'done' | 'not_needed' (never 'pending') */
    private static array $cache = [];

    // ----- State: the gate, /health/ready and the cron's guard -----

    /**
     * 'not_needed' (the process zone is UTC-equivalent and no repair was
     * recorded for a non-UTC zone: nothing was ever stored on a different
     * clock), 'done' (the repair is recorded for this zone) or 'pending' (not
     * recorded, or recorded for another zone — also when this process now runs
     * on UTC: `date.timezone` changed, or the ini line is gone and PHP fell back
     * to UTC, or the CLI and PHP-FPM disagree. The stored values are on the
     * recorded zone's clock and would read off here).
     */
    public static function state(Connection $conn, ?DateTimeZone $zone = null): string
    {
        $zone ??= ProcessClock::zone();
        $recorded = self::decodeRecorded($conn->fetchOne('SELECT value FROM app_settings WHERE setting_key = ?', [self::SETTING]));
        if (self::utcEquivalent($zone)) {
            return $recorded === null || self::recordedUtcEquivalent($recorded) ? 'not_needed' : 'pending';
        }

        return $recorded !== null && ($recorded['zone'] ?? null) === $zone->getName() ? 'done' : 'pending';
    }

    /**
     * Whether scheduling writes (and the cron) must wait for the repair.
     * 'done' / 'not_needed' are cached per zone for the rest of this process
     * (one request, one cron run); 'pending' is never cached. Every zone reads
     * the recorded repair once (a UTC process too: a repair recorded for
     * another zone pauses it).
     */
    public static function isPending(Connection $conn): bool
    {
        $name = date_default_timezone_get();
        if (isset(self::$cache[$name])) {
            return false;
        }
        $state = self::state($conn, ProcessClock::zone());
        if ($state !== 'pending') {
            self::$cache[$name] = $state;
        }

        return $state === 'pending';
    }

    /** For tests: forget the cached states. */
    public static function resetCache(): void
    {
        self::$cache = [];
    }

    /**
     * Whether the marker can be written: this process's entity mappings have both
     * marker fields AND the database has both columns. Stale cached mappings (an old
     * worker refilled the cache during a deploy) fail the first; a schema update that
     * ran on stale mappings, and so never added the columns, fails the second.
     */
    public static function markerReady(EntityManagerInterface $em): bool
    {
        if (!$em->getClassMetadata(Appointment::class)->hasField('scheduledEpoch')
            || !$em->getClassMetadata(AvailabilitySlot::class)->hasField('startsEpoch')) {
            return false;
        }

        return (int) $em->getConnection()->fetchOne(
            "SELECT count(*) FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND ((table_name = 'appointments' AND column_name = 'scheduled_epoch')
                  OR (table_name = 'availability_slots' AND column_name = 'starts_epoch'))",
        ) === 2;
    }

    // ----- Flags -----

    /**
     * @param list<string> $args the raw values of every --clock-decide= flag
     * @return array<string,'shift'|'keep'|'slot'> lower-case id => action
     * @throws \InvalidArgumentException
     */
    public static function parseDecisions(array $args): array
    {
        $decisions = [];
        foreach ($args as $arg) {
            foreach (explode(',', (string) $arg) as $item) {
                $item = trim($item);
                if ($item === '') {
                    continue;
                }
                $parts = explode(':', $item);
                if (count($parts) !== 2 || preg_match(self::UUID, $parts[0]) !== 1 || !in_array($parts[1], self::ACTIONS, true)) {
                    throw new \InvalidArgumentException(sprintf('"%s" is not <id>:<shift|keep|slot> (the id is an appointment or availability slot uuid)', $item));
                }
                $id = strtolower($parts[0]);
                if (isset($decisions[$id]) && $decisions[$id] !== $parts[1]) {
                    throw new \InvalidArgumentException(sprintf('%s is given both %s and %s', $id, $decisions[$id], $parts[1]));
                }
                $decisions[$id] = $parts[1];
            }
        }

        return $decisions;
    }

    // ----- Pure rules (§2.3, §2.4, §2.6) -----

    /**
     * Classify every appointment and availability slot, apply the decisions and
     * work out the overlaps the corrected times would make.
     *
     * @param list<array<string,mixed>> $appointments    Q1 rows
     * @param list<array<string,mixed>> $auditEvidence   Q2 rows {id, action, iso}
     * @param list<array<string,mixed>> $paymentEvidence Q3 rows {id, iso}
     * @param list<array<string,mixed>> $slots           Q4 rows
     * @param array<string,string>      $decisions       lower-case id => shift|keep|slot
     * @param array<string,mixed>|null  $recorded        the recorded repair (R)
     * @return array<string,mixed>
     */
    public static function classify(
        array $appointments,
        array $auditEvidence,
        array $paymentEvidence,
        array $slots,
        DateTimeZone $zone,
        DateTimeImmutable $now,
        array $decisions,
        ?array $recorded,
    ): array {
        $nowTs      = $now->getTimestamp();
        $recordedAt = self::recordedAt($recorded);
        // Once the repair is recorded for this zone, a decision on a marked, consistent
        // row is the repeat of one the repair already applied (step 4 run again with the
        // same DECIDE): nothing to do, not a refusal.
        $repeatable = $recorded !== null && ($recorded['zone'] ?? null) === $zone->getName();
        $audit      = self::evidence($auditEvidence);
        $payment    = self::evidence($paymentEvidence);
        $refusals   = ['undecided' => [], 'bad_decision' => []];
        $used       = [];

        // Open slots the old code published (unmarked), by doctor and stored start.
        $published = [];
        foreach ($slots as $s) {
            if ((string) $s['kind'] === 'open' && self::int($s['starts_epoch'] ?? null) === null) {
                $published[strtolower((string) $s['specialist_id']) . '|' . (string) $s['starts_at']] = (string) $s['starts_at'];
            }
        }

        $rows = [];
        foreach ($appointments as $a) {
            $id            = strtolower((string) $a['id']);
            $specialist    = strtolower((string) $a['specialist_id']);
            $status        = (string) $a['status'];
            $n             = (string) $a['scheduled_at'];
            $epoch         = self::int($a['scheduled_epoch'] ?? null);
            $expires       = self::str($a['expires_at'] ?? null);
            $created       = (string) $a['created_at'];
            $proposedBy    = self::str($a['proposed_by'] ?? null);
            $rescheduledBy = self::str($a['rescheduled_by'] ?? null);
            $inZ           = self::inZ($n, $zone);
            $utc           = self::utc($n);
            $sh            = self::shiftNaive($n, $zone);
            $createdTs     = self::inZ($created, $zone);
            $followUp      = $audit[$id] ?? null;
            $paid          = $payment[$id]['ts'] ?? null;
            $slotStart     = $published[$specialist . '|' . $sh] ?? null;

            // Step A: the base class, from provenance.
            $legacy = false;
            if ($epoch !== null && $epoch === $inZ) {
                $base = 'keep:marked';
            } elseif ($epoch !== null) {
                $base = 'review:marker_mismatch';
            } elseif ($recordedAt !== null && $createdTs > $recordedAt) {
                $base = 'review:unmarked_after_repair';
            } else {
                $legacy = true;
                if ($proposedBy === 'doctor' && $rescheduledBy === null) {
                    if ($followUp !== null && $followUp['ts'] === $inZ) {
                        $base = 'keep:proposal_parsestart';
                    } elseif ($followUp !== null && $followUp['ts'] === $utc) {
                        $base = 'shift:proposal_written_on_utc_clock';
                    } elseif ($followUp !== null && $followUp['action'] === 'appointment.follow_up_accepted' && $status !== 'proposed') {
                        $base = 'shift:proposal_moved_after_accept';
                    } elseif ($followUp === null && $expires !== null
                        && $expires === self::minusHours($n, FollowUpService::CLOSE_HOURS_BEFORE_START)) {
                        $base = 'keep:proposal_parsestart_by_expiry';
                    } else {
                        $base = 'review:proposal_unproven';
                    }
                } elseif ($proposedBy === 'doctor') {
                    $base = 'shift:proposal_then_rescheduled_by_' . $rescheduledBy;
                } elseif ($rescheduledBy !== null) {
                    $base = 'shift:rescheduled_by_' . $rescheduledBy;
                } elseif ($status === 'rescheduled') {
                    $base = 'shift:rescheduled_before_rescheduled_by_existed';
                } elseif ($proposedBy === 'patient') {
                    $base = 'shift:patient_follow_up_booking';
                } else {
                    $base = 'shift:booking_patient_or_backoffice';
                }
            }
            $isShift            = str_starts_with($base, 'shift:');
            $isKeep             = str_starts_with($base, 'keep:');
            $startsBeforeBooked = ($isShift ? $utc : $inZ) < $createdTs - self::TOLERANCE;
            $paymentSignal      = $paid === null ? null : ($paid === $utc ? 'utc_clock' : ($paid === $inZ ? 'process_clock' : 'moved_since_payment'));

            // Step B: evidence overrides — first match wins: B2, B1, B1′, B3.
            $class = $base;
            if ($legacy) {
                if ($isShift && $slotStart !== null) {
                    $class = 'decide:published_slot';
                } elseif ($isShift && $paid !== null && $paid === $inZ) {
                    $class = 'review:payment_says_process_clock';
                } elseif ($isKeep && $paid !== null && $paid === $utc) {
                    $class = 'review:payment_says_utc_clock';
                } elseif (($isShift || $isKeep) && $startsBeforeBooked) {
                    $class = 'review:starts_before_booked';
                }
            }

            $auto = match (true) {
                $class === 'keep:marked'                                                => 'none',
                str_starts_with($class, 'review:') || str_starts_with($class, 'decide:') => 'undecided',
                str_starts_with($class, 'keep:')                                        => 'mark',
                default                                                                 => 'shift',
            };

            // Step C: decisions.
            $action  = $auto;
            $decided = null;
            if (isset($decisions[$id])) {
                $used[$id] = true;
                $decision  = $decisions[$id];
                if ($auto === 'none' && $repeatable) {
                    // Already applied: the row stays as it is.
                } elseif ($auto === 'none' || ($decision === 'slot' && $class !== 'decide:published_slot')) {
                    $refusals['bad_decision'][] = $id;
                } else {
                    $decided = $decision;
                    $action  = match ($decision) {
                        'shift' => 'shift',
                        'slot'  => 'slot',
                        default => $epoch === null ? 'mark' : 'keep',
                    };
                }
            } elseif ($auto === 'undecided') {
                $refusals['undecided'][] = $id;
            }

            [$to, $newTs, $newEpoch] = match ($action) {
                'shift'      => [$sh, $utc, $utc],
                'slot'       => [self::shiftNaive((string) $slotStart, $zone), self::utc((string) $slotStart), self::utc((string) $slotStart)],
                'mark', 'keep' => [$n, $inZ, $inZ],
                'none'       => [$n, $inZ, $epoch],
                default      => [$n, null, $epoch], // undecided: left out of the overlap rules
            };

            $row = [
                'id'                => $id,
                'specialist_id'     => $specialist,
                'status'            => $status,
                'deleted'           => self::bool($a['deleted'] ?? false),
                'base_class'        => $base,
                'class'             => $class,
                'action'            => $action,
                'decided'           => $decided,
                'from'              => $n,
                'to'                => $to,
                'to_iso'            => $newTs !== null ? self::iso($newTs, $zone) : null,
                'from_ts'           => $inZ,
                'before_ts'         => $utc,
                'new_ts'            => $newTs,
                'old_epoch'         => $epoch,
                'new_epoch'         => $newEpoch,
                'created_ts'        => $createdTs,
                'expires_ts'        => $expires !== null ? self::inZ($expires, $zone) : null,
                'slot_minutes'      => max(1, (int) ($a['slot_minutes'] ?? 30)),
                'parent_id'         => self::str($a['parent_appointment_id'] ?? null) !== null ? strtolower((string) $a['parent_appointment_id']) : null,
                'priced_follow_up'  => self::bool($a['priced_follow_up'] ?? false),
                'payment_status'    => self::str($a['payment_status'] ?? null),
                'amount'            => self::str($a['amount'] ?? null),
                'refunded_amount'   => self::str($a['refunded_amount'] ?? null),
                'closure_reason'    => self::str($a['closure_reason'] ?? null),
                'closed_ts'         => self::str($a['closed_at'] ?? null) !== null ? self::inZ((string) $a['closed_at'], $zone) : null,
                'evidence'          => [
                    'payment'              => $paymentSignal,
                    'published_slot'       => $slotStart !== null,
                    'starts_before_booked' => $startsBeforeBooked,
                ],
            ];
            if ($auto === 'undecided') {
                // What each decision would store (`slot`: the doctor's published time, +16 h on PRC).
                $row['candidates'] = ['shift' => $sh]
                    + ($class === 'decide:published_slot' ? ['slot' => self::shiftNaive((string) $slotStart, $zone)] : [])
                    + ['keep' => $n];
            }
            $rows[$id] = $row;
        }

        // §2.4 Availability slots.
        $slotRows = [];
        foreach ($slots as $s) {
            $id      = strtolower((string) $s['id']);
            $start   = (string) $s['starts_at'];
            $end     = (string) $s['ends_at'];
            $epoch   = self::int($s['starts_epoch'] ?? null);
            $inZ     = self::inZ($start, $zone);
            $created = self::inZ((string) $s['created_at'], $zone);
            if ($epoch !== null && $epoch === $inZ) {
                [$class, $auto] = ['keep:marked', 'none'];
            } elseif ($epoch !== null) {
                [$class, $auto] = ['review:marker_mismatch', 'undecided'];
            } elseif ($recordedAt !== null && $created > $recordedAt) {
                [$class, $auto] = ['review:unmarked_after_repair', 'undecided'];
            } else {
                [$class, $auto] = ['shift:written_on_utc_clock', 'shift'];
            }
            $action  = $auto;
            $decided = null;
            if (isset($decisions[$id])) {
                $used[$id] = true;
                if ($decisions[$id] !== 'slot' && $auto === 'none' && $repeatable) {
                    // Already applied: the slot stays as it is.
                } elseif ($auto === 'none' || $decisions[$id] === 'slot') {
                    $refusals['bad_decision'][] = $id;
                } else {
                    $decided = $decisions[$id];
                    $action  = $decided === 'shift' ? 'shift' : ($epoch === null ? 'mark' : 'keep');
                }
            } elseif ($auto === 'undecided') {
                $refusals['undecided'][] = $id;
            }
            $shift = $action === 'shift';
            $slotRows[$id] = [
                'id'            => $id,
                'specialist_id' => strtolower((string) $s['specialist_id']),
                'kind'          => (string) $s['kind'],
                'class'         => $class,
                'action'        => $action,
                'decided'       => $decided,
                'from'          => $start,
                'to'            => $shift ? self::shiftNaive($start, $zone) : $start,
                'ends_from'     => $end,
                'ends_to'       => $shift ? self::shiftNaive($end, $zone) : $end,
                'old_epoch'     => $epoch,
                'new_epoch'     => match ($action) {
                    'shift'        => self::utc($start),
                    'mark', 'keep' => $inZ,
                    default        => $epoch,
                },
                // The final interval [from, to): undecided slots are left out (null).
                'final_from'    => $action === 'undecided' ? null : ($shift ? self::utc($start) : $inZ),
                'final_to'      => $action === 'undecided' ? null : ($shift ? self::utc($end) : self::inZ($end, $zone)),
            ] + ($auto === 'undecided' ? ['candidates' => ['shift' => self::shiftNaive($start, $zone), 'keep' => $start]] : []);
        }

        foreach ($decisions as $id => $decision) {
            if (!isset($used[$id])) {
                $refusals['bad_decision'][] = $id; // no such appointment or slot
            }
        }

        $overlaps = self::overlaps($rows, $slotRows, $zone, $nowTs);

        // §2.5 Reported, never changed.
        $pricing  = [];
        $money    = [];
        $upcoming = [];
        foreach ($rows as $r) {
            $moved = in_array($r['action'], ['shift', 'slot'], true);
            if (!$moved) {
                continue;
            }
            foreach ($rows as $child) {
                if ($child['parent_id'] === $r['id'] && $child['priced_follow_up']) {
                    $pricing[] = ['id' => $child['id'], 'parent_appointment_id' => $r['id']];
                }
            }
            if (in_array($r['status'], ['cancelled', 'missed'], true) && in_array($r['payment_status'], ['paid', 'refunded'], true)) {
                $amount   = $r['amount'] ?? '0';
                $refunded = $r['refunded_amount'] ?? ($r['payment_status'] === 'refunded' ? $amount : '0');
                if (bccomp($refunded, $amount, 2) < 0) {
                    $money[] = [
                        'id'                       => $r['id'],
                        'status'                   => $r['status'],
                        'payment_status'           => $r['payment_status'],
                        'amount'                   => $amount,
                        'refunded_amount'          => $r['refunded_amount'],
                        'closure_reason'           => $r['closure_reason'],
                        'closed_before_real_start' => $r['closed_ts'] !== null && $r['closed_ts'] < $r['new_ts'],
                    ];
                }
            }
            if (!$r['deleted'] && in_array($r['status'], [...self::LIVE, 'proposed'], true) && $r['new_ts'] > $nowTs) {
                $upcoming[] = ['id' => $r['id'], 'status' => $r['status'], 'from_iso' => self::iso($r['from_ts'], $zone), 'to_iso' => $r['to_iso']];
            }
        }

        $refusalList = [];
        foreach (['undecided', 'bad_decision'] as $code) {
            if ($refusals[$code] !== []) {
                $ids = array_values(array_unique($refusals[$code]));
                sort($ids);
                $refusalList[] = ['code' => $code, 'ids' => $ids];
            }
        }
        if ($overlaps['new_collisions'] !== []) {
            $refusalList[] = ['code' => 'new_collision', 'count' => count($overlaps['new_collisions'])];
        }
        if ($overlaps['hold_collisions'] !== []) {
            $refusalList[] = ['code' => 'hold_collision', 'count' => count($overlaps['hold_collisions'])];
        }

        return [
            'rows'                     => $rows,
            'slot_rows'                => $slotRows,
            'refusals'                 => $refusalList,
            'upcoming_changed'         => $upcoming,
            'follow_up_pricing_review' => $pricing,
            'money_review'             => $money,
        ] + $overlaps;
    }

    /**
     * §2.5: the document shares anchored to a moved consultation. Open ones are
     * recomputed (old-based → new-based), lapsed ones are never written (never
     * revived) and are listed when they ended before the corrected end.
     *
     * @param list<array<string,mixed>>         $grants          Q5 rows
     * @param array<string,array<string,mixed>> $appointmentPlan {@see classify()}['rows']
     * @return array{changes: list<array<string,mixed>>, keep: int, review: list<array<string,mixed>>, expired_early: list<array<string,mixed>>}
     */
    public static function grantChanges(array $grants, array $appointmentPlan, DateTimeZone $zone, DateTimeImmutable $now): array
    {
        $nowTs = $now->getTimestamp();
        $out   = ['changes' => [], 'keep' => 0, 'review' => [], 'expired_early' => []];
        foreach ($grants as $g) {
            $appointmentId = strtolower((string) ($g['appointment_id'] ?? ''));
            $row           = $appointmentPlan[$appointmentId] ?? null;
            $duration      = ShareDuration::tryFrom((string) ($g['duration'] ?? ''));
            if ($row === null || !in_array($row['action'], ['shift', 'slot'], true) || $duration === null || !$duration->isAnchored()) {
                continue;
            }
            $id      = strtolower((string) $g['id']);
            $minutes = (int) $row['slot_minutes'] * 60;
            $oldEnd  = self::plusOffset((int) $row['from_ts'] + $minutes, $duration, $zone);
            $newEnd  = self::plusOffset((int) $row['new_ts'] + $minutes, $duration, $zone);
            $status  = (string) $g['status'];
            $expires = self::str($g['expires_at'] ?? null);
            $expTs   = $expires !== null ? self::inZ($expires, $zone) : null;
            $lapsed  = $status === 'active' && $expTs !== null && $expTs <= $nowTs;
            $open    = $status === 'active' && ($expTs === null || $expTs > $nowTs);

            if ($open) {
                foreach (self::GRANT_COLUMNS as $column) {
                    $value = self::str($g[$column] ?? null);
                    if ($value === null) {
                        continue;
                    }
                    $at = self::inZ($value, $zone);
                    if ($at === $oldEnd) {
                        $out['changes'][] = ['id' => $id, 'appointment_id' => $appointmentId, 'column' => $column, 'from' => $value, 'to' => self::naive($newEnd, $zone)];
                    } elseif ($at === $newEnd) {
                        ++$out['keep'];
                    } else {
                        $out['review'][] = ['id' => $id, 'appointment_id' => $appointmentId, 'column' => $column, 'at' => $value];
                    }
                }
            }

            $endedAt = self::str($g['ended_at'] ?? null);
            $ended   = null;
            if ($lapsed && $expTs < $newEnd) {
                $ended = $expTs;
            } elseif ($status !== 'active' && self::str($g['end_reason'] ?? null) === 'expired' && $endedAt !== null && self::inZ($endedAt, $zone) < $newEnd) {
                $ended = self::inZ($endedAt, $zone);
            }
            if ($ended !== null) {
                $out['expired_early'][] = [
                    'id'                  => $id,
                    'appointment_id'      => $appointmentId,
                    'ended_iso'           => self::iso($ended, $zone),
                    'corrected_end_iso'   => self::iso($newEnd, $zone),
                    'would_still_be_open' => $newEnd > $nowTs,
                ];
            }
        }

        return $out;
    }

    /** A plain run's status (§2.7): refused / done / stragglers / pending / would_record. @param array<string,mixed>|null $recorded */
    public static function plainStatus(bool $changes, bool $refusals, ?array $recorded, string $zoneName): string
    {
        if ($recorded !== null) {
            if (($recorded['zone'] ?? null) !== $zoneName) {
                return 'refused';
            }

            return $changes ? 'stragglers' : 'done';
        }

        return $changes || $refusals ? 'pending' : 'would_record';
    }

    /** Whether a DriverException's SQLSTATE means "re-run" (lock timeout, deadlock, serialization failure). */
    public static function isBusyState(?string $sqlState): bool
    {
        return $sqlState !== null && in_array($sqlState, self::BUSY_SQLSTATES, true);
    }

    /** A stored naive time read as UTC, expressed in `$zone` ("09:00" → "17:00" on PRC). */
    public static function shiftNaive(string $naive, DateTimeZone $zone): string
    {
        return self::naive(self::utc($naive), $zone);
    }

    /** @return list<int> the distinct UTC offsets (seconds) `$zone` has between two unix times */
    public static function offsets(DateTimeZone $zone, int $from, int $to): array
    {
        $offsets = [];
        foreach ($zone->getTransitions($from, max($from, $to)) ?: [] as $transition) {
            $offsets[] = (int) $transition['offset'];
        }
        if ($offsets === []) {
            $offsets[] = $zone->getOffset(new DateTimeImmutable('@' . $from));
        }
        $offsets = array_values(array_unique($offsets));
        sort($offsets);

        return $offsets;
    }

    /**
     * How many ISO strings PHP wrote carry an offset other than `$zone`'s at
     * that instant (a sign PHP did not always run on this zone).
     *
     * @param list<string> $isoStrings
     * @return array{checked:int, mismatched:int}
     */
    public static function zoneHistory(array $isoStrings, DateTimeZone $zone): array
    {
        $checked    = 0;
        $mismatched = 0;
        foreach ($isoStrings as $iso) {
            try {
                $at = new DateTimeImmutable((string) $iso);
            } catch (\Throwable) {
                continue;
            }
            ++$checked;
            if ($at->getOffset() !== $zone->getOffset($at)) {
                ++$mismatched;
            }
        }

        return ['checked' => $checked, 'mismatched' => $mismatched];
    }

    // ----- Read-only plan -----

    /**
     * Fetch everything and plan (no locks, no writes).
     *
     * @param array<string,string> $decisions
     * @return array<string,mixed>
     */
    public static function plan(Connection $conn, DateTimeZone $zone, DateTimeImmutable $now, array $decisions): array
    {
        $f        = self::NAIVE;
        $recorded = self::decodeRecorded($conn->fetchOne('SELECT value FROM app_settings WHERE setting_key = :k', ['k' => self::SETTING]));

        $appointments = $conn->fetchAllAssociative(
            "SELECT a.id::text AS id, a.specialist_id::text AS specialist_id, a.status, a.proposed_by, a.rescheduled_by,
                    a.parent_appointment_id::text AS parent_appointment_id,
                    a.payment_status, a.amount::text AS amount, a.refunded_amount::text AS refunded_amount, a.closure_reason,
                    to_char(a.closed_at, '{$f}') AS closed_at, to_char(a.scheduled_at, '{$f}') AS scheduled_at, a.scheduled_epoch,
                    to_char(a.expires_at, '{$f}') AS expires_at, to_char(a.created_at, '{$f}') AS created_at,
                    a.deleted_at IS NOT NULL AS deleted,
                    a.follow_up_pricing IS NOT NULL AS priced_follow_up,
                    s.slot_minutes
               FROM appointments a JOIN specialists s ON s.id = a.specialist_id
              ORDER BY a.scheduled_at, a.id",
        );
        $audit = $conn->fetchAllAssociative(
            "SELECT DISTINCT ON (e.resource_id) e.resource_id AS id, e.action, e.metadata->>'scheduled_at' AS iso
               FROM audit_events e
              WHERE e.resource_type = 'appointment'
                AND e.action IN ('appointment.follow_up_proposed', 'appointment.follow_up_accepted')
                AND json_typeof(e.metadata) = 'object'
                AND e.metadata->>'scheduled_at' ~ '" . self::ISO . "'
              ORDER BY e.resource_id, e.created_at DESC, (e.action = 'appointment.follow_up_accepted') DESC",
        );
        $payments = $conn->fetchAllAssociative(
            "SELECT DISTINCT ON (i.consumed_by) i.consumed_by AS id, i.context->>'scheduled_at' AS iso
               FROM payment_intents i
              WHERE i.consumed_by IS NOT NULL
                AND json_typeof(i.context) = 'object'
                AND i.context->>'scheduled_at' ~ '" . self::PAY_ISO . "'
              ORDER BY i.consumed_by, i.created_at DESC",
        );
        $slots = $conn->fetchAllAssociative(
            "SELECT id::text AS id, specialist_id::text AS specialist_id, kind,
                    to_char(starts_at, '{$f}') AS starts_at, to_char(ends_at, '{$f}') AS ends_at, starts_epoch,
                    to_char(created_at, '{$f}') AS created_at
               FROM availability_slots
              ORDER BY starts_at, id",
        );
        $grants = $conn->fetchAllAssociative(
            "SELECT id::text AS id, appointment_id::text AS appointment_id, duration, status, end_reason,
                    to_char(expires_at, '{$f}') AS expires_at, to_char(original_expires_at, '{$f}') AS original_expires_at,
                    to_char(ended_at, '{$f}') AS ended_at
               FROM document_access_grants
              WHERE appointment_id IS NOT NULL AND duration IN ('after_24h', 'after_7d', 'after_30d')
              ORDER BY id",
        );

        // Q6: ISO strings only PHP wrote (PHP-FPM, or the cron's CLI) — never prod-migrate's settings.
        $sources = [
            'guests.invited_at' => $conn->fetchFirstColumn(
                "SELECT g->>'invited_at'
                   FROM appointments a
                  CROSS JOIN LATERAL json_array_elements(CASE WHEN json_typeof(a.guests) = 'array' THEN a.guests ELSE '[]'::json END) g
                  WHERE json_typeof(g) = 'object' AND g->>'invited_at' ~ '" . self::ISO . "'",
            ),
            'audit.follow_up_*' => $conn->fetchFirstColumn(
                "SELECT e.metadata->>k.key
                   FROM audit_events e
                  CROSS JOIN LATERAL (VALUES ('scheduled_at'), ('expires_at')) k(key)
                  WHERE e.action IN ('appointment.follow_up_proposed', 'appointment.follow_up_accepted', 'appointment.follow_up_expired')
                    AND json_typeof(e.metadata) = 'object'
                    AND e.metadata->>k.key ~ '" . self::ISO . "'",
            ),
        ];
        $history = ['checked' => 0, 'mismatched' => 0, 'by_source' => [], 'mismatched_by_source' => []];
        foreach ($sources as $source => $isoStrings) {
            $counts                                   = self::zoneHistory(array_map('strval', $isoStrings), $zone);
            $history['checked']                      += $counts['checked'];
            $history['mismatched']                   += $counts['mismatched'];
            $history['by_source'][$source]            = $counts['checked'];
            $history['mismatched_by_source'][$source] = $counts['mismatched'];
        }

        $plan   = self::classify($appointments, $audit, $payments, $slots, $zone, $now, $decisions, $recorded);
        $grants = self::grantChanges($grants, $plan['rows'], $zone, $now);

        $refusals = $plan['refusals'];
        if ($history['mismatched'] > 0) {
            $refusals[] = ['code' => 'zone_history', 'by_source' => $history['mismatched_by_source']];
        }
        // One offset over everything stored (both readings of each value), ±2 days, and now.
        $instants = [$now->getTimestamp()];
        foreach ($plan['rows'] as $r) {
            $instants[] = $r['from_ts'];
            $instants[] = $r['before_ts'];
        }
        foreach ($slots as $s) {
            $instants[] = self::inZ((string) $s['starts_at'], $zone);
            $instants[] = self::utc((string) $s['starts_at']);
        }
        $offsets = array_values(array_unique([
            ...self::offsets($zone, min($instants) - 2 * 86400, max($instants) + 2 * 86400),
            $zone->getOffset($now),
        ]));
        sort($offsets);
        if (count($offsets) > 1) {
            $refusals[] = ['code' => 'zone_has_transitions', 'offsets' => $offsets];
        }
        if ($recorded !== null && ($recorded['zone'] ?? null) !== $zone->getName()) {
            $refusals[] = ['code' => 'recorded_for_other_zone', 'recorded_zone' => (string) ($recorded['zone'] ?? '')];
        }

        // The writes, in the order they run (§2.8 step 9).
        $moves = [];
        $marks = [];
        foreach ($plan['rows'] as $r) {
            if (in_array($r['action'], ['shift', 'slot', 'keep'], true)) {
                $moves[] = ['type' => 'appointment', 'id' => $r['id'], 'new' => $r['to'], 'e' => $r['new_epoch'], 'old' => $r['from'], 'oe' => $r['old_epoch']];
            } elseif ($r['action'] === 'mark') {
                $marks[] = ['type' => 'mark', 'id' => $r['id'], 'e' => $r['new_epoch'], 'old' => $r['from']];
            }
        }
        // Descending by the new start, every shift positive: a row moving onto a
        // time is always written after the row there has moved on (the live-slot index).
        usort($moves, static fn (array $x, array $y): int => [$y['new'], $y['id']] <=> [$x['new'], $x['id']]);
        $slotWrites = [];
        foreach ($plan['slot_rows'] as $s) {
            if (in_array($s['action'], ['shift', 'mark', 'keep'], true)) {
                $slotWrites[] = ['type' => 'slot', 'id' => $s['id'], 's' => $s['to'], 'en' => $s['ends_to'], 'e' => $s['new_epoch'], 'os' => $s['from'], 'oen' => $s['ends_from'], 'oe' => $s['old_epoch']];
            }
        }
        $grantWrites = [];
        foreach ($grants['changes'] as $g) {
            $grantWrites[] = ['type' => 'grant', 'id' => $g['id'], 'appointment_id' => $g['appointment_id'], 'column' => $g['column'], 'new' => $g['to'], 'old' => $g['from']];
        }
        $writes = [...$moves, ...$marks, ...$slotWrites, ...$grantWrites];

        $specialists = [];
        $changing    = [];
        foreach ([...$moves, ...$marks] as $w) {
            $specialists[] = $plan['rows'][$w['id']]['specialist_id'];
            $changing[]    = 'appointment:' . $w['id'];
        }
        foreach ($slotWrites as $w) {
            $specialists[] = $plan['slot_rows'][$w['id']]['specialist_id'];
            $changing[]    = 'slot:' . $w['id'];
        }
        foreach ($grantWrites as $w) {
            $specialists[] = $plan['rows'][$w['appointment_id']]['specialist_id'];
            $changing[]    = 'grant:' . $w['id'] . ':' . $w['column'];
        }
        $specialists = array_values(array_unique($specialists));
        sort($specialists);
        sort($changing);
        $undecided = false;
        foreach ([...array_values($plan['rows']), ...array_values($plan['slot_rows'])] as $r) {
            $undecided = $undecided || $r['action'] === 'undecided';
        }

        return [
            'recorded'     => $recorded,
            'refusals'     => $refusals,
            'zone_history' => ['checked' => $history['checked'], 'mismatched' => $history['mismatched'], 'by_source' => $history['by_source']]
                + ($history['mismatched'] > 0 ? ['mismatched_by_source' => $history['mismatched_by_source']] : []),
            'counts'       => self::counts($plan['rows'], $plan['slot_rows'], $grants),
            'appointments' => self::appointmentListing($plan['rows']),
            'review'       => self::reviewListing($plan['rows'], $plan['slot_rows']),
            'slots'        => self::slotListing($plan['slot_rows']),
            'grants'       => $grants['changes'],
            'grants_review'        => $grants['review'],
            'grants_expired_early' => $grants['expired_early'],
            'new_collisions'             => $plan['new_collisions'],
            'hold_collisions'            => $plan['hold_collisions'],
            'live_overlaps_after'        => $plan['live_overlaps_after'],
            'live_slot_duplicates_after' => $plan['live_slot_duplicates_after'],
            'holds_overlap_after'        => $plan['holds_overlap_after'],
            'blocked_after'              => $plan['blocked_after'],
            'upcoming_changed'           => $plan['upcoming_changed'],
            'follow_up_pricing_review'   => $plan['follow_up_pricing_review'],
            'money_review'               => $plan['money_review'],
            // Internal (not reported):
            'rows'        => $plan['rows'],
            'slot_rows'   => $plan['slot_rows'],
            'writes'      => $writes,
            'specialists' => $specialists,
            'changing'    => $changing,
            'changes'     => $writes !== [] || $undecided,
        ];
    }

    // ----- prod-migrate step 13 -----

    /**
     * prod-migrate step 13. `$beforeWrite` is a test seam only (called with the
     * connection after plan₁, before the first write); production passes null.
     *
     * @param array<string,string> $decisions lower-case id => shift|keep|slot ({@see parseDecisions()})
     * @return array<string,mixed> the report (§2.10)
     */
    public static function run(
        EntityManagerInterface $em,
        ?string $fixZone,
        array $decisions,
        bool $dryRun,
        ?DateTimeImmutable $now = null,
        string $lockTimeout = self::LOCK_TIMEOUT,
        ?\Closure $beforeWrite = null,
    ): array {
        if (preg_match('/^\d{1,6}(ms|s)$/', $lockTimeout) !== 1) {
            throw new \InvalidArgumentException('lock timeout like "10s" or "500ms"');
        }
        $zoneName = date_default_timezone_get();
        $zone     = ProcessClock::zone();
        if ($fixZone !== null && $fixZone !== $zoneName) {
            return ['status' => 'refused', 'zone' => $zoneName, 'refusals' => [['code' => 'zone_mismatch', 'fix_clock' => $fixZone, 'cli_zone' => $zoneName]]];
        }
        $now = ($now ?? new DateTimeImmutable('@' . time()))->setTimezone($zone);
        if (self::utcEquivalent($zone)) {
            // A repair recorded for a non-UTC zone means the stored values are on that
            // zone's clock: this process (date.timezone changed, or missing and PHP fell
            // back to UTC) would read them off. Refuse, as for any other zone.
            $recorded = self::decodeRecorded($em->getConnection()->fetchOne('SELECT value FROM app_settings WHERE setting_key = ?', [self::SETTING]));
            if ($recorded !== null && !self::recordedUtcEquivalent($recorded)) {
                return [
                    'status'         => 'refused',
                    'zone'           => $zoneName,
                    'offset_seconds' => $zone->getOffset($now),
                    'refusals'       => [['code' => 'recorded_for_other_zone', 'recorded_zone' => (string) ($recorded['zone'] ?? '')]],
                ];
            }

            return ['status' => 'not_needed', 'zone' => $zoneName, 'offset_seconds' => $zone->getOffset($now)];
        }
        if (!self::markerReady($em)) {
            return ['status' => 'refused', 'zone' => $zoneName, 'refusals' => [['code' => 'marker_unmapped']]];
        }

        $conn   = $em->getConnection();
        $runId  = Uuid::uuid4()->toString();
        $offset = $zone->getOffset($now);
        $report = static fn (string $status, array $plan, array $extra = []): array => self::report($status, $plan, $zoneName, $offset, $runId, $extra);
        $plan0  = self::plan($conn, $zone, $now, $decisions);

        // A plain run (the redeploy one-liner, before the PHP-FPM reload) never locks or writes anything.
        if ($fixZone === null) {
            return $report(self::plainStatus($plan0['changes'], $plan0['refusals'] !== [], $plan0['recorded'], $zoneName), $plan0);
        }
        if ($plan0['refusals'] !== []) {
            return $report('refused', $plan0);
        }

        $level = $conn->getTransactionNestingLevel();
        try {
            if (!$plan0['changes']) {
                if ($plan0['recorded'] !== null) {
                    return $report('done', $plan0);
                }
                if ($dryRun) {
                    return $report('would_record', $plan0);
                }
                $conn->beginTransaction();
                $recorded = self::record($conn, $zoneName, $offset, $now, $runId, ['appointments_shifted' => 0, 'appointments_marked' => 0, 'slots_shifted' => 0, 'grants_shifted' => 0], true);
                $conn->commit();
                self::$cache[$zoneName] = 'done';

                return $report('recorded', ['recorded' => $recorded] + $plan0);
            }

            $conn->beginTransaction();
            $conn->executeStatement("SET LOCAL lock_timeout = '" . $lockTimeout . "'");
            foreach ($plan0['specialists'] as $specialistId) {
                $conn->executeQuery('SELECT pg_advisory_xact_lock(' . SlotLock::NAMESPACE . ', hashtext(?))', [strtolower($specialistId)]);
            }
            // EXCLUSIVE: every write and every SELECT … FOR UPDATE / FOR SHARE waits; plain reads go on.
            $conn->executeStatement('LOCK TABLE appointments, availability_slots, document_access_grants IN EXCLUSIVE MODE');

            $plan1 = self::plan($conn, $zone, $now, $decisions);
            if (array_diff($plan1['specialists'], $plan0['specialists']) !== [] || $plan1['changing'] !== $plan0['changing']) {
                self::rollBackTo($conn, $level);

                return $report('busy', $plan0, ['reason' => 'the rows to change moved while the step waited for its locks — re-run']);
            }
            if ($plan1['refusals'] !== []) {
                self::rollBackTo($conn, $level);

                return $report('refused', $plan1);
            }

            if ($beforeWrite !== null) {
                $beforeWrite($conn);
            }
            $nowSql = DocumentSharingRules::sql($now);
            foreach ($plan1['writes'] as $w) {
                if (self::write($conn, $w, $nowSql) !== 1) {
                    self::rollBackTo($conn, $level);

                    return $report('conflict', $plan1, ['conflict' => ['type' => $w['type'], 'id' => $w['id']] + (isset($w['column']) ? ['column' => $w['column']] : [])]);
                }
            }

            $totals = self::audit($conn, $plan1, $zoneName, $offset, $now, $runId, $decisions);
            $recorded = self::record($conn, $zoneName, $offset, $now, $runId, $totals, false);

            if ($dryRun) {
                // Everything above is undone here (a savepoint inside prod-migrate's dry-run transaction).
                self::rollBackTo($conn, $level);

                return $report('would_repair', $plan1);
            }
            $conn->commit();
            self::$cache[$zoneName] = 'done';

            return $report('repaired', ['recorded' => $recorded] + $plan1);
        } catch (DriverException $e) {
            self::rollBackTo($conn, $level);
            if (self::isBusyState($e->getSQLState())) {
                return $report('busy', $plan0, ['reason' => 'a lock was not obtained in time, or Postgres broke a lock cycle (SQLSTATE ' . $e->getSQLState() . ') — nothing was changed; re-run']);
            }

            throw $e;
        } catch (\Throwable $e) {
            self::rollBackTo($conn, $level);

            throw $e;
        }
    }

    // ----- Internals -----

    /** One compare-and-set write; returns the rows it affected (must be 1). @param array<string,mixed> $w */
    private static function write(Connection $conn, array $w, string $nowSql): int
    {
        return match ($w['type']) {
            'appointment' => $conn->executeStatement(
                'UPDATE appointments SET scheduled_at = CAST(:new AS TIMESTAMP(0)), scheduled_epoch = CAST(:e AS BIGINT)
                  WHERE id = :id AND scheduled_at = CAST(:old AS TIMESTAMP(0))
                    AND scheduled_epoch IS NOT DISTINCT FROM CAST(:oe AS BIGINT)',
                ['new' => $w['new'], 'e' => (string) $w['e'], 'id' => $w['id'], 'old' => $w['old'], 'oe' => $w['oe'] === null ? null : (string) $w['oe']],
            ),
            'mark' => $conn->executeStatement(
                'UPDATE appointments SET scheduled_epoch = CAST(:e AS BIGINT)
                  WHERE id = :id AND scheduled_at = CAST(:old AS TIMESTAMP(0)) AND scheduled_epoch IS NULL',
                ['e' => (string) $w['e'], 'id' => $w['id'], 'old' => $w['old']],
            ),
            'slot' => $conn->executeStatement(
                'UPDATE availability_slots
                    SET starts_at = CAST(:s AS TIMESTAMP(0)), ends_at = CAST(:en AS TIMESTAMP(0)), starts_epoch = CAST(:e AS BIGINT)
                  WHERE id = :id AND starts_at = CAST(:os AS TIMESTAMP(0)) AND ends_at = CAST(:oen AS TIMESTAMP(0))
                    AND starts_epoch IS NOT DISTINCT FROM CAST(:oe AS BIGINT)',
                ['s' => $w['s'], 'en' => $w['en'], 'e' => (string) $w['e'], 'id' => $w['id'], 'os' => $w['os'], 'oen' => $w['oen'], 'oe' => $w['oe'] === null ? null : (string) $w['oe']],
            ),
            'grant' => in_array($w['column'], self::GRANT_COLUMNS, true)
                ? $conn->executeStatement(
                    'UPDATE document_access_grants SET ' . $w['column'] . ' = CAST(:new AS TIMESTAMP(0))
                      WHERE id = :id AND ' . $w['column'] . " = CAST(:old AS TIMESTAMP(0)) AND status = 'active'
                        AND (expires_at IS NULL OR expires_at > CAST(:now AS TIMESTAMP(0)))",
                    ['new' => $w['new'], 'id' => $w['id'], 'old' => $w['old'], 'now' => $nowSql],
                )
                : throw new \LogicException('not a grant column'),
            default => throw new \LogicException('unknown write'),
        };
    }

    /**
     * The audit trail of a repair: one row per corrected appointment, slot and
     * grant column (marks are only counted), plus the summary. No PHI.
     *
     * @param array<string,mixed>  $plan
     * @param array<string,string> $decisions
     * @return array{appointments_shifted:int, appointments_marked:int, slots_shifted:int, grants_shifted:int}
     */
    private static function audit(Connection $conn, array $plan, string $zoneName, int $offset, DateTimeImmutable $now, string $runId, array $decisions): array
    {
        $at     = DocumentSharingRules::sql($now);
        $insert = static function (string $action, ?string $appointmentId, string $resourceType, string $resourceId, array $metadata) use ($conn, $at): void {
            $conn->executeStatement(
                "INSERT INTO audit_events (id, actor_name, actor_role, actor_id, action, appointment_id, resource_type, resource_id, metadata, created_at)
                 VALUES (:id, 'System', 'system', NULL, :action, :appointment, :rtype, :rid, CAST(:m AS JSON), CAST(:at AS TIMESTAMP(0)))",
                [
                    'id'          => Uuid::uuid4()->toString(),
                    'action'      => $action,
                    'appointment' => $appointmentId,
                    'rtype'       => $resourceType,
                    'rid'         => $resourceId,
                    'm'           => json_encode($metadata, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR),
                    'at'          => $at,
                ],
            );
        };

        $totals = ['appointments_shifted' => 0, 'appointments_marked' => 0, 'slots_shifted' => 0, 'grants_shifted' => 0];
        foreach ($plan['rows'] as $r) {
            if ($r['action'] === 'mark') {
                ++$totals['appointments_marked'];
                continue;
            }
            if (!in_array($r['action'], ['shift', 'slot', 'keep'], true)) {
                continue;
            }
            if ($r['action'] !== 'keep') {
                ++$totals['appointments_shifted'];
            }
            $insert('appointment.time_corrected', $r['id'], 'appointment', $r['id'], [
                'step'          => 13,
                'run_id'        => $runId,
                'class'         => $r['class'],
                'action'        => $r['action'],
            ] + ($r['decided'] !== null ? ['decided' => $r['decided']] : []) + [
                'from'          => $r['from'],
                'to'            => $r['to'],
                'to_iso'        => $r['to_iso'],
                'delta_seconds' => self::utc($r['to']) - self::utc($r['from']),
                'zone'          => $zoneName,
            ]);
        }
        foreach ($plan['slot_rows'] as $s) {
            if (!in_array($s['action'], ['shift', 'keep'], true)) {
                continue; // marks are only counted
            }
            if ($s['action'] === 'shift') {
                ++$totals['slots_shifted'];
            }
            $insert('availability.time_corrected', null, 'availability_slot', $s['id'], [
                'step'          => 13,
                'run_id'        => $runId,
                'from'          => $s['from'],
                'to'            => $s['to'],
                'ends_from'     => $s['ends_from'],
                'ends_to'       => $s['ends_to'],
                'delta_seconds' => self::utc($s['to']) - self::utc($s['from']),
                'zone'          => $zoneName,
            ]);
        }
        foreach ($plan['writes'] as $w) {
            if ($w['type'] !== 'grant') {
                continue;
            }
            ++$totals['grants_shifted'];
            $insert('document_access.expiry_corrected', $w['appointment_id'], 'document_access_grant', $w['id'], [
                'step'   => 13,
                'run_id' => $runId,
                'column' => $w['column'],
                'from'   => $w['old'],
                'to'     => $w['new'],
            ]);
        }
        $insert('maintenance.clock_repaired', null, 'maintenance', $runId, [
            'step'   => 13,
            'run_id' => $runId,
            'zone'   => $zoneName,
            'offset' => $offset,
        ] + $totals + ['decisions' => $decisions]);

        return $totals;
    }

    /**
     * Record the repair for this zone (R): the gate opens and the cron runs once it commits.
     *
     * @param array<string,int> $totals
     * @return array<string,mixed>
     */
    private static function record(Connection $conn, string $zoneName, int $offset, DateTimeImmutable $now, string $runId, array $totals, bool $nothingToRepair): array
    {
        $value = ['zone' => $zoneName, 'offset' => $offset, 'at' => $now->format(DATE_ATOM), 'run_id' => $runId] + $totals
            + ($nothingToRepair ? ['nothing_to_repair' => true] : []);
        $conn->executeStatement(
            'INSERT INTO app_settings (setting_key, value) VALUES (:k, :v)
             ON CONFLICT (setting_key) DO UPDATE SET value = EXCLUDED.value',
            ['k' => self::SETTING, 'v' => json_encode($value, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR)],
        );

        return $value;
    }

    /**
     * @param array<string,mixed> $plan
     * @param array<string,mixed> $extra
     * @return array<string,mixed>
     */
    private static function report(string $status, array $plan, string $zoneName, int $offset, string $runId, array $extra = []): array
    {
        $report = ['status' => $status, 'zone' => $zoneName, 'offset_seconds' => $offset, 'run_id' => $runId] + $extra;
        foreach (self::REPORT_KEYS as $key) {
            if (array_key_exists($key, $plan)) {
                $report[$key] = $plan[$key];
            }
        }

        return $report;
    }

    /**
     * §2.6 — per doctor, over every pair of rows with a final time.
     *
     * @param array<string,array<string,mixed>> $rows
     * @param array<string,array<string,mixed>> $slotRows
     * @return array<string,list<array<string,mixed>>>
     */
    private static function overlaps(array $rows, array $slotRows, DateTimeZone $zone, int $nowTs): array
    {
        $out = [
            'new_collisions' => [], 'hold_collisions' => [], 'live_overlaps_after' => [],
            'live_slot_duplicates_after' => [], 'holds_overlap_after' => [], 'blocked_after' => [],
        ];
        $byDoctor = [];
        foreach ($rows as $r) {
            if ($r['new_ts'] === null || $r['deleted']) {
                continue;
            }
            $kind = match (true) {
                in_array($r['status'], self::LIVE, true)                                   => 'live',
                $r['status'] === 'proposed' && $r['expires_ts'] !== null && $r['expires_ts'] > $nowTs => 'hold',
                $r['status'] === 'proposed'                                                => 'stale_hold',
                default                                                                    => null,
            };
            if ($kind !== null) {
                $byDoctor[$r['specialist_id']][] = $r + ['kind' => $kind];
            }
        }
        $blocks = [];
        foreach ($slotRows as $s) {
            if ($s['kind'] === 'block' && $s['final_from'] !== null) {
                $blocks[$s['specialist_id']][] = $s;
            }
        }
        ksort($byDoctor);
        $label = static fn (array $r): string => $r['id'] . ':' . $r['status'] . ':' . self::iso($r['new_ts'], $zone);

        foreach ($byDoctor as $doctor => $list) {
            usort($list, static fn (array $x, array $y): int => [$x['new_ts'], $x['id']] <=> [$y['new_ts'], $y['id']]);
            $count = count($list);
            for ($i = 0; $i < $count; $i++) {
                for ($j = $i + 1; $j < $count; $j++) {
                    [$x, $y] = [$list[$i], $list[$j]];
                    $span    = max($x['slot_minutes'], $y['slot_minutes']) * 60;
                    $after   = abs($x['new_ts'] - $y['new_ts']) < $span;
                    if (!$after) {
                        continue;
                    }
                    $before = abs($x['before_ts'] - $y['before_ts']) < $span;
                    $pair   = ['specialist_id' => $doctor, 'rows' => [$label($x), $label($y)]];
                    $kinds  = [$x['kind'], $y['kind']];
                    sort($kinds);
                    if ($kinds === ['live', 'live']) {
                        $out[$before ? 'live_overlaps_after' : 'new_collisions'][] = $pair;
                    } elseif ($kinds === ['hold', 'live'] || $kinds === ['hold', 'hold']) {
                        $out['hold_collisions'][] = $pair;
                    } elseif ($kinds === ['live', 'stale_hold']) {
                        $out['holds_overlap_after'][] = $pair;
                    }
                }
            }

            $byStart = [];
            foreach ($list as $r) {
                if ($r['kind'] === 'live') {
                    $byStart[$r['new_ts']][] = $r['id'] . ':' . $r['status'];
                }
            }
            foreach ($byStart as $ts => $ids) {
                if (count($ids) > 1) {
                    $out['live_slot_duplicates_after'][] = ['specialist_id' => $doctor, 'at' => self::naive((int) $ts, $zone), 'ids' => $ids];
                }
            }

            foreach ($list as $r) {
                if (!in_array($r['kind'], ['live', 'hold'], true) || $r['new_ts'] <= $nowTs) {
                    continue;
                }
                $end = $r['new_ts'] + $r['slot_minutes'] * 60;
                foreach ($blocks[$doctor] ?? [] as $b) {
                    if ($r['new_ts'] < $b['final_to'] && $end > $b['final_from']) {
                        $out['blocked_after'][] = [
                            'id'             => $r['id'],
                            'status'         => $r['status'],
                            'at_iso'         => self::iso($r['new_ts'], $zone),
                            'block_id'       => $b['id'],
                            'block_from_iso' => self::iso($b['final_from'], $zone),
                            'block_to_iso'   => self::iso($b['final_to'], $zone),
                        ];
                    }
                }
            }
        }

        return $out;
    }

    /**
     * @param array<string,array<string,mixed>> $rows
     * @param array<string,array<string,mixed>> $slotRows
     * @param array<string,mixed>               $grants
     * @return array<string,array<string,int>>
     */
    private static function counts(array $rows, array $slotRows, array $grants): array
    {
        $a = ['shift' => 0, 'mark' => 0, 'keep' => 0, 'marked' => 0, 'slot' => 0, 'review_decided' => 0, 'unchanged' => 0];
        foreach ($rows as $r) {
            match ($r['action']) {
                'none'      => ++$a['marked'],
                'undecided' => ++$a['unchanged'],
                default     => ++$a[$r['action']],
            };
            if ($r['decided'] !== null) {
                ++$a['review_decided'];
            }
        }
        $s = ['shift' => 0, 'mark' => 0, 'keep' => 0, 'marked' => 0, 'unchanged' => 0];
        foreach ($slotRows as $r) {
            match ($r['action']) {
                'none'      => ++$s['marked'],
                'undecided' => ++$s['unchanged'],
                default     => ++$s[$r['action']],
            };
        }

        return [
            'appointments' => $a,
            'slots'        => $s,
            'grants'       => ['shift' => count($grants['changes']), 'keep' => $grants['keep'], 'review' => count($grants['review']), 'expired_early' => count($grants['expired_early'])],
        ];
    }

    /** @param array<string,array<string,mixed>> $rows @return list<array<string,mixed>> */
    private static function appointmentListing(array $rows): array
    {
        $out = [];
        foreach ($rows as $r) {
            if (in_array($r['action'], ['none', 'undecided'], true)) {
                continue;
            }
            $out[] = [
                'id'            => $r['id'],
                'specialist_id' => $r['specialist_id'],
                'status'        => $r['status'],
                'base_class'    => $r['base_class'],
                'class'         => $r['class'],
                'action'        => $r['action'],
            ] + ($r['decided'] !== null ? ['decided' => $r['decided']] : []) + [
                'from'          => $r['from'],
                'to'            => $r['to'],
                'to_iso'        => $r['to_iso'],
                'evidence'      => $r['evidence'],
            ];
        }

        return $out;
    }

    /**
     * Every row that needs (or got) a person's decision.
     *
     * @param array<string,array<string,mixed>> $rows
     * @param array<string,array<string,mixed>> $slotRows
     * @return list<array<string,mixed>>
     */
    private static function reviewListing(array $rows, array $slotRows): array
    {
        $out = [];
        foreach ($rows as $r) {
            if (!str_starts_with($r['class'], 'review:') && !str_starts_with($r['class'], 'decide:')) {
                continue;
            }
            $out[] = [
                'id'            => $r['id'],
                'resource'      => 'appointment',
                'specialist_id' => $r['specialist_id'],
                'status'        => $r['status'],
                'base_class'    => $r['base_class'],
                'class'         => $r['class'],
                'from'          => $r['from'],
                'candidates'    => $r['candidates'] ?? [],
                'evidence'      => $r['evidence'],
            ] + ($r['decided'] !== null ? ['decided' => $r['decided']] : []);
        }
        foreach ($slotRows as $s) {
            if (!str_starts_with($s['class'], 'review:')) {
                continue;
            }
            $out[] = [
                'id'            => $s['id'],
                'resource'      => 'availability_slot',
                'specialist_id' => $s['specialist_id'],
                'kind'          => $s['kind'],
                'class'         => $s['class'],
                'from'          => $s['from'],
                'candidates'    => $s['candidates'] ?? [],
            ] + ($s['decided'] !== null ? ['decided' => $s['decided']] : []);
        }

        return $out;
    }

    /** @param array<string,array<string,mixed>> $slotRows @return list<array<string,mixed>> */
    private static function slotListing(array $slotRows): array
    {
        $out = [];
        foreach ($slotRows as $s) {
            if (!in_array($s['action'], ['shift', 'mark', 'keep'], true)) {
                continue;
            }
            $out[] = ['id' => $s['id'], 'specialist_id' => $s['specialist_id'], 'kind' => $s['kind'], 'action' => $s['action']]
                + ($s['decided'] !== null ? ['decided' => $s['decided']] : [])
                + ['from' => $s['from'], 'to' => $s['to']];
        }

        return $out;
    }

    /** Roll back only what this call began (prod-migrate's dry-run transaction stays open). */
    private static function rollBackTo(Connection $conn, int $level): void
    {
        while ($conn->getTransactionNestingLevel() > $level) {
            $conn->rollBack();
        }
    }

    /** Whether `$zone` has been, and will stay, UTC (offset 0 from 5 years back to 2 years ahead). */
    private static function utcEquivalent(DateTimeZone $zone): bool
    {
        $now = time();
        foreach ($zone->getTransitions($now - 5 * 365 * 86400, $now + 2 * 365 * 86400) ?: [] as $transition) {
            if ((int) $transition['offset'] !== 0) {
                return false;
            }
        }

        return $zone->getOffset(new DateTimeImmutable('@' . $now)) === 0;
    }

    /**
     * Whether a recorded repair names a UTC-equivalent zone. An unreadable or
     * unknown zone name counts as not UTC (fail closed: the caller pauses).
     *
     * @param array<string,mixed> $recorded
     */
    private static function recordedUtcEquivalent(array $recorded): bool
    {
        $name = $recorded['zone'] ?? null;
        if (!is_string($name) || $name === '') {
            return false;
        }
        try {
            return self::utcEquivalent(new DateTimeZone($name));
        } catch (\Throwable) {
            return false;
        }
    }

    /** @return array<string,mixed>|null */
    private static function decodeRecorded(mixed $raw): ?array
    {
        if (!is_string($raw) || $raw === '') {
            return null;
        }
        $value = json_decode($raw, true);

        return is_array($value) ? $value : null;
    }

    /** @param array<string,mixed>|null $recorded */
    private static function recordedAt(?array $recorded): ?int
    {
        if ($recorded === null || !is_string($recorded['at'] ?? null)) {
            return null;
        }
        try {
            return (new DateTimeImmutable($recorded['at']))->getTimestamp();
        } catch (\Throwable) {
            return null;
        }
    }

    /**
     * Rows {id, action?, iso} → lower-case id => {action, ts}; unreadable times are skipped.
     *
     * @param list<array<string,mixed>> $rows
     * @return array<string,array{action:?string, ts:int}>
     */
    private static function evidence(array $rows): array
    {
        $out = [];
        foreach ($rows as $row) {
            $id = strtolower((string) ($row['id'] ?? ''));
            if ($id === '' || isset($out[$id])) {
                continue;
            }
            try {
                $ts = (new DateTimeImmutable((string) $row['iso']))->getTimestamp();
            } catch (\Throwable) {
                continue;
            }
            $out[$id] = ['action' => isset($row['action']) ? (string) $row['action'] : null, 'ts' => $ts];
        }

        return $out;
    }

    /** `$naive` minus `$hours`, as naive wall-clock arithmetic. */
    private static function minusHours(string $naive, int $hours): string
    {
        return (new DateTimeImmutable($naive, new DateTimeZone('UTC')))->modify('-' . $hours . ' hours')->format('Y-m-d H:i:s');
    }

    /** A unix time plus a share's offset, as the app adds it (in the process zone). */
    private static function plusOffset(int $ts, ShareDuration $duration, DateTimeZone $zone): int
    {
        $offset = $duration->offset();

        return $offset === null ? $ts : (new DateTimeImmutable('@' . $ts))->setTimezone($zone)->add($offset)->getTimestamp();
    }

    /** inZ(N): a stored naive time read in `$zone`, as a unix time. */
    private static function inZ(string $naive, DateTimeZone $zone): int
    {
        return (new DateTimeImmutable($naive, $zone))->getTimestamp();
    }

    /** utc(N): a stored naive time read as UTC, as a unix time. */
    private static function utc(string $naive): int
    {
        return (new DateTimeImmutable($naive, new DateTimeZone('UTC')))->getTimestamp();
    }

    private static function naive(int $ts, DateTimeZone $zone): string
    {
        return (new DateTimeImmutable('@' . $ts))->setTimezone($zone)->format('Y-m-d H:i:s');
    }

    private static function iso(int $ts, DateTimeZone $zone): string
    {
        return (new DateTimeImmutable('@' . $ts))->setTimezone($zone)->format(DATE_ATOM);
    }

    private static function int(mixed $value): ?int
    {
        return $value === null || $value === '' ? null : (int) $value;
    }

    private static function str(mixed $value): ?string
    {
        return $value === null || $value === '' ? null : (string) $value;
    }

    private static function bool(mixed $value): bool
    {
        return $value === true || $value === 1 || $value === 't' || $value === '1' || $value === 'true';
    }
}
