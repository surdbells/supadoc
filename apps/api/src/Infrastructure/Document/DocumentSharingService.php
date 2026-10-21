<?php

declare(strict_types=1);

namespace App\Infrastructure\Document;

use App\Domain\Appointment\AppointmentLifecycle;
use App\Domain\Document\AccessRequestRules;
use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Document\DomainRefusal;
use App\Domain\Document\ReschedulePolicy;
use App\Domain\Document\ShareDuration;
use App\Domain\Entity\Appointment;
use App\Domain\Entity\MedicalDocument;
use App\Domain\Entity\Patient;
use App\Domain\Entity\Specialist;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Repository\DocumentAccessGrantRepository;
use App\Domain\Repository\DocumentAccessLogRepository;
use App\Domain\Repository\DocumentAccessRequestRepository;
use App\Domain\Repository\MedicalDocumentRepository;
use App\Domain\Repository\SpecialistStatusEventRepository;
use App\Infrastructure\Service\AuditLogger;
use DateTimeImmutable;
use Doctrine\DBAL\Exception\UniqueConstraintViolationException;
use Doctrine\ORM\EntityManagerInterface;
use Ramsey\Uuid\Uuid;

/**
 * Every write of patient-controlled document sharing (spec §1–§4): shares,
 * changes, revokes and Undo, per-document removal / "show again", doctors'
 * requests and the patient's answers, the upload / booking hooks, reschedules,
 * reinstatement and account closure.
 *
 * Atomicity (spec §2.5): each call is ONE transaction that takes the pair
 * locks (patient, specialist) in sorted, lower-cased order — after any slot
 * lock the caller holds — runs the pairs' lazy expiry, re-validates inside the
 * locks and then writes; a {@see DomainRefusal} thrown inside rolls back
 * everything the call did. Notices are queued and sent only after the commit
 * ({@see DocumentAccessNoticeQueue}). State changes of existing rows are
 * compare-and-set ({@see DocumentAccessTransitions}), each recorded once in
 * the audit trail and the patient's ledger.
 *
 * What a doctor can SEE is never decided here — only {@see DocumentAccessPolicy}.
 */
