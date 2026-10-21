<?php

declare(strict_types=1);

namespace App\Infrastructure\Document;

use App\Domain\Document\DocumentAccessCalculator;
use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Document\ShareDuration;
use App\Domain\Entity\MedicalDocument;
use App\Domain\Entity\Patient;
use App\Domain\Entity\Specialist;
use DateTimeImmutable;
use Doctrine\DBAL\ArrayParameterType;
use Doctrine\ORM\EntityManagerInterface;

/**
 * The ONLY code that decides what a doctor may see of a patient's documents
 * (spec §2.1–§2.2). Callers: the doctor's list, document-access and file view,
 * and — for the patient's view of the same truth — the patient's document
 * list, document access, appointment document access and sharing doctors.
 *
 * The rule, evaluated at request time (the sweeper only does bookkeeping):
 *  1. practising: the doctor is approved and not deleted;
 *  2. the patient is not deleted;
 *  3. booked: the pair has an appointment that is not deleted and not a proposal;
 *  4. owned: the document is the patient's (and the one asked for);
 *  5. a covering grant: active and in window (`starts_at` inclusive,
 *     `expires_at` exclusive), its anchored consultation (`after_*`) neither
 *     cancelled, deleted nor gone, and either a `selected` grant listing the
 *     document or an `all` grant whose pair has not hidden it.
 *
 * There is exactly one SQL builder ({@see visibilitySql()}); the doctor's
 * list, one document, and the patient-side per-doctor sets all use it.
 * Everything fails private: with the kill switch off ({@see Rules::enabled()})
 * the policy returns nothing.
 */
final class DocumentAccessPolicy
{
    public function __construct(private readonly EntityManagerInterface $em)
    {
    }

    /** Gate 1: approved and not deleted. */
    public function isPractising(Specialist $doctor): bool
    {
        return !$doctor->isDeleted() && $doctor->isApproved();
    }

    /** Gate 3: the pair has an appointment with deleted_at IS NULL AND status <> 'proposed'. */
    public function isBooked(string $patientId, string $specialistId): bool
    {
        return $this->em->getConnection()->fetchOne(
            "SELECT 1 FROM appointments x
              WHERE x.patient_id = :p AND x.specialist_id = :s AND x.deleted_at IS NULL AND x.status <> 'proposed' LIMIT 1",
            ['p' => strtolower($patientId), 's' => strtolower($specialistId)],
        ) !== false;
    }

    /** @return list<VisibleDocument> newest first. Empty when the kill switch is off. */
    public function visibleDocuments(Specialist $doctor, Patient $patient, DateTimeImmutable $now, bool $ignorePractising = false): array
    {
        if (!Rules::enabled() || $patient->isDeleted() || (!$ignorePractising && !$this->isPractising($doctor))) {
            return [];
        }
        $rows = $this->em->getConnection()->fetchAllAssociative(
            $this->visibilitySql(true, false, false),
            ['p' => strtolower($patient->getId()), 's' => strtolower($doctor->getId()), 'now' => Rules::sql($now), 'anchored' => ShareDuration::anchoredCodes()],
            ['anchored' => ArrayParameterType::STRING],
        );

        return $this->build($patient, DocumentAccessCalculator::reduce($rows)[strtolower($doctor->getId())] ?? []);
    }

    /** One document, bound to the route's patient: SQL adds d.patient_id = :p AND d.id = :doc. */
    public function visibleDocument(Specialist $doctor, Patient $patient, string $documentId, DateTimeImmutable $now): ?VisibleDocument
    {
        $documentId = Rules::lowerUuid($documentId);
        if ($documentId === null || !Rules::enabled() || $patient->isDeleted() || !$this->isPractising($doctor)) {
            return null;
        }
        $rows = $this->em->getConnection()->fetchAllAssociative(
            $this->visibilitySql(true, true, false),
            ['p' => strtolower($patient->getId()), 's' => strtolower($doctor->getId()), 'doc' => $documentId, 'now' => Rules::sql($now), 'anchored' => ShareDuration::anchoredCodes()],
            ['anchored' => ArrayParameterType::STRING],
        );
        $built = $this->build($patient, DocumentAccessCalculator::reduce($rows)[strtolower($doctor->getId())] ?? []);

        return $built[0] ?? null;
    }

