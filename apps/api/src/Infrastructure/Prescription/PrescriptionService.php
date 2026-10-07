<?php

declare(strict_types=1);

namespace App\Infrastructure\Prescription;

use App\Domain\Entity\Appointment;
use App\Domain\Entity\Drug;
use App\Domain\Entity\Patient;
use App\Domain\Entity\Prescription;
use App\Domain\Entity\Specialist;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Enum\NotificationType;
use App\Domain\Exception\ValidationException;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\DrugRepository;
use App\Domain\Repository\PatientRepository;
use App\Domain\Repository\PrescriptionRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Settings\ClinicTime;
use App\Domain\Settings\HealthProfile;
use App\Infrastructure\Drug\DrugRoute;
use App\Infrastructure\Drug\DrugSearchTerms;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Email\MailService;
use App\Infrastructure\Service\AuditLogger;
use App\Infrastructure\Service\JwtService;
use App\Infrastructure\Service\PatientNotifier;
use DateTimeImmutable;
use DomainException;

/**
 * The e-prescribing workflow (GVM-RX-01/02): draft → send (locked, numbered,
 * signed, patient told) → expire / cancel-and-replace, plus the branded PDF and
 * the 15-minute signed links it is served through. Every state change and every
 * use of a signature is written to the audit log.
 *
 * Access rules live here too: a doctor prescribes only for their own
 * consultation, or — outside a consultation — only for a patient they have
 * consulted before.
 */
final class PrescriptionService
{
    public function __construct(
        private readonly PrescriptionRepository $prescriptions,
        private readonly DrugRepository $drugs,
        private readonly PatientRepository $patients,
        private readonly SpecialistRepository $specialists,
        private readonly AppointmentRepository $appointments,
        private readonly PrescriptionNumberGenerator $numbers,
        private readonly PrescriptionSettings $settings,
        private readonly SignatureStore $signatures,
        private readonly PrescriptionPdfRenderer $renderer,
        private readonly JwtService $jwt,
        private readonly PatientNotifier $notifier,
        private readonly MailService $mail,
        private readonly AuditLogger $audit,
        private readonly string $webUrl,
    ) {
    }

    // ----- catalogue -----

    /** @return list<array<string,mixed>> */
    public function searchDrugs(string $query, int $limit = 20): array
    {
        return array_map(
            static fn (Drug $d): array => $d->toArray(),
            $this->drugs->search(DrugSearchTerms::from($query), $limit),
        );
    }

    // ----- authoring -----

    /** Minutes before a booked start time that a doctor may already prescribe (joining a call early). */
    private const CONSULT_LEAD_MINUTES = 120;

    /**
     * Whether `$doctor` has consulted `$patient` — a completed appointment, or a
     * non-cancelled one that has started (or starts within the lead window).
     * Gates standalone prescribing and the clinical side panel; a cancelled or
     * future booking is not a consultation.
     */
    public function hasConsulted(Specialist $doctor, Patient $patient): bool
    {
        return $this->appointments->hasConsultedWith(
            $doctor->getId(),
            $patient->getId(),
            new DateTimeImmutable(),
            self::CONSULT_LEAD_MINUTES,
        );
    }

    /** Whether a prescription may be written against this appointment now. */
    private function appointmentIsPrescribable(Appointment $appointment): bool
    {
        if ($appointment->getStatus() === AppointmentStatus::COMPLETED) {
            return true;
        }
        $started = $appointment->getScheduledAt() <= (new DateTimeImmutable())->modify('+' . self::CONSULT_LEAD_MINUTES . ' minutes');

        return $started && $appointment->getStatus() !== AppointmentStatus::CANCELLED;
    }

