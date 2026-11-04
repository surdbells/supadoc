<?php

declare(strict_types=1);

namespace App\Infrastructure\Lab;

use App\Domain\Document\DocumentSharingRules;
use App\Domain\Document\DocumentType;
use App\Domain\Entity\LabRequest;
use App\Domain\Entity\LabRequestEvent;
use App\Domain\Entity\LabRequestItem;
use App\Domain\Entity\LabRequestResult;
use App\Domain\Entity\MedicalDocument;
use App\Domain\Lab\LabCatalogue;
use App\Domain\Lab\LabRequestRules;
use App\Domain\Lab\LabRequestTransitions;
use App\Domain\Settings\ClinicTime;
use App\Infrastructure\Document\VisibleDocument;
use DateTimeImmutable;

/**
 * The lab request DTOs (spec §2.2, §2.3, §2.5; keys = Wave 0's
 * lab-request-keys.fixture.json) — explicit allowlists, pure.
 *
 *  - Doctor: what a result file is comes ONLY from {@see VisibleDocument}s the
 *    access policy returned for this doctor and patient.
 *  - Patient: never the review outcome, `abnormal`, the clinical flags,
 *    history, medication, allergies or the imaging screen (they are on the
 *    PDF, which the patient is told about before accepting).
 *  - Nobody but `labs.manage` staff ever gets a correction's `staff_note`.
 *
 * Instants are DATE_ATOM; `valid_until` / `lab_date` / `sample_date` are
 * 'Y-m-d' calendar dates.
 */
final class LabRequestPresenter
{
    // ----- doctor -----

    /** LabRequestSummaryDto. `$unreviewed`: the REVIEWABLE unreviewed results (computed by the caller). */
    public static function doctorSummary(LabRequest $r, DateTimeImmutable $now, int $unreviewed): array
    {
        $snapshot = $r->getPatientSnapshot();
        $byKind   = $r->itemsByKind();

        return [
            'id'                => $r->getId(),
            'number'            => $r->getNumber(),
            'status'            => $r->effectiveStatus($now),
            'priority'          => $r->getPriority(),
            'appointment_id'    => $r->getAppointmentId(),
            'patient'           => [
                'id'   => $r->getPatientId(),
                'name' => (string) ($snapshot['name'] ?? ''),
                'age'  => self::age($snapshot),
                'sex'  => self::nullable($snapshot['sex'] ?? null),
            ],
            'clinical_question' => $r->getClinicalQuestion(),
            'tests_label'       => $r->testsLabel(),
            'items_count'       => count($r->getItems()),
            'counts'            => ['lab' => count($byKind['lab']), 'imaging' => count($byKind['imaging']), 'physiological' => count($byKind['physiological'])],
            'results_count'     => $r->getResultsCount(),
            'unreviewed_count'  => $unreviewed,
            'abnormal'          => $r->isAbnormal(),
            'sent_at'           => self::iso($r->getSentAt()),
            'valid_until'       => $r->getValidUntil()->format('Y-m-d'),
            'expires_at'        => self::iso($r->getExpiresAt()),
            'last_activity_at'  => self::iso($r->getLastActivityAt()),
        ];
    }