    /**
     * Patient side, batched: every doctor's visible set in one query (gate 1
     * ignored; the caller derives `paused` from {@see isPractising()}). Same SQL
     * builder as {@see visibleDocuments()}.
     *
     * @param list<string>|null $documentIds restrict to these (a list page)
     * @return array<string, list<VisibleDocument>> keyed by specialist id
     */
    public function visibleByDoctor(Patient $patient, DateTimeImmutable $now, ?array $documentIds = null): array
    {
        if (!Rules::enabled() || $patient->isDeleted() || $documentIds === []) {
            return [];
        }
        $params = ['p' => strtolower($patient->getId()), 'now' => Rules::sql($now), 'anchored' => ShareDuration::anchoredCodes()];
        $types  = ['anchored' => ArrayParameterType::STRING];
        if ($documentIds !== null) {
            $params['docIds'] = array_values(array_map('strtolower', $documentIds));
            $types['docIds']  = ArrayParameterType::STRING;
        }
        $rows = $this->em->getConnection()->fetchAllAssociative($this->visibilitySql(false, false, $documentIds !== null), $params, $types);

        $out = [];
        foreach (DocumentAccessCalculator::reduce($rows) as $specialistId => $byDocument) {
            $out[$specialistId] = $this->build($patient, $byDocument);
        }

        return $out;
    }

    /**
     * The doctor's view of their access (DoctorDocumentAccessDto.access, spec §8.2).
     * `$visible`: {@see visibleDocuments()} for the same doctor, patient and
     * instant when the caller already has it (so a poll runs the visibility
     * query once); computed here otherwise.
     *
     * `until*` / `indefinite` describe everything visible (latest end, NULL
     * wins); `folder_until_label_at` / `folder_indefinite` describe the
     * whole-folder share alone (the first `scope = all` grant, exactly as
     * {@see DocumentSharingPresenter::accessSummary()} does for the patient).
     *
     * @param list<VisibleDocument>|null $visible
     * @return array{state:string, scope:?string, document_count:int, until:?string, until_label_at:?string, indefinite:bool,
     *               folder_until_label_at:?string, folder_indefinite:bool,
     *               next_change_at:?string, ends_soon:bool, had_access_before:bool}
     */
    public function doctorSummary(Specialist $doctor, Patient $patient, DateTimeImmutable $now, ?array $visible = null): array
    {
        $grants  = Rules::enabled() && !$patient->isDeleted() && $this->isPractising($doctor)
            ? $this->activeGrantRows($patient->getId(), $doctor->getId(), $now)
            : [];
        $visible = $grants !== [] ? count($visible ?? $this->visibleDocuments($doctor, $patient, $now)) : 0;
        $ends    = self::ends($grants);
        $soon    = false;
        $folder  = null;
        foreach ($grants as $g) {
            if ($g['scope'] === 'all' && $folder === null) {
                $folder = $g;
            }
            $exp = Rules::fromSql($g['expires_at']);
            if ($g['scope'] === 'all' && $exp !== null && $exp <= $now->modify('+' . Rules::EXTEND_WINDOW_HOURS . ' hours')) {
                $soon = true;
            }
        }
        $folderEnd = $folder !== null ? Rules::fromSql($folder['expires_at']) : null;

        return [
            'state'                 => $grants !== [] ? 'active' : 'none',
            'scope'                 => $grants === [] ? null : ($folder !== null ? 'all' : 'selected'),
            'document_count'        => $visible,
            'until'                 => Rules::iso($ends['until']),
            'until_label_at'        => Rules::iso($ends['until_label_at']),
            'indefinite'            => $ends['indefinite'],
            'folder_until_label_at' => $folder !== null ? Rules::iso(Rules::untilLabelAt($folderEnd, (string) $folder['duration'])) : null,
            'folder_indefinite'     => $folder !== null && $folderEnd === null,
            'next_change_at'        => Rules::iso($ends['next_change_at']),
            'ends_soon'             => $soon,
            'had_access_before'     => $grants === [] && $this->pairEverShared($patient->getId(), $doctor->getId()),
        ];
    }

    /**
     * The pair's (or the patient's) grants that give access now: stored
     * active, in window, a valid anchor for `after_*`, and the pair booked —
     * the same predicate as {@see visibilitySql()} without the document part.
     * Gate 1 is the caller's (a paused doctor's grants are listed).
     *
     * @return list<array<string,mixed>> grant columns, newest first
     */
    public function activeGrantRows(string $patientId, ?string $specialistId, DateTimeImmutable $now): array
    {
        $params = ['p' => strtolower($patientId), 'now' => Rules::sql($now), 'anchored' => ShareDuration::anchoredCodes()];
        $one    = '';
        if ($specialistId !== null) {
            $one         = ' AND g.specialist_id = :s';
            $params['s'] = strtolower($specialistId);
        }

        return $this->em->getConnection()->fetchAllAssociative(
            'SELECT ' . \App\Domain\Repository\DocumentAccessGrantRepository::COLUMNS . '
               FROM document_access_grants g
          LEFT JOIN appointments a ON a.id = g.appointment_id
              WHERE g.patient_id = :p' . $one . ' AND ' . self::activePredicate() . '
              ORDER BY g.created_at DESC, g.id DESC',
            $params,
            ['anchored' => ArrayParameterType::STRING],
        );
    }

