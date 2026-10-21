<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Document\ShareDuration;
use App\Domain\Entity\DocumentAccessGrant;
use DateTimeImmutable;
use Doctrine\DBAL\ArrayParameterType;
use Doctrine\DBAL\Connection;
use Ramsey\Uuid\Uuid;

/**
 * SQL for document-access grants, their include rows, and the per-pair
 * hidden rows and request blocks (spec §1.3). Rows come back as associative
 * arrays (timestamps as naive process-zone strings — read them with
 * {@see Rules::fromSql()}). Writes are plain DBAL inside the caller's
 * pair-locked transaction; state changes of an existing grant go through
 * {@see \App\Infrastructure\Document\DocumentAccessTransitions} (compare-and-set),
 * never through here.
 *
 * Nothing here decides what a doctor may SEE — that is
 * {@see \App\Infrastructure\Document\DocumentAccessPolicy} alone.
 */
final class DocumentAccessGrantRepository extends BaseRepository
{
    /** Every grant column, aliased `g`. */
    public const COLUMNS = 'g.id, g.patient_id, g.specialist_id, g.scope, g.status, g.source, g.surface, g.consent_version, g.duration,
        g.starts_at, g.expires_at, g.original_expires_at, g.appointment_id, g.request_id, g.client_key, g.request_hash,
        g.revoke_batch_id, g.restored_at, g.restored_from_grant_id, g.ended_at, g.end_reason, g.ended_by,
        g.last_accessed_at, g.access_count, g.created_at, g.updated_at';

    protected function getEntityClass(): string
    {
        return DocumentAccessGrant::class;
    }

    private function conn(): Connection
    {
        return $this->em->getConnection();
    }

    // ----- Grants -----

    /**
     * Insert a grant; returns its id.
     *
     * @param array{patient_id:string, specialist_id:string, scope:string, source:string, surface:string, duration:string,
     *              expires_at:?DateTimeImmutable, original_expires_at?:?DateTimeImmutable, appointment_id?:?string,
     *              request_id?:?string, client_key?:?string, request_hash?:?string, restored_from_grant_id?:?string} $g
     */
    public function insertGrant(array $g, DateTimeImmutable $now): string
    {
        $id = Uuid::uuid4()->toString();
        $this->conn()->insert('document_access_grants', [
            'id'                     => $id,
            'patient_id'             => strtolower($g['patient_id']),
            'specialist_id'          => strtolower($g['specialist_id']),
            'scope'                  => $g['scope'],
            'status'                 => DocumentAccessGrant::STATUS_ACTIVE,
            'source'                 => $g['source'],
            'surface'                => $g['surface'],
            'consent_version'        => Rules::CONSENT_VERSION,
            'duration'               => $g['duration'],
            'starts_at'              => Rules::sql($now),
            'expires_at'             => $g['expires_at'] !== null ? Rules::sql($g['expires_at']) : null,
            'original_expires_at'    => array_key_exists('original_expires_at', $g)
                ? ($g['original_expires_at'] !== null ? Rules::sql($g['original_expires_at']) : null)
                : ($g['expires_at'] !== null ? Rules::sql($g['expires_at']) : null),
            'appointment_id'         => $g['appointment_id'] ?? null,
            'request_id'             => $g['request_id'] ?? null,
            'client_key'             => $g['client_key'] ?? null,
            'request_hash'           => $g['request_hash'] ?? null,
            'restored_from_grant_id' => $g['restored_from_grant_id'] ?? null,
            'access_count'           => 0,
            'created_at'             => Rules::sql($now),
            'updated_at'             => Rules::sql($now),
        ]);

        return $id;
    }

    /** @return array<string,mixed>|null */
    public function row(string $id): ?array
    {
        $row = $this->conn()->fetchAssociative('SELECT ' . self::COLUMNS . ' FROM document_access_grants g WHERE g.id = :id', ['id' => strtolower($id)]);

        return $row === false ? null : $row;
    }

