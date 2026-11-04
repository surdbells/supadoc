<?php

declare(strict_types=1);

namespace App\Infrastructure\Lab;

use App\Domain\Document\DocumentSharingRules;
use App\Domain\Document\DomainRefusal;
use App\Domain\Entity\Appointment;
use App\Domain\Entity\LabRequest;
use App\Domain\Entity\LabRequestEvent;
use App\Domain\Entity\LabRequestItem;
use App\Domain\Entity\LabRequestResult;
use App\Domain\Entity\MedicalDocument;
use App\Domain\Entity\Patient;
use App\Domain\Entity\Specialist;
use App\Domain\Entity\User;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Exception\ValidationException;
use App\Domain\Lab\LabCatalogue;
use App\Domain\Lab\LabRequestForm;
use App\Domain\Lab\LabRequestRules;
use App\Domain\Lab\LabRequestTransitions;
use App\Domain\Lab\LabTransitionRefused;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\LabRequestRepository;
use App\Domain\Repository\MedicalDocumentRepository;
use App\Domain\Repository\PatientRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Domain\Settings\ClinicTime;
use App\Domain\Settings\HealthProfile;
use App\Domain\Settings\ProcessClock;
use App\Infrastructure\Document\DocumentAccessPolicy;
use App\Infrastructure\Document\DocumentSharingService;
use App\Infrastructure\Document\VisibleDocument;
use App\Infrastructure\Prescription\PrescriberSnapshot;
use App\Infrastructure\Prescription\PrescriptionService;
use App\Infrastructure\Prescription\SignatureStore;
use App\Infrastructure\Service\AuditLogger;
use App\Infrastructure\Service\DocumentRejectedException;
use App\Infrastructure\Service\JwtService;
use App\Infrastructure\Service\MedicalDocumentStorage;
use DateTimeImmutable;
use Doctrine\DBAL\Exception\UniqueConstraintViolationException;
use Doctrine\DBAL\LockMode;
use Doctrine\ORM\EntityManager;
use Doctrine\ORM\EntityManagerInterface;
use Psr\Http\Message\UploadedFileInterface;
use Ramsey\Uuid\Uuid;

/**
 * Laboratory & diagnostics requests (spec §1, §2): send (idempotent, signed,
 * numbered), the patient's answer and reports, result uploads with their
 * sharing, the doctor's review and cancel, staff corrections, the signed PDF
 * links and every read model.
 *
 * Every transition runs in {@see transition()}: ONE transaction that locks the
 * request row, stores a due expiry first (computed on read everywhere, so a
 * missing cron never shows a stale status), re-checks the status machine on
 * the effective status, writes the change, its timeline event and audit row;
 * notices go out only after the commit (best effort). Lock order is always
 * the request row, then the document-sharing pair locks — never the reverse.
 *
 * Errors are {@see DomainRefusal}s (status, message, `errors` with a `code`)
 * or {@see ValidationException}s (422, every field).
 */
