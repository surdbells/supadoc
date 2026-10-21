<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Entity\DocumentAccessRequest;
use DateTimeImmutable;
use Doctrine\DBAL\Connection;
use Ramsey\Uuid\Uuid;

/**
 * SQL for doctors' document-access requests (spec §1.3, §3.2). Rows come back
 * as associative arrays. State changes go through
 * {@see \App\Infrastructure\Document\DocumentAccessTransitions} (compare-and-set).
 * A request whose `expires_at` has passed counts as expired everywhere, even
 * before the sweeper (or a pair's lazy expiry) records it.
 */
final class DocumentAccessRequestRepository extends BaseRepository
{
    public const COLUMNS = 'r.id, r.patient_id, r.specialist_id, r.appointment_id, r.requested_by_user_id, r.kind, r.status,
        r.message, r.expires_at, r.decided_at, r.close_reason, r.created_at, r.updated_at';

    protected function getEntityClass(): string
    {
        return DocumentAccessRequest::class;
    }

    private function conn(): Connection
    {
        return $this->em->getConnection();
    }

    /**
     * @param array{patient_id:string, specialist_id:string, appointment_id:?string, requested_by_user_id:?string, kind:string, message:?string} $r
     */
    public function insertRequest(array $r, DateTimeImmutable $now): string
    {
        $id = Uuid::uuid4()->toString();
        $this->conn()->insert('document_access_requests', [
            'id'                   => $id,
            'patient_id'           => strtolower($r['patient_id']),
            'specialist_id'        => strtolower($r['specialist_id']),
            'appointment_id'       => $r['appointment_id'] !== null ? strtolower($r['appointment_id']) : null,
            'requested_by_user_id' => $r['requested_by_user_id'],
            'kind'                 => $r['kind'],
            'status'               => 'pending',
            'message'              => $r['message'],
            'expires_at'           => Rules::sql($now->modify('+' . Rules::REQUEST_TTL_DAYS . ' days')),
            'created_at'           => Rules::sql($now),
            'updated_at'           => Rules::sql($now),
        ]);

        return $id;
    }

    /** @return array<string,mixed>|null */
    public function row(string $id): ?array
    {
        $row = $this->conn()->fetchAssociative('SELECT ' . self::COLUMNS . ' FROM document_access_requests r WHERE r.id = :id', ['id' => strtolower($id)]);

        return $row === false ? null : $row;
    }

    /** The request if it is this patient's, else null. @return array<string,mixed>|null */
    public function rowForPatient(string $id, string $patientId): ?array
    {
        $row = $this->conn()->fetchAssociative(
            'SELECT ' . self::COLUMNS . ' FROM document_access_requests r WHERE r.id = :id AND r.patient_id = :p',
            ['id' => strtolower($id), 'p' => strtolower($patientId)],
        );

        return $row === false ? null : $row;
    }

    /** The pair's pending request that has not expired. @return array<string,mixed>|null */
    public function pendingForPair(string $patientId, string $specialistId, DateTimeImmutable $now): ?array
    {
        $row = $this->conn()->fetchAssociative(
            'SELECT ' . self::COLUMNS . " FROM document_access_requests r
              WHERE r.patient_id = :p AND r.specialist_id = :s AND r.status = 'pending' AND r.expires_at > :now
              ORDER BY r.created_at DESC LIMIT 1",
            ['p' => strtolower($patientId), 's' => strtolower($specialistId), 'now' => Rules::sql($now)],
        );

        return $row === false ? null : $row;
    }

    /**
     * The patient's requests: `pending` = waiting and not past their close;
     * `all` = made in the last 90 days. Newest first.
     *
     * @return list<array<string,mixed>>
     */
    public function listForPatient(string $patientId, string $status, DateTimeImmutable $now): array
    {
        if ($status === 'pending') {
            return $this->conn()->fetchAllAssociative(
                'SELECT ' . self::COLUMNS . " FROM document_access_requests r
                  WHERE r.patient_id = :p AND r.status = 'pending' AND r.expires_at > :now
                  ORDER BY r.created_at DESC, r.id DESC LIMIT 100",
                ['p' => strtolower($patientId), 'now' => Rules::sql($now)],
            );
        }

        return $this->conn()->fetchAllAssociative(
            'SELECT ' . self::COLUMNS . ' FROM document_access_requests r
              WHERE r.patient_id = :p AND r.created_at >= :since
              ORDER BY r.created_at DESC, r.id DESC LIMIT 100',
            ['p' => strtolower($patientId), 'since' => Rules::sql($now->modify('-' . Rules::ENDED_LIST_DAYS . ' days'))],
        );
    }