    /** The grant if it is this patient's (unknown and foreign ids read the same: null). @return array<string,mixed>|null */
    public function rowForPatient(string $id, string $patientId): ?array
    {
        $row = $this->conn()->fetchAssociative(
            'SELECT ' . self::COLUMNS . ' FROM document_access_grants g WHERE g.id = :id AND g.patient_id = :p',
            ['id' => strtolower($id), 'p' => strtolower($patientId)],
        );

        return $row === false ? null : $row;
    }

    /**
     * @param list<string> $ids
     * @return list<array<string,mixed>>
     */
    public function rowsByIds(array $ids): array
    {
        if ($ids === []) {
            return [];
        }

        return $this->conn()->fetchAllAssociative(
            'SELECT ' . self::COLUMNS . ' FROM document_access_grants g WHERE g.id IN (:ids) ORDER BY g.created_at DESC, g.id DESC',
            ['ids' => array_values(array_map('strtolower', $ids))],
            ['ids' => ArrayParameterType::STRING],
        );
    }

    /** Stored-active grants of the pair (in window once the pair's lazy expiry ran), newest first. @return list<array<string,mixed>> */
    public function activeRowsForPair(string $patientId, string $specialistId): array
    {
        return $this->conn()->fetchAllAssociative(
            'SELECT ' . self::COLUMNS . " FROM document_access_grants g
              WHERE g.patient_id = :p AND g.specialist_id = :s AND g.status = 'active'
              ORDER BY g.created_at DESC, g.id DESC",
            ['p' => strtolower($patientId), 's' => strtolower($specialistId)],
        );
    }

    /** The pair's stored-active whole-folder grant (at most one: a partial unique index). @return array<string,mixed>|null */
    public function activeFolderForPair(string $patientId, string $specialistId): ?array
    {
        $row = $this->conn()->fetchAssociative(
            'SELECT ' . self::COLUMNS . " FROM document_access_grants g
              WHERE g.patient_id = :p AND g.specialist_id = :s AND g.status = 'active' AND g.scope = 'all'
              ORDER BY g.created_at DESC LIMIT 1",
            ['p' => strtolower($patientId), 's' => strtolower($specialistId)],
        );

        return $row === false ? null : $row;
    }

    /** The pair's active grant made with this client key (an upload batch), if any. @return array<string,mixed>|null */
    public function activeWithClientKey(string $patientId, string $specialistId, string $clientKey): ?array
    {
        $row = $this->conn()->fetchAssociative(
            'SELECT ' . self::COLUMNS . " FROM document_access_grants g
              WHERE g.patient_id = :p AND g.specialist_id = :s AND g.client_key = :k AND g.status = 'active'
              ORDER BY g.created_at DESC LIMIT 1",
            ['p' => strtolower($patientId), 's' => strtolower($specialistId), 'k' => strtolower($clientKey)],
        );

        return $row === false ? null : $row;
    }

    /** Every grant (any status) this patient made with this client key, oldest first. @return list<array<string,mixed>> */
    public function rowsWithClientKey(string $patientId, string $clientKey): array
    {
        return $this->conn()->fetchAllAssociative(
            'SELECT ' . self::COLUMNS . ' FROM document_access_grants g
              WHERE g.patient_id = :p AND g.client_key = :k ORDER BY g.created_at ASC, g.id ASC',
            ['p' => strtolower($patientId), 'k' => strtolower($clientKey)],
        );
    }

    // ----- Share submissions (idempotency, spec §3.5) -----

    /**
     * The patient's share submission made with this client key, or null. The
     * JSON columns come back decoded.
     *
     * @return array{id:string, patient_id:string, client_key:string, request_hash:string, grant_ids:list<string>,
     *               outcomes:list<array{specialist_id:string, grant_id:string, outcome:string}>,
     *               approved_request_ids:list<string>, created_at:string}|null
     */
    public function submission(string $patientId, string $clientKey): ?array
    {
        $row = $this->conn()->fetchAssociative(
            'SELECT id, patient_id, client_key, request_hash, grant_ids, outcomes, approved_request_ids, created_at
               FROM document_access_submissions WHERE patient_id = :p AND client_key = :k',
            ['p' => strtolower($patientId), 'k' => strtolower($clientKey)],
        );
        if ($row === false) {
            return null;
        }
        foreach (['grant_ids', 'outcomes', 'approved_request_ids'] as $column) {
            $decoded      = is_string($row[$column]) ? json_decode($row[$column], true) : $row[$column];
            $row[$column] = is_array($decoded) ? array_values($decoded) : [];
        }

        return $row;
    }