    /**
     * Start a draft (in a consultation when `$appointment` is given).
     *
     * @throws ValidationException
     */
    public function createDraft(Specialist $doctor, Patient $patient, ?Appointment $appointment, array $body): Prescription
    {
        if ($appointment !== null) {
            if ($appointment->getSpecialist()->getId() !== $doctor->getId()
                || $appointment->getPatient()->getId() !== $patient->getId()) {
                throw new ValidationException(['appointment_id' => 'This consultation is not yours']);
            }
            if (!$this->appointmentIsPrescribable($appointment)) {
                throw new ValidationException(['appointment_id' => $appointment->getStatus() === AppointmentStatus::CANCELLED
                    ? 'This consultation was cancelled before it took place, so you can’t prescribe against it.'
                    : 'This consultation hasn’t taken place yet. You can prescribe during or after the call.']);
            }
        } elseif (!$this->hasConsulted($doctor, $patient)) {
            throw new ValidationException(['patient_id' => 'You can only prescribe for patients you have consulted.']);
        }

        $today = ClinicTime::today();
        $clean = $this->normalize($body, $today);
        $rx    = new Prescription(
            $patient->getId(),
            $doctor->getId(),
            $appointment?->getId(),
            $this->numbers->next(),
            $clean['valid_until'] ?? $today->modify('+' . $this->settings->get('valid_days') . ' days'),
        );
        $this->apply($rx, $clean, $today);
        $this->prescriptions->save($rx);

        $this->audit->record($doctor->getName(), 'doctor', 'prescription.drafted', $rx->getAppointmentId(), 'prescription', $rx->getId(), [
            'number' => $rx->getNumber(),
        ]);

        return $rx;
    }

    /** @throws ValidationException|DomainException */
    public function updateDraft(Prescription $rx, Specialist $doctor, array $body): Prescription
    {
        $this->assertDraft($rx);
        $today = ClinicTime::today();
        $this->apply($rx, $this->normalize($body, $today), $today);
        $this->prescriptions->save($rx);

        return $rx;
    }

    /** @throws DomainException */
    public function deleteDraft(Prescription $rx, Specialist $doctor): void
    {
        $this->assertDraft($rx);
        $this->audit->record($doctor->getName(), 'doctor', 'prescription.draft_deleted', $rx->getAppointmentId(), 'prescription', $rx->getId(), [
            'number' => $rx->getNumber(),
        ]);
        $this->prescriptions->remove($rx);
        $this->prescriptions->flush();
    }

    /**
     * Sign, lock and send a draft to the patient.
     *
     * Body: optional `form` (final edits), `confirm` {allergies, doses, patient}
     * — the pre-send checklist — and `signature` {mode: saved|drawn, image?:
     * data URL, save?: bool}.
     *
     * @throws ValidationException|DomainException
     */
    public function send(Prescription $rx, Specialist $doctor, array $body): Prescription
    {
        $this->assertDraft($rx);
        $today = ClinicTime::today();
        if (is_array($body['form'] ?? null)) {
            $this->apply($rx, $this->normalize($body['form'], $today), $today);
        }

        $confirm = is_array($body['confirm'] ?? null) ? $body['confirm'] : [];
        foreach (['allergies', 'doses', 'patient'] as $check) {
            if (!filter_var($confirm[$check] ?? false, FILTER_VALIDATE_BOOLEAN)) {
                throw new ValidationException(['confirm' => 'Tick every item on the checklist before sending']);
            }
        }

        $patient = $this->patientOf($rx);
        if ($patient->getDateOfBirth() === null) {
            throw new ValidationException([
                'patient' => "The patient's date of birth is not on file. Pharmacists need it to check the prescription. Ask the patient to add it in their profile before you send.",
            ], "The patient's date of birth is missing");
        }
        $errors  = PrescriptionForm::sendErrors(
            $this->formState($rx),
            PrescriptionForm::asksPregnancy($patient->getGender(), $patient->getDateOfBirth(), $today),
        );
        if ($rx->getValidUntil() !== null && $rx->getValidUntil() < $today) {
            $errors['valid_until'] = 'Valid until must be today or later';
        }
        if ($errors !== []) {
            throw new ValidationException($errors, 'Complete the prescription before sending');
        }

        // Signature: the saved profile picture, or one drawn by hand now.
        $signature = is_array($body['signature'] ?? null) ? $body['signature'] : [];
        $mode      = (string) ($signature['mode'] ?? 'saved');
        if ($mode === 'drawn') {
            $png = $this->signatures->fromDataUrl((string) ($signature['image'] ?? ''), 'signature');
            if (filter_var($signature['save'] ?? false, FILTER_VALIDATE_BOOLEAN)) {
                $this->replaceSavedSignature($doctor, $png);
                $this->audit->record($doctor->getName(), 'doctor', 'signature.updated', null, 'specialist', $doctor->getId());
            }
        } elseif ($mode === 'saved') {
            $png = $this->signatures->read($doctor->getSignatureKey());
            if ($png === null) {
                throw new ValidationException(['signature' => 'You have no saved signature. Sign by hand, or add one in your profile.']);
            }
        } else {
            throw new ValidationException(['signature' => 'Choose how to sign']);
        }
        $frozenKey = $this->signatures->store($png, 'rx-signatures');

        $now = new DateTimeImmutable();
        $rx->send($this->prescriberDetails($doctor), $this->patientDetails($patient), $mode, $frozenKey, $now);
        $this->prescriptions->save($rx);
        $this->recordVitals($patient, $rx, $now);

        $this->audit->record($doctor->getName(), 'doctor', 'prescription.sent', $rx->getAppointmentId(), 'prescription', $rx->getId(), [
            'number'     => $rx->getNumber(),
            'medicines'  => count($rx->getItems()),
            'valid_until' => $rx->getValidUntil()?->format('Y-m-d'),
        ]);
        $this->audit->record($doctor->getName(), 'doctor', 'signature.used', $rx->getAppointmentId(), 'prescription', $rx->getId(), [
            'mode' => $mode,
        ]);

        $this->tellPatientSent($patient, $doctor, $rx);

        return $rx;
    }

