<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/**
 * One health reading (temperature, blood pressure, weight …) in a patient's
 * history — see VitalsForm for the catalogue. Append-only: a new reading is a
 * new row, so nothing a doctor recorded is ever overwritten by the patient.
 * `Patient::$latestVitals` caches the newest reading of each type.
 */
#[ORM\Entity]
#[ORM\Table(name: 'vital_readings')]
#[ORM\Index(name: 'idx_vitals_patient_key_taken', columns: ['patient_id', 'reading_key', 'taken_at'])]
#[ORM\Index(name: 'idx_vitals_prescription', columns: ['prescription_id'])]
class VitalReading
{
    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(name: 'patient_id', type: 'uuid')]
    private string $patientId;

    /** A VitalsForm::READINGS key, e.g. `blood_pressure`. */
    #[ORM\Column(name: 'reading_key', type: 'string', length: 32)]
    private string $key;

    /** As validated: a number ("37.8") or, for blood pressure, "120/80". */
    #[ORM\Column(type: 'string', length: 20)]
    private string $value;

    #[ORM\Column(type: 'string', length: 20)]
    private string $unit;

    #[ORM\Column(name: 'taken_at', type: 'datetime_immutable')]
    private DateTimeImmutable $takenAt;

    /** A VitalsForm::SOURCES key: self_reported, patient_device, video, clinic, lab. */
    #[ORM\Column(type: 'string', length: 20)]
    private string $source;

    /** `patient` or `doctor`. */
    #[ORM\Column(name: 'recorded_by_type', type: 'string', length: 10)]
    private string $recordedByType;

    /** The patient's id, or the doctor's specialist id. */
    #[ORM\Column(name: 'recorded_by_id', type: 'uuid', nullable: true)]
    private ?string $recordedById;

    #[ORM\Column(name: 'appointment_id', type: 'uuid', nullable: true)]
    private ?string $appointmentId;

    /** Set when the reading was written on a prescription. */
    #[ORM\Column(name: 'prescription_id', type: 'uuid', nullable: true)]
    private ?string $prescriptionId;

    #[ORM\Column(name: 'created_at', type: 'datetime_immutable')]
    private DateTimeImmutable $createdAt;

    public function __construct(
        string $patientId,
        string $key,
        string $value,
        string $unit,
        DateTimeImmutable $takenAt,
        string $source,
        string $recordedByType,
        ?string $recordedById = null,
        ?string $appointmentId = null,
        ?string $prescriptionId = null,
    ) {
        $this->id             = Uuid::uuid4()->toString();
        $this->patientId      = $patientId;
        $this->key            = $key;
        $this->value          = $value;
        $this->unit           = $unit;
        $this->takenAt        = $takenAt;
        $this->source         = $source;
        $this->recordedByType = $recordedByType;
        $this->recordedById   = $recordedById;
        $this->appointmentId  = $appointmentId;
        $this->prescriptionId = $prescriptionId;
        $this->createdAt      = new DateTimeImmutable();
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function getPatientId(): string
    {
        return $this->patientId;
    }

    public function getKey(): string
    {
        return $this->key;
    }

    public function getValue(): string
    {
        return $this->value;
    }

    public function getUnit(): string
    {
        return $this->unit;
    }

    public function getTakenAt(): DateTimeImmutable
    {
        return $this->takenAt;
    }

    public function getSource(): string
    {
        return $this->source;
    }

    public function getRecordedByType(): string
    {
        return $this->recordedByType;
    }

    public function getRecordedById(): ?string
    {
        return $this->recordedById;
    }

    public function getAppointmentId(): ?string
    {
        return $this->appointmentId;
    }

    public function getPrescriptionId(): ?string
    {
        return $this->prescriptionId;
    }

    public function getCreatedAt(): DateTimeImmutable
    {
        return $this->createdAt;
    }
}
