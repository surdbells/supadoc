<?php

declare(strict_types=1);

namespace App\Infrastructure\Document;

use App\Domain\Appointment\AppointmentLifecycle;
use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Document\ShareDuration;
use App\Domain\Entity\Appointment;
use App\Domain\Entity\MedicalDocument;
use App\Domain\Entity\Specialist;
use App\Domain\Enum\AppointmentStatus;
use DateTimeImmutable;

/**
 * The wire shapes of document sharing — each method emits EXACTLY the keys of
 * one DTO of the TypeScript contract (`libs/shared/models/src/lib/document-sharing.ts`,
 * spec §8.2); DtoShapeTest asserts every key set. Pure: callers pass the rows
 * and entities they already read. Doctor shapes are explicit allowlists and
 * never carry the patient-side extras (`shared_with`, other doctors, hidden rows).
 */
final class DocumentSharingPresenter
{
    /** SharingDoctorRefDto */
    public static function doctorRef(Specialist $s): array
    {
        return [
            'id'        => strtolower($s->getId()),
            'name'      => $s->getName(),
            'specialty' => $s->getSpecialty() !== '' ? $s->getSpecialty() : null,
            'photo_url' => $s->getPhotoUrl(),
        ];
    }

    /** SharingAppointmentRefDto (with the pair's `after_options`). */
    public static function appointmentRef(Appointment $a, string $patientId, string $specialistId, DateTimeImmutable $now): array
    {
        return [
            'id'            => strtolower($a->getId()),
            'scheduled_at'  => $a->getScheduledAt()->format(DATE_ATOM),
            'ends_at'       => AppointmentLifecycle::endsAt($a)->format(DATE_ATOM),
            'after_options' => Rules::afterOptions($a, $patientId, $specialistId, $now),
        ];
    }

    /** Whether a consultation an `after_*` share is anchored to keeps it alive (not cancelled, not deleted). */
    public static function anchorValid(?Appointment $a): bool
    {
        return $a !== null && !$a->isDeleted() && $a->getStatus() !== AppointmentStatus::CANCELLED;
    }

    /**
     * DocumentGrantDto. `$effective`: the grant gives access now (stored active,
     * in window, anchor valid, pair booked — {@see DocumentAccessPolicy::activeGrantRows()});
     * a stored-active grant that doesn't reads as expired.
     *
     * @param array<string,mixed> $row grant columns
     * @param list<string>        $documentIds
     */
    public static function grant(
        array $row,
        array $doctorRef,
        ?array $appointmentRef,
        array $documentIds,
        int $documentCount,
        bool $effective,
        bool $practising,
        DateTimeImmutable $now,
    ): array {
        $expires = Rules::fromSql($row['expires_at']);
        $stored  = (string) $row['status'];
        $endedAt = Rules::fromSql($row['ended_at']);
        $reason  = $row['end_reason'] !== null ? (string) $row['end_reason'] : null;
        $endedBy = $row['ended_by'] !== null ? (string) $row['ended_by'] : null;

        if ($stored === 'active' && $effective) {
            $status = $practising ? 'active' : 'paused';
        } elseif ($stored === 'active') {
            // Past its end (or its consultation went) before the sweeper recorded it.
            $status  = 'expired';
            $past    = $expires !== null && $expires <= $now;
            $endedAt = $past ? $expires : null;
            $reason  = $past ? 'expired' : (ShareDuration::tryFrom((string) $row['duration'])?->isAnchored() ? 'appointment_cancelled' : 'expired');
            $endedBy = 'system';
        } else {
            $status = $stored === 'revoked' ? 'revoked' : 'expired';
        }

        $restorable = null;
        if ($stored !== 'active' && $reason === 'revoked' && $endedBy === 'patient'
            && $row['revoke_batch_id'] !== null && $row['restored_at'] === null && $endedAt !== null) {
            $until      = $endedAt->modify('+' . Rules::RESTORE_MINUTES . ' minutes');
            $restorable = $until > $now ? Rules::iso($until) : null;
        }
        $scope = (string) $row['scope'];

        return [
            'id'               => strtolower((string) $row['id']),
            'specialist'       => $doctorRef,
            'scope'            => $scope,
            'status'           => $status,
            'source'           => (string) $row['source'],
            'surface'          => (string) $row['surface'],
            'duration'         => (string) $row['duration'],
            'starts_at'        => Rules::iso(Rules::fromSql($row['starts_at'])),
            'expires_at'       => Rules::iso($expires),
            'until_label_at'   => Rules::iso(Rules::untilLabelAt($expires, (string) $row['duration'])),
            'ended_at'         => Rules::iso($endedAt),
            'end_reason'       => $reason,
            'ended_by'         => $endedBy,
            'document_ids'     => $scope === 'selected' ? array_values(array_slice($documentIds, 0, Rules::GRANT_DOCUMENT_IDS_MAX)) : [],
            'document_count'   => $documentCount,
            'appointment'      => $appointmentRef,
            'request_id'       => $row['request_id'] !== null ? strtolower((string) $row['request_id']) : null,
            'revoke_batch_id'  => $row['revoke_batch_id'] !== null ? strtolower((string) $row['revoke_batch_id']) : null,
            'restorable_until' => $restorable,
            'last_accessed_at' => Rules::iso(Rules::fromSql($row['last_accessed_at'])),
            'access_count'     => (int) $row['access_count'],
            'created_at'       => Rules::iso(Rules::fromSql($row['created_at'])),
        ];
    }