    /**
     * Cancel an active prescription; with `$replace`, also start a replacement
     * draft pre-filled from it.
     *
     * @return array{0: Prescription, 1: ?Prescription}
     * @throws ValidationException|DomainException
     */
    public function cancel(Prescription $rx, Specialist $doctor, string $reason, bool $replace): array
    {
        $status = $rx->effectiveStatus();
        if ($status === Prescription::STATUS_DRAFT) {
            throw new DomainException('A draft has not been sent — delete it instead of cancelling.');
        }
        if ($status !== Prescription::STATUS_ACTIVE) {
            throw new DomainException(sprintf('This prescription is already %s and cannot be cancelled.', $status));
        }
        $reason = trim($reason);
        if (mb_strlen($reason) < 3) {
            throw new ValidationException(['reason' => 'Say why you are cancelling it']);
        }
        if (mb_strlen($reason) > 300) {
            throw new ValidationException(['reason' => 'Keep the reason under 300 characters']);
        }

        $now = new DateTimeImmutable();
        $rx->cancel($reason, $now);
        $replacement = null;
        if ($replace) {
            $today       = ClinicTime::today();
            $replacement = new Prescription(
                $rx->getPatientId(),
                $doctor->getId(),
                $rx->getAppointmentId(),
                $this->numbers->next(),
                $today->modify('+' . $this->settings->get('valid_days') . ' days'),
            );
            $state = $this->formState($rx);
            $state['valid_until'] = null;
            $this->apply($replacement, $state, $today);
            $replacement->markReplaces($rx->getId());
            $this->prescriptions->persist($replacement);
            $rx->linkReplacement($replacement->getId());
        }
        $this->prescriptions->save($rx);

        $this->audit->record($doctor->getName(), 'doctor', 'prescription.cancelled', $rx->getAppointmentId(), 'prescription', $rx->getId(), [
            'number'      => $rx->getNumber(),
            'reason'      => $reason,
            'replaced_by' => $replacement?->getNumber(),
        ]);

        $patient = $this->patients->find($rx->getPatientId());
        if ($patient instanceof Patient) {
            $doctorName = $doctor->getName();
            $this->notifier->notify(
                $patient,
                NotificationType::PRESCRIPTION,
                'Prescription cancelled',
                sprintf('%s has cancelled your prescription %s. Do not use it at a pharmacy.', $doctorName, $rx->getNumber()),
                '/dashboard/prescriptions/' . $rx->getId(),
            );
            $this->email($patient, EmailTemplates::prescriptionCancelled(
                $patient->getFirstName(),
                $doctorName,
                $rx->getNumber(),
                $replace,
                $this->webUrl . '/dashboard/prescriptions',
            ));
        }

        return [$rx, $replacement];
    }