    /** The pair's most recent request that is no longer waiting. @return array<string,mixed>|null */
    public function lastDecidedForPair(string $patientId, string $specialistId, DateTimeImmutable $now): ?array
    {
        $row = $this->conn()->fetchAssociative(
            'SELECT ' . self::COLUMNS . " FROM document_access_requests r
              WHERE r.patient_id = :p AND r.specialist_id = :s
                AND (r.status <> 'pending' OR r.expires_at <= :now)
              ORDER BY COALESCE(r.decided_at, r.expires_at) DESC, r.created_at DESC LIMIT 1",
            ['p' => strtolower($patientId), 's' => strtolower($specialistId), 'now' => Rules::sql($now)],
        );

        return $row === false ? null : $row;
    }

    /** When the pair's requests were made since `$since`. @return list<DateTimeImmutable> */
    public function pairRequestTimes(string $patientId, string $specialistId, DateTimeImmutable $since): array
    {
        return $this->times(
            'SELECT created_at FROM document_access_requests WHERE patient_id = :p AND specialist_id = :s AND created_at > :since',
            ['p' => strtolower($patientId), 's' => strtolower($specialistId), 'since' => Rules::sql($since)],
        );
    }

    /** When this doctor's requests (any patient) were made since `$since`. @return list<DateTimeImmutable> */
    public function doctorRequestTimes(string $specialistId, DateTimeImmutable $since): array
    {
        return $this->times(
            'SELECT created_at FROM document_access_requests WHERE specialist_id = :s AND created_at > :since',
            ['s' => strtolower($specialistId), 'since' => Rules::sql($since)],
        );
    }

    /** When the pair's last request was declined, or null. */
    public function lastDeclinedAt(string $patientId, string $specialistId): ?DateTimeImmutable
    {
        $at = $this->conn()->fetchOne(
            "SELECT MAX(decided_at) FROM document_access_requests WHERE patient_id = :p AND specialist_id = :s AND status = 'declined'",
            ['p' => strtolower($patientId), 's' => strtolower($specialistId)],
        );

        return Rules::fromSql($at === false ? null : $at);
    }

    // ----- Sweeper candidates -----

    /** Pending requests past their close. @return list<string> */
    public function dueIds(DateTimeImmutable $now, int $limit, ?string $patientId = null, ?string $specialistId = null): array
    {
        $params = ['now' => Rules::sql($now)];
        $pair   = '';
        if ($patientId !== null) {
            $pair       .= ' AND patient_id = :p';
            $params['p'] = strtolower($patientId);
        }
        if ($specialistId !== null) {
            $pair       .= ' AND specialist_id = :s';
            $params['s'] = strtolower($specialistId);
        }

        return array_map('strval', $this->conn()->fetchFirstColumn(
            "SELECT id FROM document_access_requests WHERE status = 'pending' AND expires_at <= :now{$pair}
              ORDER BY expires_at ASC LIMIT " . max(1, $limit),
            $params,
        ));
    }

    /** Pending requests of doctors who are not practising (suspended, not approved, deleted). @return list<string> */
    public function pendingOfNonPractisingIds(int $limit): array
    {
        return array_map('strval', $this->conn()->fetchFirstColumn(
            "SELECT r.id FROM document_access_requests r JOIN specialists s ON s.id = r.specialist_id
              WHERE r.status = 'pending'
                AND (s.deleted_at IS NOT NULL OR (s.status IS NOT NULL AND s.status <> 'approved'))
              ORDER BY r.created_at ASC LIMIT " . max(1, $limit),
        ));
    }

    /**
     * Pending requests whose consultation was cancelled, deleted or removed,
     * when the pair has no other consultation a request could be made from
     * (open, or completed / missed within the last 30 days).
     *
     * @return list<string>
     */
    public function pendingWithoutEligibleAppointmentIds(DateTimeImmutable $now, int $limit): array
    {
        return array_map('strval', $this->conn()->fetchFirstColumn(
            "SELECT r.id FROM document_access_requests r
          LEFT JOIN appointments a ON a.id = r.appointment_id
              WHERE r.status = 'pending'
                AND (a.id IS NULL OR a.deleted_at IS NOT NULL OR a.status = 'cancelled')
                AND NOT EXISTS (
                    SELECT 1 FROM appointments x
                     WHERE x.patient_id = r.patient_id AND x.specialist_id = r.specialist_id AND x.deleted_at IS NULL
                       AND (x.status IN ('pending', 'confirmed', 'rescheduled')
                            OR (x.status IN ('completed', 'missed') AND x.scheduled_at >= :since)))
              ORDER BY r.created_at ASC LIMIT " . max(1, $limit),
            ['since' => Rules::sql($now->modify('-31 days'))],
        ));
    }

    public function countPending(DateTimeImmutable $now): int
    {
        return (int) $this->conn()->fetchOne(
            "SELECT COUNT(*) FROM document_access_requests WHERE status = 'pending' AND expires_at > :now",
            ['now' => Rules::sql($now)],
        );
    }

    /**
     * @param array<string,string> $params
     * @return list<DateTimeImmutable>
     */
    private function times(string $sql, array $params): array
    {
        return array_values(array_filter(array_map(
            static fn ($v): ?DateTimeImmutable => Rules::fromSql($v),
            $this->conn()->fetchFirstColumn($sql, $params),
        )));
    }
}