    /** The status a request reads as now: a pending one past its close is expired. */
    public static function requestStatus(array $row, DateTimeImmutable $now): string
    {
        $status = (string) $row['status'];
        $close  = Rules::fromSql($row['expires_at']);

        return $status === 'pending' && $close !== null && $close <= $now ? 'expired' : $status;
    }

    /**
     * DocumentAccessRequestSuggestionDto — what one-tap Approve shares (spec §6.10):
     * an extension → the whole folder; otherwise the files attached for the
     * request's consultation, or nothing sensible (scope null: the patient
     * chooses). Until 7 days after that consultation when it can, else 7 days.
     *
     * @param list<string> $attachmentIds
     */
    public static function suggestion(string $kind, ?array $appointmentRef, array $attachmentIds): array
    {
        $after7d = $appointmentRef !== null && ($appointmentRef['after_options']['after_7d'] ?? null) !== null;
        $scope   = $kind === 'extend' ? 'all' : ($attachmentIds !== [] ? 'selected' : null);

        return [
            'scope'          => $scope,
            'document_ids'   => $scope === 'selected' ? array_values(array_slice($attachmentIds, 0, Rules::MAX_DOCUMENTS)) : [],
            'duration'       => $after7d ? ShareDuration::AFTER_7D->value : ShareDuration::D7->value,
            'appointment_id' => $appointmentRef !== null ? $appointmentRef['id'] : null,
        ];
    }

    /** DocumentAccessRequestDto (patient). `$appointmentRef` null when that consultation was cancelled or deleted. */
    public static function request(array $row, array $doctorRef, ?array $appointmentRef, ?string $grantId, array $suggestion, DateTimeImmutable $now): array
    {
        return [
            'id'          => strtolower((string) $row['id']),
            'specialist'  => $doctorRef,
            'appointment' => $appointmentRef,
            'kind'        => (string) $row['kind'],
            'status'      => self::requestStatus($row, $now),
            'message'     => $row['message'] !== null && (string) $row['message'] !== '' ? (string) $row['message'] : null,
            'created_at'  => Rules::iso(Rules::fromSql($row['created_at'])),
            'expires_at'  => Rules::iso(Rules::fromSql($row['expires_at'])),
            'decided_at'  => Rules::iso(Rules::fromSql($row['decided_at'])),
            'grant_id'    => $grantId,
            'suggestion'  => $suggestion,
        ];
    }

    /** DoctorAccessRequestDto — the doctor's own request (their consultation only). */
    public static function doctorRequest(array $row, DateTimeImmutable $now): array
    {
        return [
            'id'             => strtolower((string) $row['id']),
            'kind'           => (string) $row['kind'],
            'status'         => self::requestStatus($row, $now),
            'message'        => $row['message'] !== null && (string) $row['message'] !== '' ? (string) $row['message'] : null,
            'appointment_id' => $row['appointment_id'] !== null ? strtolower((string) $row['appointment_id']) : null,
            'created_at'     => Rules::iso(Rules::fromSql($row['created_at'])),
            'expires_at'     => Rules::iso(Rules::fromSql($row['expires_at'])),
            'decided_at'     => Rules::iso(Rules::fromSql($row['decided_at'])),
        ];
    }

    /** DocumentSharedWithDto — one doctor who can see a document (patient view). */
    public static function sharedWith(VisibleDocument $v, string $specialistId, string $name, bool $paused): array
    {
        return [
            'specialist_id'  => strtolower($specialistId),
            'name'           => $name,
            'via'            => $v->via,
            'until'          => Rules::iso($v->until),
            'until_label_at' => Rules::iso($v->untilLabelAt),
            'indefinite'     => $v->indefinite,
            'paused'         => $paused,
        ];
    }