    /**
     * Rows for list views, with `patient_name` filled in for drafts and
     * legacy prescriptions (which have no frozen patient snapshot).
     *
     * @param list<Prescription> $rows
     * @return list<array<string,mixed>>
     */
    public function rowsFor(array $rows, bool $full = false): array
    {
        $names = [];

        return array_map(function (Prescription $rx) use ($full, &$names): array {
            $row = $full ? $rx->toArray() : $rx->toSummaryArray();
            if (($row['patient_name'] ?? null) === null) {
                $id = $rx->getPatientId();
                if (!array_key_exists($id, $names)) {
                    $patient    = $this->patients->find($id);
                    $names[$id] = $patient instanceof Patient ? $patient->getFullName() : null;
                }
                $row['patient_name'] = $names[$id];
            }

            return $row;
        }, $rows);
    }

    // ----- documents -----

    /**
     * The branded PDF, stamped DRAFT / EXPIRED / CANCELLED as its state
     * requires (the stored prescription is never altered).
     *
     * @return array{filename: string, bytes: string}
     */
    public function pdf(Prescription $rx): array
    {
        $status    = $rx->effectiveStatus();
        $watermark = match ($status) {
            Prescription::STATUS_DRAFT     => 'DRAFT',
            Prescription::STATUS_EXPIRED   => 'EXPIRED',
            Prescription::STATUS_CANCELLED => 'CANCELLED',
            default                        => null,
        };
        if ($rx->isDraft()) {
            $patient    = $this->patients->find($rx->getPatientId());
            $doctor     = $rx->getSpecialistId() !== null ? $this->specialists->find($rx->getSpecialistId()) : null;
            $patientArr = $patient instanceof Patient ? $this->patientDetails($patient) : [];
            $doctorArr  = $doctor instanceof Specialist ? $this->prescriberDetails($doctor) : [];
            $signature  = null;
        } else {
            $patientArr = $rx->getPatientSnapshot();
            if ($patientArr === []) {
                $patient    = $this->patients->find($rx->getPatientId());
                $patientArr = $patient instanceof Patient ? $this->patientDetails($patient) : [];
            }
            $patientArr = $this->withAge($patientArr);
            $doctorArr  = $rx->getPrescriber();
            $signature  = $this->signatures->read($rx->getSignatureKey());
        }

        return [
            'filename' => $rx->getNumber() . '.pdf',
            'bytes'    => $this->renderer->render($rx, $patientArr, $doctorArr, $signature, $this->verifyUrl(), $watermark),
        ];
    }

    /**
     * A signed link (valid for the admin-set number of minutes) through which
     * the PDF is viewed, downloaded or printed.
     *
     * @return array{url: string, expires_at: string, filename: string}
     */
    public function issueLink(Prescription $rx, string $viewerType, string $viewerId, bool $download): array
    {
        $ttl   = $this->settings->get('link_minutes') * 60;
        $token = $this->jwt->issueFileLink([
            'rx'  => $rx->getId(),
            'vt'  => $viewerType,
            'vid' => $viewerId,
            'dl'  => $download ? 1 : 0,
        ], $ttl);

        return [
            'url'        => '/api/public/prescriptions/file?token=' . rawurlencode($token),
            'expires_at' => (new DateTimeImmutable('+' . $ttl . ' seconds'))->format(DATE_ATOM),
            'filename'   => $rx->getNumber() . '.pdf',
        ];
    }

    /**
     * Resolve a signed link back to its prescription, re-checking that the
     * viewer is still entitled to it (a patient never gets a draft).
     *
     * @return array{rx: Prescription, viewer_type: string, viewer_id: string, download: bool}|null
     */
    public function resolveLink(string $token): ?array
    {
        $claims = $this->jwt->verifyFileLink($token);
        if ($claims === null) {
            return null;
        }
        $rx = $this->prescriptions->findById((string) ($claims['rx'] ?? ''));
        if ($rx === null) {
            return null;
        }
        $type = (string) ($claims['vt'] ?? '');
        $id   = (string) ($claims['vid'] ?? '');
        $ok   = match ($type) {
            'patient' => $rx->getPatientId() === $id && !$rx->isDraft(),
            'doctor'  => $rx->getSpecialistId() === $id,
            'staff'   => !$rx->isDraft(),
            default   => false,
        };

        return $ok ? ['rx' => $rx, 'viewer_type' => $type, 'viewer_id' => $id, 'download' => (bool) ($claims['dl'] ?? false)] : null;
    }

