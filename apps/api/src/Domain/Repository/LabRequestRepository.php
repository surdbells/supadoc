<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Document\DocumentSharingRules;
use App\Domain\Entity\LabRequest;
use App\Domain\Entity\LabRequestEvent;
use App\Domain\Entity\LabRequestResult;
use App\Domain\Lab\LabRequestRules;
use DateTimeImmutable;
use Doctrine\DBAL\ArrayParameterType;

/**
 * Lab requests, their results and timeline (spec §1). Lists are scoped to ONE
 * owner (the requesting doctor or the patient) and composed as
 * "<owner> = :o AND " + a parenthesised {@see LabRequestRules::GROUP_SQL}
 * fragment, so a filter can never widen past the owner. Every timestamp is
 * bound from PHP's clock as the naive process-zone string the columns hold
 * ({@see DocumentSharingRules::sql()}) — never SQL NOW().
 */
final class LabRequestRepository extends BaseRepository
{
    private const OWNERS = ['specialist_id', 'patient_id'];

    protected function getEntityClass(): string
    {
        return LabRequest::class;
    }

    public function findById(string $id): ?LabRequest
    {
        $id = strtolower(trim($id));
        if (preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/', $id) !== 1) {
            return null;
        }
        $r = $this->find($id);

        return $r instanceof LabRequest ? $r : null;
    }

    /** The doctor's own request, else null (another doctor's reads as unknown). */
    public function findForSpecialist(string $id, string $specialistId): ?LabRequest
    {
        $r = $this->findById($id);

        return $r !== null && $r->getSpecialistId() === strtolower($specialistId) ? $r : null;
    }

    /** The patient's own request, else null. */
    public function findForPatient(string $id, string $patientId): ?LabRequest
    {
        $r = $this->findById($id);

        return $r !== null && $r->getPatientId() === strtolower($patientId) ? $r : null;
    }

    /** {id, request_hash} of the doctor's request sent with this form key, or null (DBAL: usable after a rollback). */
    public function clientKeyRow(string $specialistId, string $clientKey): ?array
    {
        $row = $this->em->getConnection()->fetchAssociative(
            'SELECT id, request_hash FROM lab_requests WHERE specialist_id = :s AND client_key = :k',
            ['s' => strtolower($specialistId), 'k' => strtolower($clientKey)],
        );

        return $row === false ? null : ['id' => strtolower((string) $row['id']), 'request_hash' => (string) $row['request_hash']];
    }

    /**
     * One page of an owner's requests, most recent activity first.
     *
     * @param array{q?: ?string, appointment_id?: ?string, patient_id?: ?string} $filters
     * @return array{ids: list<string>, total: int}
     */
    public function listIds(string $owner, string $ownerId, string $group, array $filters, DateTimeImmutable $now, int $offset, int $limit): array
    {
        [$where, $params] = $this->scope($owner, $ownerId, $filters, $now);
        $where .= ' AND ' . LabRequestRules::GROUP_SQL[$group];
        $params = self::used($where, $params);
        $conn   = $this->em->getConnection();
        $total  = (int) $conn->fetchOne('SELECT COUNT(*) FROM lab_requests WHERE ' . $where, $params);
        $ids    = $conn->fetchFirstColumn(
            'SELECT id FROM lab_requests WHERE ' . $where . ' ORDER BY last_activity_at DESC, id DESC LIMIT ' . max(1, $limit) . ' OFFSET ' . max(0, $offset),
            $params,
        );

        return ['ids' => array_map(static fn ($id): string => strtolower((string) $id), $ids), 'total' => $total];
    }

    /**
     * Every group's count for the owner (honouring the filters, not the group).
     *
     * @param array{q?: ?string, appointment_id?: ?string, patient_id?: ?string} $filters
     * @return array<string,int>
     */
    public function groupCounts(string $owner, string $ownerId, array $filters, DateTimeImmutable $now): array
    {
        [$where, $params] = $this->scope($owner, $ownerId, $filters, $now);
        $select = [];
        foreach (LabRequestRules::GROUP_SQL as $group => $sql) {
            $select[] = 'COUNT(*) FILTER (WHERE ' . $sql . ') AS g_' . $group;
        }
        $row = $this->em->getConnection()->fetchAssociative('SELECT ' . implode(', ', $select) . ' FROM lab_requests WHERE ' . $where, $params) ?: [];
        $out = [];
        foreach (LabRequestRules::GROUPS as $group) {
            $out[$group] = (int) ($row['g_' . $group] ?? 0);
        }

        return $out;
    }