final class DocumentSharingService
{
    /** First key of the pair advisory lock (0x0DA5); the second is hashtext("patient:specialist"). */
    private const LOCK_NAMESPACE = 3493;

    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly DocumentAccessPolicy $policy,
        private readonly DocumentAccessTransitions $transitions,
        private readonly DocumentAccessNoticeQueue $queue,
        private readonly DocumentAccessNotifier $notifier,
        private readonly DocumentAccessGrantRepository $grants,
        private readonly DocumentAccessRequestRepository $requests,
        private readonly DocumentAccessLogRepository $log,
        private readonly MedicalDocumentRepository $documents,
        private readonly AuditLogger $audit,
        private readonly SpecialistStatusEventRepository $statusEvents,
        private readonly DocumentSharingViews $views,
    ) {
    }

    // =====================================================================
    // Transaction + pair locks
    // =====================================================================

    /**
     * Run `$work` in one transaction (joining the caller's, as a savepoint,
     * when one is open) holding the pair locks of `$specialistIds` — sorted
     * and lower-cased — after the pairs' lazy expiry. When this call owns the
     * outermost transaction it dispatches the queued notices after the commit
     * (and discards them on a rollback). `$work` may RETURN a DomainRefusal to
     * keep what it did (e.g. a lazily expired request) and still refuse: it is
     * thrown after the commit.
     */
    public function inPairs(Patient $p, array $specialistIds, callable $work, ?DateTimeImmutable $now = null): mixed
    {
        $now ??= Rules::now();
        $conn  = $this->em->getConnection();
        $owns  = !$conn->isTransactionActive();
        $level = $conn->getTransactionNestingLevel();
        $ids   = array_values(array_unique(array_filter(array_map(static fn ($id): string => strtolower(trim((string) $id)), $specialistIds))));
        sort($ids);
        $patientId = strtolower($p->getId());

        $conn->beginTransaction();
        try {
            foreach ($ids as $sid) {
                $conn->executeQuery('SELECT pg_advisory_xact_lock(' . self::LOCK_NAMESPACE . ', hashtext(:key))', ['key' => $patientId . ':' . $sid]);
            }
            foreach ($ids as $sid) {
                $this->lazyExpire($patientId, $sid, $now);
            }
            $result = $work();
            $conn->commit();
        } catch (\Throwable $e) {
            if ($conn->getTransactionNestingLevel() > $level) {
                $conn->rollBack();
            }
            if ($owns) {
                $this->queue->discard();
            }
            throw $e;
        }
        if ($owns) {
            $this->queue->dispatch();
        }
        if ($result instanceof DomainRefusal) {
            throw $result;
        }

        return $result;
    }

    /** Send the notices queued by work inside a transaction the CALLER committed (booking, reschedule). */
    public function dispatchNotices(): void
    {
        $this->queue->dispatch();
    }

    /** Drop them when the caller's transaction rolled back or the booking didn't happen. */
    public function discardNotices(): void
    {
        $this->queue->discard();
    }

    /**
     * Record what has run out for one pair before anything is decided (so the
     * partial unique indexes never collide with stale rows, and each expiry is
     * still audited and logged exactly once).
     */
    private function lazyExpire(string $patientId, string $specialistId, DateTimeImmutable $now): void
    {
        foreach ($this->grants->dueIds($now, 200, $patientId, $specialistId) as $id) {
            $this->transitions->expireGrant($id, $now);
        }
        foreach ($this->grants->danglingAnchoredIds(200, $patientId, $specialistId) as $id) {
            $this->transitions->endGrant($id, 'appointment_cancelled', 'system', $now);
        }
        foreach ($this->requests->dueIds($now, 50, $patientId, $specialistId) as $id) {
            $this->transitions->expireRequest($id, $now);
        }
    }

    // =====================================================================
    // Patient: share, change, stop, Undo
    // =====================================================================

    /**
     * POST /portal/document-access/grants — share with 1–5 booked doctors
     * (spec §3.3). Returns DocumentShareResultDto (`replayed` true for a
     * repeat of the same submission within 24 hours).
     *
     * @param array<string,mixed> $input
     * @return array<string,mixed>
     */
    public function share(Patient $p, array $input, DateTimeImmutable $now): array
    {
        $this->requireEnabled();
        // A retry of a submission that went through is answered from its record
        // (spec §3.5) — also when it merged into an existing share, and when the
        // request it answered is closed by now.
        $key   = Rules::lowerUuid($input['client_key'] ?? null);
        $prior = $key !== null ? $this->grants->submission($p->getId(), $key) : null;
        $n     = $this->normaliseShare($p, $input, $now, $prior !== null);
        if ($prior !== null) {
            return $this->replay($p, $n, $prior, $now);
        }

        try {
            $result = $this->inPairs($p, $n['specialist_ids'], fn (): array => $this->shareLocked($p, $n, $now), $now);
        } catch (UniqueConstraintViolationException $e) {
            // The same key sent at once for other doctors (no lock in common):
            // the submission that committed first owns it.
            $winner = $this->grants->submission($p->getId(), $n['client_key']);
            if ($winner === null) {
                throw $e;
            }

            return $this->replay($p, $n, $winner, $now);
        }

        if (isset($result['replay'])) {
            $winner = $this->grants->submission($p->getId(), $n['client_key']) ?? throw DomainRefusal::code(409, 'idempotency_conflict', 'Something changed. Check your choices and try again.');

            return $this->replay($p, $n, $winner, $now);
        }

        return [
            'grants'               => $this->views->grantDtosByIds($p, $result['grant_ids'], $now),
            'outcomes'             => $result['outcomes'],
            'approved_request_ids' => $result['approved'],
            'replayed'             => false,
        ];
    }

    /**
     * The locked part of {@see share()}: every doctor's share, the answered
     * request, the notices, and the submission record — one transaction.
     *
     * @param array<string,mixed> $n the normalised share
     * @return array{replay:true}|array{grant_ids:list<string>, outcomes:list<array<string,string>>, approved:list<string>}
     */
    private function shareLocked(Patient $p, array $n, DateTimeImmutable $now): array
    {
        // Two tabs sending the same submission: the second waited on the locks.
        if ($this->grants->submission($p->getId(), $n['client_key']) !== null) {
            return ['replay' => true];
        }
        $grantIds = [];
        $outcomes = [];
        $approved = [];
        foreach ($n['specialist_ids'] as $sid) {
            $s = $this->specialist($sid);
            $this->assertEligible($p, $s);
            \assert($s instanceof Specialist);
            $appt    = $n['appointment'] !== null && strtolower($n['appointment']->getSpecialist()->getId()) === $sid ? $n['appointment'] : null;
            $expires = $this->expiryFor($n['duration'], $n['until'], $appt, $p, $sid, $now);
            $applied = $this->applyShare($p, $s, $n['scope'], $n['document_ids'], $n['duration'], $expires, $appt?->getId(), 'share', $n['surface'], $n['client_key'], $n['hash'], null, $now);
            $widened = $applied['widened'];
            if ($n['scope'] === 'all' && in_array($sid, $n['show_hidden'], true)
                && $this->showHidden($p, $s, null, $n['surface'], $applied['grant_id'], $now) !== []) {
                $widened = true;
            }
            $grantIds[] = $applied['grant_id'];
            $outcomes[] = ['specialist_id' => $sid, 'grant_id' => $applied['grant_id'], 'outcome' => $applied['outcome']];
            $link       = $this->doctorLinkAppointment($p->getId(), $sid, $appt?->getId(), $now);
            if ($n['answers_specialist'] === $sid) {
                $this->answerRequest($p, $sid, (string) $n['answers_request_id'], $applied['grant_id'], $now);
                $approved[] = (string) $n['answers_request_id'];
                $this->notifier->queueDoctor('approved', $sid, $p->getId(), $this->patientName($p, $sid), $link);
            } elseif ($widened) {
                $this->notifier->queueDoctor('shared', $sid, $p->getId(), $this->patientName($p, $sid), $link);
            }
        }
        // What this submission did, whatever it merged into: a retry finds it here.
        $this->grants->insertSubmission($p->getId(), (string) $n['client_key'], (string) $n['hash'], $grantIds, $outcomes, $approved, $now);

        return ['grant_ids' => $grantIds, 'outcomes' => $outcomes, 'approved' => $approved];
    }

    /**
     * PATCH /portal/document-access/grants/{id} — extend / shorten, change
     * scope, add / remove documents (spec §3.3). Returns DocumentGrantDto (the
     * surviving folder grant when this one merged into it).
     *
     * @param array<string,mixed> $input
     * @return array<string,mixed>
     */
    public function updateGrant(Patient $p, string $grantId, array $input, DateTimeImmutable $now): array
    {
        $this->requireEnabled();
        $id  = Rules::lowerUuid($grantId) ?? throw DomainRefusal::notFound('This share could not be found.');
        $row = $this->grants->rowForPatient($id, $p->getId()) ?? throw DomainRefusal::notFound('This share could not be found.');
        $sid = strtolower((string) $row['specialist_id']);

        $errors = [];
        $scope  = $input['scope'] ?? null;
        if ($scope !== null && !in_array($scope, ['all', 'selected'], true)) {
            $errors['scope'] = 'Choose what they can see.';
        }
        $replace = null;
        if (array_key_exists('document_ids', $input) && $input['document_ids'] !== null) {
            [$replace, $e] = $this->ownDocumentList($p, $input['document_ids'], 'document_ids', Rules::MAX_DOCUMENTS);
            $errors += $e;
        }
        [$add, $e] = $this->ownDocumentList($p, $input['add_document_ids'] ?? null, 'add_document_ids', Rules::MAX_PATCH_DOCUMENTS);
        $errors += $e;
        [$remove, $e] = Rules::uuidList($input['remove_document_ids'] ?? null, 'remove_document_ids', Rules::MAX_PATCH_DOCUMENTS, 'You can remove up to 200 documents at a time.', 'One of these documents could not be found.');
        $errors += $e;

        $targetScope = $scope ?? (string) $row['scope'];
        if ($targetScope === 'selected' && (string) $row['scope'] === 'all' && ($replace ?? []) === [] && !isset($errors['document_ids'])) {
            $errors['document_ids'] = 'Choose at least one document.';
            $errors['code']         = 'nothing_selected';
        }
        if (($add !== [] || $remove !== []) && $targetScope === 'all') {
            $errors['scope'] = 'Documents can only be added to or removed from a share of selected documents.';
        }

        $duration = null;
        $newEnd   = null;
        $appt     = null;
        if (array_key_exists('duration', $input) && $input['duration'] !== null) {
            $duration = ShareDuration::tryFrom((string) $input['duration']);
            if ($duration === null) {
                $errors['duration'] = 'Choose how long they can see them.';
            } else {
                [$appt, $apptError] = $this->appointmentChoice($p, $input['appointment_id'] ?? null, [$sid], $duration->isAnchored() ? ($row['appointment_id'] !== null ? (string) $row['appointment_id'] : null) : null);
                if ($apptError !== null) {
                    $errors['appointment_id'] = $apptError;
                }
                $until = null;
                if ($duration === ShareDuration::UNTIL) {
                    $parsed = Rules::parseUntil((string) ($input['expires_at'] ?? ''), $now);
                    if (is_string($parsed)) {
                        $errors['expires_at'] = $parsed;
                    } else {
                        $until = $parsed;
                    }
                }
                if (!isset($errors['appointment_id']) && !isset($errors['expires_at'])) {
                    $durationError = $this->durationProblem($duration, $appt, [$sid], $p, $now);
                    if ($durationError !== null) {
                        $errors[$durationError[0]] = $durationError[1];
                    } else {
                        $newEnd = $this->expiryFor($duration, $until, $appt, $p, $sid, $now);
                        if ($newEnd !== null && $newEnd <= $now->modify('+' . Rules::MIN_LEAD_MINUTES . ' minutes')) {
                            $errors['duration'] = 'Choose an end at least an hour from now.';
                        }
                    }
                }
            }
        }
        if ($scope === null && $replace === null && $add === [] && $remove === [] && $duration === null && $errors === []) {
            $errors['scope'] = 'Nothing to change.';
        }
        if ($errors !== []) {
            throw self::invalid($errors);
        }

        $resultId = $this->inPairs($p, [$sid], function () use ($p, $id, $sid, $scope, $replace, $add, $remove, $duration, $newEnd, $appt, $now): string|DomainRefusal {
            $fresh = $this->grants->row($id);
            if ($fresh === null || $fresh['status'] !== 'active') {
                return self::grantEnded();
            }
            $current = (string) $fresh['scope'];
            // The scope checks above read the row before the lock; another tab may
            // have changed it since. Decide again on the locked row, before any
            // write, so include rows never land on a whole-folder share.
            $target = $scope ?? $current;
            if (($add !== [] || $remove !== [] || ($replace !== null && $scope === null)) && $target !== 'selected') {
                return DomainRefusal::field('scope', 'Documents can only be added to or removed from a share of selected documents.');
            }
            if ($target === 'selected' && $current === 'all' && ($replace ?? []) === []) {
                return self::invalid(['document_ids' => 'Choose at least one document.', 'code' => 'nothing_selected']);
            }
            $oldEnd  = Rules::fromSql($fresh['expires_at']);
            $later   = $duration !== null && ($newEnd === null ? $oldEnd !== null : ($oldEnd !== null && $newEnd > $oldEnd));
            $widens  = $later || $add !== [] || ($scope === 'all' && $current === 'selected') || ($replace !== null && $current === 'selected');
            $s       = $this->specialist($sid);
            if ($widens) {
                $this->assertEligible($p, $s);
            }

            $widened = false;
            if ($duration !== null) {
                if (!$this->transitions->changeGrantEnd($id, $newEnd, $duration->value, true, 'patient', $now, ['surface' => 'manage_sharing'], $appt?->getId(), $duration->isAnchored())) {
                    return self::grantEnded();
                }
                $widened = $later;
            }

            $resultId = $id;
            if ($replace !== null && $target === 'selected') {
                // Always clear: a folder share turning selected must not keep any
                // stray include row — the new set is exactly `document_ids`.
                $cleared = $this->grants->clearDocuments($id);
                $removed = $current === 'selected' ? $cleared : [];
                if ($current === 'all') {
                    $this->grants->setScope($id, 'selected', $now);
                }
                $added    = $this->grants->addDocuments($id, $replace, $now);
                $newOnes  = array_values(array_diff($added, $removed));
                $dropped  = array_values(array_diff($removed, $added));
                $this->recordChange($id, $now, ['previous_scope' => $current, 'added_ids' => $newOnes, 'removed_ids' => $dropped]);
                $widened = $widened || ($current === 'selected' && $newOnes !== []);
            } elseif ($scope === 'all' && $current === 'selected') {
                $this->grants->clearDocuments($id);
                $other = $this->grants->activeFolderForPair($p->getId(), $sid);
                if ($other !== null && strtolower((string) $other['id']) !== $id) {
                    // Two folder shares become one: this one ends `merged`, the survivor keeps the later end.
                    $mine    = $this->grants->row($id) ?? $fresh;
                    $mineEnd = Rules::fromSql($mine['expires_at']);
                    $otherEnd = Rules::fromSql($other['expires_at']);
                    $this->transitions->endGrant($id, 'merged', 'patient', $now);
                    if ($otherEnd !== null && ($mineEnd === null || $mineEnd > $otherEnd)) {
                        $this->transitions->changeGrantEnd(
                            (string) $other['id'],
                            $mineEnd,
                            (string) $mine['duration'],
                            true,
                            'patient',
                            $now,
                            ['surface' => 'manage_sharing'],
                            $mine['appointment_id'] !== null ? (string) $mine['appointment_id'] : null,
                            DocumentSharingViews::anchored((string) $mine['duration']),
                        );
                    }
                    $resultId = strtolower((string) $other['id']);
                } else {
                    $this->grants->setScope($id, 'all', $now);
                    $this->recordChange($id, $now, ['previous_scope' => 'selected']);
                }
                $widened = true;
            }

            if ($add !== [] || $remove !== []) {
                $added   = $this->grants->addDocuments($id, $add, $now);
                $removed = $this->grants->removeDocuments($id, $remove);
                if ($added !== [] || $removed !== []) {
                    $this->recordChange($id, $now, ['added_ids' => $added, 'removed_ids' => $removed]);
                }
                $widened = $widened || $added !== [];
                if (($this->grants->documentCounts([$id])[$id] ?? 0) === 0) {
                    $this->transitions->endGrant($id, 'emptied', 'patient', $now);
                }
            }

            if ($widened && $s !== null && $this->policy->isPractising($s)) {
                $link = $this->doctorLinkAppointment($p->getId(), $sid, $fresh['appointment_id'] !== null ? (string) $fresh['appointment_id'] : null, $now);
                $this->notifier->queueDoctor('shared', $sid, $p->getId(), $this->patientName($p, $sid), $link);
            }

            return $resultId;
        }, $now);

        return $this->views->grantDto($p, $resultId, $now) ?? throw DomainRefusal::notFound('This share could not be found.');
    }

    /** POST …/grants/{id}/revoke — stop one share (idempotent; no doctor notice). Returns DocumentGrantDto. */
    public function revokeGrant(Patient $p, string $grantId, DateTimeImmutable $now): array
    {
        $this->requireEnabled();
        $id  = Rules::lowerUuid($grantId) ?? throw DomainRefusal::notFound('This share could not be found.');
        $row = $this->grants->rowForPatient($id, $p->getId()) ?? throw DomainRefusal::notFound('This share could not be found.');
        $this->inPairs($p, [(string) $row['specialist_id']], function () use ($id, $now): void {
            $fresh = $this->grants->row($id);
            if ($fresh !== null && $fresh['status'] === 'active') {
                $this->transitions->endGrant($id, 'revoked', 'patient', $now, Uuid::uuid4()->toString());
            }
        }, $now);

        return $this->views->grantDto($p, $id, $now) ?? throw DomainRefusal::notFound('This share could not be found.');
    }

    /** POST …/doctors/{specialistId}/revoke — stop every share with one doctor (one Undo batch). RevokeResultDto. */
    public function stopSharing(Patient $p, string $specialistId, DateTimeImmutable $now): array
    {
        $this->requireEnabled();
        $sid = Rules::lowerUuid($specialistId) ?? throw DomainRefusal::notFound('This doctor could not be found.');

        return $this->revokeBatch($p, [$sid], $now);
    }

    /** POST …/revoke-all — stop sharing with everyone (one Undo batch; pending requests stay). RevokeResultDto. */
    public function revokeAll(Patient $p, DateTimeImmutable $now): array
    {
        $this->requireEnabled();

        return $this->revokeBatch($p, $this->grants->activeSpecialistIds($p->getId()), $now);
    }

    /**
     * POST …/grants/{id}/restore — Undo a patient revoke within 10 minutes:
     * every grant of its batch comes back as a new grant (source `restore`),
     * except those whose end has passed or whose doctor can't be shared with
     * any more (`skipped_grant_ids`). A repeat returns what was restored.
     * RestoreResultDto.
     */
    public function restore(Patient $p, string $grantId, DateTimeImmutable $now): array
    {
        $this->requireEnabled();
        $id  = Rules::lowerUuid($grantId) ?? throw DomainRefusal::notFound('This share could not be found.');
        $row = $this->grants->rowForPatient($id, $p->getId()) ?? throw DomainRefusal::notFound('This share could not be found.');
        $batch = $row['revoke_batch_id'] !== null ? strtolower((string) $row['revoke_batch_id']) : null;
        if ($batch === null || $row['end_reason'] !== 'revoked' || $row['ended_by'] !== 'patient') {
            throw self::restoreExpired();
        }
        $batchRows = $this->grants->rowsInBatch($p->getId(), $batch);
        $sids      = array_values(array_unique(array_map(static fn (array $r): string => strtolower((string) $r['specialist_id']), $batchRows)));

        $result = $this->inPairs($p, $sids, function () use ($p, $batch, $batchRows, $now): array|DomainRefusal {
            $marked = $this->transitions->markRestored($p->getId(), $batch, $now);
            $oldIds = array_map(static fn (array $r): string => strtolower((string) $r['id']), $batchRows);
            if ($marked === []) {
                $already = $this->grants->restoredFrom($oldIds);
                if ($already === []) {
                    return self::restoreExpired();
                }
                // The first Undo restored them in the batch's order; the new rows
                // share one created_at, so their own order is random — answer in
                // the batch's order again (a repeat reads the same as the first).
                $pos = array_flip($oldIds);
                usort($already, static fn (array $a, array $b): int => ($pos[strtolower((string) $a['restored_from_grant_id'])] ?? PHP_INT_MAX)
                    <=> ($pos[strtolower((string) $b['restored_from_grant_id'])] ?? PHP_INT_MAX));
                $from = array_map(static fn (array $r): string => strtolower((string) $r['restored_from_grant_id']), $already);

                return [
                    'restored' => array_map(static fn (array $r): string => strtolower((string) $r['id']), $already),
                    'skipped'  => array_values(array_diff($oldIds, $from)),
                ];
            }
            $marked   = array_map('strtolower', $marked);
            $restored = [];
            $skipped  = [];
            foreach ($batchRows as $old) {
                $oldId = strtolower((string) $old['id']);
                if (!in_array($oldId, $marked, true)) {
                    continue;
                }
                $newId = $this->restoreOne($p, $old, $batch, $now);
                if ($newId !== null) {
                    $restored[] = $newId;
                } else {
                    $skipped[] = $oldId;
                }
            }

            return ['restored' => $restored, 'skipped' => $skipped];
        }, $now);

        return [
            'restored'          => $this->views->grantDtosByIds($p, $result['restored'], $now),
            'skipped_grant_ids' => $result['skipped'],
        ];
    }

    /** POST …/doctors/{specialistId}/allow-requests — lift the request block (idempotent). SharingDoctorDto. */
    public function allowRequests(Patient $p, string $specialistId, DateTimeImmutable $now): array
    {
        $this->requireEnabled();
        $sid = $this->bookedDoctorId($p, $specialistId);
        $this->inPairs($p, [$sid], function () use ($p, $sid, $now): void {
            if (!$this->grants->liftBlock($p->getId(), $sid, $now)) {
                return;
            }
            $this->log->append(['patient_id' => $p->getId(), 'specialist_id' => $sid, 'event' => 'requests_allowed', 'actor_role' => 'patient'], $now);
            $this->auditPatient($p, $sid, 'document_access.requests_allowed', 'specialist', $sid, []);
        }, $now);

        return $this->views->sharingDoctor($p, $sid, $now) ?? throw DomainRefusal::notFound('This doctor could not be found.');
    }

    /**
     * DELETE /portal/documents/{id}/access/{specialistId} — the doctor can no
     * longer see this document: it leaves the pair's selected shares (an
     * emptied one ends) AND an open hidden row is written (always, so a later
     * folder share respects it). Idempotent.
     */
    public function removeDocumentAccess(Patient $p, string $documentId, string $specialistId, DateTimeImmutable $now): void
    {
        $this->requireEnabled();
        $doc = $this->ownDocument($p, $documentId);
        $sid = $this->bookedDoctorId($p, $specialistId);
        $docId = strtolower($doc->getId());
        $this->inPairs($p, [$sid], function () use ($p, $sid, $docId, $now): void {
            $touched = [];
            foreach ($this->grants->activeSelectedIncluding($p->getId(), $sid, $docId) as $g) {
                $gid = strtolower((string) $g['id']);
                $this->grants->removeDocuments($gid, [$docId]);
                $touched[] = $gid;
                if (($this->grants->documentCounts([$gid])[$gid] ?? 0) === 0) {
                    $this->transitions->endGrant($gid, 'emptied', 'patient', $now);
                }
            }
            $hidden = $this->grants->hide($p->getId(), $sid, $docId, 'remove_access', $now);
            if ($touched === [] && !$hidden) {
                return;
            }
            $this->log->append([
                'patient_id'    => $p->getId(),
                'specialist_id' => $sid,
                'document_id'   => $docId,
                'grant_id'      => $touched[0] ?? null,
                'event'         => 'document_removed',
                'actor_role'    => 'patient',
                'details'       => ['surface' => 'document_access'],
            ], $now);
            $this->auditPatient($p, $sid, 'document_access.document_removed', 'medical_document', $docId, ['grant_ids' => $touched]);
        }, $now);
    }

    /** POST /portal/documents/{id}/access/{specialistId}/unhide — "Show again" through the folder share. Idempotent. */
    public function unhideDocument(Patient $p, string $documentId, string $specialistId, DateTimeImmutable $now): void
    {
        $this->requireEnabled();
        $doc = $this->ownDocument($p, $documentId);
        $sid = $this->bookedDoctorId($p, $specialistId);
        $docId = strtolower($doc->getId());
        $this->inPairs($p, [$sid], function () use ($p, $sid, $docId, $now): void {
            $s = $this->specialist($sid);
            if ($s === null || $this->showHidden($p, $s, [$docId], 'document_access', null, $now, perDocumentAudit: true) === []) {
                return;
            }
            $folder = $this->grants->activeFolderForPair($p->getId(), $sid);
            if ($folder !== null && $this->policy->isPractising($s)) {
                $link = $this->doctorLinkAppointment($p->getId(), $sid, $folder['appointment_id'] !== null ? (string) $folder['appointment_id'] : null, $now);
                $this->notifier->queueDoctor('shared', $sid, $p->getId(), $this->patientName($p, $sid), $link);
            }
        }, $now);
    }

    // =====================================================================
    // Requests
    // =====================================================================

    /**
     * POST /doctor/appointments/{id}/document-access/request — the doctor
     * asks the consultation's patient (spec §3.4). Returns the request row.
     *
     * @return array<string,mixed>
     */
    public function requestAccess(Specialist $s, Appointment $a, string $userId, ?string $message, DateTimeImmutable $now): array
    {
        $this->requireEnabled();
        $clean = Rules::sanitizeMessage($message);
        if ($clean !== null && mb_strlen($clean) > Rules::MESSAGE_MAX) {
            throw DomainRefusal::field('message', 'Keep the reason to ' . Rules::MESSAGE_MAX . ' characters or fewer.');
        }
        $p   = $a->getPatient();
        $sid = strtolower($s->getId());

        return $this->inPairs($p, [$sid], function () use ($s, $a, $p, $sid, $userId, $clean, $now): array {
            $facts = $this->requestFacts($s, $a, $now);
            $check = AccessRequestRules::check($facts, $now);
            if ($check !== null) {
                throw $this->requestRefusal($check, $p, $sid, $now);
            }
            $kind  = AccessRequestRules::kind($facts, $now);
            $id    = $this->requests->insertRequest([
                'patient_id'           => $p->getId(),
                'specialist_id'        => $sid,
                'appointment_id'       => $a->getId(),
                'requested_by_user_id' => Rules::lowerUuid($userId),
                'kind'                 => $kind,
                'message'              => $clean,
            ], $now);
            $names = $this->transitions->names($p->getId(), $sid);
            $this->audit->record($names['doctor'], 'doctor', 'document_access.requested', $a->getId(), 'document_access_request', $id, [
                'patient_id'     => strtolower($p->getId()),
                'patient_name'   => $names['patient'],
                'specialist_id'  => $sid,
                'doctor'         => $names['doctor'],
                'has_message'    => $clean !== null,
                'kind'           => $kind,
                'appointment_id' => strtolower($a->getId()),
            ], Rules::lowerUuid($userId));
            $this->log->append([
                'patient_id'     => $p->getId(),
                'specialist_id'  => $sid,
                'request_id'     => $id,
                'appointment_id' => $a->getId(),
                'event'          => 'requested',
                'actor_role'     => 'doctor',
            ], $now);
            $this->notifier->queueRequested($p, $s->getName(), $id);

            return $this->requests->row($id) ?? [];
        }, $now);
    }

    /**
     * POST …/document-access/request/cancel — the doctor withdraws their
     * pending request (no patient notice). Returns the request row.
     *
     * @return array<string,mixed>
     */
    public function cancelRequest(Specialist $s, Patient $p, DateTimeImmutable $now): array
    {
        $this->requireEnabled();
        $sid = strtolower($s->getId());

        return $this->inPairs($p, [$sid], function () use ($p, $sid, $now): array|DomainRefusal {
            $pending = $this->requests->pendingForPair($p->getId(), $sid, $now);
            if ($pending === null) {
                return self::notPending($this->requests->lastDecidedForPair($p->getId(), $sid, $now), $now);
            }
            $row = $this->transitions->casRequest((string) $pending['id'], 'cancelled', 'withdrawn', $now);
            if ($row === null) {
                return self::notPending($this->requests->row((string) $pending['id']), $now);
            }
            $this->transitions->recordRequestClosed($row, 'cancelled', 'withdrawn', 'doctor', $now);

            return $this->requests->row((string) $pending['id']) ?? [];
        }, $now);
    }

    /**
     * POST /portal/document-access/requests/{id}/approve — CAS approve plus the
     * grant, in one transaction. A doctor who can no longer be shared with
     * ends the request (in a committed transaction of its own) and answers 422.
     * Returns `{request, grant}` DTOs.
     *
     * @param array<string,mixed> $input
     * @return array{request: array<string,mixed>, grant: array<string,mixed>|null}
     */
    public function approveRequest(Patient $p, string $requestId, array $input, DateTimeImmutable $now): array
    {
        $this->requireEnabled();
        $req = $this->requestRow($p, $requestId);
        $rid = strtolower((string) $req['id']);
        $sid = strtolower((string) $req['specialist_id']);
        $s   = $this->specialist($sid);

        [$choice, $errors] = $this->parseChoice($p, $input, [$sid], $now, $req['appointment_id'] !== null ? (string) $req['appointment_id'] : null);
        if ($errors !== []) {
            throw self::invalid($errors);
        }
        $showHidden = $choice['scope'] === 'all' && filter_var($input['show_hidden'] ?? false, FILTER_VALIDATE_BOOL);

        $problem = $this->eligibilityProblem($p, $s);
        if ($problem !== null) {
            $reason = $problem->errorCode() === 'doctor_unavailable' ? 'doctor_unavailable' : 'not_eligible';
            $this->inPairs($p, [$sid], function () use ($rid, $reason, $now): void {
                $row = $this->transitions->casRequest($rid, 'cancelled', $reason, $now);
                if ($row !== null) {
                    $this->transitions->recordRequestClosed($row, 'cancelled', $reason, 'system', $now);
                }
            }, $now);
            throw $problem;
        }
        \assert($s instanceof Specialist);

        $grantId = $this->inPairs($p, [$sid], function () use ($p, $s, $sid, $rid, $choice, $showHidden, $now): string|DomainRefusal {
            $row = $this->transitions->casRequest($rid, 'approved', 'approved', $now);
            if ($row === null) {
                return self::notPending($this->requests->row($rid), $now);
            }
            $this->assertEligible($p, $s);
            $appt    = $choice['appointment'];
            $expires = $this->expiryFor($choice['duration'], $choice['until'], $appt, $p, $sid, $now);
            $applied = $this->applyShare($p, $s, $choice['scope'], $choice['document_ids'], $choice['duration'], $expires, $appt?->getId(), 'request', 'request', null, null, $rid, $now);
            if ($showHidden) {
                $this->showHidden($p, $s, null, 'request', $applied['grant_id'], $now);
            }
            $this->transitions->recordRequestClosed($row, 'approved', 'approved', 'patient', $now, [], $applied['grant_id']);
            $link = $this->doctorLinkAppointment($p->getId(), $sid, $row['appointment_id'] !== null ? (string) $row['appointment_id'] : null, $now);
            $this->notifier->queueDoctor('approved', $sid, $p->getId(), $this->patientName($p, $sid), $link);

            return $applied['grant_id'];
        }, $now);

        return [
            'request' => $this->views->requestDto($p, $this->requests->row($rid) ?? $req, $now) ?? [],
            'grant'   => $this->views->grantDto($p, $grantId, $now),
        ];
    }

    /**
     * POST …/requests/{id}/decline — optionally blocking further requests.
     * The doctor is told "declined" (never "blocked"). DocumentAccessRequestDto.
     */
    public function declineRequest(Patient $p, string $requestId, bool $block, DateTimeImmutable $now): array
    {
        $this->requireEnabled();
        $req = $this->requestRow($p, $requestId);
        $rid = strtolower((string) $req['id']);
        $sid = strtolower((string) $req['specialist_id']);
        $this->inPairs($p, [$sid], function () use ($p, $sid, $rid, $block, $now): bool|DomainRefusal {
            $row = $this->transitions->casRequest($rid, 'declined', 'declined', $now);
            if ($row === null) {
                return self::notPending($this->requests->row($rid), $now);
            }
            if ($block && $this->grants->insertBlock($p->getId(), $sid, $rid, $now)) {
                $this->log->append(['patient_id' => $p->getId(), 'specialist_id' => $sid, 'request_id' => $rid, 'event' => 'requests_blocked', 'actor_role' => 'patient'], $now);
            }
            $this->transitions->recordRequestClosed($row, 'declined', 'declined', 'patient', $now, ['blocked' => $block]);
            $link = $this->doctorLinkAppointment($p->getId(), $sid, $row['appointment_id'] !== null ? (string) $row['appointment_id'] : null, $now);
            $this->notifier->queueDoctor('declined', $sid, $p->getId(), $this->patientName($p, $sid), $link);

            return true;
        }, $now);

        return $this->views->requestDto($p, $this->requests->row($rid) ?? $req, $now) ?? [];
    }

    /** The pair's pending request (DocumentAccessRequestDto), or null. */
    public function pendingRequestFor(Patient $p, string $specialistId, DateTimeImmutable $now): ?array
    {
        return $this->views->pendingRequestDto($p, $specialistId, $now);
    }

    /**
     * DoctorDocumentAccessDto.request — whether this doctor may ask now, and
     * their pending / last request.
     *
     * @return array<string,mixed>
     */
    public function doctorRequestBlock(Specialist $s, Appointment $a, DateTimeImmutable $now): array
    {
        $p       = $a->getPatient();
        $sid     = strtolower($s->getId());
        $lastRow = $this->requests->lastDecidedForPair($p->getId(), $sid, $now);
        $last    = $lastRow !== null ? DocumentSharingPresenter::doctorRequest($lastRow, $now) : null;
        if (!Rules::enabled()) {
            return ['can_request' => false, 'kind' => null, 'blocked_reason' => 'sharing_unavailable', 'available_at' => null, 'pending' => null, 'last' => $last];
        }
        $pending = $this->requests->pendingForPair($p->getId(), $sid, $now);
        $facts   = $this->requestFacts($s, $a, $now);
        $check   = AccessRequestRules::check($facts, $now);
        $reason  = $check['code'] ?? null;
        if ($reason === 'doctor_unavailable') {
            $reason = 'appointment_not_eligible';
        }

        return [
            'can_request'    => $check === null,
            'kind'           => $check === null ? AccessRequestRules::kind($facts, $now) : null,
            'blocked_reason' => $reason,
            'available_at'   => Rules::iso($check['available_at'] ?? null),
            'pending'        => $pending !== null ? DocumentSharingPresenter::doctorRequest($pending, $now) : null,
            'last'           => $last,
        ];
    }

    // =====================================================================
    // Upload, booking-attachment upload, booking
    // =====================================================================

    /**
     * Validate POST /portal/documents' sharing fields BEFORE the bytes are
     * stored (spec §3.3): the share (when sharing is on), the exclusions and
     * the batch hash (409 `idempotency_conflict` when this batch id was used
     * with other choices).
     *
     * @param array<string,mixed> $body
     * @return array{share: array{specialist_ids: list<string>, duration: ?ShareDuration, until: ?DateTimeImmutable, appointment: ?Appointment, batch_id: ?string, surface: string, hash: ?string}, exclude: list<string>, asked: bool}
     */
    public function validateUploadShare(Patient $p, array $body, DateTimeImmutable $now): array
    {
        $errors = [];
        [$exclude, $e] = Rules::uuidList($body['exclude_specialist_ids'] ?? null, 'exclude_specialist_ids', Rules::MAX_EXCLUDE, 'You can list up to ' . Rules::MAX_EXCLUDE . ' doctors.', 'Choose a doctor');
        $errors += $e;
        foreach ($exclude as $i => $sid) {
            if (!$this->policy->isBooked($p->getId(), $sid)) {
                $errors["exclude_specialist_ids.$i"] = "You can only keep files from doctors you've booked.";
            }
        }
        [$sids, $e] = Rules::uuidList($body['share_specialist_ids'] ?? null, 'share_specialist_ids', Rules::MAX_DOCTORS, 'You can share with up to ' . Rules::MAX_DOCTORS . ' doctors at a time.', 'Choose a doctor');
        $errors += $e;
        $surface = is_string($body['share_surface'] ?? null) && $body['share_surface'] !== '' ? (string) $body['share_surface'] : 'documents_page';
        if (!in_array($surface, Rules::UPLOAD_SURFACES, true)) {
            $errors['share_surface'] = 'Unknown sharing surface';
        }
        $none  = ['specialist_ids' => [], 'duration' => null, 'until' => null, 'appointment' => null, 'batch_id' => null, 'surface' => $surface, 'hash' => null];
        $asked = $sids !== [];
        if (!$asked || !Rules::enabled()) {
            if ($errors !== []) {
                throw self::invalid($errors);
            }

            return ['share' => $none, 'exclude' => $exclude, 'asked' => $asked];
        }

        $duration = ShareDuration::tryFrom((string) ($body['share_duration'] ?? ''));
        $until    = null;
        $appt     = null;
        if ($duration === null) {
            $errors['share_duration'] = 'Choose how long they can see these files.';
        } else {
            if ($duration === ShareDuration::UNTIL) {
                $parsed = Rules::parseUntil((string) ($body['share_expires_at'] ?? ''), $now);
                if (is_string($parsed)) {
                    $errors['share_expires_at'] = $parsed;
                } else {
                    $until = $parsed;
                }
            }
            [$appt, $apptError] = $this->appointmentChoice($p, $body['share_appointment_id'] ?? null, $sids, null);
            if ($apptError !== null) {
                $errors['share_appointment_id'] = $apptError;
            } elseif (($problem = $this->durationProblem($duration, $appt, $sids, $p, $now)) !== null) {
                $errors[$problem[0] === 'appointment_id' ? 'share_appointment_id' : 'share_duration'] = $problem[1];
            }
        }
        $batch = Rules::lowerUuid($body['share_batch_id'] ?? null);
        if ($batch === null) {
            $errors['share_batch_id'] = 'Send the upload batch id';
        }
        if ($errors !== []) {
            throw self::invalid($errors);
        }
        foreach ($sids as $sid) {
            $this->assertEligible($p, $this->specialist($sid), 'share_specialist_ids');
        }
        \assert($duration instanceof ShareDuration && $batch !== null);
        $hash = Rules::requestHash([
            'specialist_ids' => $sids,
            'duration'       => $duration->value,
            'expires_at'     => Rules::iso($until),
            'appointment_id' => $appt !== null ? strtolower($appt->getId()) : null,
        ]);
        foreach ($this->grants->rowsWithClientKey($p->getId(), $batch) as $row) {
            if (trim((string) $row['request_hash']) !== $hash) {
                throw DomainRefusal::code(409, 'idempotency_conflict', 'These files were already sent with different sharing choices. Check your choices and try again.');
            }
        }

        return [
            'share'   => ['specialist_ids' => $sids, 'duration' => $duration, 'until' => $until, 'appointment' => $appt, 'batch_id' => $batch, 'surface' => $surface, 'hash' => $hash],
            'exclude' => array_values(array_diff($exclude, $sids)),
            'asked'   => true,
        ];
    }

    /**
     * Store a documents-page upload and apply its sharing choices in ONE
     * transaction (spec §3.3): the batch's active share gets this file, an
     * ended batch share leaves it private for that doctor (`ended_for`), else
     * a new `selected` share; exclusions get open hidden rows. The document
     * row is inserted here.
     *
     * @param array{specialist_ids: list<string>, duration: ?ShareDuration, until: ?DateTimeImmutable, appointment: ?Appointment, batch_id: ?string, surface: string, hash: ?string} $share
     * @param list<string> $excludeIds
     * @return array{shared: list<string>, ended_for: list<string>}
     */
    public function shareUpload(Patient $p, MedicalDocument $doc, array $share, array $excludeIds, DateTimeImmutable $now): array
    {
        $sids = Rules::enabled() ? $share['specialist_ids'] : [];

        return $this->inPairs($p, [...$sids, ...$excludeIds], function () use ($p, $doc, $share, $sids, $excludeIds, $now): array {
            $this->em->persist($doc);
            $this->em->flush();
            $docId  = strtolower($doc->getId());
            $shared = [];
            $ended  = [];
            foreach ($sids as $sid) {
                $s = $this->specialist($sid);
                $this->assertEligible($p, $s, 'share_specialist_ids');
                $batch  = (string) $share['batch_id'];
                $active = $this->grants->activeWithClientKey($p->getId(), $sid, $batch);
                if ($active !== null) {
                    $gid   = strtolower((string) $active['id']);
                    $added = $this->grants->addDocuments($gid, [$docId], $now);
                    if ($added !== []) {
                        $this->recordChange($gid, $now, ['added_ids' => $added, 'surface' => $share['surface']]);
                    }
                    $shared[] = $sid;
                    continue;
                }
                $before = array_filter(
                    $this->grants->rowsWithClientKey($p->getId(), $batch),
                    static fn (array $r): bool => strtolower((string) $r['specialist_id']) === $sid,
                );
                if ($before !== []) {
                    // This batch's share with them already ended: the file stays private for them.
                    $ended[] = $sid;
                    continue;
                }
                $appt    = $share['appointment'] !== null && strtolower($share['appointment']->getSpecialist()->getId()) === $sid ? $share['appointment'] : null;
                \assert($share['duration'] instanceof ShareDuration);
                $expires = $this->expiryFor($share['duration'], $share['until'], $appt, $p, $sid, $now);
                $gid     = $this->grants->insertGrant([
                    'patient_id'     => $p->getId(),
                    'specialist_id'  => $sid,
                    'scope'          => 'selected',
                    'source'         => 'upload',
                    'surface'        => $share['surface'],
                    'duration'       => $share['duration']->value,
                    'expires_at'     => $expires,
                    'appointment_id' => $appt?->getId(),
                    'client_key'     => $batch,
                    'request_hash'   => $share['hash'],
                ], $now);
                $this->grants->addDocuments($gid, [$docId], $now);
                $this->recordGranted($gid, 'created', $now);
                $this->notifier->queueDoctor('shared', $sid, $p->getId(), $this->patientName($p, $sid), $this->doctorLinkAppointment($p->getId(), $sid, $appt?->getId(), $now));
                $shared[] = $sid;
            }
            foreach ($excludeIds as $sid) {
                $this->grants->hide($p->getId(), $sid, $docId, 'upload', $now);
            }

            return ['shared' => $shared, 'ended_for' => $ended];
        }, $now);
    }

    /**
     * Validate `show_specialist_ids[]` (booking-attachment upload) or
     * `document_share.show_specialist_ids` (booking): ≤ 20 doctors the patient booked.
     *
     * @return list<string>
     */
    public function validateShowIds(Patient $p, mixed $raw): array
    {
        [$ids, $errors] = Rules::uuidList($raw, 'show_specialist_ids', Rules::MAX_EXCLUDE, 'You can list up to ' . Rules::MAX_EXCLUDE . ' doctors.', 'Choose a doctor');
        foreach ($ids as $i => $sid) {
            if (!$this->policy->isBooked($p->getId(), $sid)) {
                $errors["show_specialist_ids.$i"] = "You can only share with doctors you've booked.";
            }
        }
        if ($errors !== []) {
            throw self::invalid($errors);
        }

        return $ids;
    }

    /**
     * Store a booking attachment HIDDEN from every doctor holding a
     * whole-folder share — including the doctor being booked — except those
     * in `$showIds` (spec §3.3). Runs whether or not sharing is on, so
     * switching it on later never exposes the file. The document row is
     * inserted here.
     *
     * @param list<string> $showIds
     */
    public function hideBookingAttachment(Patient $p, MedicalDocument $doc, array $showIds, DateTimeImmutable $now): void
    {
        $holders = $this->grants->activeFolderHolders($p->getId());
        $this->inPairs($p, [...$holders, ...$showIds], function () use ($p, $doc, $showIds, $now): void {
            $this->em->persist($doc);
            $this->em->flush();
            $show = Rules::enabled() ? $showIds : [];
            foreach ($this->grants->activeFolderHolders($p->getId()) as $holder) {
                if (!in_array($holder, $show, true)) {
                    $this->grants->hide($p->getId(), $holder, strtolower($doc->getId()), 'booking_default', $now);
                }
            }
        }, $now);
    }

    /**
     * Validate a booking's `document_share` BEFORE any money moves: null when
     * absent (a legacy client), else `{duration, show}` (422
     * `document_share.duration` / `show_specialist_ids.N`).
     *
     * @return array{duration: ?string, show: list<string>}|null
     */
    public function validateBookingShare(Patient $p, mixed $raw): ?array
    {
        if ($raw === null) {
            return null;
        }
        if (!is_array($raw) || !array_key_exists('duration', $raw)) {
            throw self::invalid(['document_share.duration' => 'Choose whether the doctor can see your files.']);
        }
        $duration = $raw['duration'];
        if ($duration !== null && !in_array($duration, ShareDuration::bookingCodes(), true)) {
            throw self::invalid(['document_share.duration' => 'Choose how long the doctor can see your files.']);
        }

        return ['duration' => $duration !== null ? (string) $duration : null, 'show' => $this->validateShowIds($p, $raw['show_specialist_ids'] ?? null)];
    }

    /**
     * Inside the booking's transaction, after its attachments were linked
     * (the slot lock is held; pair locks follow it): the booked doctor gets
     * one `selected` share when `$duration` is set; every OTHER folder-share
     * holder ticked in `$showIds` sees the files, the rest have them hidden;
     * the booked doctor's folder share never covers them (their visibility is
     * exactly the booking share). A refusal throws and rolls the booking back.
     * Notices wait for the caller's {@see dispatchNotices()}.
     *
     * @param list<string> $documentIds
     * @param list<string> $showIds
     * @return array{outcome: string, grant_id: ?string, until_label_at: ?string}
     */
    public function shareForBooking(Patient $p, Appointment $a, array $documentIds, ?string $duration, array $showIds, DateTimeImmutable $now): array
    {
        $enabled = Rules::enabled();
        $booked  = strtolower($a->getSpecialist()->getId());
        $docIds  = array_values(array_unique(array_map('strtolower', $documentIds)));
        $holders = $this->grants->activeFolderHolders($p->getId());

        return $this->inPairs($p, [...$holders, ...$showIds, $booked], function () use ($p, $a, $booked, $docIds, $duration, $showIds, $enabled, $now): array {
            $out = ['outcome' => 'private', 'grant_id' => null, 'until_label_at' => null];
            if ($duration !== null && $docIds !== []) {
                if (!$enabled) {
                    $out['outcome'] = 'sharing_unavailable';
                } else {
                    $this->assertEligible($p, $a->getSpecialist(), 'document_share.duration');
                    $d       = ShareDuration::from($duration);
                    $expires = $this->expiryFor($d, null, $a, $p, $booked, $now);
                    $gid     = $this->grants->insertGrant([
                        'patient_id'     => $p->getId(),
                        'specialist_id'  => $booked,
                        'scope'          => 'selected',
                        'source'         => 'booking',
                        'surface'        => 'booking',
                        'duration'       => $d->value,
                        'expires_at'     => $expires,
                        'appointment_id' => $a->getId(),
                        'client_key'     => strtolower($a->getId()),
                    ], $now);
                    $this->grants->addDocuments($gid, $docIds, $now);
                    $this->recordGranted($gid, 'created', $now);
                    $this->notifier->queueDoctor('shared', $booked, $p->getId(), $this->patientName($p, $booked), $a->getId());
                    $out = ['outcome' => 'shared', 'grant_id' => $gid, 'until_label_at' => Rules::iso(Rules::untilLabelAt($expires, $d->value))];
                }
            }
            foreach ($this->grants->activeFolderHolders($p->getId()) as $holder) {
                if ($holder !== $booked && $enabled && in_array($holder, $showIds, true)) {
                    $s = $this->specialist($holder);
                    if ($s !== null && $this->showHidden($p, $s, $docIds, 'booking', null, $now) !== []) {
                        $this->notifier->queueDoctor('shared', $holder, $p->getId(), $this->patientName($p, $holder), $this->doctorLinkAppointment($p->getId(), $holder, null, $now));
                    }
                    continue;
                }
                foreach ($docIds as $docId) {
                    $this->grants->hide($p->getId(), $holder, $docId, $holder === $booked ? 'booking' : 'booking_default', $now);
                }
            }

            return $out;
        }, $now);
    }

    // =====================================================================
    // Reschedule, reinstatement, account closure
    // =====================================================================

    /**
     * A consultation moved (inside the reschedule's transaction, after
     * setScheduledAt()): its `after_*` shares follow it — re-based when the
     * patient moved it, capped at their base + 30 days otherwise (spec §1.2).
     * Returns what moved, for {@see DocumentAccessNotifier::rescheduleSuffix()}.
     *
     * @return list<array{duration:string, expires_at:DateTimeImmutable, capped:bool}>
     */
    public function appointmentMoved(Appointment $a, string $movedBy, DateTimeImmutable $now): array
    {
        if ($this->grants->activeAnchoredForAppointment($a->getId()) === []) {
            return [];
        }

        return $this->inPairs($a->getPatient(), [$a->getSpecialist()->getId()], function () use ($a, $movedBy, $now): array {
            $moved = [];
            $end   = AppointmentLifecycle::endsAt($a);
            foreach ($this->grants->activeAnchoredForAppointment($a->getId()) as $g) {
                $d = ShareDuration::from((string) $g['duration']);
                $r = ReschedulePolicy::newEnd($d, $end, Rules::fromSql($g['original_expires_at']) ?? Rules::fromSql($g['expires_at']), $movedBy);
                if (Rules::fromSql($g['expires_at']) == $r['expires_at']) {
                    continue;
                }
                if ($this->transitions->changeGrantEnd((string) $g['id'], $r['expires_at'], $d->value, $movedBy === 'patient', $movedBy === 'patient' ? 'patient' : 'system', $now, ['capped' => $r['capped']])) {
                    $moved[] = ['duration' => $d->value, 'expires_at' => $r['expires_at'], 'capped' => $r['capped']];
                }
            }

            return $moved;
        }, $now);
    }

    /**
     * Before a suspended doctor is reinstated (spec §1.4): a pause of more
     * than 30 days ends every share with them (`doctor_unavailable`); shorter,
     * the shares resume. Either way each affected patient is told — once the
     * reinstatement is saved ({@see ReinstatementNotices::dispatch()}). Any
     * failure throws, aborting the reinstatement (fail private).
     */
    public function doctorReinstated(Specialist $s, DateTimeImmutable $now): ReinstatementNotices
    {
        $sid    = strtolower($s->getId());
        $left   = $this->statusEvents->lastLeftApprovedAt($sid);
        $paused = $s->getSuspendedAt();
        $since  = $left !== null && $paused !== null ? max($left, $paused) : ($left ?? $paused);
        $long   = $since === null || $since < $now->modify('-' . Rules::REINSTATE_PAUSE_DAYS . ' days');

        $patientIds = array_values(array_unique(array_map(static fn (array $r): string => strtolower((string) $r['patient_id']), $this->grants->activeRowsForSpecialist($sid))));
        sort($patientIds);
        if ($patientIds === []) {
            return new ReinstatementNotices();
        }

        $conn     = $this->em->getConnection();
        $level    = $conn->getTransactionNestingLevel();
        $owns     = !$conn->isTransactionActive();
        $affected = [];
        $conn->beginTransaction();
        try {
            foreach ($patientIds as $pid) {
                $patient = $this->em->find(Patient::class, $pid);
                if (!$patient instanceof Patient) {
                    continue;
                }
                $touched = $this->inPairs($patient, [$sid], function () use ($pid, $sid, $long, $now): bool {
                    $rows = $this->grants->activeRowsForPair($pid, $sid);
                    if ($long) {
                        $ended = false;
                        foreach ($rows as $g) {
                            $ended = $this->transitions->endGrant((string) $g['id'], 'doctor_unavailable', 'system', $now) || $ended;
                        }

                        return $ended;
                    }

                    return $rows !== [];
                }, $now);
                if ($touched) {
                    $affected[] = $patient;
                }
            }
            $conn->commit();
        } catch (\Throwable $e) {
            if ($conn->getTransactionNestingLevel() > $level) {
                $conn->rollBack();
            }
            if ($owns) {
                $this->queue->discard();
            }
            throw $e;
        }
        if ($owns) {
            $this->queue->dispatch();
        }

        $name  = $s->getName();
        $tasks = [];
        foreach ($affected as $patient) {
            $tasks[] = function () use ($patient, $name, $sid, $long): void {
                $this->notifier->queueReinstated($patient, $name, $sid, $long);
                $this->queue->dispatch();
            };
        }

        return new ReinstatementNotices($tasks);
    }

    /** A future account-closure flow: every share ends (`account_closed`), every pending request is cancelled. */
    public function closeAccount(Patient $p, DateTimeImmutable $now): void
    {
        $pending = $this->requests->listForPatient($p->getId(), 'pending', $now);
        $sids    = [...$this->grants->activeSpecialistIds($p->getId()), ...array_map(static fn (array $r): string => (string) $r['specialist_id'], $pending)];
        $this->inPairs($p, $sids, function () use ($p, $now): void {
            foreach ($this->grants->activeSpecialistIds($p->getId()) as $sid) {
                foreach ($this->grants->activeRowsForPair($p->getId(), $sid) as $g) {
                    $this->transitions->endGrant((string) $g['id'], 'account_closed', 'system', $now);
                }
            }
            foreach ($this->requests->listForPatient($p->getId(), 'pending', $now) as $r) {
                $row = $this->transitions->casRequest((string) $r['id'], 'cancelled', 'account_closed', $now);
                if ($row !== null) {
                    $this->transitions->recordRequestClosed($row, 'cancelled', 'account_closed', 'system', $now);
                }
            }
        }, $now);
    }

    // =====================================================================
    // Internals
    // =====================================================================

    /**
     * Share with one doctor under the pair lock (spec §1.1 merge rules):
     * `all` merges into the pair's folder share taking the LATER end (NULL
     * wins; a create never shortens), else creates one; `selected` merges
     * into an active selected share with the same (duration, consultation,
     * end, source), else creates one.
     *
     * @param list<string> $documentIds
     * @return array{grant_id:string, outcome:string, widened:bool}
     */
    private function applyShare(
        Patient $p,
        Specialist $s,
        string $scope,
        array $documentIds,
        ShareDuration $d,
        ?DateTimeImmutable $expires,
        ?string $appointmentId,
        string $source,
        string $surface,
        ?string $clientKey,
        ?string $hash,
        ?string $requestId,
        DateTimeImmutable $now,
    ): array {
        $sid = strtolower($s->getId());
        if ($scope === 'all') {
            $folder = $this->grants->activeFolderForPair($p->getId(), $sid);
            if ($folder !== null) {
                $gid  = strtolower((string) $folder['id']);
                $old  = Rules::fromSql($folder['expires_at']);
                $wins = $old !== null && ($expires === null || $expires > $old);
                if ($wins) {
                    $this->transitions->changeGrantEnd($gid, $expires, $d->value, true, 'patient', $now, ['surface' => $surface], $appointmentId, $d->isAnchored());
                }
                if ($requestId !== null) {
                    $this->grants->setRequest($gid, $requestId, $now);
                }

                return ['grant_id' => $gid, 'outcome' => $wins ? 'extended' : 'unchanged', 'widened' => $wins];
            }
            $gid = $this->grants->insertGrant([
                'patient_id'     => $p->getId(),
                'specialist_id'  => $sid,
                'scope'          => 'all',
                'source'         => $source,
                'surface'        => $surface,
                'duration'       => $d->value,
                'expires_at'     => $expires,
                'appointment_id' => $appointmentId,
                'request_id'     => $requestId,
                'client_key'     => $clientKey,
                'request_hash'   => $hash,
            ], $now);
            $this->recordGranted($gid, 'created', $now);

            return ['grant_id' => $gid, 'outcome' => 'created', 'widened' => true];
        }

        $candidate = $this->grants->mergeCandidate($p->getId(), $sid, $d->value, $appointmentId, $expires, $source);
        if ($candidate !== null) {
            $gid   = strtolower((string) $candidate['id']);
            $added = $this->grants->addDocuments($gid, $documentIds, $now);
            if ($added !== []) {
                $this->recordChange($gid, $now, ['added_ids' => $added, 'surface' => $surface]);
            }
            if ($requestId !== null) {
                $this->grants->setRequest($gid, $requestId, $now);
            }

            return ['grant_id' => $gid, 'outcome' => $added !== [] ? 'merged' : 'unchanged', 'widened' => $added !== []];
        }
        $gid = $this->grants->insertGrant([
            'patient_id'     => $p->getId(),
            'specialist_id'  => $sid,
            'scope'          => 'selected',
            'source'         => $source,
            'surface'        => $surface,
            'duration'       => $d->value,
            'expires_at'     => $expires,
            'appointment_id' => $appointmentId,
            'request_id'     => $requestId,
            'client_key'     => $clientKey,
            'request_hash'   => $hash,
        ], $now);
        $this->grants->addDocuments($gid, $documentIds, $now);
        $this->recordGranted($gid, 'created', $now);

        return ['grant_id' => $gid, 'outcome' => 'created', 'widened' => true];
    }

    /** Audit `document_access.granted` + ledger `shared` for a new grant. */
    private function recordGranted(string $grantId, string $outcome, DateTimeImmutable $now): void
    {
        $row = $this->grants->row($grantId);
        if ($row === null) {
            return;
        }
        $selected = $row['scope'] === 'selected';
        $ids      = $selected ? ($this->grants->documentIdsFor([$grantId], Rules::MAX_DOCUMENTS)[strtolower($grantId)] ?? []) : [];
        $this->transitions->recordGrant($row, 'document_access.granted', 'shared', 'patient', $now, [
            'document_ids'    => $selected ? $ids : null,
            'document_count'  => $selected ? count($ids) : null,
            'source'          => (string) $row['source'],
            'surface'         => (string) $row['surface'],
            'consent_version' => (string) $row['consent_version'],
            'request_id'      => $row['request_id'] !== null ? (string) $row['request_id'] : null,
            'outcome'         => $outcome,
        ]);
    }

    /**
     * Audit `document_access.changed` + ledger `changed`.
     *
     * @param array<string,mixed> $extra previous_scope, added_ids, removed_ids, surface
     */
    private function recordChange(string $grantId, DateTimeImmutable $now, array $extra): void
    {
        $row = $this->grants->row($grantId);
        if ($row === null) {
            return;
        }
        $count = $row['scope'] === 'selected' ? ($this->grants->documentCounts([$grantId])[strtolower($grantId)] ?? 0) : null;
        $this->transitions->recordGrant($row, 'document_access.changed', 'changed', 'patient', $now, $extra + ['document_count' => $count]);
    }

    /**
     * Clear the pair's open hidden rows (only these documents, when given):
     * the documents show again through the folder share. Logged
     * `document_shown` per document; audited once (or per document).
     *
     * @param list<string>|null $documentIds
     * @return list<string> the documents cleared
     */
    private function showHidden(Patient $p, Specialist $s, ?array $documentIds, string $surface, ?string $grantId, DateTimeImmutable $now, bool $perDocumentAudit = false): array
    {
        $sid     = strtolower($s->getId());
        $cleared = $this->grants->clearHidden($p->getId(), $sid, $documentIds, $surface, $now);
        foreach ($cleared as $docId) {
            $this->log->append([
                'patient_id'    => $p->getId(),
                'specialist_id' => $sid,
                'document_id'   => $docId,
                'grant_id'      => $grantId,
                'event'         => 'document_shown',
                'actor_role'    => 'patient',
                'details'       => ['surface' => $surface],
            ], $now);
            if ($perDocumentAudit) {
                $this->auditPatient($p, $sid, 'document_access.document_shown', 'medical_document', $docId, ['surface' => $surface]);
            }
        }
        if ($cleared !== [] && !$perDocumentAudit) {
            $this->auditPatient($p, $sid, 'document_access.document_shown', 'specialist', $sid, ['surface' => $surface, 'document_count' => count($cleared)]);
        }

        return $cleared;
    }

    /** One share made with `answers_request_id` closes that request as answered (`shared_directly`). */
    private function answerRequest(Patient $p, string $sid, string $requestId, string $grantId, DateTimeImmutable $now): void
    {
        $row = $this->transitions->casRequest($requestId, 'approved', 'shared_directly', $now);
        if ($row === null || strtolower((string) $row['patient_id']) !== strtolower($p->getId()) || strtolower((string) $row['specialist_id']) !== $sid) {
            throw DomainRefusal::field('answers_request_id', 'This request is no longer waiting for an answer.');
        }
        $this->grants->setRequest($grantId, $requestId, $now);
        $this->transitions->recordRequestClosed($row, 'approved', 'shared_directly', 'patient', $now, [], $grantId);
    }

    /**
     * One ended grant of an Undo batch back as a new grant (or merged into the
     * pair's folder share); null when it can't come back.
     *
     * @param array<string,mixed> $old
     */
    private function restoreOne(Patient $p, array $old, string $batch, DateTimeImmutable $now): ?string
    {
        $sid = strtolower((string) $old['specialist_id']);
        $s   = $this->specialist($sid);
        if ($this->eligibilityProblem($p, $s) !== null) {
            return null;
        }
        \assert($s instanceof Specialist);
        $d = ShareDuration::tryFrom((string) $old['duration']);
        if ($d === null) {
            return null;
        }
        $appointmentId = $old['appointment_id'] !== null ? strtolower((string) $old['appointment_id']) : null;
        if ($d->isAnchored()) {
            $appt = $appointmentId !== null ? $this->em->find(Appointment::class, $appointmentId) : null;
            if (!$appt instanceof Appointment || !DocumentSharingPresenter::anchorValid($appt)) {
                return null;
            }
            $end = $d->expiryFrom($now, null, AppointmentLifecycle::endsAt($appt));
        } else {
            $end = Rules::fromSql($old['expires_at']);
        }
        if ($end !== null && $end <= $now) {
            return null;
        }

        if ($old['scope'] === 'all' && ($folder = $this->grants->activeFolderForPair($p->getId(), $sid)) !== null) {
            $gid     = strtolower((string) $folder['id']);
            $current = Rules::fromSql($folder['expires_at']);
            if ($current !== null && ($end === null || $end > $current)) {
                $this->transitions->changeGrantEnd($gid, $end, $d->value, true, 'patient', $now, ['surface' => 'restore'], $appointmentId, $d->isAnchored());
            }
        } else {
            $gid = $this->grants->insertGrant([
                'patient_id'             => $p->getId(),
                'specialist_id'          => $sid,
                'scope'                  => (string) $old['scope'],
                'source'                 => 'restore',
                'surface'                => 'restore',
                'duration'               => $d->value,
                'expires_at'             => $end,
                'original_expires_at'    => Rules::fromSql($old['original_expires_at']) ?? $end,
                'appointment_id'         => $appointmentId,
                'restored_from_grant_id' => strtolower((string) $old['id']),
            ], $now);
            if ($old['scope'] === 'selected') {
                $this->grants->addDocuments($gid, $this->grants->rawDocumentIds((string) $old['id']), $now);
            }
        }
        $row = $this->grants->row($gid);
        if ($row !== null) {
            $this->transitions->recordGrant($row, 'document_access.restored', 'restored', 'patient', $now, [
                'restored_from_grant_id' => strtolower((string) $old['id']),
                'revoke_batch_id'        => $batch,
            ]);
        }

        return $gid;
    }

    /**
     * End every active grant of these pairs under one revoke batch (Undo).
     *
     * @param list<string> $specialistIds
     * @return array{revoked: list<array<string,mixed>>, revoke_batch_id: ?string, restorable_until: ?string}
     */
    private function revokeBatch(Patient $p, array $specialistIds, DateTimeImmutable $now): array
    {
        $batch = Uuid::uuid4()->toString();
        $ended = $this->inPairs($p, $specialistIds, function () use ($p, $specialistIds, $batch, $now): array {
            $ids = [];
            foreach (array_unique(array_map('strtolower', $specialistIds)) as $sid) {
                foreach ($this->grants->activeRowsForPair($p->getId(), $sid) as $g) {
                    if ($this->transitions->endGrant((string) $g['id'], 'revoked', 'patient', $now, $batch)) {
                        $ids[] = strtolower((string) $g['id']);
                    }
                }
            }

            return $ids;
        }, $now);

        return [
            'revoked'          => $this->views->grantDtosByIds($p, $ended, $now),
            'revoke_batch_id'  => $ended !== [] ? $batch : null,
            'restorable_until' => $ended !== [] ? Rules::iso($now->modify('+' . Rules::RESTORE_MINUTES . ' minutes')) : null,
        ];
    }

    /**
     * A repeat of one share submission (same `client_key`, from its
     * `document_access_submissions` record): the same choices within 24 hours
     * → 200 with those grants' current state and the outcomes it first
     * answered; otherwise 409 `idempotency_conflict`.
     *
     * @param array<string,mixed> $n
     * @param array<string,mixed> $submission {@see DocumentAccessGrantRepository::submission()}
     */
    private function replay(Patient $p, array $n, array $submission, DateTimeImmutable $now): array
    {
        $created = Rules::fromSql($submission['created_at']);
        if (trim((string) $submission['request_hash']) !== $n['hash'] || $created === null || $created < $now->modify('-' . Rules::REPLAY_HOURS . ' hours')) {
            throw DomainRefusal::code(409, 'idempotency_conflict', 'Something changed. Check your choices and try again.');
        }

        return [
            'grants'               => $this->views->grantDtosByIds($p, array_map('strval', $submission['grant_ids']), $now),
            'outcomes'             => array_map(static fn (array $o): array => [
                'specialist_id' => strtolower((string) ($o['specialist_id'] ?? '')),
                'grant_id'      => strtolower((string) ($o['grant_id'] ?? '')),
                'outcome'       => (string) ($o['outcome'] ?? 'created'),
            ], array_values(array_filter($submission['outcomes'], 'is_array'))),
            'approved_request_ids' => array_values(array_map(static fn ($id): string => strtolower((string) $id), $submission['approved_request_ids'])),
            'replayed'             => true,
        ];
    }

    /**
     * Normalise and validate a share (fail fast, before any lock).
     * `$replaying`: this client key already went through — only what the
     * request hash needs is checked; the request it answered may be closed by
     * now and its doctors' standing is not re-checked (the retry is answered
     * from the record, or refused as a different submission).
     *
     * @param array<string,mixed> $input
     * @return array<string,mixed>
     */
    private function normaliseShare(Patient $p, array $input, DateTimeImmutable $now, bool $replaying = false): array
    {
        $errors = [];
        [$sids, $e] = Rules::uuidList($input['specialist_ids'] ?? null, 'specialist_ids', Rules::MAX_DOCTORS, 'You can share with up to ' . Rules::MAX_DOCTORS . ' doctors at a time.', 'Choose a doctor');
        $errors += $e;
        if ($sids === [] && $e === []) {
            $errors['specialist_ids'] = 'Choose at least one doctor.';
        }
        [$choice, $e] = $this->parseChoice($p, $input, $sids, $now, null);
        $errors += $e;

        $clientKey = Rules::lowerUuid($input['client_key'] ?? null);
        if ($clientKey === null) {
            $errors['client_key'] = 'Send a client key';
        }
        $answers           = null;
        $answersSpecialist = null;
        if (($input['answers_request_id'] ?? null) !== null && $input['answers_request_id'] !== '') {
            $answers = Rules::lowerUuid($input['answers_request_id']);
            $req     = $answers !== null ? $this->requests->rowForPatient($answers, $p->getId()) : null;
            $closed  = $req !== null && ($req['status'] !== 'pending' || Rules::fromSql($req['expires_at']) <= $now);
            if ($req === null || ($closed && !$replaying) || !in_array(strtolower((string) $req['specialist_id']), $sids, true)) {
                $errors['answers_request_id'] = 'This request is no longer waiting for an answer.';
            } else {
                $answersSpecialist = strtolower((string) $req['specialist_id']);
            }
        }
        [$show, $e] = Rules::uuidList($input['show_hidden_for_specialist_ids'] ?? null, 'show_hidden_for_specialist_ids', Rules::MAX_DOCTORS, 'Choose up to ' . Rules::MAX_DOCTORS . ' doctors.', 'Choose a doctor');
        $errors += $e;
        if (array_diff($show, $sids) !== []) {
            $errors['show_hidden_for_specialist_ids'] = 'Choose doctors you are sharing with.';
        }
        $surface = is_string($input['surface'] ?? null) && $input['surface'] !== '' ? (string) $input['surface'] : 'manage_sharing';
        if (!in_array($surface, Rules::SURFACES, true)) {
            $errors['surface'] = 'Unknown sharing surface';
        }
        if ($errors !== []) {
            throw self::invalid($errors);
        }
        if (!$replaying) {
            foreach ($sids as $sid) {
                $this->assertEligible($p, $this->specialist($sid));
            }
        }
        $show = $choice['scope'] === 'all' ? $show : [];

        return $choice + [
            'specialist_ids'     => $sids,
            'client_key'         => $clientKey,
            'answers_request_id' => $answers,
            'answers_specialist' => $answersSpecialist,
            'show_hidden'        => $show,
            'surface'            => $surface,
            'hash'               => Rules::requestHash([
                'specialist_ids'                 => $sids,
                'scope'                          => $choice['scope'],
                'document_ids'                   => $choice['document_ids'],
                'duration'                       => $choice['duration']->value,
                'expires_at'                     => Rules::iso($choice['until']),
                'appointment_id'                 => $choice['appointment'] !== null ? strtolower($choice['appointment']->getId()) : null,
                'answers_request_id'             => $answers,
                'show_hidden_for_specialist_ids' => $show,
            ]),
        ];
    }

    /**
     * What and how long (share and approve): scope, documents, duration, the
     * `until` end and the consultation (validated whenever present; required
     * for `after_*`; `$defaultAppointmentId` stands in when none is sent).
     *
     * @param array<string,mixed> $input
     * @param list<string>        $sids
     * @return array{0: array{scope:string, document_ids:list<string>, duration:ShareDuration, until:?DateTimeImmutable, appointment:?Appointment}, 1: array<string,string>}
     */
    private function parseChoice(Patient $p, array $input, array $sids, DateTimeImmutable $now, ?string $defaultAppointmentId): array
    {
        $errors = [];
        $scope  = $input['scope'] ?? null;
        if (!in_array($scope, ['all', 'selected'], true)) {
            $errors['scope'] = 'Choose what they can see.';
            $scope           = 'all';
        }
        $docIds = [];
        if ($scope === 'selected') {
            [$docIds, $e] = $this->ownDocumentList($p, $input['document_ids'] ?? null, 'document_ids', Rules::MAX_DOCUMENTS);
            $errors += $e;
            if ($docIds === [] && $e === []) {
                $errors['document_ids'] = 'Choose at least one document.';
                $errors['code']         = 'nothing_selected';
            }
        }
        $duration = ShareDuration::tryFrom((string) ($input['duration'] ?? ''));
        $until    = null;
        $appt     = null;
        if ($duration === null) {
            $errors['duration'] = 'Choose how long they can see them.';
            $duration           = ShareDuration::D7;
        } else {
            if ($duration === ShareDuration::UNTIL) {
                $parsed = Rules::parseUntil((string) ($input['expires_at'] ?? ''), $now);
                if (is_string($parsed)) {
                    $errors['expires_at'] = $parsed;
                } else {
                    $until = $parsed;
                }
            }
            [$appt, $apptError] = $this->appointmentChoice($p, $input['appointment_id'] ?? null, $sids, $duration->isAnchored() ? $defaultAppointmentId : null);
            if ($apptError !== null) {
                $errors['appointment_id'] = $apptError;
            } elseif (($problem = $this->durationProblem($duration, $appt, $sids, $p, $now)) !== null) {
                $errors[$problem[0]] = $problem[1];
            }
        }

        return [['scope' => (string) $scope, 'document_ids' => $docIds, 'duration' => $duration, 'until' => $until, 'appointment' => $appt], $errors];
    }

    /**
     * The consultation a share names (validated whenever present): the
     * patient's, with one of the chosen doctors, not deleted, not a proposal.
     *
     * @param list<string> $sids
     * @return array{0: ?Appointment, 1: ?string} the appointment, or the error
     */
    private function appointmentChoice(Patient $p, mixed $raw, array $sids, ?string $default): array
    {
        $raw = $raw === null || $raw === '' ? $default : $raw;
        if ($raw === null) {
            return [null, null];
        }
        $id   = Rules::lowerUuid($raw);
        $appt = $id !== null ? $this->em->find(Appointment::class, $id) : null;
        if (
            !$appt instanceof Appointment
            || strtolower($appt->getPatient()->getId()) !== strtolower($p->getId())
            || !in_array(strtolower($appt->getSpecialist()->getId()), $sids, true)
            || $appt->isDeleted()
            || $appt->getStatus() === AppointmentStatus::PROPOSED
        ) {
            return [null, 'This consultation could not be found.'];
        }

        return [$appt, null];
    }

    /**
     * Why an `after_*` duration can't be used (field + message), else null.
     *
     * @param list<string> $sids
     * @return array{0:string, 1:string}|null
     */
    private function durationProblem(ShareDuration $d, ?Appointment $appt, array $sids, Patient $p, DateTimeImmutable $now): ?array
    {
        if (!$d->isAnchored()) {
            return null;
        }
        if ($appt === null) {
            return ['appointment_id', 'Choose the consultation to share until after.'];
        }
        if (count($sids) > 1) {
            return ['duration', 'Sharing until after a consultation works with one doctor at a time. Choose another duration.'];
        }
        $options = Rules::afterOptions($appt, $p->getId(), $appt->getSpecialist()->getId(), $now);
        if (($options[$d->value] ?? null) === null) {
            return ['duration', 'That option is no longer available for this consultation. Choose another duration.'];
        }

        return null;
    }

    /** The exclusive end of a share made now (an `after_*` one re-checked against its consultation). */
    private function expiryFor(ShareDuration $d, ?DateTimeImmutable $until, ?Appointment $appt, Patient $p, string $sid, DateTimeImmutable $now): ?DateTimeImmutable
    {
        if ($d->isAnchored()) {
            if ($appt === null || (Rules::afterOptions($appt, $p->getId(), $sid, $now)[$d->value] ?? null) === null) {
                throw DomainRefusal::field('duration', 'That option is no longer available for this consultation. Choose another duration.');
            }

            return $d->expiryFrom($now, null, AppointmentLifecycle::endsAt($appt));
        }

        return $d->expiryFrom($now, $until, null);
    }

    /**
     * The patient's own documents from a list (errors `field.N` on the
     * position the client sent), de-duplicated.
     *
     * @return array{0: list<string>, 1: array<string,string>}
     */
    private function ownDocumentList(Patient $p, mixed $raw, string $field, int $max): array
    {
        if ($raw === null || $raw === '' || $raw === []) {
            return [[], []];
        }
        if (!is_array($raw)) {
            return [[], [$field => 'Send a list of documents']];
        }
        $raw = array_values($raw);
        if (count($raw) > $max) {
            return [[], [$field => 'You can choose up to ' . $max . ' documents at a time.']];
        }
        $ids = [];
        foreach ($raw as $value) {
            $id = Rules::lowerUuid($value);
            if ($id !== null) {
                $ids[] = $id;
            }
        }
        $owned  = $this->documents->byIdsForPatient($p->getId(), array_values(array_unique($ids)));
        $errors = [];
        $out    = [];
        foreach ($raw as $i => $value) {
            $id = Rules::lowerUuid($value);
            if ($id === null || !isset($owned[$id])) {
                $errors["$field.$i"] = 'One of these documents could not be found.';
                continue;
            }
            if (!in_array($id, $out, true)) {
                $out[] = $id;
            }
        }

        return [$out, $errors];
    }

    /** @return array<string,mixed> facts for {@see AccessRequestRules} */
    private function requestFacts(Specialist $s, Appointment $a, DateTimeImmutable $now): array
    {
        $p      = $a->getPatient();
        $sid    = strtolower($s->getId());
        $folder = null;
        foreach ($this->policy->activeGrantRows($p->getId(), $sid, $now) as $g) {
            if ($g['scope'] === 'all') {
                $folder = $g;
                break;
            }
        }

        return [
            'appointment'      => [
                'status'  => $a->getStatus()->value,
                'deleted' => $a->isDeleted() || strtolower($a->getSpecialist()->getId()) !== $sid,
                'ends_at' => AppointmentLifecycle::endsAt($a),
            ],
            'practising'       => $this->policy->isPractising($s),
            'pending'          => $this->requests->pendingForPair($p->getId(), $sid, $now) !== null,
            'blocked'          => $this->grants->hasOpenBlock($p->getId(), $sid),
            'has_folder'       => $folder !== null,
            'folder_ends_at'   => $folder !== null ? Rules::fromSql($folder['expires_at']) : null,
            'last_declined_at' => $this->requests->lastDeclinedAt($p->getId(), $sid),
            'pair_requests'    => $this->requests->pairRequestTimes($p->getId(), $sid, $now->modify('-30 days')),
            'doctor_requests'  => $this->requests->doctorRequestTimes($sid, $now->modify('-24 hours')),
        ];
    }

    /** @param array{code:string, available_at:?DateTimeImmutable} $check */
    private function requestRefusal(array $check, Patient $p, string $sid, DateTimeImmutable $now): DomainRefusal
    {
        $code = $check['code'];
        [$status, $message] = match ($code) {
            'appointment_not_eligible' => [422, 'You can ask for access from an upcoming consultation or one in the last 30 days.'],
            'doctor_unavailable'       => [422, "You can't ask for documents while your account isn't active."],
            'request_pending'          => [409, "You've already asked this patient. Wait for their answer."],
            'request_blocked'          => [409, "You can't ask this patient right now."],
            'has_full_access'          => [409, 'The patient already shares all their documents with you.'],
            'request_cooldown'         => [409, 'The patient declined your last request. You can ask again later.'],
            default                    => [409, "You've reached the limit of access requests for now."],
        };
        $extra = [];
        if ($check['available_at'] !== null) {
            $extra['available_at'] = Rules::iso($check['available_at']);
        }
        if ($code === 'request_pending') {
            $pending = $this->requests->pendingForPair($p->getId(), $sid, $now);
            if ($pending !== null) {
                $extra['request'] = DocumentSharingPresenter::doctorRequest($pending, $now);
            }
        }

        return DomainRefusal::code($status, $code, $message, $extra);
    }

    /** The patient's request, or 404. @return array<string,mixed> */
    private function requestRow(Patient $p, string $requestId): array
    {
        $id = Rules::lowerUuid($requestId) ?? throw DomainRefusal::notFound('This request could not be found.');

        return $this->requests->rowForPatient($id, $p->getId()) ?? throw DomainRefusal::notFound('This request could not be found.');
    }

    /** The patient's own document, or 404 (unknown and foreign ids read the same). */
    private function ownDocument(Patient $p, string $documentId): MedicalDocument
    {
        $id = Rules::lowerUuid($documentId) ?? throw DomainRefusal::notFound('This document could not be found.');

        return $this->documents->findForPatient($id, $p->getId()) ?? throw DomainRefusal::notFound('This document could not be found.');
    }

    /** A doctor the patient has booked (practising or not), or 404. */
    private function bookedDoctorId(Patient $p, string $specialistId): string
    {
        $sid = Rules::lowerUuid($specialistId);
        if ($sid === null || !$this->policy->isBooked($p->getId(), $sid)) {
            throw DomainRefusal::notFound('This doctor could not be found.');
        }

        return $sid;
    }

    private function specialist(string $id): ?Specialist
    {
        $s = $this->em->find(Specialist::class, strtolower($id));

        return $s instanceof Specialist ? $s : null;
    }

    /** Booked and practising, else the refusal (422 doctor_not_eligible / doctor_unavailable). */
    private function eligibilityProblem(Patient $p, ?Specialist $s, string $field = 'specialist_ids'): ?DomainRefusal
    {
        if ($s !== null && $this->em->contains($s)) {
            // Re-read the doctor's standing: inside the pair locks it must be what
            // the database says NOW, not what this request loaded earlier.
            $this->em->refresh($s);
        }
        if ($s === null || !$this->policy->isBooked($p->getId(), $s->getId())) {
            $m = "You can share with doctors you've booked.";

            return new DomainRefusal(422, $m, [$field => $m, 'code' => 'doctor_not_eligible']);
        }
        if (!$this->policy->isPractising($s)) {
            $m = "This doctor isn't practising on VideoMed right now.";

            return new DomainRefusal(422, $m, [$field => $m, 'code' => 'doctor_unavailable']);
        }

        return null;
    }

    private function assertEligible(Patient $p, ?Specialist $s, string $field = 'specialist_ids'): void
    {
        $problem = $this->eligibilityProblem($p, $s, $field);
        if ($problem !== null) {
            throw $problem;
        }
    }

    private function requireEnabled(): void
    {
        if (!Rules::enabled()) {
            throw DomainRefusal::unavailable();
        }
    }

    /**
     * The consultation a doctor notice links to: the share's / request's own,
     * else the pair's next open one, else the latest.
     */
    private function doctorLinkAppointment(string $patientId, string $specialistId, ?string $appointmentId, DateTimeImmutable $now): ?string
    {
        if ($appointmentId !== null) {
            return strtolower($appointmentId);
        }
        $conn = $this->em->getConnection();
        $next = $conn->fetchOne(
            "SELECT id FROM appointments WHERE patient_id = :p AND specialist_id = :s AND deleted_at IS NULL
                AND status IN ('pending', 'confirmed', 'rescheduled') AND scheduled_at > :now
              ORDER BY scheduled_at ASC LIMIT 1",
            ['p' => strtolower($patientId), 's' => strtolower($specialistId), 'now' => Rules::sql($now)],
        );
        if ($next !== false) {
            return strtolower((string) $next);
        }
        $latest = $conn->fetchOne(
            "SELECT id FROM appointments WHERE patient_id = :p AND specialist_id = :s AND deleted_at IS NULL AND status <> 'proposed'
              ORDER BY scheduled_at DESC LIMIT 1",
            ['p' => strtolower($patientId), 's' => strtolower($specialistId)],
        );

        return $latest !== false ? strtolower((string) $latest) : null;
    }

    private function patientName(Patient $p, string $sid): string
    {
        return $this->transitions->names($p->getId(), $sid)['patient'];
    }

    /** @param array<string,mixed> $meta */
    private function auditPatient(Patient $p, string $sid, string $action, string $resourceType, string $resourceId, array $meta): void
    {
        $names = $this->transitions->names($p->getId(), $sid);
        $this->audit->record($names['patient'], 'patient', $action, null, $resourceType, $resourceId, [
            'patient_id'    => strtolower($p->getId()),
            'patient_name'  => $names['patient'],
            'specialist_id' => strtolower($sid),
            'doctor'        => $names['doctor'],
        ] + $meta, strtolower($p->getId()));
    }

    /** 409 `request_not_pending` with the request's fresh status. @param array<string,mixed>|null $row */
    private static function notPending(?array $row, DateTimeImmutable $now): DomainRefusal
    {
        $status  = $row !== null ? DocumentSharingPresenter::requestStatus($row, $now) : 'expired';
        $message = match ($status) {
            'approved'  => "You've already approved this request.",
            'declined'  => 'You declined this request.',
            'cancelled' => 'The doctor withdrew this request.',
            default     => 'This request closed without an answer. Nothing was shared.',
        };

        return DomainRefusal::code(409, 'request_not_pending', $message, ['status' => $status]);
    }

    private static function grantEnded(): DomainRefusal
    {
        return DomainRefusal::code(409, 'grant_ended', 'This access already ended. Share again to give access.');
    }

    private static function restoreExpired(): DomainRefusal
    {
        return DomainRefusal::code(409, 'restore_expired', 'Undo is no longer available. Share again to give access.');
    }

    /** A 422 whose message is the first field error. @param array<string,string> $errors */
    private static function invalid(array $errors): DomainRefusal
    {
        $first = 'Validation failed';
        foreach ($errors as $key => $value) {
            if ($key !== 'code') {
                $first = $value;
                break;
            }
        }

        return DomainRefusal::validation($errors, $first);
    }
}