    public function verifyUrl(): string
    {
        return $this->webUrl . '/check-prescription';
    }

    // ----- side panel -----

    /**
     * Read-only patient information for the doctor while prescribing (AC1–AC6):
     * allergies most serious first, latest readings (flagged when older than 7
     * days), current medicines grouped by what they are for, and whether to ask
     * the pregnancy question.
     */
    public function clinicalSummary(Patient $patient): array
    {
        $today   = ClinicTime::today();
        $medical = $patient->getMedical();
        $rank    = ['life-threatening' => 0, 'severe' => 1, 'moderate' => 2, 'mild' => 3, 'unknown' => 4];
        $allergies = array_map(static function (array $a) use ($rank): array {
            $severity = HealthProfile::canonicalSeverity((string) ($a['severity'] ?? ''));
            $severity = array_key_exists($severity, $rank) ? $severity : 'unknown';

            return [
                'substance' => (string) ($a['allergen'] ?? ''),
                'reaction'  => (string) ($a['reaction'] ?? ''),
                'severity'  => $severity,
            ];
        }, $medical['allergies'] ?? []);
        usort($allergies, static fn (array $a, array $b): int => $rank[$a['severity']] <=> $rank[$b['severity']]);

        $groups = [];
        foreach ($medical['medications'] ?? [] as $m) {
            $for = trim((string) ($m['reason'] ?? ''));
            $groups[$for !== '' ? $for : 'Not stated'][] = [
                'name'      => (string) ($m['name'] ?? ''),
                'amount'    => (string) ($m['dosage'] ?? ''),
                'frequency' => (string) ($m['frequency'] ?? ''),
                'herbal'    => in_array(strtolower((string) ($m['herbal'] ?? '')), ['1', 'yes', 'true', 'on'], true),
            ];
        }
        $medicines = [];
        foreach ($groups as $for => $rows) {
            $medicines[] = ['for' => $for, 'items' => $rows];
        }

        $vitals = [];
        foreach (PrescriptionForm::READINGS as $key => [$label, $unit]) {
            $v = $patient->getLatestVitals()[$key] ?? null;
            if ($v === null) {
                continue;
            }
            $at = strtotime((string) ($v['taken_at'] ?? '')) ?: null;
            $vitals[] = [
                'key'       => $key,
                'label'     => $label,
                'value'     => (string) $v['value'],
                'unit'      => $unit,
                'taken_at'  => $at !== null ? date(DATE_ATOM, $at) : null,
                'source'    => PrescriptionForm::READING_SOURCES[$v['source'] ?? ''] ?? null,
                'stale'     => $at === null || $at < strtotime('-7 days'),
            ];
        }

        $dob = $patient->getDateOfBirth();

        return [
            'patient' => [
                'id'            => $patient->getId(),
                'name'          => $patient->getFullName(),
                'gender'        => $patient->getGender(),
                'date_of_birth' => $dob?->format('Y-m-d'),
                'age'           => $dob?->diff($today)->y,
            ],
            'allergies_recorded' => $allergies !== [],
            'allergies'          => $allergies,
            'ask_pregnancy'      => PrescriptionForm::asksPregnancy($patient->getGender(), $dob, $today),
            'vitals'             => $vitals,
            'medicines'          => $medicines,
            'conditions'         => array_values(array_map(
                static fn (array $c): string => trim(((string) ($c['condition'] ?? '')) . (($c['status'] ?? '') !== '' ? ' (' . $c['status'] . ')' : '')),
                $medical['conditions'] ?? [],
            )),
        ];
    }