    /**
     * Platform-wide group counts (back-office overview).
     *
     * @return array<string,int>
     */
    public function platformCounts(DateTimeImmutable $now): array
    {
        $select = [];
        foreach (LabRequestRules::GROUP_SQL as $group => $sql) {
            $select[] = 'COUNT(*) FILTER (WHERE ' . $sql . ') AS g_' . $group;
        }
        $row = $this->em->getConnection()->fetchAssociative('SELECT ' . implode(', ', $select) . ' FROM lab_requests', ['now' => DocumentSharingRules::sql($now)]) ?: [];
        $out = [];
        foreach (LabRequestRules::GROUPS as $group) {
            $out[$group] = (int) ($row['g_' . $group] ?? 0);
        }

        return $out;
    }

    /** @param list<string> $ids @return list<LabRequest> in the order of `$ids` */
    public function loadByIds(array $ids): array
    {
        if ($ids === []) {
            return [];
        }
        /** @var list<LabRequest> $rows */
        $rows = $this->em->createQueryBuilder()
            ->select('r')
            ->from(LabRequest::class, 'r')
            ->andWhere('r.id IN (:ids)')
            ->setParameter('ids', $ids)
            ->getQuery()
            ->getResult();
        $byId = [];
        foreach ($rows as $r) {
            $byId[$r->getId()] = $r;
        }

        return array_values(array_filter(array_map(static fn (string $id): ?LabRequest => $byId[$id] ?? null, $ids)));
    }

    /** A patient's requests, newest sent first (back office). @return list<LabRequest> */
    public function forPatient(string $patientId, int $limit = 200): array
    {
        return $this->em->createQueryBuilder()
            ->select('r')
            ->from(LabRequest::class, 'r')
            ->andWhere('r.patientId = :p')
            ->setParameter('p', strtolower($patientId))
            ->orderBy('r.sentAt', 'DESC')
            ->addOrderBy('r.id', 'DESC')
            ->setMaxResults($limit)
            ->getQuery()
            ->getResult();
    }

    /** The request's timeline, oldest first. @return list<LabRequestEvent> */
    public function events(string $labRequestId): array
    {
        return $this->em->createQueryBuilder()
            ->select('e')
            ->from(LabRequestEvent::class, 'e')
            ->andWhere('e.labRequestId = :r')
            ->setParameter('r', strtolower($labRequestId))
            ->orderBy('e.createdAt', 'ASC')
            ->addOrderBy('e.id', 'ASC')
            ->getQuery()
            ->getResult();
    }

    /**
     * The latest staff correction's note of each request (labs.manage only).
     *
     * @param list<string> $labRequestIds
     * @return array<string,string> request id => note
     */
    public function latestCorrectionNotes(array $labRequestIds): array
    {
        if ($labRequestIds === []) {
            return [];
        }
        $rows = $this->em->getConnection()->fetchAllAssociative(
            "SELECT DISTINCT ON (lab_request_id) lab_request_id, staff_note
               FROM lab_request_events
              WHERE event = 'status_corrected' AND lab_request_id IN (:ids)
              ORDER BY lab_request_id, created_at DESC, id DESC",
            ['ids' => array_map('strtolower', $labRequestIds)],
            ['ids' => ArrayParameterType::STRING],
        );
        $out = [];
        foreach ($rows as $row) {
            if ($row['staff_note'] !== null && trim((string) $row['staff_note']) !== '') {
                $out[strtolower((string) $row['lab_request_id'])] = (string) $row['staff_note'];
            }
        }

        return $out;
    }

    public function findResult(string $resultId): ?LabRequestResult
    {
        $id = strtolower(trim($resultId));
        if (preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/', $id) !== 1) {
            return null;
        }
        $r = $this->em->find(LabRequestResult::class, $id);

        return $r instanceof LabRequestResult ? $r : null;
    }

    // ----- Sweeper candidates (each returns ids; the row is re-checked under its lock) -----

    /** T10: unanswered past the priority's reminder time, not reminded yet. @return list<string> */
    public function dueReminderIds(DateTimeImmutable $now, int $limit = 200): array
    {
        [$sql, $params] = self::byPriority('sent_at', LabRequestRules::REMINDER_HOURS, 'hours', $now);

        return $this->ids(
            "SELECT id FROM lab_requests WHERE status = 'awaiting_consent' AND reminded_at IS NULL AND expires_at > :now AND " . $sql
            . ' ORDER BY sent_at ASC, id ASC LIMIT ' . $limit,
            $params + ['now' => DocumentSharingRules::sql($now)],
        );
    }