    /**
     * LabRequestDto.
     *
     * @param array<string, VisibleDocument> $visible document id => what the policy lets this doctor see now
     * @param list<LabRequestEvent>          $events
     */
    public static function doctorDetail(LabRequest $r, DateTimeImmutable $now, array $visible, ?DateTimeImmutable $appointmentScheduledAt, array $events): array
    {
        $results    = array_map(static fn (LabRequestResult $res): array => self::doctorResult($res, $visible[$res->getDocumentId()] ?? null), $r->getResults());
        $reviewable = array_filter($results, static fn (array $res): bool => $res['reviewable']);
        $unreviewed = count(array_filter($results, static fn (array $res): bool => $res['reviewable'] && $res['review'] === null));
        $effective  = $r->effectiveStatus($now);
        $prescriber = $r->getPrescriber();
        $snapshot   = $r->getPatientSnapshot();
        $flags      = $r->getClinicalFlags();

        return self::doctorSummary($r, $now, $unreviewed) + [
            'appointment_scheduled_at' => $appointmentScheduledAt !== null ? self::iso($appointmentScheduledAt) : null,
            'purpose'                  => $r->getPurpose(),
            'history'                  => $r->getHistory(),
            'medication'               => $r->getMedication(),
            'allergies'                => $r->getAllergies(),
            'clinical'                 => [
                'fasting'          => $flags['fasting'] ?? null,
                'fasting_hours'    => $flags['fasting_hours'] ?? null,
                'pregnancy_asked'  => (bool) ($flags['pregnancy_asked'] ?? false),
                'pregnant'         => $flags['pregnant'] ?? null,
                'weeks_pregnant'   => $flags['weeks_pregnant'] ?? null,
                'infection_alerts' => array_values((array) ($flags['infection_alerts'] ?? [])),
                'transfusion_3m'   => $flags['transfusion_3m'] ?? null,
            ],
            'imaging_safety'           => $r->getImagingSafety() !== null ? [
                'contrast_allergy' => (string) ($r->getImagingSafety()['contrast_allergy'] ?? ''),
                'mobility'         => (string) ($r->getImagingSafety()['mobility'] ?? ''),
                'pregnant'         => (string) ($r->getImagingSafety()['pregnant'] ?? 'na'),
            ] : null,
            'catalogue_version'        => $r->getCatalogueVersion(),
            'items'                    => array_map([self::class, 'doctorItem'], $r->getItems()),
            'prescriber'               => [
                'id'                  => (string) ($prescriber['id'] ?? $r->getSpecialistId()),
                'name'                => (string) ($prescriber['name'] ?? ''),
                'specialty'           => (string) ($prescriber['specialty'] ?? ''),
                'qualifications'      => (string) ($prescriber['qualifications'] ?? ''),
                'registration_label'  => (string) ($prescriber['registration_label'] ?? ''),
                'registration_number' => (string) ($prescriber['mdcn_number'] ?? ''),
            ],
            'patient_snapshot'         => [
                'name'          => (string) ($snapshot['name'] ?? ''),
                'reference'     => (string) ($snapshot['reference'] ?? ''),
                'email'         => (string) ($snapshot['email'] ?? ''),
                'date_of_birth' => self::nullable($snapshot['date_of_birth'] ?? null),
                'age'           => self::age($snapshot),
                'sex'           => self::nullable($snapshot['sex'] ?? null),
            ],
            'consent'                  => self::consent($r),
            'lab_name'                 => $r->getLabName(),
            'lab_date'                 => $r->getLabDate()?->format('Y-m-d'),
            'declined_at'              => self::isoOrNull($r->getDeclinedAt()),
            'decline_reason'           => $r->getDeclineReason(),
            'sample_at'                => self::isoOrNull($r->getSampleAt()),
            'result_ready_at'          => self::isoOrNull($r->getResultReadyAt()),
            'reviewed_at'              => self::isoOrNull($r->getReviewedAt()),
            'cancelled_at'             => self::isoOrNull($r->getCancelledAt()),
            'cancel_reason'            => $r->getCancelReason(),
            'expired_at'               => self::isoOrNull($r->getExpiredAt() ?? ($effective === LabRequest::STATUS_EXPIRED ? $r->getExpiresAt() : null)),
            'duplicated_from'          => $r->getDuplicatedFromId(),
            'results'                  => $results,
            'timeline'                 => self::timeline($events),
            'can'                      => [
                'cancel'    => LabRequestTransitions::allowed($effective, 'cancel', $r),
                'review'    => in_array($effective, LabRequestTransitions::DOCTOR_REVIEW_ON, true) && LabRequestTransitions::allowed($effective, 'review', $r) && $reviewable !== [],
                'duplicate' => true,
            ],
        ];
    }

    /** DoctorLabResultDto: the file only through what the policy lets this doctor see. */
    public static function doctorResult(LabRequestResult $res, ?VisibleDocument $visible): array
    {
        $doc      = $visible?->document;
        $viewable = $doc !== null && DocumentSharingRules::isViewable($doc->getExtension(), $doc->getMimeType());

        return [
            'id'          => $res->getId(),
            'uploaded_at' => self::iso($res->getUploadedAt()),
            'item_ids'    => $res->getItemIds(),
            'visible'     => $doc !== null,
            'reviewable'  => $doc !== null && $viewable,
            'document'    => $doc !== null ? [
                'title'      => $doc->getTitle(),
                'type_label' => $doc->typeLabel(),
                'extension'  => $doc->getExtension(),
                'size_label' => $doc->sizeLabel(),
                'viewable'   => $viewable,
            ] : null,
            'review'      => $res->getReviewedAt() !== null ? [
                'outcome'     => (string) $res->getReviewOutcome(),
                'comment'     => $res->getReviewComment(),
                'reviewed_at' => self::iso($res->getReviewedAt()),
            ] : null,
        ];
    }