    /**
     * Record one share submission — inside the share's own transaction, so it
     * exists exactly when the share committed. A second insert of the same
     * (patient, client key) fails on `uniq_doc_submissions_key`.
     *
     * @param list<string>                                                         $grantIds
     * @param list<array{specialist_id:string, grant_id:string, outcome:string}> $outcomes
     * @param list<string>                                                         $approvedRequestIds
     */
    public function insertSubmission(string $patientId, string $clientKey, string $requestHash, array $grantIds, array $outcomes, array $approvedRequestIds, DateTimeImmutable $now): void
    {
        $this->conn()->insert('document_access_submissions', [
            'id'                   => Uuid::uuid4()->toString(),
            'patient_id'           => strtolower($patientId),
            'client_key'           => strtolower($clientKey),
            'request_hash'         => $requestHash,
            'grant_ids'            => json_encode(array_values($grantIds), JSON_UNESCAPED_SLASHES),
            'outcomes'             => json_encode(array_values($outcomes), JSON_UNESCAPED_SLASHES),
            'approved_request_ids' => json_encode(array_values($approvedRequestIds), JSON_UNESCAPED_SLASHES),
            'created_at'           => Rules::sql($now),
        ]);
    }

    /**
     * The pair's active `selected` grant a new selected share merges into: the
     * same duration, consultation, end and source (spec §1.1).
     *
     * @return array<string,mixed>|null
     */
    public function mergeCandidate(string $patientId, string $specialistId, string $duration, ?string $appointmentId, ?DateTimeImmutable $expiresAt, string $source): ?array
    {
        $sql = 'SELECT ' . self::COLUMNS . " FROM document_access_grants g
                 WHERE g.patient_id = :p AND g.specialist_id = :s AND g.status = 'active' AND g.scope = 'selected'
                   AND g.duration = :d AND g.source = :src
                   AND " . ($appointmentId === null ? 'g.appointment_id IS NULL' : 'g.appointment_id = :a') . '
                   AND ' . ($expiresAt === null ? 'g.expires_at IS NULL' : 'g.expires_at = :e') . '
                 ORDER BY g.created_at DESC LIMIT 1';
        $params = ['p' => strtolower($patientId), 's' => strtolower($specialistId), 'd' => $duration, 'src' => $source];
        if ($appointmentId !== null) {
            $params['a'] = strtolower($appointmentId);
        }
        if ($expiresAt !== null) {
            $params['e'] = Rules::sql($expiresAt);
        }
        $row = $this->conn()->fetchAssociative($sql, $params);

        return $row === false ? null : $row;
    }

    /** The grants one patient revoke ended together. @return list<array<string,mixed>> */
    public function rowsInBatch(string $patientId, string $batchId): array
    {
        return $this->conn()->fetchAllAssociative(
            'SELECT ' . self::COLUMNS . ' FROM document_access_grants g
              WHERE g.patient_id = :p AND g.revoke_batch_id = :b ORDER BY g.created_at ASC, g.id ASC',
            ['p' => strtolower($patientId), 'b' => strtolower($batchId)],
        );
    }

    /**
     * Grants an Undo created from these ended grants.
     *
     * @param list<string> $fromIds
     * @return list<array<string,mixed>>
     */
    public function restoredFrom(array $fromIds): array
    {
        if ($fromIds === []) {
            return [];
        }

        return $this->conn()->fetchAllAssociative(
            'SELECT ' . self::COLUMNS . ' FROM document_access_grants g WHERE g.restored_from_grant_id IN (:ids) ORDER BY g.created_at ASC, g.id ASC',
            ['ids' => array_values(array_map('strtolower', $fromIds))],
            ['ids' => ArrayParameterType::STRING],
        );
    }