    /** T11: STAT / urgent not accepted past the doctor's nudge time. @return list<string> */
    public function dueDoctorNudgeIds(DateTimeImmutable $now, int $limit = 200): array
    {
        [$sql, $params] = self::byPriority('sent_at', LabRequestRules::DOCTOR_NUDGE_HOURS, 'hours', $now);

        return $this->ids(
            "SELECT id FROM lab_requests WHERE status = 'awaiting_consent' AND doctor_nudged_at IS NULL AND expires_at > :now AND " . $sql
            . ' ORDER BY sent_at ASC, id ASC LIMIT ' . $limit,
            $params + ['now' => DocumentSharingRules::sql($now)],
        );
    }

    /** T13: in the lab past the priority's nudge time with no result. @return list<string> */
    public function dueResultNudgeIds(DateTimeImmutable $now, int $limit = 200): array
    {
        [$sql, $params] = self::byPriority('sample_at', LabRequestRules::RESULT_NUDGE_DAYS, 'days', $now);

        return $this->ids(
            "SELECT id FROM lab_requests WHERE status = 'in_lab' AND result_reminded_at IS NULL AND sample_at IS NOT NULL AND " . $sql
            . ' ORDER BY sample_at ASC, id ASC LIMIT ' . $limit,
            $params,
        );
    }

    /** T9: awaiting / booked past their expiry, not stored yet. @return list<string> */
    public function dueExpiryIds(DateTimeImmutable $now, int $limit = 200): array
    {
        return $this->ids(
            "SELECT id FROM lab_requests WHERE status IN ('awaiting_consent', 'booked') AND expires_at <= :now ORDER BY expires_at ASC, id ASC LIMIT " . $limit,
            ['now' => DocumentSharingRules::sql($now)],
        );
    }

    /**
     * T12 reminder: review-due results (stored fields only: unreviewed,
     * viewable, not private, on a result-ready / cancelled request) past the
     * priority's reminder time and not reminded. Keyset-paged after
     * (`$afterAt`, `$afterId`) — a result that isn't reviewable now stays a
     * candidate, so a run walks past it.
     *
     * @return list<array{id:string, uploaded_at:string}>
     */
    public function dueReviewReminders(DateTimeImmutable $now, ?string $afterAt, ?string $afterId, int $limit = 200): array
    {
        [$sql, $params] = self::byPriority('r.uploaded_at', LabRequestRules::REVIEW_REMIND_HOURS, 'hours', $now, 'q.priority');

        return $this->resultPage('r.review_reminded_at IS NULL AND ' . $sql, $params, $afterAt, $afterId, $limit);
    }

    /** T12 escalation: review-due results older than REVIEW_ESCALATE_DAYS, not escalated. @return list<array{id:string, uploaded_at:string}> */
    public function dueReviewEscalations(DateTimeImmutable $now, ?string $afterAt, ?string $afterId, int $limit = 200): array
    {
        return $this->resultPage(
            'r.review_escalated_at IS NULL AND r.uploaded_at <= :cutoff',
            ['cutoff' => DocumentSharingRules::sql($now->modify('-' . LabRequestRules::REVIEW_ESCALATE_DAYS . ' days'))],
            $afterAt,
            $afterId,
            $limit,
        );
    }

    /** Review-due results uploaded before `$before` (back-office `review_overdue`). */
    public function countReviewOverdue(DateTimeImmutable $before): int
    {
        return (int) $this->em->getConnection()->fetchOne(
            'SELECT COUNT(*) FROM lab_request_results r JOIN lab_requests q ON q.id = r.lab_request_id
              WHERE ' . self::REVIEW_DUE . ' AND r.uploaded_at <= :before',
            ['before' => DocumentSharingRules::sql($before)],
        );
    }

    /**
     * Candidates for `needs_review`: unreviewed, review-due results of
     * requests with `unreviewed_total > 0` (the policy decides afterwards).
     *
     * @return list<array{request_id:string, patient_id:string, specialist_id:string, document_id:string}>
     */
    public function reviewDueResults(int $limit = 5000): array
    {
        return array_map(static fn (array $r): array => [
            'request_id'    => strtolower((string) $r['request_id']),
            'patient_id'    => strtolower((string) $r['patient_id']),
            'specialist_id' => strtolower((string) $r['specialist_id']),
            'document_id'   => strtolower((string) $r['document_id']),
        ], $this->em->getConnection()->fetchAllAssociative(
            'SELECT q.id AS request_id, q.patient_id, q.specialist_id, r.document_id
               FROM lab_request_results r JOIN lab_requests q ON q.id = r.lab_request_id
              WHERE q.unreviewed_total > 0 AND ' . self::REVIEW_DUE . '
              ORDER BY q.id LIMIT ' . $limit,
        ));
    }