    /** LabRequestItemDto. */
    public static function doctorItem(LabRequestItem $i): array
    {
        return [
            'id'                => $i->getId(),
            'position'          => $i->getPosition(),
            'code'              => $i->getCode(),
            'kind'              => $i->getKind(),
            'category'          => $i->getCategory(),
            'modality'          => $i->getModality(),
            'site'              => $i->getSite(),
            'label'             => $i->getLabel(),
            'short'             => $i->getShort(),
            'specimen_mode'     => $i->getSpecimenMode(),
            'specimen_code'     => $i->getSpecimenCode(),
            'specimen_label'    => $i->getSpecimenLabel(),
            'preparation_code'  => $i->getPreparationCode(),
            'preparation_label' => $i->getPreparationLabel(),
            'contrast_possible' => $i->isContrastPossible(),
            'ionising'          => $i->isIonising(),
        ];
    }

    // ----- patient -----

    /**
     * PatientLabRequestSummaryDto — no test names, no clinical question.
     * `$review`: {reviewed, awaiting_review} over the REVIEWABLE results.
     *
     * @param array{reviewed: bool, awaiting_review: bool} $review
     */
    public static function patientSummary(LabRequest $r, DateTimeImmutable $now, array $review): array
    {
        $prescriber = $r->getPrescriber();

        return [
            'id'               => $r->getId(),
            'number'           => $r->getNumber(),
            'status'           => $r->effectiveStatus($now),
            'priority'         => $r->getPriority(),
            'doctor'           => [
                'id'        => $r->getSpecialistId(),
                'name'      => (string) ($prescriber['name'] ?? ''),
                'specialty' => (string) ($prescriber['specialty'] ?? ''),
            ],
            'items_count'      => count($r->getItems()),
            'results_count'    => $r->getResultsCount(),
            'reviewed'         => $review['reviewed'],
            'awaiting_review'  => $review['awaiting_review'],
            'appointment_id'   => $r->getAppointmentId(),
            'sent_at'          => self::iso($r->getSentAt()),
            'valid_until'      => $r->getValidUntil()->format('Y-m-d'),
            'expires_at'       => self::iso($r->getExpiresAt()),
            'last_activity_at' => self::iso($r->getLastActivityAt()),
        ];
    }

    /**
     * {reviewed, awaiting_review} from the patient's result rows (reviewable only).
     *
     * @param list<array{reviewable: bool, review: ?array}> $results
     * @return array{reviewed: bool, awaiting_review: bool}
     */
    public static function reviewState(array $results): array
    {
        $awaiting = false;
        $reviewed = false;
        foreach ($results as $res) {
            if (!$res['reviewable']) {
                continue;
            }
            if ($res['review'] === null) {
                $awaiting = true;
            } else {
                $reviewed = true;
            }
        }

        return ['reviewed' => $reviewed && !$awaiting, 'awaiting_review' => $awaiting];
    }