    /**
     * The patient's grants for the list (spec §3.3): `active` = stored active,
     * in window and — for an "after the consultation" share — its consultation
     * still standing (the anchor part of DocumentAccessPolicy::activePredicate);
     * `ended` = ended within 90 days plus stored-active ones already past their
     * end or whose consultation went (shown as expired) before the sweeper
     * recorded it, newest first, at most 100. A grant is in one list, never both.
     *
     * @return list<array<string,mixed>>
     */
    public function listForPatient(string $patientId, string $status, ?string $specialistId, DateTimeImmutable $now): array
    {
        $params = ['p' => strtolower($patientId), 'now' => Rules::sql($now), 'anchored' => ShareDuration::anchoredCodes()];
        $where  = 'g.patient_id = :p';
        if ($specialistId !== null) {
            $where          .= ' AND g.specialist_id = :s';
            $params['s'] = strtolower($specialistId);
        }
        // An anchored (`after_*`) share whose consultation is missing, deleted or cancelled no longer gives access.
        $anchorGone = "(g.duration IN (:anchored) AND (a.id IS NULL OR a.deleted_at IS NOT NULL OR a.status = 'cancelled'))";
        if ($status === 'ended') {
            $params['since'] = Rules::sql($now->modify('-' . Rules::ENDED_LIST_DAYS . ' days'));
            $where .= " AND ((g.status <> 'active' AND g.ended_at >= :since)
                          OR (g.status = 'active' AND g.expires_at IS NOT NULL AND g.expires_at <= :now)
                          OR (g.status = 'active' AND {$anchorGone}))";
            $order = 'COALESCE(g.ended_at, g.expires_at) DESC, g.id DESC';
        } else {
            $where .= " AND g.status = 'active' AND g.starts_at <= :now AND (g.expires_at IS NULL OR g.expires_at > :now)
                        AND NOT {$anchorGone}";
            $order = 'g.created_at DESC, g.id DESC';
        }