    /**
     * The end of a set of active grants: the latest end (NULL wins) and its
     * label, and the earliest end (when to look again).
     *
     * @param list<array<string,mixed>> $grants
     * @return array{until:?DateTimeImmutable, until_label_at:?DateTimeImmutable, indefinite:bool, next_change_at:?DateTimeImmutable}
     */
    public static function ends(array $grants): array
    {
        $until      = null;
        $label      = null;
        $indefinite = false;
        $next       = null;
        foreach ($grants as $g) {
            $exp = Rules::fromSql($g['expires_at']);
            if ($exp === null) {
                $indefinite = true;
                continue;
            }
            if ($next === null || $exp < $next) {
                $next = $exp;
            }
            if ($until === null || $exp > $until) {
                $until = $exp;
                $label = Rules::untilLabelAt($exp, (string) $g['duration']);
            }
        }
        if ($indefinite) {
            $until = null;
            $label = null;
        }

        return ['until' => $until, 'until_label_at' => $label, 'indefinite' => $indefinite, 'next_change_at' => $next];
    }

    private function pairEverShared(string $patientId, string $specialistId): bool
    {
        return $this->em->getConnection()->fetchOne(
            'SELECT 1 FROM document_access_grants WHERE patient_id = :p AND specialist_id = :s LIMIT 1',
            ['p' => strtolower($patientId), 's' => strtolower($specialistId)],
        ) !== false;
    }

    /**
     * Gate 3 + gate 5's window and anchor, for a grant `g` LEFT JOINed to its
     * appointment `a` (params :now, :anchored).
     */
    private static function activePredicate(): string
    {
        return "g.status = 'active'
            AND g.starts_at <= :now
            AND (g.expires_at IS NULL OR g.expires_at > :now)
            AND (g.duration NOT IN (:anchored)
                 OR (a.id IS NOT NULL AND a.deleted_at IS NULL AND a.status <> 'cancelled'))
            AND EXISTS (SELECT 1 FROM appointments x
                         WHERE x.patient_id = g.patient_id AND x.specialist_id = g.specialist_id
                           AND x.deleted_at IS NULL AND x.status <> 'proposed')";
    }

    /**
     * THE visibility query (spec §2.2): one row per covering grant × visible
     * document. Bound: :p, :now, :anchored, plus :s (one doctor), :doc (one
     * document) or :docIds (a list page).
     */
    private function visibilitySql(bool $oneDoctor, bool $oneDocument, bool $docList): string
    {
        return 'SELECT g.specialist_id, d.id AS document_id, g.id AS grant_id, g.scope, g.duration, g.expires_at, g.created_at
                  FROM document_access_grants g
                  JOIN medical_documents d ON d.patient_id = g.patient_id
             LEFT JOIN appointments a ON a.id = g.appointment_id
                 WHERE g.patient_id = :p'
            . ($oneDoctor ? ' AND g.specialist_id = :s' : '')
            . ($oneDocument ? ' AND d.id = :doc' : '')
            . ($docList ? ' AND d.id IN (:docIds)' : '')
            . ' AND ' . self::activePredicate() . "
                   AND (
                        (g.scope = 'selected' AND EXISTS (
                            SELECT 1 FROM document_access_grant_documents gd
                             WHERE gd.grant_id = g.id AND gd.document_id = d.id))
                     OR (g.scope = 'all' AND NOT EXISTS (
                            SELECT 1 FROM document_access_hidden h
                             WHERE h.patient_id = :p AND h.specialist_id = g.specialist_id
                               AND h.document_id = d.id AND h.cleared_at IS NULL))
                   )";
    }

    /**
     * VisibleDocuments for one doctor's reduced set, newest document first.
     *
     * @param array<string, array<string,mixed>> $byDocument
     * @return list<VisibleDocument>
     */
    private function build(Patient $patient, array $byDocument): array
    {
        if ($byDocument === []) {
            return [];
        }
        /** @var list<MedicalDocument> $docs */
        $docs = $this->em->createQueryBuilder()
            ->select('d')
            ->from(MedicalDocument::class, 'd')
            ->andWhere('d.patientId = :p')
            ->andWhere('d.id IN (:ids)')
            ->setParameter('p', strtolower($patient->getId()))
            ->setParameter('ids', array_keys($byDocument))
            ->orderBy('d.createdAt', 'DESC')
            ->addOrderBy('d.id', 'DESC')
            ->getQuery()
            ->getResult();

        $out = [];
        foreach ($docs as $doc) {
            $r = $byDocument[strtolower($doc->getId())] ?? null;
            if ($r === null) {
                continue;
            }
            $out[] = new VisibleDocument(
                strtolower($doc->getId()),
                $doc,
                $r['until'],
                $r['until_label_at'],
                $r['indefinite'],
                $r['via'],
                $r['grant_id'],
                $r['shared_at'],
                $r['grant_ids'],
            );
        }

        return $out;
    }
}