    /**
     * PatientLabRequestDto.
     *
     * @param array<string, MedicalDocument> $documents the patient's own result documents, by id
     * @param array<string, bool>            $sharedNow document id => the requesting doctor can see it now
     * @param list<LabRequestEvent>          $events
     */
    public static function patient(
        LabRequest $r,
        DateTimeImmutable $now,
        array $documents,
        array $sharedNow,
        bool $doctorAvailable,
        string $resultsSharing,
        array $events,
        LabCatalogue $catalogue,
    ): array {
        $results = [];
        foreach ($r->getResults() as $res) {
            $doc = $documents[$res->getDocumentId()] ?? null;
            if ($doc !== null) {
                $results[] = self::patientResult($res, $doc, $doctorAvailable && ($sharedNow[$res->getDocumentId()] ?? false));
            }
        }
        $effective  = $r->effectiveStatus($now);
        $prescriber = $r->getPrescriber();
        $consented  = $r->getConsentedAt() !== null;

        return self::patientSummary($r, $now, self::reviewState($results)) + [
            'clinical_question'     => $r->getClinicalQuestion(),
            'purpose'               => $r->getPurpose(),
            'items'                 => array_map(static fn (LabRequestItem $i): array => [
                'id'                => $i->getId(),
                'kind'              => $i->getKind(),
                'label'             => $i->getLabel(),
                'short'             => $i->getShort(),
                'specimen_label'    => $i->getSpecimenLabel(),
                'preparation_code'  => $i->getPreparationCode(),
                'preparation_label' => $i->getPreparationLabel(),
            ], $r->getItems()),
            'instructions'          => LabRequestRules::patientInstructions($r, $catalogue),
            'consent_version'       => LabRequestRules::CONSENT_VERSION,
            'consent_statements'    => LabRequestRules::consentStatements((string) ($prescriber['name'] ?? '')),
            'consent'               => self::consent($r),
            'lab_name'              => $r->getLabName(),
            'lab_date'              => $r->getLabDate()?->format('Y-m-d'),
            'declined_at'           => self::isoOrNull($r->getDeclinedAt()),
            'decline_reason'        => $r->getDeclineReason(),
            'sample_at'             => self::isoOrNull($r->getSampleAt()),
            'result_ready_at'       => self::isoOrNull($r->getResultReadyAt()),
            'cancelled_at'          => self::isoOrNull($r->getCancelledAt()),
            'cancel_reason'         => $r->getCancelReason(),
            'expired_at'            => self::isoOrNull($r->getExpiredAt() ?? ($effective === LabRequest::STATUS_EXPIRED ? $r->getExpiresAt() : null)),
            'results_sharing'       => $resultsSharing,
            'doctor_available'      => $doctorAvailable,
            'results'               => $results,
            'timeline'              => self::timeline($events),
            'can'                   => [
                'accept'  => LabRequestTransitions::allowed($effective, 'accept', $r),
                'decline' => LabRequestTransitions::allowed($effective, 'decline', $r),
                'sample'  => LabRequestTransitions::allowed($effective, 'sample', $r),
                'upload'  => LabRequestTransitions::allowed($effective, 'upload', $r) && $r->getResultsCount() < LabRequestRules::MAX_RESULTS,
                'pdf'     => $consented && in_array($effective, [LabRequest::STATUS_BOOKED, LabRequest::STATUS_IN_LAB, LabRequest::STATUS_RESULT_READY, LabRequest::STATUS_EXPIRED], true),
            ],
            'result_document_types' => array_map(
                static fn (string $t): array => ['value' => $t, 'label' => DocumentType::label($t)],
                LabRequestRules::RESULT_DOCUMENT_TYPES,
            ),
            'default_document_type' => LabRequestRules::defaultDocumentType($r->getItems()),
        ];
    }

    /** PatientLabResultDto (never the review outcome). `$sharedNow`: the doctor can see the file now and is practising. */
    public static function patientResult(LabRequestResult $res, MedicalDocument $doc, bool $sharedNow): array
    {
        return [
            'id'            => $res->getId(),
            'uploaded_at'   => self::iso($res->getUploadedAt()),
            'item_ids'      => $res->getItemIds(),
            'document'      => [
                'id'         => $doc->getId(),
                'title'      => $doc->getTitle(),
                'type_label' => $doc->typeLabel(),
                'extension'  => $doc->getExtension(),
                'size_label' => $doc->sizeLabel(),
            ],
            'share_outcome' => $res->getShareOutcome(),
            'shared_now'    => $sharedNow,
            'viewable'      => $res->isViewable(),
            'reviewable'    => $sharedNow && $res->isViewable(),
            'review'        => $res->getReviewedAt() !== null ? [
                'comment'     => $res->getReviewComment(),
                'reviewed_at' => self::iso($res->getReviewedAt()),
            ] : null,
        ];
    }

    // ----- back office -----

