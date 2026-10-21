<?php

declare(strict_types=1);

namespace App\Infrastructure\Document;

use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Document\ShareDuration;
use App\Domain\Entity\Appointment;
use App\Domain\Entity\MedicalDocument;
use App\Domain\Entity\Patient;
use App\Domain\Entity\Specialist;
use App\Domain\Repository\DocumentAccessGrantRepository;
use App\Domain\Repository\DocumentAccessLogRepository;
use App\Domain\Repository\DocumentAccessRequestRepository;
use App\Domain\Repository\MedicalDocumentRepository;
use DateTimeImmutable;
use Doctrine\ORM\EntityManagerInterface;

/**
 * The read side of document sharing: every response DTO is assembled here
 * from a FIXED number of queries (no N+1 — spec §3.3, §3.4), shaped by
 * {@see DocumentSharingPresenter}. What a doctor can see always comes from
 * {@see DocumentAccessPolicy}; nothing here re-derives visibility.
 */
final class DocumentSharingViews
{
    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly DocumentAccessPolicy $policy,
        private readonly DocumentAccessGrantRepository $grants,
        private readonly DocumentAccessRequestRepository $requests,
        private readonly DocumentAccessLogRepository $log,
        private readonly MedicalDocumentRepository $documents,
    ) {
    }

    // ----- Loaders (one query each) -----

    /**
     * @param list<string> $ids
     * @return array<string, Specialist>
     */
    public function specialists(array $ids): array
    {
        $ids = array_values(array_unique(array_filter(array_map(static fn ($id): string => strtolower((string) $id), $ids))));
        if ($ids === []) {
            return [];
        }
        $out = [];
        foreach ($this->em->createQueryBuilder()->select('s')->from(Specialist::class, 's')
            ->andWhere('s.id IN (:ids)')->setParameter('ids', $ids)->getQuery()->getResult() as $s) {
            $out[strtolower($s->getId())] = $s;
        }

        return $out;
    }

    /**
     * @param list<string|null> $ids
     * @return array<string, Appointment>
     */
    public function appointments(array $ids): array
    {
        $ids = array_values(array_unique(array_filter(array_map(static fn ($id): string => strtolower((string) $id), $ids))));
        if ($ids === []) {
            return [];
        }
        $out = [];
        foreach ($this->em->createQueryBuilder()->select('a')->from(Appointment::class, 'a')
            ->andWhere('a.id IN (:ids)')->setParameter('ids', $ids)->getQuery()->getResult() as $a) {
            $out[strtolower($a->getId())] = $a;
        }

        return $out;
    }

    /** How many documents the patient has. */
    public function documentTotal(string $patientId): int
    {
        return (int) $this->em->getConnection()->fetchOne('SELECT COUNT(*) FROM medical_documents WHERE patient_id = :p', ['p' => strtolower($patientId)]);
    }

    // ----- Grants -----

    /**
     * DocumentGrantDto for each row (any status), in the given order.
     *
     * @param list<array<string,mixed>> $rows
     * @return list<array<string,mixed>>
     */
    public function grantDtos(Patient $patient, array $rows, DateTimeImmutable $now): array
    {
        if ($rows === []) {
            return [];
        }
        $ids          = array_map(static fn (array $r): string => strtolower((string) $r['id']), $rows);
        $doctors      = $this->specialists(array_column($rows, 'specialist_id'));
        $appointments = $this->appointments(array_column($rows, 'appointment_id'));
        $docIds       = $this->grants->documentIdsFor($ids);
        $counts       = $this->grants->documentCounts($ids);
        $effective    = array_map(static fn (array $g): string => strtolower((string) $g['id']), $this->policy->activeGrantRows($patient->getId(), null, $now));
        $hidden       = $this->grants->openHiddenByDoctor($patient->getId());
        $total        = null;

        $out = [];
        foreach ($rows as $row) {
            $id     = strtolower((string) $row['id']);
            $sid    = strtolower((string) $row['specialist_id']);
            $doctor = $doctors[$sid] ?? null;
            if ($doctor === null) {
                continue;
            }
            $appt = $row['appointment_id'] !== null ? ($appointments[strtolower((string) $row['appointment_id'])] ?? null) : null;
            if ($row['scope'] === 'all') {
                $total ??= $this->documentTotal($patient->getId());
                $count   = max(0, $total - count($hidden[$sid] ?? []));
            } else {
                $count = $counts[$id] ?? 0;
            }
            $out[] = DocumentSharingPresenter::grant(
                $row,
                DocumentSharingPresenter::doctorRef($doctor),
                $appt !== null ? DocumentSharingPresenter::appointmentRef($appt, $patient->getId(), $sid, $now) : null,
                $docIds[$id] ?? [],
                $count,
                in_array($id, $effective, true),
                $this->policy->isPractising($doctor),
                $now,
            );
        }

        return $out;
    }

    /** @return array<string,mixed>|null one grant's DTO */
    public function grantDto(Patient $patient, string $grantId, DateTimeImmutable $now): ?array
    {
        $row = $this->grants->rowForPatient($grantId, $patient->getId());

        return $row !== null ? ($this->grantDtos($patient, [$row], $now)[0] ?? null) : null;
    }

    /**
     * DTOs of these grant ids, in this order.
     *
     * @param list<string> $ids
     * @return list<array<string,mixed>>
     */
    public function grantDtosByIds(Patient $patient, array $ids, DateTimeImmutable $now): array
    {
        $rows = [];
        foreach ($this->grants->rowsByIds(array_values(array_unique($ids))) as $row) {
            $rows[strtolower((string) $row['id'])] = $row;
        }
        $ordered = [];
        foreach (array_values(array_unique(array_map('strtolower', $ids))) as $id) {
            if (isset($rows[$id]) && strtolower((string) $rows[$id]['patient_id']) === strtolower($patient->getId())) {
                $ordered[] = $rows[$id];
            }
        }

        return $this->grantDtos($patient, $ordered, $now);
    }

    // ----- Requests -----

    /**
     * DocumentAccessRequestDto for each row.
     *
     * @param list<array<string,mixed>> $rows
     * @return list<array<string,mixed>>
     */
    public function requestDtos(Patient $patient, array $rows, DateTimeImmutable $now): array
    {
        if ($rows === []) {
            return [];
        }
        $doctors      = $this->specialists(array_column($rows, 'specialist_id'));
        $appointments = $this->appointments(array_column($rows, 'appointment_id'));
        $grantIds     = $this->log->grantIdsForRequests(array_map(static fn (array $r): string => (string) $r['id'], $rows));
        // The booking attachments behind each suggestion: one query for every
        // `access` request whose consultation still stands (no N+1).
        $wanted = [];
        foreach ($rows as $row) {
            $appt = $row['appointment_id'] !== null ? ($appointments[strtolower((string) $row['appointment_id'])] ?? null) : null;
            if ($appt !== null && (string) $row['kind'] !== 'extend' && DocumentSharingPresenter::anchorValid($appt)) {
                $wanted[] = strtolower($appt->getId());
            }
        }
        $attached = $this->documents->attachmentIdsByAppointment($patient->getId(), $wanted);

        $out = [];
        foreach ($rows as $row) {
            $sid    = strtolower((string) $row['specialist_id']);
            $doctor = $doctors[$sid] ?? null;
            if ($doctor === null) {
                continue;
            }
            $appt = $row['appointment_id'] !== null ? ($appointments[strtolower((string) $row['appointment_id'])] ?? null) : null;
            $ref  = DocumentSharingPresenter::anchorValid($appt) ? DocumentSharingPresenter::appointmentRef($appt, $patient->getId(), $sid, $now) : null;
            $attachments = $ref !== null && (string) $row['kind'] !== 'extend' ? ($attached[$ref['id']] ?? []) : [];
            $out[] = DocumentSharingPresenter::request(
                $row,
                DocumentSharingPresenter::doctorRef($doctor),
                $ref,
                $grantIds[strtolower((string) $row['id'])] ?? null,
                DocumentSharingPresenter::suggestion((string) $row['kind'], $ref, $attachments),
                $now,
            );
        }

        return $out;
    }

    /** @return array<string,mixed>|null */
    public function requestDto(Patient $patient, array $row, DateTimeImmutable $now): ?array
    {
        return $this->requestDtos($patient, [$row], $now)[0] ?? null;
    }

    /** The pair's pending request as DocumentAccessRequestDto, or null (none, or sharing off). */
    public function pendingRequestDto(Patient $patient, string $specialistId, DateTimeImmutable $now): ?array
    {
        if (!Rules::enabled()) {
            return null;
        }
        $row = $this->requests->pendingForPair($patient->getId(), $specialistId, $now);

        return $row !== null ? $this->requestDto($patient, $row, $now) : null;
    }

    // ----- Sharing doctors -----

    /**
     * SharingDoctorDto for every doctor the patient has booked, most recent
     * consultation first — from a fixed set of grouped queries.
     *
     * @return list<array<string,mixed>>
     */
    public function sharingDoctors(Patient $patient, DateTimeImmutable $now, ?string $onlySpecialistId = null): array
    {
        $conn   = $this->em->getConnection();
        $p      = strtolower($patient->getId());
        $params = ['p' => $p, 'now' => Rules::sql($now)];
        $one    = '';
        if ($onlySpecialistId !== null) {
            $one         = ' AND a.specialist_id = :s';
            $params['s'] = strtolower($onlySpecialistId);
        }
        // 1. Booked doctors, the latest consultation, and the next open one.
        $booked = $conn->fetchAllAssociative(
            "SELECT a.specialist_id, MAX(a.scheduled_at) AS last_at
               FROM appointments a
              WHERE a.patient_id = :p AND a.deleted_at IS NULL AND a.status <> 'proposed'{$one}
              GROUP BY a.specialist_id
              ORDER BY MAX(a.scheduled_at) DESC",
            $params,
        );
        if ($booked === []) {
            return [];
        }
        $next = [];
        foreach ($conn->fetchAllAssociative(
            "SELECT DISTINCT ON (a.specialist_id) a.specialist_id, a.id
               FROM appointments a
              WHERE a.patient_id = :p AND a.deleted_at IS NULL
                AND a.status IN ('pending', 'confirmed', 'rescheduled') AND a.scheduled_at > :now{$one}
              ORDER BY a.specialist_id, a.scheduled_at ASC",
            $params,
        ) as $row) {
            $next[strtolower((string) $row['specialist_id'])] = strtolower((string) $row['id']);
        }
        $doctors      = $this->specialists(array_column($booked, 'specialist_id'));
        $appointments = $this->appointments(array_values($next));
        // 2. Visible sets (one policy call), 3. active grants, 4. pending requests, 5. hidden, 6. blocks.
        $visible  = Rules::enabled() ? $this->policy->visibleByDoctor($patient, $now) : [];
        $active   = [];
        if (Rules::enabled()) {
            foreach ($this->policy->activeGrantRows($patient->getId(), $onlySpecialistId, $now) as $g) {
                $active[strtolower((string) $g['specialist_id'])][] = $g;
            }
        }
        $pending = [];
        if (Rules::enabled()) {
            $pendingRows = $this->requests->listForPatient($patient->getId(), 'pending', $now);
            foreach ($this->requestDtos($patient, $pendingRows, $now) as $dto) {
                $pending[$dto['specialist']['id']] ??= $dto;
            }
        }
        $hidden  = $this->grants->openHiddenByDoctor($patient->getId(), $onlySpecialistId);
        $blocked = $this->grants->blockedSpecialistIds($patient->getId());

        $out = [];
        foreach ($booked as $row) {
            $sid    = strtolower((string) $row['specialist_id']);
            $doctor = $doctors[$sid] ?? null;
            if ($doctor === null) {
                continue;
            }
            $practising = $this->policy->isPractising($doctor);
            $nextAppt   = isset($next[$sid]) ? ($appointments[$next[$sid]] ?? null) : null;
            $out[] = [
                'specialist'          => DocumentSharingPresenter::doctorRef($doctor),
                'can_share'           => $practising && Rules::enabled(),
                'unavailable_reason'  => $practising ? null : 'doctor_unavailable',
                'last_appointment_at' => Rules::iso(Rules::fromSql($row['last_at'])),
                'next_appointment'    => $nextAppt !== null ? DocumentSharingPresenter::appointmentRef($nextAppt, $p, $sid, $now) : null,
                'access'              => DocumentSharingPresenter::accessSummary($active[$sid] ?? [], count($visible[$sid] ?? []), $practising, $hidden[$sid] ?? []),
                'pending_request'     => $pending[$sid] ?? null,
                'requests_blocked'    => in_array($sid, $blocked, true),
            ];
        }

        return $out;
    }

    /** One booked doctor's SharingDoctorDto, or null when the patient never booked them. */
    public function sharingDoctor(Patient $patient, string $specialistId, DateTimeImmutable $now): ?array
    {
        return $this->sharingDoctors($patient, $now, $specialistId)[0] ?? null;
    }

    /** Doctors the patient has booked and can share with now. @return list<array<string,mixed>> SharingDoctorRefDto */
    public function eligibleDoctors(Patient $patient): array
    {
        if (!Rules::enabled()) {
            return [];
        }
        $ids = $this->em->getConnection()->fetchFirstColumn(
            "SELECT DISTINCT specialist_id FROM appointments WHERE patient_id = :p AND deleted_at IS NULL AND status <> 'proposed'",
            ['p' => strtolower($patient->getId())],
        );
        $out = [];
        foreach ($this->specialists(array_map('strval', $ids)) as $doctor) {
            if ($this->policy->isPractising($doctor)) {
                $out[] = DocumentSharingPresenter::doctorRef($doctor);
            }
        }
        usort($out, static fn (array $a, array $b): int => strcmp($a['name'], $b['name']));

        return $out;
    }

    // ----- Documents -----

    /**
     * `shared_with` for each document of a list page, from ONE policy call.
     *
     * @param list<string> $documentIds
     * @return array<string, list<array<string,mixed>>> document id => DocumentSharedWithDto[]
     */
    public function sharedWith(Patient $patient, array $documentIds, DateTimeImmutable $now): array
    {
        $out = [];
        foreach ($documentIds as $id) {
            $out[strtolower($id)] = [];
        }
        $byDoctor = $this->policy->visibleByDoctor($patient, $now, array_values(array_map('strtolower', $documentIds)));
        $doctors  = $this->specialists(array_keys($byDoctor));
        foreach ($byDoctor as $sid => $visible) {
            $doctor = $doctors[$sid] ?? null;
            if ($doctor === null) {
                continue;
            }
            foreach ($visible as $v) {
                $out[$v->documentId][] = DocumentSharingPresenter::sharedWith($v, $sid, $doctor->getName(), !$this->policy->isPractising($doctor));
            }
        }

        return $out;
    }

    /** DocumentAccessDetailDto — GET /portal/documents/{id}/access. */
    public function documentAccess(Patient $patient, MedicalDocument $doc, DateTimeImmutable $now): array
    {
        $docId    = strtolower($doc->getId());
        $byDoctor = $this->policy->visibleByDoctor($patient, $now, [$docId]);
        $hiddenFrom = $this->grants->hiddenFrom($patient->getId(), $docId);
        $folders  = [];
        foreach ($this->policy->activeGrantRows($patient->getId(), null, $now) as $g) {
            if ($g['scope'] === 'all') {
                $folders[strtolower((string) $g['specialist_id'])] = $g;
            }
        }
        $doctors  = $this->specialists([...array_keys($byDoctor), ...$hiddenFrom]);
        $viewed   = $this->log->lastViewedByDoctor($patient->getId(), $docId);

        $with = [];
        foreach ($byDoctor as $sid => $visible) {
            $doctor = $doctors[$sid] ?? null;
            $v      = $visible[0] ?? null;
            if ($doctor === null || $v === null) {
                continue;
            }
            $with[] = DocumentSharingPresenter::sharedWith($v, $sid, $doctor->getName(), !$this->policy->isPractising($doctor)) + [
                'specialist'     => DocumentSharingPresenter::doctorRef($doctor),
                'grant_ids'      => $v->grantIds !== [] ? $v->grantIds : [$v->grantId],
                'last_viewed_at' => Rules::iso($viewed[$sid] ?? null),
            ];
        }
        $hidden = [];
        foreach ($hiddenFrom as $sid) {
            $doctor = $doctors[$sid] ?? null;
            $folder = $folders[$sid] ?? null;
            if ($doctor === null || $folder === null) {
                continue;
            }
            $hidden[] = [
                'specialist'            => DocumentSharingPresenter::doctorRef($doctor),
                'folder_until_label_at' => Rules::iso(Rules::untilLabelAt(Rules::fromSql($folder['expires_at']), (string) $folder['duration'])),
            ];
        }
        $history = $this->historyDtos($patient, 0, 20, null, $docId)['items'];

        return [
            'document_id'      => $docId,
            'doctors'          => $with,
            'hidden_from'      => $hidden,
            'eligible_doctors' => $this->eligibleDoctors($patient),
            'history'          => $history,
        ];
    }

    /**
     * The ledger as DocumentAccessEventDto (titles only from the patient's own documents).
     *
     * @return array{items: list<array<string,mixed>>, total: int}
     */
    public function historyDtos(Patient $patient, int $offset, int $limit, ?string $specialistId, ?string $documentId): array
    {
        $page    = $this->log->history($patient->getId(), $offset, $limit, $specialistId, $documentId);
        $doctors = $this->specialists(array_values(array_filter(array_column($page['items'], 'specialist_id'))));
        $items   = [];
        foreach ($page['items'] as $row) {
            $sid    = $row['specialist_id'] !== null ? strtolower((string) $row['specialist_id']) : null;
            $doctor = $sid !== null ? ($doctors[$sid] ?? null) : null;
            $items[] = DocumentSharingPresenter::event($row, $doctor !== null ? DocumentSharingPresenter::doctorRef($doctor) : null);
        }

        return ['items' => $items, 'total' => $page['total']];
    }

    /** AppointmentDocumentAccessDto — GET /portal/appointments/{id}/document-access. */
    public function appointmentAccess(Patient $patient, Appointment $appointment, DateTimeImmutable $now): array
    {
        $doctor     = $appointment->getSpecialist();
        $sid        = strtolower($doctor->getId());
        $practising = $this->policy->isPractising($doctor);
        $visible    = Rules::enabled() ? ($this->policy->visibleByDoctor($patient, $now)[$sid] ?? []) : [];
        $grants     = Rules::enabled() ? $this->policy->activeGrantRows($patient->getId(), $sid, $now) : [];
        $hidden     = $this->grants->openHiddenByDoctor($patient->getId(), $sid)[$sid] ?? [];
        $visibleIds = array_map(static fn (VisibleDocument $v): string => $v->documentId, $visible);
        $unshared   = [];
        foreach ($this->documents->attachmentsOf($appointment->getId(), $patient->getId()) as $doc) {
            if (!in_array(strtolower($doc->getId()), $visibleIds, true)) {
                $unshared[] = $doc->toArray();
            }
        }

        return [
            'specialist'           => DocumentSharingPresenter::doctorRef($doctor),
            'appointment'          => DocumentSharingPresenter::appointmentRef($appointment, $patient->getId(), $sid, $now),
            'can_share'            => $practising && Rules::enabled(),
            'unavailable_reason'   => $practising ? null : 'doctor_unavailable',
            'access'               => DocumentSharingPresenter::accessSummary($grants, count($visible), $practising, $hidden),
            'visible_documents'    => array_map([DocumentSharingPresenter::class, 'patientVisibleDocument'], $visible),
            'unshared_attachments' => $unshared,
            'pending_request'      => $this->pendingRequestDto($patient, $sid, $now),
        ];
    }

    // ----- Doctor side -----

    /**
     * DoctorDocumentAccessDto — GET /doctor/appointments/{id}/document-access.
     * `$requestBlock`: the request part (computed by the service from the
     * request rules).
     *
     * @param array<string,mixed> $requestBlock
     */
    public function doctorAccess(Specialist $doctor, Appointment $appointment, array $requestBlock, DateTimeImmutable $now): array
    {
        $patient = $appointment->getPatient();
        // The visibility query runs once per poll: the summary counts the same list.
        $visible = $this->policy->visibleDocuments($doctor, $patient, $now);
        $access  = $this->policy->doctorSummary($doctor, $patient, $now, $visible);
        if ($access['state'] !== 'active') {
            $visible = [];
        }
        $own     = $visible !== [] ? $this->ownAppointmentIds($patient->getId(), $doctor->getId()) : [];

        return [
            'access'      => $access,
            'documents'   => array_map(
                static fn (VisibleDocument $v): array => DocumentSharingPresenter::doctorSharedDocument($v, $doctor->getId(), $own),
                $visible,
            ),
            'request'     => $requestBlock,
            'server_time' => Rules::iso($now),
        ];
    }

    /** The doctor's appointment ids with this patient (for `toDoctorArray`'s `appointment_id`). @return list<string> */
    public function ownAppointmentIds(string $patientId, string $specialistId): array
    {
        return array_map('strval', $this->em->getConnection()->fetchFirstColumn(
            'SELECT id FROM appointments WHERE patient_id = :p AND specialist_id = :s',
            ['p' => strtolower($patientId), 's' => strtolower($specialistId)],
        ));
    }

    /** Whether `$duration` is an anchored (`after_*`) code. */
    public static function anchored(string $duration): bool
    {
        return ShareDuration::tryFrom($duration)?->isAnchored() ?? false;
    }
}