    /** "Review-due" on stored fields only (spec §1.7), for a result `r` joined to its request `q`. */
    private const REVIEW_DUE = "r.reviewed_at IS NULL AND r.viewable = true AND r.share_outcome <> 'private' AND q.status IN ('result_ready', 'cancelled')";

    /**
     * @param array<string,mixed> $params
     * @return list<array{id:string, uploaded_at:string}>
     */
    private function resultPage(string $condition, array $params, ?string $afterAt, ?string $afterId, int $limit): array
    {
        $after = '';
        if ($afterAt !== null && $afterId !== null) {
            $after             = ' AND (r.uploaded_at, r.id) > (CAST(:after_at AS TIMESTAMP(0)), CAST(:after_id AS CHAR(36)))';
            $params['after_at'] = $afterAt;
            $params['after_id'] = $afterId;
        }
        $rows = $this->em->getConnection()->fetchAllAssociative(
            'SELECT r.id, r.uploaded_at FROM lab_request_results r JOIN lab_requests q ON q.id = r.lab_request_id
              WHERE ' . self::REVIEW_DUE . ' AND ' . $condition . $after . '
              ORDER BY r.uploaded_at ASC, r.id ASC LIMIT ' . $limit,
            $params,
        );

        return array_map(static fn (array $r): array => ['id' => strtolower((string) $r['id']), 'uploaded_at' => (string) $r['uploaded_at']], $rows);
    }

    /**
     * "(priority = 'stat' AND col <= :t_stat) OR …" — one bound cutoff per
     * priority, OR-ed inside parentheses.
     *
     * @param array<string,int> $table priority => hours | days
     * @return array{0:string, 1:array<string,string>}
     */
    private static function byPriority(string $column, array $table, string $unit, DateTimeImmutable $now, string $priorityColumn = 'priority'): array
    {
        $parts  = [];
        $params = [];
        foreach ($table as $priority => $amount) {
            if (!in_array($priority, ['routine', 'urgent', 'stat'], true)) {
                continue;
            }
            $parts[]                 = "($priorityColumn = '$priority' AND $column <= :t_$priority)";
            $params['t_' . $priority] = DocumentSharingRules::sql($now->modify('-' . (int) $amount . ' ' . $unit));
        }

        return ['(' . implode(' OR ', $parts) . ')', $params];
    }

    /**
     * The owner scope and the optional filters, plus `:now`.
     *
     * @param array{q?: ?string, appointment_id?: ?string, patient_id?: ?string} $filters
     * @return array{0:string, 1:array<string,string>}
     */
    private function scope(string $owner, string $ownerId, array $filters, DateTimeImmutable $now): array
    {
        if (!in_array($owner, self::OWNERS, true)) {
            throw new \InvalidArgumentException('Unknown lab request owner');
        }
        $where  = $owner . ' = :o';
        $params = ['o' => strtolower($ownerId), 'now' => DocumentSharingRules::sql($now)];
        if (($filters['appointment_id'] ?? null) !== null) {
            $where .= ' AND appointment_id = :fa';
            $params['fa'] = strtolower((string) $filters['appointment_id']);
        }
        if (($filters['patient_id'] ?? null) !== null) {
            $where .= ' AND patient_id = :fp';
            $params['fp'] = strtolower((string) $filters['patient_id']);
        }
        $q = trim((string) ($filters['q'] ?? ''));
        if ($q !== '') {
            $where .= " AND (LOWER(number) LIKE :q
                OR EXISTS (SELECT 1 FROM patients sp WHERE sp.id = lab_requests.patient_id AND LOWER(sp.first_name || ' ' || sp.last_name) LIKE :q)
                OR EXISTS (SELECT 1 FROM lab_request_items si WHERE si.lab_request_id = lab_requests.id
                           AND (LOWER(si.label) LIKE :q OR LOWER(si.short) LIKE :q OR LOWER(si.name) LIKE :q)))";
            $params['q'] = '%' . addcslashes(mb_strtolower($q), '%_\\') . '%';
        }

        return [$where, $params];
    }

    /**
     * Only the parameters the SQL names (PDO refuses a bound name the statement lacks).
     *
     * @param array<string,mixed> $params
     * @return array<string,mixed>
     */
    private static function used(string $sql, array $params): array
    {
        return array_filter($params, static fn (string $name): bool => preg_match('/:' . preg_quote($name, '/') . '\b/', $sql) === 1, ARRAY_FILTER_USE_KEY);
    }

    /** @param array<string,mixed> $params @return list<string> */
    private function ids(string $sql, array $params): array
    {
        return array_map(static fn ($id): string => strtolower((string) $id), $this->em->getConnection()->fetchFirstColumn($sql, $params));
    }
}