    /** Defaults + option lists the composer needs. */
    public function formOptions(): array
    {
        $today = ClinicTime::today();

        return [
            'valid_days'        => $this->settings->get('valid_days'),
            'default_valid_until' => $today->modify('+' . $this->settings->get('valid_days') . ' days')->format('Y-m-d'),
            'max_items'         => Prescription::MAX_ITEMS,
            'rows_per_page'     => Prescription::ROWS_PER_PAGE,
            'max_repeats'       => PrescriptionForm::MAX_REPEATS,
            'limits'            => PrescriptionForm::LIMITS,
            'routes'            => DrugRoute::ALL,
            'readings'          => array_map(
                static fn (array $r, string $k): array => ['key' => $k, 'label' => $r[0], 'unit' => $r[1], 'min' => $r[2], 'max' => $r[3]],
                PrescriptionForm::READINGS,
                array_keys(PrescriptionForm::READINGS),
            ),
            'reading_sources'   => PrescriptionForm::READING_SOURCES,
            'pregnancy'         => PrescriptionForm::PREGNANCY,
            'follow_up_modes'   => PrescriptionForm::FOLLOW_UP_MODES,
        ];
    }

    // ----- signature management -----

    /** @throws ValidationException */
    public function saveSignature(Specialist $doctor, string $bytes): void
    {
        $this->replaceSavedSignature($doctor, $this->signatures->normalize($bytes));
        $this->audit->record($doctor->getName(), 'doctor', 'signature.updated', null, 'specialist', $doctor->getId());
    }

    public function removeSignature(Specialist $doctor): void
    {
        $this->signatures->delete($doctor->getSignatureKey());
        $doctor->setSignatureKey(null);
        $this->specialists->save($doctor);
        $this->audit->record($doctor->getName(), 'doctor', 'signature.removed', null, 'specialist', $doctor->getId());
    }

    public function signatureImage(Specialist $doctor): ?string
    {
        return $this->signatures->read($doctor->getSignatureKey());
    }

    // ----- internals -----

    /** @throws ValidationException */
    private function normalize(array $body, DateTimeImmutable $today): array
    {
        [$clean, $errors] = PrescriptionForm::normalize(
            $body,
            fn (string $rxcui): ?Drug => $this->drugs->findByRxcui($rxcui),
            $today,
        );
        if ($errors !== []) {
            throw new ValidationException($errors);
        }

        return $clean;
    }

    private function apply(Prescription $rx, array $clean, DateTimeImmutable $today): void
    {
        $rx->setReadings($clean['readings'] ?? []);
        $rx->setConsultation($clean['reason'] ?? null, $clean['icd_code'] ?? null, $clean['current_medications'] ?? null, $clean['pregnancy_status'] ?? null);
        $rx->setItems($clean['items'] ?? []);
        $rx->setAdvice($clean['advice'] ?? null, $clean['follow_up_date'] ?? null, $clean['follow_up_mode'] ?? null, $clean['tests_referrals'] ?? null);
        $rx->setValidity(
            $clean['valid_until'] ?? $rx->getValidUntil() ?? $today->modify('+' . $this->settings->get('valid_days') . ' days'),
            (bool) ($clean['allows_repeats'] ?? false),
        );
    }

    /** The prescription's current form content, in normalised-form shape. */
    private function formState(Prescription $rx): array
    {
        return [
            'readings'            => $rx->getReadings(),
            'reason'              => $rx->getReason(),
            'icd_code'            => $rx->getIcdCode(),
            'current_medications' => $rx->getCurrentMedications(),
            'pregnancy_status'    => $rx->getPregnancyStatus(),
            'items'               => $rx->getItems(),
            'advice'              => $rx->getAdvice(),
            'follow_up_date'      => $rx->getFollowUpDate(),
            'follow_up_mode'      => $rx->getFollowUpMode(),
            'tests_referrals'     => $rx->getTestsReferrals(),
            'valid_until'         => $rx->getValidUntil(),
            'allows_repeats'      => $rx->allowsRepeats(),
        ];
    }

    private function assertDraft(Prescription $rx): void
    {
        if (!$rx->isDraft()) {
            throw new DomainException('This prescription has been sent and is locked. Cancel and replace it to make changes.');
        }
    }

