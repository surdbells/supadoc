<?php

declare(strict_types=1);

namespace App\Infrastructure\Document;

use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Repository\DocumentAccessLogRepository;
use App\Infrastructure\Service\AuditLogger;
use DateTimeImmutable;
use Doctrine\ORM\EntityManagerInterface;

/**
 * Every state change of an existing grant or request, as a compare-and-set
 * statement (spec §2.4):
 *
 *     UPDATE … SET status = :to, … WHERE id = :id AND status = :from [AND <time>] RETURNING …
 *
 * The audit row, the ledger row and any notice are emitted ONLY when a row
 * came back, so each transition is recorded exactly once whoever wins — the
 * sweeper, a pair's lazy expiry, or an action. Used inside the caller's
 * transaction (the audit write throws on failure, so the whole change rolls
 * back with it).
 */
final class DocumentAccessTransitions
{
    /** @var array<string, array{patient:string, doctor:string}> pair => names (per request) */
    private array $names = [];

    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly AuditLogger $audit,
        private readonly DocumentAccessLogRepository $log,
        private readonly DocumentAccessNotifier $notifier,
    ) {
    }

    // ----- Grants -----

    /** An active grant whose end has come is recorded as expired. */
    public function expireGrant(string $grantId, DateTimeImmutable $now): bool
    {
        $row = $this->cas(
            "UPDATE document_access_grants
                SET status = 'expired', ended_at = :now, end_reason = 'expired', ended_by = 'system', updated_at = :now
              WHERE id = :id AND status = 'active' AND expires_at IS NOT NULL AND expires_at <= :now
          RETURNING " . self::GRANT_RETURNING,
            ['id' => strtolower($grantId), 'now' => Rules::sql($now)],
        );
        if ($row === null) {
            return false;
        }
        $this->recordGrant($row, 'document_access.expired', 'expired', 'system', $now, ['end_reason' => 'expired']);

        return true;
    }

    /**
     * End an active grant (revoked by the patient, or emptied, merged,
     * appointment_cancelled, doctor_unavailable, account_closed). A patient
     * revoke carries `$revokeBatchId` (for Undo).
     */
    public function endGrant(string $grantId, string $endReason, string $endedBy, DateTimeImmutable $now, ?string $revokeBatchId = null): bool
    {
        $row = $this->cas(
            "UPDATE document_access_grants
                SET status = :to, ended_at = :now, end_reason = :reason, ended_by = :by,
                    revoke_batch_id = COALESCE(CAST(:batch AS CHAR(36)), revoke_batch_id), updated_at = :now
              WHERE id = :id AND status = 'active'
          RETURNING " . self::GRANT_RETURNING,
            [
                'to'     => $endReason === 'expired' ? 'expired' : 'revoked',
                'now'    => Rules::sql($now),
                'reason' => $endReason,
                'by'     => $endedBy,
                'batch'  => $revokeBatchId !== null ? strtolower($revokeBatchId) : null,
                'id'     => strtolower($grantId),
            ],
        );
        if ($row === null) {
            return false;
        }
        $this->recordGrant(
            $row,
            $endReason === 'expired' ? 'document_access.expired' : 'document_access.revoked',
            $endReason === 'expired' ? 'expired' : 'revoked',
            $endedBy,
            $now,
            ['end_reason' => $endReason, 'revoke_batch_id' => $revokeBatchId],
        );

        return true;
    }

    /**
     * Move an active, in-window grant's end (extend / shorten, or a
     * consultation moved). `$rebaseOriginal`: the patient's own change becomes
     * the base of the reschedule cap. `$appointmentId` (with `$setAppointment`)
     * re-anchors it. `$details`: `capped`, plus anything for the audit.
     *
     * @param array<string,mixed> $details
     */
    public function changeGrantEnd(
        string $grantId,
        ?DateTimeImmutable $newEnd,
        string $duration,
        bool $rebaseOriginal,
        string $actorRole,
        DateTimeImmutable $now,
        array $details = [],
        ?string $appointmentId = null,
        bool $setAppointment = false,
    ): bool {
        $before = $this->em->getConnection()->fetchAssociative(
            'SELECT expires_at, duration FROM document_access_grants WHERE id = :id',
            ['id' => strtolower($grantId)],
        );
        if ($before === false) {
            return false;
        }
        $end = $newEnd !== null ? Rules::sql($newEnd) : null;
        $row = $this->cas(
            'UPDATE document_access_grants
                SET expires_at = CAST(:end AS TIMESTAMP(0)), duration = :duration,
                    original_expires_at = CASE WHEN :rebase = 1 THEN CAST(:end AS TIMESTAMP(0)) ELSE original_expires_at END'
                . ($setAppointment ? ', appointment_id = CAST(:appointment AS CHAR(36))' : '') . ",
                    updated_at = :now
              WHERE id = :id AND status = 'active' AND (expires_at IS NULL OR expires_at > :now)
          RETURNING " . self::GRANT_RETURNING,
            ['end' => $end, 'duration' => $duration, 'rebase' => $rebaseOriginal ? 1 : 0, 'now' => Rules::sql($now), 'id' => strtolower($grantId)]
                + ($setAppointment ? ['appointment' => $appointmentId !== null ? strtolower($appointmentId) : null] : []),
        );
        if ($row === null) {
            return false;
        }
        $previous = Rules::fromSql($before['expires_at']);
        $this->recordGrant($row, 'document_access.extended', 'extended', $actorRole, $now, [
            'previous_expires_at' => Rules::iso($previous),
            'previous_duration'   => (string) $before['duration'],
            'capped'              => (bool) ($details['capped'] ?? false),
        ] + array_diff_key($details, ['capped' => true]));

        return true;
    }

    /**
     * Undo: mark every grant of one patient revoke batch as restored, within
     * 10 minutes of the revoke. Returns the grant ids marked (each once).
     *
     * @return list<string>
     */
    public function markRestored(string $patientId, string $revokeBatchId, DateTimeImmutable $now): array
    {
        return array_map('strval', $this->em->getConnection()->fetchFirstColumn(
            "UPDATE document_access_grants SET restored_at = :now, updated_at = :now
              WHERE patient_id = :p AND revoke_batch_id = :b AND restored_at IS NULL
                AND status <> 'active' AND end_reason = 'revoked' AND ended_by = 'patient' AND ended_at > :cutoff
          RETURNING id",
            [
                'now'    => Rules::sql($now),
                'p'      => strtolower($patientId),
                'b'      => strtolower($revokeBatchId),
                'cutoff' => Rules::sql($now->modify('-' . Rules::RESTORE_MINUTES . ' minutes')),
            ],
        ));
    }

    // ----- Requests -----

    /**
     * Close a pending request: approved / declined / cancelled (withdrawn by
     * the doctor, or doctor_unavailable / not_eligible / account_closed).
     * Approve, decline and withdraw (and shared_directly) need it unexpired.
     * Records the audit and ledger rows; the caller queues any notice.
     *
     * @param array<string,mixed> $extra audit metadata (grant_id, blocked, …)
     */
    public function closeRequest(string $requestId, string $toStatus, string $closeReason, string $actorRole, DateTimeImmutable $now, array $extra = [], ?string $grantId = null): bool
    {
        $row = $this->casRequest($requestId, $toStatus, $closeReason, $now);
        if ($row === null) {
            return false;
        }
        $this->recordRequestClosed($row, $toStatus, $closeReason, $actorRole, $now, $extra, $grantId);

        return true;
    }

    /**
     * The compare-and-set of {@see closeRequest()} alone (the approve path
     * records once the grant exists). Returns the closed row, or null.
     *
     * @return array<string,mixed>|null
     */
    public function casRequest(string $requestId, string $toStatus, string $closeReason, DateTimeImmutable $now): ?array
    {
        $needsUnexpired = in_array($closeReason, ['approved', 'shared_directly', 'declined', 'withdrawn'], true);

        return $this->cas(
            "UPDATE document_access_requests
                SET status = :to, close_reason = :reason, decided_at = :now, updated_at = :now
              WHERE id = :id AND status = 'pending'" . ($needsUnexpired ? ' AND expires_at > :now' : '') . '
          RETURNING ' . self::REQUEST_RETURNING,
            ['to' => $toStatus, 'reason' => $closeReason, 'now' => Rules::sql($now), 'id' => strtolower($requestId)],
        );
    }

    /**
     * Audit + ledger for a closed request.
     *
     * @param array<string,mixed> $row from {@see casRequest()}
     * @param array<string,mixed> $extra
     */
    public function recordRequestClosed(array $row, string $toStatus, string $closeReason, string $actorRole, DateTimeImmutable $now, array $extra = [], ?string $grantId = null): void
    {
        [$action, $event] = match ($toStatus) {
            'approved' => ['document_access.request_approved', 'request_approved'],
            'declined' => ['document_access.request_declined', 'request_declined'],
            'expired'  => ['document_access.request_expired', 'request_expired'],
            default    => ['document_access.request_cancelled', 'request_cancelled'],
        };
        $names = $this->names((string) $row['patient_id'], (string) $row['specialist_id']);
        $this->audit->record(
            $actorRole === 'doctor' ? $names['doctor'] : ($actorRole === 'patient' ? $names['patient'] : 'System'),
            $actorRole,
            $action,
            $row['appointment_id'] !== null ? (string) $row['appointment_id'] : null,
            'document_access_request',
            (string) $row['id'],
            [
                'patient_id'    => (string) $row['patient_id'],
                'patient_name'  => $names['patient'],
                'specialist_id' => (string) $row['specialist_id'],
                'doctor'        => $names['doctor'],
                'close_reason'  => $closeReason,
                'grant_id'      => $grantId,
                'blocked'       => (bool) ($extra['blocked'] ?? false),
            ] + array_diff_key($extra, ['blocked' => true]),
            $actorRole === 'patient' ? (string) $row['patient_id'] : null,
        );
        $this->log->append([
            'patient_id'     => (string) $row['patient_id'],
            'specialist_id'  => (string) $row['specialist_id'],
            'request_id'     => (string) $row['id'],
            'grant_id'       => $grantId,
            'appointment_id' => $row['appointment_id'] !== null ? (string) $row['appointment_id'] : null,
            'event'          => $event,
            'actor_role'     => $actorRole,
        ], $now);
    }

    /** A pending request whose close has come is recorded as expired, and the doctor told it closed. */
    public function expireRequest(string $requestId, DateTimeImmutable $now): bool
    {
        $row = $this->cas(
            "UPDATE document_access_requests
                SET status = 'expired', close_reason = 'expired', decided_at = :now, updated_at = :now
              WHERE id = :id AND status = 'pending' AND expires_at <= :now
          RETURNING " . self::REQUEST_RETURNING,
            ['id' => strtolower($requestId), 'now' => Rules::sql($now)],
        );
        if ($row === null) {
            return false;
        }
        $this->recordRequestClosed($row, 'expired', 'expired', 'system', $now);
        $names = $this->names((string) $row['patient_id'], (string) $row['specialist_id']);
        $this->notifier->queueDoctor('closed', (string) $row['specialist_id'], (string) $row['patient_id'], $names['patient'], $row['appointment_id'] !== null ? (string) $row['appointment_id'] : null);

        return true;
    }

    // ----- Shared plumbing -----

    private const GRANT_RETURNING   = 'id, patient_id, specialist_id, scope, duration, expires_at, appointment_id, request_id, source, surface, revoke_batch_id';
    private const REQUEST_RETURNING = 'id, patient_id, specialist_id, appointment_id, kind, status';

    /**
     * Audit + ledger for a grant transition.
     *
     * @param array<string,mixed> $row
     * @param array<string,mixed> $extra
     */
    public function recordGrant(array $row, string $action, string $event, string $actorRole, DateTimeImmutable $now, array $extra = []): void
    {
        $names   = $this->names((string) $row['patient_id'], (string) $row['specialist_id']);
        $expires = Rules::fromSql($row['expires_at'] ?? null);
        $this->audit->record(
            match ($actorRole) {
                'patient' => $names['patient'],
                'doctor'  => $names['doctor'],
                default   => 'System',
            },
            $actorRole,
            $action,
            isset($row['appointment_id']) && $row['appointment_id'] !== null ? (string) $row['appointment_id'] : null,
            'document_access_grant',
            (string) $row['id'],
            [
                'patient_id'    => (string) $row['patient_id'],
                'patient_name'  => $names['patient'],
                'specialist_id' => (string) $row['specialist_id'],
                'doctor'        => $names['doctor'],
                'scope'         => (string) ($row['scope'] ?? ''),
                'duration'      => (string) ($row['duration'] ?? ''),
                'expires_at'    => Rules::iso($expires),
            ] + array_filter($extra, static fn ($v): bool => $v !== null),
            $actorRole === 'patient' ? (string) $row['patient_id'] : null,
        );
        $this->log->append([
            'patient_id'     => (string) $row['patient_id'],
            'specialist_id'  => (string) $row['specialist_id'],
            'grant_id'       => (string) $row['id'],
            'request_id'     => isset($row['request_id']) && $row['request_id'] !== null ? (string) $row['request_id'] : null,
            'appointment_id' => isset($row['appointment_id']) && $row['appointment_id'] !== null ? (string) $row['appointment_id'] : null,
            'event'          => $event,
            'actor_role'     => $actorRole,
            'details'        => [
                'scope'               => $row['scope'] ?? null,
                'duration'            => $row['duration'] ?? null,
                'expires_at'          => Rules::iso($expires),
                'previous_expires_at' => $extra['previous_expires_at'] ?? null,
                'previous_scope'      => $extra['previous_scope'] ?? null,
                'document_count'      => $extra['document_count'] ?? null,
                'end_reason'          => $extra['end_reason'] ?? null,
                'capped'              => isset($extra['capped']) ? (bool) $extra['capped'] : null,
                'surface'             => $extra['surface'] ?? null,
                'consent_version'     => $extra['consent_version'] ?? null,
            ],
        ], $now);
    }

    /** The patient's and the doctor's display names (cached for the request). @return array{patient:string, doctor:string} */
    public function names(string $patientId, string $specialistId): array
    {
        $key = strtolower($patientId) . ':' . strtolower($specialistId);
        if (isset($this->names[$key])) {
            return $this->names[$key];
        }
        $row = $this->em->getConnection()->fetchAssociative(
            'SELECT (SELECT TRIM(p.first_name || \' \' || p.last_name) FROM patients p WHERE p.id = :p) AS patient,
                    (SELECT s.name FROM specialists s WHERE s.id = :s) AS doctor',
            ['p' => strtolower($patientId), 's' => strtolower($specialistId)],
        );

        return $this->names[$key] = [
            'patient' => trim((string) ($row['patient'] ?? '')) !== '' ? trim((string) $row['patient']) : 'Patient',
            'doctor'  => trim((string) ($row['doctor'] ?? '')) !== '' ? trim((string) $row['doctor']) : 'Doctor',
        ];
    }

    /**
     * @param array<string,mixed> $params
     * @return array<string,mixed>|null the changed row, or null when the compare-and-set lost
     */
    private function cas(string $sql, array $params): ?array
    {
        $row = $this->em->getConnection()->fetchAssociative($sql, $params);

        return $row === false ? null : $row;
    }
}