        return $this->conn()->fetchAllAssociative(
            'SELECT ' . self::COLUMNS . " FROM document_access_grants g
          LEFT JOIN appointments a ON a.id = g.appointment_id
              WHERE {$where} ORDER BY {$order} LIMIT 100",
            $params,
            ['anchored' => ArrayParameterType::STRING],
        );
    }

    /** Doctors the patient has a stored-active grant with. @return list<string> */
    public function activeSpecialistIds(string $patientId): array
    {
        return array_map('strval', $this->conn()->fetchFirstColumn(
            "SELECT DISTINCT specialist_id FROM document_access_grants WHERE patient_id = :p AND status = 'active'",
            ['p' => strtolower($patientId)],
        ));
    }

    /** Doctors holding a stored-active whole-folder grant of the patient. @return list<string> */
    public function activeFolderHolders(string $patientId): array
    {
        return array_map('strtolower', array_map('strval', $this->conn()->fetchFirstColumn(
            "SELECT DISTINCT specialist_id FROM document_access_grants WHERE patient_id = :p AND status = 'active' AND scope = 'all'",
            ['p' => strtolower($patientId)],
        )));
    }

    /** Stored-active `after_*` grants anchored to one consultation. @return list<array<string,mixed>> */
    public function activeAnchoredForAppointment(string $appointmentId): array
    {
        return $this->conn()->fetchAllAssociative(
            'SELECT ' . self::COLUMNS . " FROM document_access_grants g
              WHERE g.appointment_id = :a AND g.status = 'active' AND g.duration IN (:anchored)
              ORDER BY g.created_at ASC",
            ['a' => strtolower($appointmentId), 'anchored' => ShareDuration::anchoredCodes()],
            ['anchored' => ArrayParameterType::STRING],
        );
    }

    /** Stored-active grants of one doctor (every patient). @return list<array<string,mixed>> */
    public function activeRowsForSpecialist(string $specialistId): array
    {
        return $this->conn()->fetchAllAssociative(
            'SELECT ' . self::COLUMNS . " FROM document_access_grants g WHERE g.specialist_id = :s AND g.status = 'active' ORDER BY g.patient_id, g.created_at",
            ['s' => strtolower($specialistId)],
        );
    }

    /** Whether the pair ever had a grant (any status). */
    public function pairEverShared(string $patientId, string $specialistId): bool
    {
        return $this->conn()->fetchOne(
            'SELECT 1 FROM document_access_grants WHERE patient_id = :p AND specialist_id = :s LIMIT 1',
            ['p' => strtolower($patientId), 's' => strtolower($specialistId)],
        ) !== false;
    }

    // ----- Sweeper / lazy-expiry candidates -----

    /** Active grants past their end (optionally of one pair). @return list<string> */
    public function dueIds(DateTimeImmutable $now, int $limit, ?string $patientId = null, ?string $specialistId = null): array
    {
        [$pair, $params] = $this->pairFilter($patientId, $specialistId);

        return array_map('strval', $this->conn()->fetchFirstColumn(
            "SELECT g.id FROM document_access_grants g
              WHERE g.status = 'active' AND g.expires_at IS NOT NULL AND g.expires_at <= :now {$pair}
              ORDER BY g.expires_at ASC LIMIT " . max(1, $limit),
            ['now' => Rules::sql($now)] + $params,
        ));
    }

    /** Active `after_*` grants whose consultation is cancelled, deleted or gone. @return list<string> */
    public function danglingAnchoredIds(int $limit, ?string $patientId = null, ?string $specialistId = null): array
    {
        [$pair, $params] = $this->pairFilter($patientId, $specialistId);

        return array_map('strval', $this->conn()->fetchFirstColumn(
            "SELECT g.id FROM document_access_grants g
          LEFT JOIN appointments a ON a.id = g.appointment_id
              WHERE g.status = 'active' AND g.duration IN (:anchored)
                AND (a.id IS NULL OR a.deleted_at IS NOT NULL OR a.status = 'cancelled') {$pair}
              ORDER BY g.created_at ASC LIMIT " . max(1, $limit),
            ['anchored' => ShareDuration::anchoredCodes()] + $params,
            ['anchored' => ArrayParameterType::STRING],
        ));
    }

    /** Active `selected` grants none of whose included documents exists any more. @return list<string> */
    public function emptiedIds(int $limit): array
    {
        return array_map('strval', $this->conn()->fetchFirstColumn(
            "SELECT g.id FROM document_access_grants g
              WHERE g.status = 'active' AND g.scope = 'selected'
                AND NOT EXISTS (SELECT 1 FROM document_access_grant_documents gd
                                  JOIN medical_documents d ON d.id = gd.document_id AND d.patient_id = g.patient_id
                                 WHERE gd.grant_id = g.id)
              ORDER BY g.created_at ASC LIMIT " . max(1, $limit),
        ));
    }

    public function countActive(): int
    {
        return (int) $this->conn()->fetchOne("SELECT COUNT(*) FROM document_access_grants WHERE status = 'active'");
    }

    /** Record one doctor file view on the grant that showed it. */
    public function touchAccess(string $grantId, DateTimeImmutable $now): int
    {
        return (int) $this->conn()->executeStatement(
            'UPDATE document_access_grants SET last_accessed_at = :now, access_count = access_count + 1 WHERE id = :id',
            ['now' => Rules::sql($now), 'id' => strtolower($grantId)],
        );
    }

    /** Change a grant's scope while it is active (include rows are the caller's). */
    public function setScope(string $grantId, string $scope, DateTimeImmutable $now): bool
    {
        return (int) $this->conn()->executeStatement(
            "UPDATE document_access_grants SET scope = :scope, updated_at = :now WHERE id = :id AND status = 'active'",
            ['scope' => $scope, 'now' => Rules::sql($now), 'id' => strtolower($grantId)],
        ) === 1;
    }

    /** Link a grant to the request it answered. */
    public function setRequest(string $grantId, string $requestId, DateTimeImmutable $now): void
    {
        $this->conn()->executeStatement(
            'UPDATE document_access_grants SET request_id = :r, updated_at = :now WHERE id = :id',
            ['r' => strtolower($requestId), 'now' => Rules::sql($now), 'id' => strtolower($grantId)],
        );
    }

    // ----- Include rows (selected grants) -----

    /**
     * Add documents to a grant; returns the ids actually added (not already on it).
     *
     * @param list<string> $documentIds
     * @return list<string>
     */
    public function addDocuments(string $grantId, array $documentIds, DateTimeImmutable $now): array
    {
        $added = [];
        foreach ($documentIds as $documentId) {
            $id = $this->conn()->fetchOne(
                'INSERT INTO document_access_grant_documents (id, grant_id, document_id, created_at)
                 VALUES (:id, :g, :d, :now) ON CONFLICT DO NOTHING RETURNING document_id',
                ['id' => Uuid::uuid4()->toString(), 'g' => strtolower($grantId), 'd' => strtolower($documentId), 'now' => Rules::sql($now)],
            );
            if ($id !== false) {
                $added[] = strtolower((string) $id);
            }
        }

        return $added;
    }

    /**
     * Take documents off a grant; returns the ids removed.
     *
     * @param list<string> $documentIds
     * @return list<string>
     */
    public function removeDocuments(string $grantId, array $documentIds): array
    {
        if ($documentIds === []) {
            return [];
        }

        return array_map('strval', $this->conn()->fetchFirstColumn(
            'DELETE FROM document_access_grant_documents WHERE grant_id = :g AND document_id IN (:ids) RETURNING document_id',
            ['g' => strtolower($grantId), 'ids' => array_values(array_map('strtolower', $documentIds))],
            ['ids' => ArrayParameterType::STRING],
        ));
    }

    /** Remove every include row of a grant; returns the ids removed. @return list<string> */
    public function clearDocuments(string $grantId): array
    {
        return array_map('strval', $this->conn()->fetchFirstColumn(
            'DELETE FROM document_access_grant_documents WHERE grant_id = :g RETURNING document_id',
            ['g' => strtolower($grantId)],
        ));
    }

    /**
     * Each grant's included documents that still exist (the patient's own),
     * newest first, at most `$limit` per grant.
     *
     * @param list<string> $grantIds
     * @return array<string, list<string>>
     */
    public function documentIdsFor(array $grantIds, int $limit = Rules::GRANT_DOCUMENT_IDS_MAX): array
    {
        if ($grantIds === []) {
            return [];
        }
        $out  = [];
        $rows = $this->conn()->fetchAllAssociative(
            'SELECT gd.grant_id, gd.document_id FROM document_access_grant_documents gd
               JOIN document_access_grants g ON g.id = gd.grant_id
               JOIN medical_documents d ON d.id = gd.document_id AND d.patient_id = g.patient_id
              WHERE gd.grant_id IN (:ids)
              ORDER BY d.created_at DESC, d.id DESC',
            ['ids' => array_values(array_map('strtolower', $grantIds))],
            ['ids' => ArrayParameterType::STRING],
        );
        foreach ($rows as $row) {
            $g = strtolower((string) $row['grant_id']);
            if (count($out[$g] ?? []) < $limit) {
                $out[$g][] = strtolower((string) $row['document_id']);
            }
        }

        return $out;
    }

    /**
     * How many existing documents each grant includes (exact).
     *
     * @param list<string> $grantIds
     * @return array<string,int>
     */
    public function documentCounts(array $grantIds): array
    {
        if ($grantIds === []) {
            return [];
        }
        $out = [];
        foreach ($this->conn()->fetchAllAssociative(
            'SELECT gd.grant_id, COUNT(*) AS n FROM document_access_grant_documents gd
               JOIN document_access_grants g ON g.id = gd.grant_id
               JOIN medical_documents d ON d.id = gd.document_id AND d.patient_id = g.patient_id
              WHERE gd.grant_id IN (:ids) GROUP BY gd.grant_id',
            ['ids' => array_values(array_map('strtolower', $grantIds))],
            ['ids' => ArrayParameterType::STRING],
        ) as $row) {
            $out[strtolower((string) $row['grant_id'])] = (int) $row['n'];
        }

        return $out;
    }

    /**
     * Raw include rows (whether or not the document still exists) — for a restore copy.
     *
     * @return list<string>
     */
    public function rawDocumentIds(string $grantId): array
    {
        return array_map('strval', $this->conn()->fetchFirstColumn(
            'SELECT document_id FROM document_access_grant_documents WHERE grant_id = :g ORDER BY created_at ASC',
            ['g' => strtolower($grantId)],
        ));
    }

    /**
     * The pair's active selected grants that include this document.
     *
     * @return list<array<string,mixed>>
     */
    public function activeSelectedIncluding(string $patientId, string $specialistId, string $documentId): array
    {
        return $this->conn()->fetchAllAssociative(
            'SELECT ' . self::COLUMNS . " FROM document_access_grants g
              WHERE g.patient_id = :p AND g.specialist_id = :s AND g.status = 'active' AND g.scope = 'selected'
                AND EXISTS (SELECT 1 FROM document_access_grant_documents gd WHERE gd.grant_id = g.id AND gd.document_id = :d)
              ORDER BY g.created_at ASC",
            ['p' => strtolower($patientId), 's' => strtolower($specialistId), 'd' => strtolower($documentId)],
        );
    }

    // ----- Hidden rows (per pair) -----

    /** Hide a document from a doctor's folder access; false when it already was. */
    public function hide(string $patientId, string $specialistId, string $documentId, string $surface, DateTimeImmutable $now): bool
    {
        return $this->conn()->fetchOne(
            'INSERT INTO document_access_hidden (id, patient_id, specialist_id, document_id, created_at, created_surface)
             SELECT CAST(:id AS CHAR(36)), CAST(:p AS CHAR(36)), CAST(:s AS CHAR(36)), CAST(:d AS CHAR(36)),
                    CAST(:now AS TIMESTAMP(0)), CAST(:surface AS VARCHAR(24))
              WHERE NOT EXISTS (SELECT 1 FROM document_access_hidden h
                                 WHERE h.patient_id = :p AND h.specialist_id = :s AND h.document_id = :d AND h.cleared_at IS NULL)
             ON CONFLICT DO NOTHING RETURNING id',
            [
                'id'      => Uuid::uuid4()->toString(),
                'p'       => strtolower($patientId),
                's'       => strtolower($specialistId),
                'd'       => strtolower($documentId),
                'now'     => Rules::sql($now),
                'surface' => $surface,
            ],
        ) !== false;
    }

    /**
     * Clear open hidden rows of the pair (only these documents, when given);
     * returns the document ids cleared.
     *
     * @param list<string>|null $documentIds
     * @return list<string>
     */
    public function clearHidden(string $patientId, string $specialistId, ?array $documentIds, string $surface, DateTimeImmutable $now): array
    {
        if ($documentIds === []) {
            return [];
        }
        $params = ['p' => strtolower($patientId), 's' => strtolower($specialistId), 'now' => Rules::sql($now), 'surface' => $surface];
        $types  = [];
        $only   = '';
        if ($documentIds !== null) {
            $only            = ' AND document_id IN (:ids)';
            $params['ids'] = array_values(array_map('strtolower', $documentIds));
            $types['ids']  = ArrayParameterType::STRING;
        }

        return array_map('strval', $this->conn()->fetchFirstColumn(
            "UPDATE document_access_hidden SET cleared_at = :now, cleared_surface = :surface
              WHERE patient_id = :p AND specialist_id = :s AND cleared_at IS NULL{$only}
              RETURNING document_id",
            $params,
            $types,
        ));
    }

    /**
     * Open hidden rows of each of the patient's doctors (documents that still
     * exist), newest document first.
     *
     * @return array<string, list<string>> specialist id => document ids
     */
    public function openHiddenByDoctor(string $patientId, ?string $specialistId = null): array
    {
        $params = ['p' => strtolower($patientId)];
        $one    = '';
        if ($specialistId !== null) {
            $one         = ' AND h.specialist_id = :s';
            $params['s'] = strtolower($specialistId);
        }
        $out = [];
        foreach ($this->conn()->fetchAllAssociative(
            "SELECT h.specialist_id, h.document_id FROM document_access_hidden h
               JOIN medical_documents d ON d.id = h.document_id AND d.patient_id = h.patient_id
              WHERE h.patient_id = :p AND h.cleared_at IS NULL{$one}
              ORDER BY d.created_at DESC, d.id DESC",
            $params,
        ) as $row) {
            $out[strtolower((string) $row['specialist_id'])][] = strtolower((string) $row['document_id']);
        }

        return $out;
    }

    /** The doctors a document is hidden from (open rows). @return list<string> */
    public function hiddenFrom(string $patientId, string $documentId): array
    {
        return array_map('strtolower', array_map('strval', $this->conn()->fetchFirstColumn(
            'SELECT specialist_id FROM document_access_hidden WHERE patient_id = :p AND document_id = :d AND cleared_at IS NULL',
            ['p' => strtolower($patientId), 'd' => strtolower($documentId)],
        )));
    }

    // ----- Request blocks (per pair) -----

    public function hasOpenBlock(string $patientId, string $specialistId): bool
    {
        return $this->conn()->fetchOne(
            'SELECT 1 FROM document_access_blocks WHERE patient_id = :p AND specialist_id = :s AND lifted_at IS NULL LIMIT 1',
            ['p' => strtolower($patientId), 's' => strtolower($specialistId)],
        ) !== false;
    }

    /** Doctors the patient stopped asking. @return list<string> */
    public function blockedSpecialistIds(string $patientId): array
    {
        return array_map('strtolower', array_map('strval', $this->conn()->fetchFirstColumn(
            'SELECT specialist_id FROM document_access_blocks WHERE patient_id = :p AND lifted_at IS NULL',
            ['p' => strtolower($patientId)],
        )));
    }

    /** Open a block; false when one is already open. */
    public function insertBlock(string $patientId, string $specialistId, ?string $requestId, DateTimeImmutable $now): bool
    {
        return $this->conn()->fetchOne(
            'INSERT INTO document_access_blocks (id, patient_id, specialist_id, request_id, created_at)
             SELECT CAST(:id AS CHAR(36)), CAST(:p AS CHAR(36)), CAST(:s AS CHAR(36)), CAST(:r AS CHAR(36)), CAST(:now AS TIMESTAMP(0))
              WHERE NOT EXISTS (SELECT 1 FROM document_access_blocks b WHERE b.patient_id = :p AND b.specialist_id = :s AND b.lifted_at IS NULL)
             ON CONFLICT DO NOTHING RETURNING id',
            ['id' => Uuid::uuid4()->toString(), 'p' => strtolower($patientId), 's' => strtolower($specialistId), 'r' => $requestId !== null ? strtolower($requestId) : null, 'now' => Rules::sql($now)],
        ) !== false;
    }

    /** Lift the open block; false when there was none. */
    public function liftBlock(string $patientId, string $specialistId, DateTimeImmutable $now): bool
    {
        return (int) $this->conn()->executeStatement(
            'UPDATE document_access_blocks SET lifted_at = :now WHERE patient_id = :p AND specialist_id = :s AND lifted_at IS NULL',
            ['now' => Rules::sql($now), 'p' => strtolower($patientId), 's' => strtolower($specialistId)],
        ) > 0;
    }

    /** @return array{0:string, 1:array<string,string>} */
    private function pairFilter(?string $patientId, ?string $specialistId): array
    {
        $sql    = '';
        $params = [];
        if ($patientId !== null) {
            $sql        .= ' AND g.patient_id = :p';
            $params['p'] = strtolower($patientId);
        }
        if ($specialistId !== null) {
            $sql        .= ' AND g.specialist_id = :s';
            $params['s'] = strtolower($specialistId);
        }

        return [$sql, $params];
    }
}