final class LabRequestService
{
    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly LabRequestRepository $requests,
        private readonly PatientRepository $patients,
        private readonly SpecialistRepository $specialists,
        private readonly AppointmentRepository $appointments,
        private readonly UserRepository $users,
        private readonly MedicalDocumentRepository $documents,
        private readonly LabCatalogue $catalogue,
        private readonly LabRequestNumberGenerator $numbers,
        private readonly SignatureStore $signatures,
        private readonly PrescriptionService $prescriptions,
        private readonly DocumentAccessPolicy $policy,
        private readonly DocumentSharingService $sharing,
        private readonly MedicalDocumentStorage $storage,
        private readonly LabRequestNotifier $notifier,
        private readonly LabRequestPdfRenderer $renderer,
        private readonly JwtService $jwt,
        private readonly AuditLogger $audit,
    ) {
    }

    public function catalogue(): LabCatalogue
    {
        return $this->catalogue;
    }

    // =====================================================================
    // Doctor: form support
    // =====================================================================

    /** LabOptionsDto. */
    public function options(Specialist $doctor): array
    {
        return $this->catalogue->options() + ['has_signature' => $this->signatures->read($doctor->getSignatureKey()) !== null];
    }

    /**
     * The doctor's consulted patients for the picker.
     *
     * @return array{items: list<array<string,mixed>>, total: int}
     */
    public function patientPicks(Specialist $doctor, ?string $search, int $offset, int $perPage): array
    {
        $page = $this->appointments->consultedPatientsForSpecialist($offset, $perPage, $doctor->getId(), $search, LabRequestRules::now());

        return [
            'items' => array_map(static fn (array $r): array => [
                'patient_id' => $r['patient_id'],
                'name'       => trim($r['first_name'] . ' ' . $r['last_name']),
                'email'      => $r['email'],
                'reference'  => LabRequestPresenter::patientReference($r['patient_id']),
                'avatar_url' => $r['avatar_url'],
                'last_visit' => self::lastVisitIso($r['last_visit']),
            ], $page['items']),
            'total' => $page['total'],
        ];
    }

    /**
     * LabRequestContextDto: who the form is for, whether to ask "Pregnant?",
     * the medication / allergy pre-fill and the consultation.
     */
    public function context(Specialist $doctor, string $patientId, ?string $appointmentId): array
    {
        $patient = $this->patient($patientId);
        $appointment = $this->checkAccess($doctor, $patient, $appointmentId);
        \assert($patient instanceof Patient);
        $dob = $patient->getDateOfBirth();

        return [
            'patient'       => [
                'id'         => $patient->getId(),
                'name'       => $patient->getFullName(),
                'first_name' => $patient->getFirstName(),
                'email'      => $patient->getEmail(),
                'age'        => $dob?->diff(ClinicTime::today())->y,
                'sex'        => self::sex($patient->getGender()),
                'reference'  => LabRequestPresenter::patientReference($patient->getId()),
                'avatar_url' => $patient->getAvatarUrl(),
            ],
            'ask_pregnancy' => LabRequestRules::asksPregnancy($patient->getGender(), $dob, ClinicTime::today()),
            'prefill'       => self::prefill($patient),
            'appointment'   => $appointment !== null ? ['id' => $appointment->getId(), 'scheduled_at' => (string) DocumentSharingRules::iso($appointment->getScheduledAt())] : null,
        ];
    }

    // =====================================================================
    // Doctor: send (T2)
    // =====================================================================

    /**
     * POST /doctor/lab-requests (spec §2.2, E6): one transaction that first
     * takes the (doctor, form key) advisory lock, then answers a replay of the
     * same form (200, nothing written) or a reuse with other details (409),
     * then checks the catalogue version (409), the form (422, every error) and
     * the access rules (422), and writes the request.
     *
     * @return array{dto: array<string,mixed>, created: bool}
     */
    public function send(Specialist $doctor, string $userId, array $body): array
    {
        if (!LabRequestForm::isClientKey($body['client_key'] ?? null)) {
            throw new ValidationException(['client_key' => 'Send the form key'], LabRequestForm::MESSAGE);
        }
        $key  = strtolower(trim((string) $body['client_key']));
        $hash = LabRequestForm::hash($body);
        $sid  = strtolower($doctor->getId());
        $conn = $this->em->getConnection();

        $frozen   = null;
        $savedOld = null;
        $savedNew = null;
        try {
            $outcome = $this->em->wrapInTransaction(function () use ($conn, $doctor, $userId, $body, $key, $hash, $sid, &$frozen, &$savedOld, &$savedNew): array|DomainRefusal|ValidationException {
                $conn->executeQuery('SELECT pg_advisory_xact_lock(' . LabRequestRules::LOCK_NAMESPACE . ', hashtext(:k))', ['k' => $sid . ':' . $key]);
                $existing = $this->requests->clientKeyRow($sid, $key);
                if ($existing !== null) {
                    return $existing['request_hash'] === $hash ? ['replay' => $existing['id']] : self::idempotencyConflict();
                }
                if (($body['catalogue_version'] ?? null) !== $this->catalogue->version()) {
                    return DomainRefusal::code(409, 'catalogue_changed', 'The test list was updated. Check the request and preview it again.', ['catalogue_version' => $this->catalogue->version()]);
                }

                $patient = $this->patients->find(strtolower(trim((string) ($body['patient_id'] ?? ''))));
                $patient = $patient instanceof Patient && !$patient->isDeleted() ? $patient : null;
                $asks    = $patient !== null && LabRequestRules::asksPregnancy($patient->getGender(), $patient->getDateOfBirth(), ClinicTime::today());
                [$form, $errors] = LabRequestForm::check($body, $asks, $this->catalogue);
                $png = null;
                if (!isset($errors['signature'])) {
                    try {
                        $png = $this->signaturePng($doctor, $form['signature_mode'], is_array($body['signature'] ?? null) ? $body['signature'] : []);
                    } catch (ValidationException $e) {
                        $errors += $e->getErrors();
                    }
                }
                if ($errors !== []) {
                    return new ValidationException($errors, LabRequestForm::MESSAGE);
                }
                try {
                    $appointment = $this->checkAccess($doctor, $patient, is_string($body['appointment_id'] ?? null) && trim($body['appointment_id']) !== '' ? $body['appointment_id'] : null);
                    $duplicated  = $this->duplicatedFrom($doctor, $patient, $body['duplicated_from'] ?? null);
                } catch (DomainRefusal $r) {
                    return $r;
                }
                \assert($patient instanceof Patient && $png !== null);

                $now    = LabRequestRules::now();
                $frozen = $this->signatures->store($png, 'lab-signatures');
                if ($form['signature_mode'] === 'drawn' && filter_var($body['signature']['save'] ?? false, FILTER_VALIDATE_BOOLEAN)) {
                    $savedOld = $doctor->getSignatureKey() ?? '';
                    $savedNew = $this->signatures->store($png, 'signatures');
                    $doctor->setSignatureKey($savedNew);
                    $this->em->persist($doctor);
                    $this->audit->record($doctor->getName(), 'doctor', 'signature.updated', null, 'specialist', $doctor->getId(), [], $userId);
                }

                $r = new LabRequest(
                    Uuid::uuid4()->toString(),
                    $this->numbers->next($now),
                    $patient->getId(),
                    $doctor->getId(),
                    $appointment?->getId(),
                    $duplicated,
                    $key,
                    $hash,
                    $form,
                    $this->catalogue->version(),
                    PrescriberSnapshot::of($doctor),
                    self::patientSnapshot($patient),
                    $form['signature_mode'],
                    $frozen,
                    Uuid::uuid4()->toString(),
                    LabRequestRules::validity($now),
                    $now,
                );
                foreach ($form['items'] as $n => $snap) {
                    $r->addItem(new LabRequestItem($r, $n + 1, $snap));
                }
                $this->em->persist($r);
                $this->event($r, 'sent', null, LabRequest::STATUS_AWAITING_CONSENT, 'doctor', $doctor->getId(), $doctor->getName(), null, $now);
                $this->auditLab($doctor->getName(), 'doctor', 'lab_request.sent', $r, ['items' => count($form['items']), 'priority' => $r->getPriority()], $userId);
                $this->auditLab($doctor->getName(), 'doctor', 'signature.used', $r, ['mode' => $form['signature_mode']], $userId);

                return ['created' => $r];
            });
        } catch (UniqueConstraintViolationException $e) {
            // Defensive (every send holds the key's lock): the row a concurrent send wrote wins.
            $this->signatures->delete($frozen);
            $this->signatures->delete($savedNew);
            $row = $this->requests->clientKeyRow($sid, $key);
            if ($row === null) {
                throw $e;
            }
            if ($row['request_hash'] !== $hash) {
                throw self::idempotencyConflict();
            }
            $fresh = new EntityManager($conn, $this->em->getConfiguration());
            $r     = $fresh->find(LabRequest::class, $row['id']);
            \assert($r instanceof LabRequest);

            return ['dto' => $this->doctorDetail($doctor, $r, $fresh), 'created' => false];
        } catch (\Throwable $e) {
            $this->signatures->delete($frozen);
            $this->signatures->delete($savedNew);
            throw $e;
        }

        if ($outcome instanceof DomainRefusal || $outcome instanceof ValidationException) {
            throw $outcome;
        }
        if (isset($outcome['replay'])) {
            $r = $this->requests->findById((string) $outcome['replay']);
            \assert($r instanceof LabRequest);

            return ['dto' => $this->doctorDetail($doctor, $r), 'created' => false];
        }
        $r = $outcome['created'];
        \assert($r instanceof LabRequest);
        if ($savedOld !== null && $savedOld !== '') {
            $this->signatures->delete($savedOld);
        }
        $this->notifier->sent($r);

        return ['dto' => $this->doctorDetail($doctor, $r), 'created' => true];
    }

    // =====================================================================
    // Doctor: reads, cancel (T8), review (T7)
    // =====================================================================

    /** The doctor's own request, else 404 (another doctor's reads as unknown). */
    public function doctorRequest(Specialist $doctor, string $labId): LabRequest
    {
        return $this->requests->findForSpecialist($labId, $doctor->getId()) ?? throw DomainRefusal::notFound(LabRequestRules::NOT_FOUND);
    }

    /**
     * The doctor's list: paginated rows + every group's count. Throws 422
     * `group` for an unknown filter.
     *
     * @param array<string,mixed> $query
     * @return array{rows: list<array<string,mixed>>, total: int, counts: array<string,int>}
     */
    public function listForDoctor(Specialist $doctor, array $query, int $offset, int $perPage): array
    {
        $group   = self::group($query['group'] ?? null);
        $filters = [
            'q'              => self::search($query['q'] ?? null),
            'appointment_id' => DocumentSharingRules::lowerUuid($query['appointment_id'] ?? null),
            'patient_id'     => DocumentSharingRules::lowerUuid($query['patient_id'] ?? null),
        ];
        $now  = LabRequestRules::now();
        $page = $this->requests->listIds('specialist_id', $doctor->getId(), $group, $filters, $now, $offset, $perPage);
        $rows = $this->requests->loadByIds($page['ids']);

        // "Needs review" counts only results this doctor can actually open now:
        // one policy call per patient on the page that has unreviewed results.
        $visible = [];
        foreach ($rows as $r) {
            if ($r->getUnreviewedTotal() > 0 && !isset($visible[$r->getPatientId()])) {
                $patient = $this->patients->find($r->getPatientId());
                $visible[$r->getPatientId()] = $patient instanceof Patient ? $this->visibleIds($doctor, $patient, $now) : [];
            }
        }

        return [
            'rows'   => array_map(fn (LabRequest $r): array => LabRequestPresenter::doctorSummary(
                $r,
                $now,
                $r->getUnreviewedTotal() > 0 ? $this->reviewableUnreviewed($r, $visible[$r->getPatientId()] ?? []) : 0,
            ), $rows),
            'total'  => $page['total'],
            'counts' => $this->requests->groupCounts('specialist_id', $doctor->getId(), $filters, $now),
        ];
    }

    /** LabRequestDto (`$em`: a fresh manager when the request's one was closed by a failed write). */
    public function doctorDetail(Specialist $doctor, LabRequest $r, ?EntityManagerInterface $em = null): array
    {
        $em ??= $this->em;
        $now     = LabRequestRules::now();
        $visible = [];
        if ($r->getResultsCount() > 0) {
            $patient = $em->find(Patient::class, $r->getPatientId());
            if ($patient instanceof Patient) {
                foreach ($this->policy->visibleDocuments($doctor, $patient, $now) as $v) {
                    $visible[$v->documentId] = $v;
                }
            }
        }
        $appointment = $r->getAppointmentId() !== null ? $em->find(Appointment::class, $r->getAppointmentId()) : null;
        $events      = $em->createQueryBuilder()
            ->select('e')->from(LabRequestEvent::class, 'e')
            ->andWhere('e.labRequestId = :r')->setParameter('r', $r->getId())
            ->orderBy('e.createdAt', 'ASC')->addOrderBy('e.id', 'ASC')
            ->getQuery()->getResult();

        return LabRequestPresenter::doctorDetail($r, $now, $visible, $appointment instanceof Appointment ? $appointment->getScheduledAt() : null, $events);
    }

    /** T8: the requesting doctor cancels (reason 3–500, shown to the patient). */
    public function cancel(Specialist $doctor, string $userId, string $labId, array $body): array
    {
        $r      = $this->doctorRequest($doctor, $labId);
        $reason = is_string($body['reason'] ?? null) ? trim($body['reason']) : '';
        if (mb_strlen($reason) < LabRequestRules::REASON_MIN || mb_strlen($reason) > LabRequestRules::REASON_MAX) {
            throw DomainRefusal::field('reason', "Tell the patient why you're cancelling");
        }
        $this->transition($r->getId(), function (LabRequest $r, DateTimeImmutable $now) use ($doctor, $userId, $reason): ?DomainRefusal {
            $from = $r->effectiveStatus($now);
            if (($refusal = self::refuse($from, 'cancel', 'doctor', $r)) !== null) {
                return $refusal;
            }
            $r->markCancelled($reason, $now);
            $this->event($r, 'cancelled', $from, LabRequest::STATUS_CANCELLED, 'doctor', $doctor->getId(), $doctor->getName(), null, $now);
            $this->auditLab($doctor->getName(), 'doctor', 'lab_request.cancelled', $r, [], $userId);

            return null;
        });
        $this->notifier->cancelled($r);

        return $this->doctorDetail($doctor, $r);
    }

    /**
     * T7: review one result Normal / Abnormal (+ a note; required, 3–1000, for
     * Abnormal). Only a REVIEWABLE result: visible to this doctor now (409
     * `not_shared`) and openable in VideoMed (409 `not_viewable`).
     */
    public function review(Specialist $doctor, string $userId, string $labId, string $resultId, array $body): array
    {
        $r       = $this->doctorRequest($doctor, $labId);
        $outcome = is_string($body['outcome'] ?? null) ? $body['outcome'] : '';
        if (!in_array($outcome, LabRequestResult::OUTCOMES, true)) {
            throw DomainRefusal::field('outcome', 'Choose Normal or Abnormal');
        }
        $comment = is_string($body['comment'] ?? null) ? trim($body['comment']) : '';
        if (mb_strlen($comment) > LabRequestRules::COMMENT_MAX) {
            throw DomainRefusal::field('comment', 'Use 1,000 characters or fewer');
        }
        if ($outcome === 'abnormal' && mb_strlen($comment) < LabRequestRules::COMMENT_MIN) {
            throw DomainRefusal::field('comment', 'Add a note for the patient');
        }
        $patient = $this->patients->find($r->getPatientId());
        if (!$patient instanceof Patient) {
            throw DomainRefusal::notFound(LabRequestRules::NOT_FOUND);
        }

        $this->transition($r->getId(), function (LabRequest $r, DateTimeImmutable $now) use ($doctor, $userId, $resultId, $outcome, $comment, $patient): ?DomainRefusal {
            $effective = $r->effectiveStatus($now);
            if (($refusal = self::refuse($effective, 'review', 'doctor', $r)) !== null) {
                return $refusal;
            }
            $result = $r->result($resultId);
            if ($result === null) {
                return DomainRefusal::notFound('Result not found');
            }
            $visible = $this->policy->visibleDocument($doctor, $patient, $result->getDocumentId(), $now);
            if ($visible === null) {
                return DomainRefusal::code(409, 'not_shared', "The patient hasn't shared this result with you.");
            }
            if (!$result->isViewable() || !DocumentSharingRules::isViewable($visible->document->getExtension(), $visible->document->getMimeType())) {
                return DomainRefusal::code(409, 'not_viewable', "You can't open this file type in VideoMed, so it can't be reviewed. Ask the patient to add a PDF or photo.");
            }
            $changed = $result->review($outcome, $comment !== '' ? $comment : null, $doctor->getId(), $now);
            $this->recomputeReviewTotals($r, $now);
            $this->event($r, 'result_reviewed', $effective, $effective, 'doctor', $doctor->getId(), $doctor->getName(), ['result_id' => $result->getId()], $now);
            $this->auditLab($doctor->getName(), 'doctor', 'lab_result.reviewed', $r, ['result_id' => $result->getId(), 'changed' => $changed], $userId, 'lab_result', $result->getId());

            return null;
        });
        $this->notifier->reviewed($r);

        return $this->doctorDetail($doctor, $r);
    }

    // =====================================================================
    // Patient: reads, accept (T3), decline (T4), sample (T5)
    // =====================================================================

    public function patientRequest(Patient $patient, string $labId): LabRequest
    {
        return $this->requests->findForPatient($labId, $patient->getId()) ?? throw DomainRefusal::notFound(LabRequestRules::NOT_FOUND);
    }

    /**
     * The patient's list (no test names, no clinical question in a row).
     *
     * @param array<string,mixed> $query
     * @return array{rows: list<array<string,mixed>>, total: int, counts: array<string,int>}
     */
    public function listForPatient(Patient $patient, array $query, int $offset, int $perPage): array
    {
        $group   = self::group($query['group'] ?? null);
        $filters = ['appointment_id' => DocumentSharingRules::lowerUuid($query['appointment_id'] ?? null)];
        $now     = LabRequestRules::now();
        $page    = $this->requests->listIds('patient_id', $patient->getId(), $group, $filters, $now, $offset, $perPage);
        $rows    = $this->requests->loadByIds($page['ids']);

        // One policy call for every result on the page; gate 1 per doctor.
        $docIds = [];
        foreach ($rows as $r) {
            foreach ($r->getResults() as $res) {
                $docIds[] = $res->getDocumentId();
            }
        }
        $byDoctor   = $docIds !== [] ? $this->visibleByDoctorIds($patient, $now, $docIds) : [];
        $practising = [];

        return [
            'rows'   => array_map(function (LabRequest $r) use ($now, $byDoctor, &$practising): array {
                $sid = $r->getSpecialistId();
                if ($r->getResultsCount() > 0 && !array_key_exists($sid, $practising)) {
                    $practising[$sid] = $this->doctorPractising($sid);
                }
                $results = array_map(static fn (LabRequestResult $res): array => [
                    'reviewable' => ($practising[$sid] ?? false) && isset($byDoctor[$sid][$res->getDocumentId()]) && $res->isViewable(),
                    'review'     => $res->getReviewedAt() !== null ? [] : null,
                ], $r->getResults());

                return LabRequestPresenter::patientSummary($r, $now, LabRequestPresenter::reviewState($results));
            }, $rows),
            'total'  => $page['total'],
            'counts' => $this->requests->groupCounts('patient_id', $patient->getId(), $filters, $now),
        ];
    }

    /** PatientLabRequestDto. */
    public function patientDetail(Patient $patient, LabRequest $r): array
    {
        $now       = LabRequestRules::now();
        $docIds    = array_map(static fn (LabRequestResult $res): string => $res->getDocumentId(), $r->getResults());
        $documents = $docIds !== [] ? $this->documents->byIdsForPatient($patient->getId(), $docIds) : [];
        $sid       = $r->getSpecialistId();
        $shared    = $docIds !== [] ? ($this->visibleByDoctorIds($patient, $now, $docIds)[$sid] ?? []) : [];
        $state     = 'none';
        try {
            $state = $this->sharing->resultShareState($patient, $sid, $r->getResultShareKey());
        } catch (\Throwable $e) {
            error_log('[lab] share state failed for request ' . $r->getId() . ': ' . $e::class);
        }

        return LabRequestPresenter::patient(
            $r,
            $now,
            $documents,
            $shared,
            $this->doctorPractising($sid),
            $state,
            $this->requests->events($r->getId()),
            $this->catalogue,
        );
    }

    /** T3: consent (three required statements + the share choice), optional lab name / planned date. */
    public function accept(Patient $patient, string $labId, array $body): array
    {
        $r = $this->patientRequest($patient, $labId);
        if (($body['consent_version'] ?? null) !== LabRequestRules::CONSENT_VERSION) {
            throw DomainRefusal::code(409, 'consent_changed', 'The consent wording has changed. Please review it again.', ['consent_version' => LabRequestRules::CONSENT_VERSION]);
        }
        foreach (['agree_tests', 'agree_pays_lab', 'agree_disclosure'] as $tick) {
            if (($body[$tick] ?? null) !== true && !in_array($body[$tick] ?? null, ['1', 'true', 1], true)) {
                throw DomainRefusal::field('agree', 'Tick the three required boxes to accept.');
            }
        }
        $share   = filter_var($body['share_results'] ?? false, FILTER_VALIDATE_BOOLEAN);
        $labName = is_string($body['lab_name'] ?? null) ? trim($body['lab_name']) : '';
        if (mb_strlen($labName) > LabRequestRules::LAB_NAME_MAX) {
            throw DomainRefusal::field('lab_name', 'Use ' . LabRequestRules::LAB_NAME_MAX . ' characters or fewer');
        }
        $rawDate = $body['lab_date'] ?? null;
        $labDate = null;
        if ($rawDate !== null && $rawDate !== '') {
            $labDate = LabRequestRules::parseDate($rawDate);
            if ($labDate === null) {
                throw DomainRefusal::field('lab_date', 'Choose a valid date');
            }
        }

        $this->transition($r->getId(), function (LabRequest $r, DateTimeImmutable $now) use ($patient, $share, $labName, $labDate): ?DomainRefusal {
            $from = $r->effectiveStatus($now);
            if (($refusal = self::refuse($from, 'accept', 'patient', $r)) !== null) {
                return $refusal;
            }
            if ($labDate !== null) {
                $earliest = (new DateTimeImmutable(ClinicTime::todayYmd(), ClinicTime::zone()))->modify('-1 day')->format('Y-m-d');
                if ($labDate->format('Y-m-d') < $earliest) {
                    return DomainRefusal::field('lab_date', 'Choose today or a later date');
                }
                if ($labDate->format('Y-m-d') > $r->getValidUntil()->format('Y-m-d')) {
                    return DomainRefusal::field('lab_date', 'Choose a date before this request expires on ' . LabRequestRules::dateLabel($r->getValidUntil()));
                }
            }
            $consent = ['version' => LabRequestRules::CONSENT_VERSION, 'tests' => true, 'pays_lab' => true, 'lab_disclosure' => true, 'share_results' => $share];
            $r->markAccepted($consent, $share, $labName !== '' ? $labName : null, $labDate, $now);
            $this->event($r, 'accepted', $from, LabRequest::STATUS_BOOKED, 'patient', $patient->getId(), $patient->getFullName(), [
                'consent_version' => LabRequestRules::CONSENT_VERSION,
                'share_results'   => $share,
            ], $now);
            $this->auditLab($patient->getFullName(), 'patient', 'lab_request.accepted', $r, [
                'consent_version' => LabRequestRules::CONSENT_VERSION,
                'share_results'   => $share,
            ], $patient->getId());

            return null;
        });
        $this->notifier->doctorAccepted($r);

        return $this->patientDetail($patient, $r);
    }

    /** T4: decline (optional reason ≤ 500, shown to the doctor). */
    public function decline(Patient $patient, string $labId, array $body): array
    {
        $r      = $this->patientRequest($patient, $labId);
        $reason = is_string($body['reason'] ?? null) ? trim($body['reason']) : '';
        if (mb_strlen($reason) > LabRequestRules::REASON_MAX) {
            throw DomainRefusal::field('reason', 'Use ' . LabRequestRules::REASON_MAX . ' characters or fewer');
        }
        $this->transition($r->getId(), function (LabRequest $r, DateTimeImmutable $now) use ($patient, $reason): ?DomainRefusal {
            $from = $r->effectiveStatus($now);
            if (($refusal = self::refuse($from, 'decline', 'patient', $r)) !== null) {
                return $refusal;
            }
            $r->markDeclined($reason !== '' ? $reason : null, $now);
            $this->event($r, 'declined', $from, LabRequest::STATUS_DECLINED, 'patient', $patient->getId(), $patient->getFullName(), ['reason_given' => $reason !== ''], $now);
            $this->auditLab($patient->getFullName(), 'patient', 'lab_request.declined', $r, ['reason_given' => $reason !== ''], $patient->getId());

            return null;
        });
        $this->notifier->doctorDeclined($r);

        return $this->patientDetail($patient, $r);
    }

    /** T5: "I've given my sample" (booked → in lab). */
    public function sample(Patient $patient, string $labId): array
    {
        $r = $this->patientRequest($patient, $labId);
        $this->transition($r->getId(), function (LabRequest $r, DateTimeImmutable $now) use ($patient): ?DomainRefusal {
            $from = $r->effectiveStatus($now);
            if (($refusal = self::refuse($from, 'sample', 'patient', $r)) !== null) {
                return $refusal;
            }
            $r->markSampleGiven($now);
            $this->event($r, 'sample_given', $from, LabRequest::STATUS_IN_LAB, 'patient', $patient->getId(), $patient->getFullName(), null, $now);
            $this->auditLab($patient->getFullName(), 'patient', 'lab_request.sample_given', $r, [], $patient->getId());

            return null;
        });
        $this->notifier->doctorSampleGiven($r);

        return $this->patientDetail($patient, $r);
    }

    // =====================================================================
    // Patient: result upload (T6 / T6b / T6c) — spec §1.9
    // =====================================================================

    /**
     * Add a result file: checks first (nothing stored), the bytes, then ONE
     * transaction — request lock, expiry, status and count, the share under
     * the pair locks (a savepoint), the result row, its outcome — then the
     * notices. Any failure after the bytes are stored rolls everything back
     * and deletes them.
     *
     * @param array<string,mixed> $body
     * @return array{result: array<string,mixed>, request: array<string,mixed>}
     */
    public function addResult(Patient $patient, string $labId, ?UploadedFileInterface $file, array $body): array
    {
        $r   = $this->patientRequest($patient, $labId);
        $now = LabRequestRules::now();

        // 1. Lock-free checks: nothing is stored for a refused upload.
        if (!$file instanceof UploadedFileInterface || $file->getError() === UPLOAD_ERR_NO_FILE) {
            throw DomainRefusal::field('file', 'Attach a file');
        }
        $ext = strtolower(pathinfo((string) $file->getClientFilename(), PATHINFO_EXTENSION));
        if (!in_array($ext, LabRequestRules::RESULT_EXTENSIONS, true)) {
            throw DomainRefusal::field('file', 'Upload a PDF, photo (JPG, PNG, WEBP), DICOM (.dcm) or Word file.');
        }
        $type = is_string($body['document_type'] ?? null) && $body['document_type'] !== '' ? $body['document_type'] : LabRequestRules::defaultDocumentType($r->getItems());
        if (!in_array($type, LabRequestRules::RESULT_DOCUMENT_TYPES, true)) {
            throw DomainRefusal::field('document_type', 'Choose a document type');
        }
        $all     = $r->itemIds();
        $raw     = $body['item_ids'] ?? null;
        $itemIds = is_array($raw) ? array_values(array_unique(array_map(static fn ($v): string => strtolower(trim((string) $v)), $raw))) : ($raw === null || $raw === '' ? [] : null);
        if ($itemIds === null || array_diff($itemIds, $all) !== []) {
            throw DomainRefusal::field('item_ids', 'Choose which tests this result covers');
        }
        $itemIds = $itemIds === [] ? $all : array_values(array_intersect($all, $itemIds));
        $exclude = $this->sharing->validateUploadShare($patient, ['exclude_specialist_ids' => $body['exclude_specialist_ids'] ?? null], $now)['exclude'];
        $share   = self::shareChoice($body['share'] ?? null);
        $effective = $r->effectiveStatus($now);
        if (($refusal = self::refuse($effective, 'upload', 'patient', $r)) !== null) {
            throw $refusal;
        }
        if ($r->getResultsCount() >= LabRequestRules::MAX_RESULTS) {
            throw self::tooManyResults();
        }

        // 2. The bytes (and the document, not persisted yet).
        try {
            $meta = $this->storage->store($file, $patient->getId());
        } catch (DocumentRejectedException $e) {
            throw DomainRefusal::field('file', $e->getMessage());
        }
        $doc = new MedicalDocument(
            $patient->getId(),
            MedicalDocument::UPLOADER_PATIENT,
            trim($patient->getFullName()) !== '' ? $patient->getFullName() : 'Patient',
            $type,
            $meta['title'],
            $meta['stored_name'],
            $meta['mime'],
            $meta['extension'],
            $meta['size'],
        );
        $viewable = DocumentSharingRules::isViewable($meta['extension'], $meta['mime']);

        // 3–8. One transaction.
        try {
            $done = $this->transition($r->getId(), function (LabRequest $r, DateTimeImmutable $now) use ($patient, $doc, $itemIds, $exclude, $share, $viewable): array|DomainRefusal {
                $from = $r->effectiveStatus($now);
                if (($refusal = self::refuse($from, 'upload', 'patient', $r)) !== null) {
                    return $refusal;
                }
                if ($r->getResultsCount() >= LabRequestRules::MAX_RESULTS) {
                    return self::tooManyResults();
                }
                $doctorId = $r->getSpecialistId();
                $state    = $this->sharing->resultShareState($patient, $doctorId, $r->getResultShareKey());
                $want     = $share ?? ($state === 'active' || ($state === 'none' && $r->sharesResults()));
                $ex       = array_values(array_diff($exclude, [$doctorId]));
                $refused  = false;
                $rotated  = false;

                // The pair locks come after the request lock (the only order anywhere).
                $this->sharing->inPairs($patient, [$doctorId, ...$ex], function () use ($patient, $doc, $r, $doctorId, $want, $now, &$ex, &$refused, &$rotated): void {
                    $none   = ['specialist_ids' => [], 'duration' => null, 'until' => null, 'appointment' => null, 'batch_id' => null, 'surface' => 'lab_request', 'hash' => null];
                    $chosen = $none;
                    $booked = $this->policy->isBooked($patient->getId(), $doctorId);
                    if ($want && DocumentSharingRules::enabled()) {
                        $key = $this->sharing->resultShareState($patient, $doctorId, $r->getResultShareKey()) === 'ended'
                            ? Uuid::uuid4()->toString()
                            : $r->getResultShareKey();
                        try {
                            $chosen = $this->sharing->labResultShare($patient, $doctorId, $key, $now);
                            if ($key !== $r->getResultShareKey()) {
                                $r->rotateResultShareKey($key);
                                $rotated = true;
                            }
                        } catch (DomainRefusal $x) {
                            if (!in_array($x->errorCode(), ['doctor_unavailable', 'doctor_not_eligible'], true)) {
                                throw $x;
                            }
                            $refused = true;
                            if ($booked) {
                                $ex[] = $doctorId;
                            }
                        }
                    } elseif (!$want && $booked) {
                        // Not shared: a requesting doctor who holds a whole-folder share must not see it either.
                        $ex[] = $doctorId;
                    }
                    $this->sharing->shareUpload($patient, $doc, $chosen, array_values(array_unique($ex)), $now);
                }, $now);

                $result = new LabRequestResult($r, $doc->getId(), $itemIds, $viewable, $now);
                $this->em->persist($result);
                $r->addResult($result);
                $r->addResultCounts($now);

                // The outcome, on this connection (it sees this transaction's grant).
                $seen    = isset($this->visibleByDoctorIds($patient, $now, [$doc->getId()])[$doctorId]);
                $outcome = match (true) {
                    $seen && $this->doctorPractising($doctorId) => 'shared',
                    $seen, $refused                              => 'doctor_unavailable',
                    !DocumentSharingRules::enabled()             => 'sharing_unavailable',
                    default                                      => 'private',
                };
                $result->setShareOutcome($outcome);
                $details = ['result_id' => $result->getId()] + ($rotated ? ['share_key_rotated' => true] : []);
                $this->event($r, 'result_added', $from, $r->getStatus(), 'patient', $patient->getId(), $patient->getFullName(), $details, $now);
                $this->auditLab($patient->getFullName(), 'patient', 'lab_result.added', $r, [
                    'result_id'     => $result->getId(),
                    'share_outcome' => $outcome,
                ], $patient->getId(), 'lab_result', $result->getId());

                return ['result_id' => $result->getId(), 'outcome' => $outcome];
            });
        } catch (\Throwable $e) {
            // 11. Nothing kept: no notice, no document row, no bytes.
            $this->sharing->discardNotices();
            try {
                $this->storage->delete($doc);
            } catch (\Throwable $x) {
                error_log('[lab] result bytes not deleted for document ' . $doc->getId() . ': ' . $x::class);
            }
            throw $e;
        }
        $this->sharing->dispatchNotices();
        $this->notifier->doctorResultAdded($r, $done['outcome'], $viewable);

        $dto = $this->patientDetail($patient, $r);
        foreach ($dto['results'] as $row) {
            if ($row['id'] === $done['result_id']) {
                return ['result' => $row, 'request' => $dto];
            }
        }

        throw new \RuntimeException('The new result is missing from its request');
    }

    // =====================================================================
    // Staff: corrections (C1–C4), rows, overview
    // =====================================================================

    /**
     * AdminLabRequestSummaryDto rows of one patient (newest first); the
     * correction note only for `labs.manage`.
     *
     * @return list<array<string,mixed>>
     */
    public function adminRows(string $patientId, bool $canSeeNotes): array
    {
        $now   = LabRequestRules::now();
        $rows  = $this->requests->forPatient($patientId);
        $notes = $canSeeNotes ? $this->requests->latestCorrectionNotes(array_map(static fn (LabRequest $r): string => $r->getId(), $rows)) : [];

        return array_map(static fn (LabRequest $r): array => LabRequestPresenter::admin($r, $now, $notes[$r->getId()] ?? null, $canSeeNotes), $rows);
    }

    /**
     * C1–C4 (E16): booked → in lab (optional reported sample date), in lab →
     * booked, declined → awaiting consent, expired → booked / awaiting
     * consent. The reason (5–500) is PHI: it is kept on the timeline event
     * (`staff_note`) only — the audit row says `reason_given`.
     */
    public function correct(User $staff, string $labId, array $body): array
    {
        $r      = $this->requests->findById($labId) ?? throw DomainRefusal::notFound(LabRequestRules::NOT_FOUND);
        $to     = is_string($body['status'] ?? null) ? $body['status'] : '';
        $reason = is_string($body['reason'] ?? null) ? trim($body['reason']) : '';
        $now    = LabRequestRules::now();
        if (!in_array($to, LabRequestTransitions::staffTargets($r, $now), true)) {
            throw DomainRefusal::field('status', 'Choose a status from the list');
        }
        if (mb_strlen($reason) < LabRequestRules::STAFF_REASON_MIN) {
            throw DomainRefusal::field('reason', 'Add a reason (at least ' . LabRequestRules::STAFF_REASON_MIN . ' characters)');
        }
        if (mb_strlen($reason) > LabRequestRules::REASON_MAX) {
            throw DomainRefusal::field('reason', 'Use ' . LabRequestRules::REASON_MAX . ' characters or fewer');
        }
        $sampleDate = null;
        $rawDate    = $body['sample_date'] ?? null;
        if ($to === LabRequest::STATUS_IN_LAB && $rawDate !== null && $rawDate !== '') {
            $sampleDate = LabRequestRules::parseDate($rawDate);
            $from       = $r->getConsentedAt() !== null ? LabRequestRules::clinicDate($r->getConsentedAt()) : null;
            if ($sampleDate === null || $from === null || $sampleDate->format('Y-m-d') < $from || $sampleDate->format('Y-m-d') > ClinicTime::todayYmd()) {
                throw DomainRefusal::field('sample_date', 'Choose a date between ' . ($from !== null ? LabRequestRules::dateLabel(LabRequestRules::parseDate($from)) : 'the consent date') . ' and today');
            }
        }

        $reopened = false;
        $this->transition($r->getId(), function (LabRequest $r, DateTimeImmutable $now) use ($staff, $to, $reason, $sampleDate, &$reopened): ?DomainRefusal {
            $from = $r->effectiveStatus($now);
            if (!in_array($to, LabRequestTransitions::staffTargets($r, $now), true)) {
                return DomainRefusal::code(409, 'status_changed', LabRequestRules::STATUS_MESSAGES[$from] ?? 'This request changed.', ['status' => $from]);
            }
            $sampleAt = $sampleDate !== null
                ? ProcessClock::normalize((DateTimeImmutable::createFromFormat('!Y-m-d H:i', $sampleDate->format('Y-m-d') . ' 12:00', ClinicTime::zone()) ?: $now))
                : null;
            $validity = null;
            if ($from === LabRequest::STATUS_DECLINED) {
                $fresh    = LabRequestRules::validity($now);
                $validity = $fresh['valid_until']->format('Y-m-d') > $r->getValidUntil()->format('Y-m-d') ? $fresh : ['valid_until' => $r->getValidUntil(), 'expires_at' => $r->getExpiresAt()];
            } elseif ($from === LabRequest::STATUS_EXPIRED) {
                $validity = LabRequestRules::validity($now);
            } elseif ($from === LabRequest::STATUS_IN_LAB && $r->getExpiresAt() <= $now) {
                // C2 after the validity lapsed (in the lab never expires): a
                // fresh validity, or "booked" would be expired the moment it is
                // stored. No patient notice — the request never closed for them.
                $validity = LabRequestRules::validity($now);
            }
            $reopened = $from === LabRequest::STATUS_DECLINED || $from === LabRequest::STATUS_EXPIRED;
            $r->correctTo($to, $sampleAt, $validity, $now);
            $details = ['reason_given' => true] + ($sampleDate !== null ? ['sample_date' => $sampleDate->format('Y-m-d')] : []);
            $this->event($r, 'status_corrected', $from, $to, 'staff', $staff->getId(), LabRequestEvent::STAFF_NAME, $details, $now, $reason);
            $this->auditLab('Staff: ' . $staff->getEmail(), 'staff', 'lab_request.status_corrected', $r, [
                'from'         => $from,
                'to'           => $to,
                'reason_given' => true,
            ], $staff->getId());

            return null;
        });
        $this->notifier->doctorCorrected($r, $to);
        if ($reopened) {
            $this->notifier->reopened($r);
        }
        $notes = $this->requests->latestCorrectionNotes([$r->getId()]);

        return LabRequestPresenter::admin($r, LabRequestRules::now(), $notes[$r->getId()] ?? null, true);
    }

    /** Back-office overview `lab_requests` (spec §2.5). @return array<string,int> */
    public function overview(): array
    {
        $now    = LabRequestRules::now();
        $counts = $this->requests->platformCounts($now);

        // needs_review: requests with ≥ 1 REVIEWABLE unreviewed result — the
        // candidates from SQL, then the policy once per patient.
        $byPatient = [];
        foreach ($this->requests->reviewDueResults() as $row) {
            $byPatient[$row['patient_id']][] = $row;
        }
        $needs      = [];
        $practising = [];
        foreach ($byPatient as $patientId => $rows) {
            $patient = $this->patients->find($patientId);
            if (!$patient instanceof Patient) {
                continue;
            }
            $seen = $this->visibleByDoctorIds($patient, $now, array_map(static fn (array $x): string => $x['document_id'], $rows));
            foreach ($rows as $row) {
                $sid = $row['specialist_id'];
                $practising[$sid] ??= $this->doctorPractising($sid);
                if ($practising[$sid] && isset($seen[$sid][$row['document_id']])) {
                    $needs[$row['request_id']] = true;
                }
            }
        }

        return [
            'total'            => $this->requests->count(),
            'awaiting_consent' => $counts['awaiting_patient'],
            'in_progress'      => $counts['in_progress'],
            'result_ready'     => $counts['result_ready'],
            'needs_review'     => count($needs),
            'review_overdue'   => $this->requests->countReviewOverdue($now->modify('-' . LabRequestRules::REVIEW_OVERDUE_HOURS . ' hours')),
        ];
    }

    // =====================================================================
    // The request PDF and its signed links (spec §2.4, §6)
    // =====================================================================

    /** @return array{url: string, expires_at: string, filename: string} */
    public function issueLink(LabRequest $r, string $viewerType, string $viewerId, bool $download): array
    {
        $ttl   = LabRequestRules::LINK_MINUTES * 60;
        $token = $this->jwt->issueFileLink([
            'k'   => 'lab_request',
            'lr'  => $r->getId(),
            'vt'  => $viewerType,
            'vid' => strtolower($viewerId),
            'dl'  => $download ? 1 : 0,
        ], $ttl);

        return [
            'url'        => '/api/public/lab-requests/file?token=' . rawurlencode($token),
            'expires_at' => (string) DocumentSharingRules::iso(LabRequestRules::now()->modify('+' . $ttl . ' seconds')),
            'filename'   => $r->getNumber() . '.pdf',
        ];
    }

    /**
     * A signed link back to its request, the viewer re-checked: the patient
     * (own, accepted), the requesting doctor, or staff still active and
     * holding `labs.manage`. Anything else (an Rx link too) is null.
     *
     * @return array{request: LabRequest, viewer_type: string, viewer_id: string, download: bool}|null
     */
    public function resolveLink(string $token): ?array
    {
        $claims = $this->jwt->verifyFileLink($token);
        $labId  = self::linkRequestId($claims);
        $r      = $labId !== null ? $this->requests->findById($labId) : null;
        if ($r === null || $claims === null || !self::linkViewerAllowed($claims, $r, fn (string $userId): bool => $this->staffMayOpen($userId))) {
            return null;
        }

        return [
            'request'     => $r,
            'viewer_type' => (string) $claims['vt'],
            'viewer_id'   => strtolower((string) $claims['vid']),
            'download'    => (bool) ($claims['dl'] ?? false),
        ];
    }

    /** The request id of a LAB link (`k` = lab_request and `lr`), else null — a prescription link has neither. @param array<string,mixed>|null $claims */
    public static function linkRequestId(?array $claims): ?string
    {
        if ($claims === null || ($claims['k'] ?? null) !== 'lab_request' || !is_string($claims['lr'] ?? null) || $claims['lr'] === '') {
            return null;
        }

        return strtolower($claims['lr']);
    }

    /**
     * Is the link's viewer still entitled to this request? The patient (own,
     * accepted), the requesting doctor, or staff (`$staffMayOpen`: active and
     * holding labs.manage).
     *
     * @param array<string,mixed>     $claims
     * @param callable(string): bool $staffMayOpen
     */
    public static function linkViewerAllowed(array $claims, LabRequest $r, callable $staffMayOpen): bool
    {
        $id = strtolower((string) ($claims['vid'] ?? ''));
        if ($id === '') {
            return false;
        }

        return match ((string) ($claims['vt'] ?? '')) {
            'patient' => $r->getPatientId() === $id && $r->getConsentedAt() !== null,
            'doctor'  => $r->getSpecialistId() === $id,
            'staff'   => $staffMayOpen($id),
            default   => false,
        };
    }

    /**
     * The request PDF, watermarked by its effective status at render time
     * (NOT YET ACCEPTED while awaiting consent).
     *
     * @return array{filename: string, bytes: string}
     */
    public function pdf(LabRequest $r): array
    {
        $watermark = match ($r->effectiveStatus(LabRequestRules::now())) {
            LabRequest::STATUS_AWAITING_CONSENT => 'NOT YET ACCEPTED',
            LabRequest::STATUS_CANCELLED        => 'CANCELLED',
            LabRequest::STATUS_EXPIRED          => 'EXPIRED',
            LabRequest::STATUS_DECLINED         => 'DECLINED',
            default                             => null,
        };
        $doctor = $this->specialists->find($r->getSpecialistId());

        return [
            'filename' => $r->getNumber() . '.pdf',
            'bytes'    => $this->renderer->render(
                $r,
                $this->signatures->read($r->getSignatureKey()),
                $watermark,
                $doctor instanceof Specialist ? $doctor->timeZone() : ClinicTime::zone(),
            ),
        ];
    }

    public function staffMayOpen(string $userId): bool
    {
        $user = $userId !== '' ? $this->users->find($userId) : null;

        return $user instanceof User
            && $user->isActive()
            && (in_array('super_admin', $user->getRoles(), true) || in_array('labs.manage', $user->getPermissions(), true));
    }

    // =====================================================================
    // The transaction
    // =====================================================================

    /**
     * Run `$work($request, $now)` in ONE transaction holding the request's row
     * lock, after storing a due expiry (T9, actor system, no notices). `$work`
     * may RETURN a DomainRefusal: what was done is kept (the expiry) and the
     * refusal is thrown after the commit. Used by the sweeper too (with its
     * run's clock); `$work` gets a third argument: whether this call stored
     * the expiry.
     *
     * @template T
     * @param callable(LabRequest, DateTimeImmutable, bool): (T|DomainRefusal) $work
     * @return T
     */
    public function transition(string $labId, callable $work, ?DateTimeImmutable $now = null): mixed
    {
        $result = $this->em->wrapInTransaction(function () use ($labId, $work, $now): mixed {
            $r = $this->em->find(LabRequest::class, strtolower($labId));
            if (!$r instanceof LabRequest) {
                return DomainRefusal::notFound(LabRequestRules::NOT_FOUND);
            }
            $this->em->refresh($r, LockMode::PESSIMISTIC_WRITE);
            $now ??= LabRequestRules::now();
            $settled = $this->settleExpiry($r, $now);

            return $work($r, $now, $settled);
        });
        if ($result instanceof DomainRefusal) {
            throw $result;
        }

        return $result;
    }

    /** T9: store an expiry that is due (inside a transition). True when it did. */
    public function settleExpiry(LabRequest $r, DateTimeImmutable $now): bool
    {
        if (!$r->expiryDue($now)) {
            return false;
        }
        $from = $r->getStatus();
        $r->markExpired();
        $this->event($r, 'expired', $from, LabRequest::STATUS_EXPIRED, 'system', null, null, null, $r->getExpiresAt());
        $this->auditLab('System', 'system', 'lab_request.expired', $r, []);

        return true;
    }

    /** Append a timeline event (persisted with the transaction). @param array<string,mixed>|null $details */
    public function event(LabRequest $r, string $event, ?string $from, ?string $to, string $role, ?string $actorId, ?string $actorName, ?array $details, DateTimeImmutable $at, ?string $staffNote = null): void
    {
        $this->em->persist(new LabRequestEvent($r->getId(), $event, $from, $to, $role, $actorId, $actorName, $details, $at, $staffNote));
    }

    /**
     * An audit row for a lab request (or result): `resource_type` lab_request /
     * lab_result, the request's consultation, and metadata from the allowlist
     * only — always `number` and `patient_id` (the back office links to the
     * patient page). Never a test, a reason text or a review outcome.
     *
     * @param array<string,mixed> $meta
     */
    public function auditLab(string $actorName, string $role, string $action, LabRequest $r, array $meta, ?string $actorId = null, string $resourceType = 'lab_request', ?string $resourceId = null): void
    {
        $this->audit->record($actorName, $role, $action, $r->getAppointmentId(), $resourceType, $resourceId ?? $r->getId(), [
            'number'     => $r->getNumber(),
        ] + $meta + ['patient_id' => $r->getPatientId()], $actorId);
    }

    /** The lab request presenter's view of whether the requesting doctor is practising. */
    public function doctorPractising(string $specialistId): bool
    {
        $doctor = $this->specialists->find($specialistId);

        return $doctor instanceof Specialist && $this->policy->isPractising($doctor);
    }

    /**
     * The REVIEWABLE results now, for the sweeper's review reminder: visible
     * to the requesting doctor (all gates) and viewable.
     */
    public function isReviewable(LabRequestResult $result, ?DateTimeImmutable $now = null): bool
    {
        $r      = $result->getRequest();
        $doctor = $this->specialists->find($r->getSpecialistId());
        $patient = $this->patients->find($r->getPatientId());
        if (!$doctor instanceof Specialist || !$patient instanceof Patient || !$result->isViewable()) {
            return false;
        }

        return $this->policy->visibleDocument($doctor, $patient, $result->getDocumentId(), $now ?? LabRequestRules::now()) !== null;
    }

    // =====================================================================
    // Internals
    // =====================================================================

    /**
     * The access rules (spec §2.2): a given consultation must be the doctor's,
     * this patient's, and have taken place; otherwise the doctor must have
     * consulted the patient. Returns the consultation (or null).
     */
    private function checkAccess(Specialist $doctor, ?Patient $patient, ?string $appointmentId): ?Appointment
    {
        if ($appointmentId !== null && trim($appointmentId) !== '') {
            $a = DocumentSharingRules::lowerUuid($appointmentId) !== null ? $this->appointments->find(strtolower(trim($appointmentId))) : null;
            if (!$a instanceof Appointment || $a->isDeleted() || strtolower($a->getSpecialist()->getId()) !== strtolower($doctor->getId())) {
                throw DomainRefusal::field('appointment_id', 'This consultation is not yours');
            }
            if ($patient === null || strtolower($a->getPatient()->getId()) !== strtolower($patient->getId())) {
                throw DomainRefusal::field('appointment_id', 'This consultation is with another patient.');
            }
            if (!self::appointmentTookPlace($a)) {
                throw DomainRefusal::field('appointment_id', "This consultation hasn't taken place yet.");
            }

            return $a;
        }
        if ($patient === null || !$this->prescriptions->hasConsulted($doctor, $patient)) {
            throw DomainRefusal::field('patient_id', 'You can request tests only for patients you have consulted.', 'not_consulted');
        }

        return null;
    }

    /** Completed, or started (or within the 120-minute lead) and not cancelled / proposed / missed. */
    private static function appointmentTookPlace(Appointment $a): bool
    {
        if ($a->getStatus() === AppointmentStatus::COMPLETED) {
            return true;
        }
        $started = $a->getScheduledAt() <= LabRequestRules::now()->modify('+120 minutes');

        return $started && !in_array($a->getStatus(), [AppointmentStatus::CANCELLED, AppointmentStatus::PROPOSED, AppointmentStatus::MISSED], true);
    }

    /** The doctor's own source request id for a duplicate: another doctor's / unknown → null; another patient's → 422. */
    private function duplicatedFrom(Specialist $doctor, ?Patient $patient, mixed $raw): ?string
    {
        $id = DocumentSharingRules::lowerUuid($raw);
        if ($id === null) {
            return null;
        }
        $source = $this->requests->findForSpecialist($id, $doctor->getId());
        if ($source === null) {
            return null;
        }
        if ($patient === null || $source->getPatientId() !== strtolower($patient->getId())) {
            throw DomainRefusal::field('duplicated_from', 'This request is for another patient.');
        }

        return $source->getId();
    }

    /**
     * The signature to freeze: the saved one (422 when there is none) or one
     * drawn now.
     *
     * @param array<string,mixed> $signature
     * @throws ValidationException
     */
    private function signaturePng(Specialist $doctor, string $mode, array $signature): string
    {
        if ($mode === 'drawn') {
            return $this->signatures->fromDataUrl((string) ($signature['image'] ?? ''), 'signature');
        }
        $png = $this->signatures->read($doctor->getSignatureKey());
        if ($png === null) {
            throw new ValidationException(['signature' => 'You have no saved signature. Sign by hand, or add one in your profile.']);
        }

        return $png;
    }

    /** T7 totals from the rows: unreviewed, any abnormal, the latest review. */
    private function recomputeReviewTotals(LabRequest $r, DateTimeImmutable $now): void
    {
        $unreviewed = 0;
        $abnormal   = false;
        $latest     = null;
        foreach ($r->getResults() as $res) {
            if ($res->getReviewedAt() === null) {
                ++$unreviewed;
                continue;
            }
            $abnormal = $abnormal || $res->getReviewOutcome() === 'abnormal';
            $latest   = $latest === null || $res->getReviewedAt() > $latest ? $res->getReviewedAt() : $latest;
        }
        $r->applyReviewTotals($unreviewed, $abnormal, $latest, $now);
    }

    /** Unreviewed results this doctor can open now (visible + viewable). @param array<string,true> $visible */
    private function reviewableUnreviewed(LabRequest $r, array $visible): int
    {
        $n = 0;
        foreach ($r->getResults() as $res) {
            if ($res->getReviewedAt() === null && $res->isViewable() && isset($visible[$res->getDocumentId()])) {
                ++$n;
            }
        }

        return $n;
    }

    /** @return array<string,true> document ids this doctor sees of the patient now */
    private function visibleIds(Specialist $doctor, Patient $patient, DateTimeImmutable $now): array
    {
        $out = [];
        foreach ($this->policy->visibleDocuments($doctor, $patient, $now) as $v) {
            $out[$v->documentId] = true;
        }

        return $out;
    }

    /**
     * Per doctor, which of these documents they see now (gate 1 ignored).
     *
     * @param list<string> $documentIds
     * @return array<string, array<string, true>>
     */
    private function visibleByDoctorIds(Patient $patient, DateTimeImmutable $now, array $documentIds): array
    {
        $out = [];
        foreach ($this->policy->visibleByDoctor($patient, $now, array_values(array_unique($documentIds))) as $sid => $docs) {
            foreach ($docs as $v) {
                \assert($v instanceof VisibleDocument);
                $out[strtolower((string) $sid)][$v->documentId] = true;
            }
        }

        return $out;
    }

    private function patient(string $id): Patient
    {
        $p = DocumentSharingRules::lowerUuid($id) !== null ? $this->patients->find(strtolower(trim($id))) : null;
        if (!$p instanceof Patient || $p->isDeleted()) {
            throw DomainRefusal::field('patient_id', 'You can request tests only for patients you have consulted.', 'not_consulted');
        }

        return $p;
    }

    /** null when this isn't the status machine's to refuse; the refusal otherwise. */
    private static function refuse(string $effective, string $action, string $role, LabRequest $r): ?DomainRefusal
    {
        try {
            LabRequestTransitions::assertCan($effective, $action, $role, $r);
        } catch (LabTransitionRefused $e) {
            return new DomainRefusal($e->status, $e->getMessage(), $e->errors);
        }

        return null;
    }

    private static function idempotencyConflict(): DomainRefusal
    {
        return DomainRefusal::code(409, 'idempotency_conflict', 'This form was already sent with different details. Check it and send again.');
    }

    private static function tooManyResults(): DomainRefusal
    {
        return DomainRefusal::field('results', 'You can add up to ' . LabRequestRules::MAX_RESULTS . ' result files to one request.');
    }

    private static function group(mixed $raw): string
    {
        $group = is_string($raw) && $raw !== '' ? $raw : 'all';
        if (!in_array($group, LabRequestRules::GROUPS, true)) {
            throw DomainRefusal::field('group', 'Unknown filter');
        }

        return $group;
    }

    private static function search(mixed $raw): ?string
    {
        if (!is_string($raw)) {
            return null;
        }
        $q = mb_substr(trim($raw), 0, LabRequestRules::SEARCH_MAX);

        return $q !== '' ? $q : null;
    }

    /** `share` from the upload form: '1' / '0' (or a bool); null when absent. */
    private static function shareChoice(mixed $raw): ?bool
    {
        if ($raw === null || $raw === '') {
            return null;
        }

        return filter_var($raw, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE);
    }

    /** @return array<string,string> */
    private static function patientSnapshot(Patient $patient): array
    {
        $dob  = $patient->getDateOfBirth();
        $snap = [
            'name'          => $patient->getFullName(),
            'reference'     => LabRequestPresenter::patientReference($patient->getId()),
            'email'         => $patient->getEmail(),
            'date_of_birth' => $dob?->format('j M Y') ?? '',
            'dob_iso'       => $dob?->format('Y-m-d') ?? '',
            'sex'           => (string) (self::sex($patient->getGender()) ?? ''),
        ];
        if ($dob !== null) {
            $snap['age'] = (string) $dob->diff(ClinicTime::today())->y;
        }

        return $snap;
    }

    private static function sex(?string $gender): ?string
    {
        $g = strtolower(trim((string) $gender));

        return $g !== '' ? ucfirst($g) : null;
    }

    /** @return array{medication: string, allergies: string} */
    private static function prefill(Patient $patient): array
    {
        $medical = $patient->getMedical();
        $meds    = [];
        foreach ((array) ($medical['medications'] ?? []) as $m) {
            $line = trim(trim((string) ($m['name'] ?? '')) . ' ' . trim((string) ($m['dosage'] ?? '')));
            if ($line !== '') {
                $meds[] = $line;
            }
        }
        $rank      = ['life-threatening' => 0, 'severe' => 1, 'moderate' => 2, 'mild' => 3, 'unknown' => 4];
        $allergies = [];
        foreach ((array) ($medical['allergies'] ?? []) as $a) {
            $name = trim((string) ($a['allergen'] ?? ''));
            if ($name === '') {
                continue;
            }
            $severity    = HealthProfile::canonicalSeverity((string) ($a['severity'] ?? ''));
            $severity    = isset($rank[$severity]) ? $severity : 'unknown';
            $allergies[] = ['label' => $severity !== 'unknown' ? $name . ' (' . $severity . ')' : $name, 'rank' => $rank[$severity]];
        }
        usort($allergies, static fn (array $a, array $b): int => $a['rank'] <=> $b['rank']);

        return [
            'medication' => mb_substr(implode(', ', $meds), 0, LabRequestRules::TEXT_MAX),
            'allergies'  => mb_substr(implode(', ', array_column($allergies, 'label')), 0, LabRequestRules::TEXT_MAX),
        ];
    }

    private static function lastVisitIso(?string $raw): ?string
    {
        if ($raw === null || $raw === '') {
            return null;
        }
        try {
            return (new DateTimeImmutable($raw, ProcessClock::zone()))->format(DATE_ATOM);
        } catch (\Throwable) {
            return null;
        }
    }
}