    private function patientOf(Prescription $rx): Patient
    {
        $patient = $this->patients->find($rx->getPatientId());
        if (!$patient instanceof Patient) {
            throw new DomainException('The patient for this prescription no longer exists.');
        }

        return $patient;
    }

    /** @return array<string,string> */
    private function prescriberDetails(Specialist $doctor): array
    {
        return [
            'id'             => $doctor->getId(),
            'name'           => $doctor->getName(),
            'specialty'      => $doctor->getSpecialty(),
            'qualifications' => (string) ($doctor->getQualifications() ?? ''),
            'mdcn_number'    => (string) ($doctor->getMdcnNumber() ?? ''),
        ];
    }

    /** @return array<string,string> */
    private function patientDetails(Patient $patient): array
    {
        $dob = $patient->getDateOfBirth();

        return $this->withAge([
            'name'          => $patient->getFullName(),
            'date_of_birth' => $dob?->format('j M Y') ?? '',
            'dob_iso'       => $dob?->format('Y-m-d') ?? '',
            'sex'           => ucfirst(strtolower((string) ($patient->getGender() ?? ''))),
            'reference'     => 'P-' . strtoupper(substr(str_replace('-', '', $patient->getId()), 0, 8)),
        ]);
    }

    /** @param array<string,string> $p */
    private function withAge(array $p): array
    {
        if (($p['dob_iso'] ?? '') !== '') {
            try {
                $p['age'] = (string) (new DateTimeImmutable($p['dob_iso']))->diff(ClinicTime::today())->y;
            } catch (\Throwable) {
                // leave age out
            }
        }

        return $p;
    }

    private function replaceSavedSignature(Specialist $doctor, string $png): void
    {
        $old = $doctor->getSignatureKey();
        $doctor->setSignatureKey($this->signatures->store($png, 'signatures'));
        $this->specialists->save($doctor);
        $this->signatures->delete($old);
    }

    /** Readings on the form become the patient's latest readings (newer wins). */
    private function recordVitals(Patient $patient, Prescription $rx, DateTimeImmutable $now): void
    {
        $readings = $rx->getReadings();
        $takenAt  = (string) ($readings['taken_at'] ?? $now->format(DATE_ATOM));
        $source   = (string) ($readings['source'] ?? 'video');
        $entries  = [];
        foreach (PrescriptionForm::READINGS as $key => [, $unit]) {
            if (($readings[$key] ?? '') !== '') {
                $entries[$key] = ['value' => (string) $readings[$key], 'unit' => $unit, 'taken_at' => $takenAt, 'source' => $source];
            }
        }
        if ($entries !== []) {
            try {
                $patient->recordVitals($entries);
                $this->patients->save($patient);
            } catch (\Throwable) {
                // the prescription is already sent; readings are a convenience
            }
        }
    }

    private function tellPatientSent(Patient $patient, Specialist $doctor, Prescription $rx): void
    {
        $doctorName = $doctor->getName();
        // Never names medicines or the reason (AC22).
        $this->notifier->notify(
            $patient,
            NotificationType::PRESCRIPTION,
            'New prescription',
            sprintf('%s has sent your prescription %s.', $doctorName, $rx->getNumber()),
            '/dashboard/prescriptions/' . $rx->getId(),
        );
        $this->email($patient, EmailTemplates::prescriptionSent(
            $patient->getFirstName(),
            $doctorName,
            $rx->getNumber(),
            $rx->getValidUntil()?->format('j M Y') ?? '',
            $this->webUrl . '/dashboard/prescriptions/' . $rx->getId(),
        ));
    }

    /** @param array{subject:string,html:string} $tpl */
    private function email(Patient $patient, array $tpl): void
    {
        try {
            $settings = $patient->getSettings();
            if (!($settings['delivery']['email'] ?? true) || !$this->mail->isConfigured()) {
                return;
            }
            $this->mail->send($patient->getEmail(), $patient->getFullName(), $tpl['subject'], $tpl['html']);
        } catch (\Throwable) {
            // email is best-effort; the in-app notification already landed
        }
    }
}