    /**
     * AdminLabRequestSummaryDto — no clinical content. `$note` is the latest
     * correction's staff note, returned only when `$canSeeNote` (labs.manage).
     */
    public static function admin(LabRequest $r, DateTimeImmutable $now, ?string $note, bool $canSeeNote): array
    {
        return [
            'id'                   => $r->getId(),
            'number'               => $r->getNumber(),
            'status'               => $r->effectiveStatus($now),
            'priority'             => $r->getPriority(),
            'doctor_name'          => (string) ($r->getPrescriber()['name'] ?? ''),
            'items_count'          => count($r->getItems()),
            'results_count'        => $r->getResultsCount(),
            'sent_at'              => self::iso($r->getSentAt()),
            'last_activity_at'     => self::iso($r->getLastActivityAt()),
            'corrections'          => LabRequestTransitions::staffTargets($r, $now),
            'consented_on'         => $r->getConsentedAt() !== null ? LabRequestRules::clinicDate($r->getConsentedAt()) : null,
            'last_correction_note' => $canSeeNote ? $note : null,
        ];
    }

    // ----- shared -----

    /** LabRequestEventDto — never the staff note. */
    public static function event(LabRequestEvent $e): array
    {
        $details = $e->getDetails();
        $sample  = $details['sample_date'] ?? null;

        return [
            'event'       => $e->getEvent(),
            'from_status' => $e->getFromStatus(),
            'to_status'   => $e->getToStatus(),
            'actor_role'  => $e->getActorRole(),
            'actor_name'  => $e->getActorName(),
            'at'          => self::iso($e->getCreatedAt()),
            'sample_date' => $e->getEvent() === 'status_corrected' && is_string($sample) ? $sample : null,
        ];
    }

    /** Lifecycle rank: orders events stored in the same second (the column holds seconds). */
    private const EVENT_RANK = [
        'sent' => 0, 'reminded' => 1, 'accepted' => 2, 'declined' => 2, 'status_corrected' => 3, 'sample_given' => 4,
        'result_added' => 5, 'result_reviewed' => 6, 'cancelled' => 7, 'expired' => 7,
    ];

    /**
     * The timeline, oldest first; events of the same second in lifecycle order.
     *
     * @param list<LabRequestEvent> $events
     * @return list<array<string,mixed>>
     */
    public static function timeline(array $events): array
    {
        $keyed = [];
        foreach (array_values($events) as $n => $e) {
            $keyed[] = [$e->getCreatedAt()->getTimestamp(), self::EVENT_RANK[$e->getEvent()] ?? 9, $n, $e];
        }
        usort($keyed, static fn (array $a, array $b): int => [$a[0], $a[1], $a[2]] <=> [$b[0], $b[1], $b[2]]);

        return array_map(static fn (array $k): array => self::event($k[3]), $keyed);
    }

    /** "P-1A2B3C4D": the patient reference printed on requests and prescriptions. */
    public static function patientReference(string $patientId): string
    {
        return 'P-' . strtoupper(substr(str_replace('-', '', $patientId), 0, 8));
    }

    /** @return array{version:string, consented_at:string, share_results:bool}|null */
    private static function consent(LabRequest $r): ?array
    {
        if ($r->getConsentedAt() === null) {
            return null;
        }

        return [
            'version'       => (string) ($r->getConsent()['version'] ?? LabRequestRules::CONSENT_VERSION),
            'consented_at'  => self::iso($r->getConsentedAt()),
            'share_results' => $r->sharesResults(),
        ];
    }

    /** Age now from the snapshot's date of birth (else the frozen age). @param array<string,mixed> $snapshot */
    private static function age(array $snapshot): ?int
    {
        $iso = (string) ($snapshot['dob_iso'] ?? '');
        if ($iso !== '') {
            try {
                return (new DateTimeImmutable($iso))->diff(ClinicTime::today())->y;
            } catch (\Throwable) {
                // fall back to the frozen age
            }
        }
        $age = $snapshot['age'] ?? null;

        return is_numeric($age) ? (int) $age : null;
    }

    private static function nullable(mixed $v): ?string
    {
        return is_string($v) && trim($v) !== '' ? $v : null;
    }

    private static function iso(DateTimeImmutable $at): string
    {
        return (string) DocumentSharingRules::iso($at);
    }

    private static function isoOrNull(?DateTimeImmutable $at): ?string
    {
        return DocumentSharingRules::iso($at);
    }
}