    /**
     * DoctorAccessSummaryDto — a patient's view of what one doctor can see now.
     *
     * @param list<array<string,mixed>> $grants the doctor's effective active grants
     * @param list<string>              $hiddenIds open hidden documents of the pair
     */
    public static function accessSummary(array $grants, int $visibleCount, bool $practising, array $hiddenIds): array
    {
        $ends   = DocumentAccessPolicy::ends($grants);
        $folder = null;
        $viewed = null;
        foreach ($grants as $g) {
            if ($g['scope'] === 'all' && $folder === null) {
                $folder = $g;
            }
            $seen = Rules::fromSql($g['last_accessed_at'] ?? null);
            if ($seen !== null && ($viewed === null || $seen > $viewed)) {
                $viewed = $seen;
            }
        }
        $folderEnd = $folder !== null ? Rules::fromSql($folder['expires_at']) : null;

        return [
            'state'                 => $grants === [] ? 'none' : ($practising ? 'active' : 'paused'),
            'scope'                 => $grants === [] ? null : ($folder !== null ? 'all' : 'selected'),
            'document_count'        => $grants === [] ? 0 : $visibleCount,
            'until'                 => Rules::iso($ends['until']),
            'until_label_at'        => Rules::iso($ends['until_label_at']),
            'indefinite'            => $ends['indefinite'],
            'folder_until_label_at' => $folder !== null ? Rules::iso(Rules::untilLabelAt($folderEnd, (string) $folder['duration'])) : null,
            'folder_indefinite'     => $folder !== null && $folderEnd === null,
            'next_change_at'        => Rules::iso($ends['next_change_at']),
            'last_viewed_at'        => Rules::iso($viewed),
            'active_grant_ids'      => array_values(array_map(static fn (array $g): string => strtolower((string) $g['id']), $grants)),
            'hidden_count'          => count($hiddenIds),
            'hidden_document_ids'   => array_values(array_slice($hiddenIds, 0, Rules::HIDDEN_IDS_MAX)),
        ];
    }

    /**
     * DocumentAccessEventDto. `$row` from the ledger with `title` joined from
     * the patient's own documents only.
     *
     * @param array<string,mixed> $row
     */
    public static function event(array $row, ?array $doctorRef): array
    {
        $raw     = is_string($row['details'] ?? null) ? json_decode((string) $row['details'], true) : ($row['details'] ?? null);
        $raw     = is_array($raw) ? $raw : [];
        $details = [];
        foreach (['scope', 'duration', 'expires_at', 'document_count', 'end_reason', 'capped'] as $key) {
            if (array_key_exists($key, $raw) && $raw[$key] !== null) {
                $details[$key] = $raw[$key];
            }
        }
        if (array_key_exists('expires_at', $details) && isset($details['duration'])) {
            $exp                       = is_string($details['expires_at']) ? new DateTimeImmutable($details['expires_at']) : null;
            $details['until_label_at'] = Rules::iso(Rules::untilLabelAt($exp, (string) $details['duration']));
        }
        $documentId = $row['document_id'] !== null ? strtolower((string) $row['document_id']) : null;

        return [
            'id'         => strtolower((string) $row['id']),
            'event'      => (string) $row['event'],
            'actor'      => (string) $row['actor_role'],
            'specialist' => $doctorRef,
            'document'   => $documentId !== null ? ['id' => $documentId, 'title' => isset($row['title']) && $row['title'] !== null ? (string) $row['title'] : null] : null,
            'grant_id'   => $row['grant_id'] !== null ? strtolower((string) $row['grant_id']) : null,
            'request_id' => $row['request_id'] !== null ? strtolower((string) $row['request_id']) : null,
            'details'    => $details !== [] ? $details : null,
            'created_at' => Rules::iso(Rules::fromSql($row['created_at'])),
        ];
    }

    /** PatientVisibleDocumentDto — what this doctor can see, from the patient's side. */
    public static function patientVisibleDocument(VisibleDocument $v): array
    {
        return $v->document->toArray() + [
            'via'            => $v->via,
            'until'          => Rules::iso($v->until),
            'until_label_at' => Rules::iso($v->untilLabelAt),
            'indefinite'     => $v->indefinite,
        ];
    }

    /**
     * DoctorSharedDocumentDto — the allowlist ({@see MedicalDocument::toDoctorArray()})
     * plus how and until when it is shared. Never `shared_with`.
     *
     * @param list<string> $ownAppointmentIds
     */
    public static function doctorSharedDocument(VisibleDocument $v, string $specialistId, array $ownAppointmentIds): array
    {
        return $v->document->toDoctorArray($specialistId, $ownAppointmentIds) + [
            'via'                   => $v->via,
            'shared_until'          => Rules::iso($v->until),
            'shared_until_label_at' => Rules::iso($v->untilLabelAt),
            'shared_indefinitely'   => $v->indefinite,
            'shared_at'             => Rules::iso($v->sharedAt),
        ];
    }

    /**
     * UploadedDocumentDto (POST /portal/documents; the booking-attachment
     * upload adds its `url`).
     *
     * @param list<array<string,mixed>> $sharedWith
     * @param list<string>              $endedFor
     */
    public static function uploaded(MedicalDocument $doc, array $sharedWith, string $outcome, array $endedFor): array
    {
        return $doc->toArray() + [
            'shared_with'     => $sharedWith,
            'share_outcome'   => $outcome,
            'share_ended_for' => array_values($endedFor),
        ];
    }
}
