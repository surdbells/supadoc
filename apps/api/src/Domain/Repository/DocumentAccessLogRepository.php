<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Entity\DocumentAccessLogEntry;
use DateTimeImmutable;
use Doctrine\DBAL\ArrayParameterType;
use Doctrine\DBAL\Connection;
use Ramsey\Uuid\Uuid;

/**
 * The disclosure ledger (`document_access_log`, spec §1.3): append-only, read
 * by the patient. Titles are joined ONLY from the patient's own documents
 * (`d.patient_id = :patient`), so a foreign or missing document id reads as
 * `title: null` — never another patient's title.
 */
final class DocumentAccessLogRepository extends BaseRepository
{
    /** Non-PHI detail keys a ledger row may carry (never a title or a type). */
    public const DETAIL_KEYS = [
        'scope', 'duration', 'expires_at', 'previous_expires_at', 'previous_scope', 'document_count',
        'end_reason', 'capped', 'surface', 'consent_version', 'via',
    ];

    protected function getEntityClass(): string
    {
        return DocumentAccessLogEntry::class;
    }

    private function conn(): Connection
    {
        return $this->em->getConnection();
    }

    /**
     * Append one row; details are cut down to {@see DETAIL_KEYS}.
     *
     * @param array{patient_id:string, event:string, actor_role:string, specialist_id?:?string, document_id?:?string,
     *              grant_id?:?string, request_id?:?string, appointment_id?:?string, details?:array<string,mixed>} $e
     */
    public function append(array $e, DateTimeImmutable $now): string
    {
        $details = array_intersect_key($e['details'] ?? [], array_flip(self::DETAIL_KEYS));
        $details = array_filter($details, static fn ($v): bool => $v !== null);
        $id      = Uuid::uuid4()->toString();
        $this->conn()->insert('document_access_log', [
            'id'             => $id,
            'patient_id'     => strtolower($e['patient_id']),
            'specialist_id'  => self::lower($e['specialist_id'] ?? null),
            'document_id'    => self::lower($e['document_id'] ?? null),
            'grant_id'       => self::lower($e['grant_id'] ?? null),
            'request_id'     => self::lower($e['request_id'] ?? null),
            'appointment_id' => self::lower($e['appointment_id'] ?? null),
            'event'          => $e['event'],
            'actor_role'     => $e['actor_role'],
            'details'        => $details !== [] ? json_encode($details, JSON_UNESCAPED_SLASHES) : null,
            'created_at'     => Rules::sql($now),
        ]);

        return $id;
    }

    /**
     * The patient's ledger, newest first, optionally for one doctor or one
     * document; each row with `title` (null when that document is gone).
     *
     * @return array{items: list<array<string,mixed>>, total: int}
     */
    public function history(string $patientId, int $offset, int $limit, ?string $specialistId = null, ?string $documentId = null): array
    {
        $params = ['p' => strtolower($patientId)];
        $where  = 'l.patient_id = :p';
        if ($specialistId !== null) {
            $where      .= ' AND l.specialist_id = :s';
            $params['s'] = strtolower($specialistId);
        }
        if ($documentId !== null) {
            $where      .= ' AND l.document_id = :d';
            $params['d'] = strtolower($documentId);
        }
        $total = (int) $this->conn()->fetchOne("SELECT COUNT(*) FROM document_access_log l WHERE {$where}", $params);
        $items = $this->conn()->fetchAllAssociative(
            "SELECT l.id, l.patient_id, l.specialist_id, l.document_id, l.grant_id, l.request_id, l.appointment_id,
                    l.event, l.actor_role, l.details, l.created_at, d.title AS title
               FROM document_access_log l
          LEFT JOIN medical_documents d ON d.id = l.document_id AND d.patient_id = :p
              WHERE {$where}
              ORDER BY l.created_at DESC, l.id DESC
              LIMIT " . max(1, $limit) . ' OFFSET ' . max(0, $offset),
            $params,
        );

        return ['items' => $items, 'total' => $total];
    }

    /**
     * When each doctor last opened this document (from the ledger).
     *
     * @return array<string, DateTimeImmutable> specialist id => instant
     */
    public function lastViewedByDoctor(string $patientId, string $documentId): array
    {
        $out = [];
        foreach ($this->conn()->fetchAllAssociative(
            "SELECT specialist_id, MAX(created_at) AS at FROM document_access_log
              WHERE patient_id = :p AND document_id = :d AND event = 'viewed' AND specialist_id IS NOT NULL
              GROUP BY specialist_id",
            ['p' => strtolower($patientId), 'd' => strtolower($documentId)],
        ) as $row) {
            $at = Rules::fromSql($row['at']);
            if ($at !== null) {
                $out[strtolower((string) $row['specialist_id'])] = $at;
            }
        }

        return $out;
    }

    /**
     * The grant each approved request produced (from its `request_approved` row).
     *
     * @param list<string> $requestIds
     * @return array<string,string> request id => grant id
     */
    public function grantIdsForRequests(array $requestIds): array
    {
        if ($requestIds === []) {
            return [];
        }
        $out = [];
        foreach ($this->conn()->fetchAllAssociative(
            "SELECT request_id, grant_id FROM document_access_log
              WHERE request_id IN (:ids) AND event = 'request_approved' AND grant_id IS NOT NULL
              ORDER BY created_at ASC",
            ['ids' => array_values(array_map('strtolower', $requestIds))],
            ['ids' => ArrayParameterType::STRING],
        ) as $row) {
            $out[strtolower((string) $row['request_id'])] = strtolower((string) $row['grant_id']);
        }

        return $out;
    }

    /** Count rows of one event for a patient (tests / monitoring). */
    public function countEvents(string $patientId, string $event): int
    {
        return (int) $this->conn()->fetchOne(
            'SELECT COUNT(*) FROM document_access_log WHERE patient_id = :p AND event = :e',
            ['p' => strtolower($patientId), 'e' => $event],
        );
    }

    private static function lower(?string $id): ?string
    {
        return $id !== null && $id !== '' ? strtolower($id) : null;
    }
}
