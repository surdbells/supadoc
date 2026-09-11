<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use App\Domain\Document\DocumentType;
use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/**
 * A file in a patient's medical record — a lab report, scan, prescription, etc.
 * Uploaded by the patient or by a clinician. The bytes live OUTSIDE the web root
 * (see MedicalDocumentStorage) and are only ever served through an authenticated,
 * ownership-checked endpoint; this row holds the metadata.
 */
#[ORM\Entity]
#[ORM\Table(name: 'medical_documents')]
#[ORM\Index(name: 'idx_med_docs_patient', columns: ['patient_id', 'created_at'])]
#[ORM\HasLifecycleCallbacks]
class MedicalDocument
{
    use TimestampsTrait;

    public const UPLOADER_PATIENT = 'patient';
    public const UPLOADER_DOCTOR  = 'doctor';
    public const UPLOADER_STAFF   = 'staff';

    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(name: 'patient_id', type: 'uuid')]
    private string $patientId;

    #[ORM\Column(name: 'uploader_role', type: 'string', length: 10)]
    private string $uploaderRole;

    #[ORM\Column(name: 'uploader_name', type: 'string', length: 200)]
    private string $uploaderName;

    /** Set when a clinician files it against a specific consultation. */
    #[ORM\Column(name: 'appointment_id', type: 'uuid', nullable: true)]
    private ?string $appointmentId = null;

    #[ORM\Column(name: 'document_type', type: 'string', length: 50)]
    private string $documentType;

    /** Free-text label when `documentType` is `other`. */
    #[ORM\Column(name: 'custom_type', type: 'string', length: 120, nullable: true)]
    private ?string $customType = null;

    /** Display name (from the original filename, sans extension). */
    #[ORM\Column(name: 'title', type: 'string', length: 200)]
    private string $title;

    /** The server-generated file name on disk (never the client's). */
    #[ORM\Column(name: 'stored_name', type: 'string', length: 200)]
    private string $storedName;

    #[ORM\Column(name: 'mime_type', type: 'string', length: 120)]
    private string $mimeType;

    #[ORM\Column(type: 'string', length: 10)]
    private string $extension;

    #[ORM\Column(name: 'size_bytes', type: 'integer')]
    private int $sizeBytes;

    public function __construct(
        string $patientId,
        string $uploaderRole,
        string $uploaderName,
        string $documentType,
        string $title,
        string $storedName,
        string $mimeType,
        string $extension,
        int $sizeBytes,
    ) {
        $this->id           = Uuid::uuid4()->toString();
        $this->patientId    = $patientId;
        $this->uploaderRole = $uploaderRole;
        $this->uploaderName = $uploaderName;
        $this->documentType = $documentType;
        $this->title        = $title;
        $this->storedName   = $storedName;
        $this->mimeType     = $mimeType;
        $this->extension    = $extension;
        $this->sizeBytes    = $sizeBytes;
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function getPatientId(): string
    {
        return $this->patientId;
    }

    public function getStoredName(): string
    {
        return $this->storedName;
    }

    public function getMimeType(): string
    {
        return $this->mimeType;
    }

    public function getTitle(): string
    {
        return $this->title;
    }

    public function getExtension(): string
    {
        return $this->extension;
    }

    public function setCustomType(?string $v): void
    {
        $this->customType = $v !== null && trim($v) !== '' ? trim($v) : null;
    }

    public function setAppointmentId(?string $v): void
    {
        $this->appointmentId = $v;
    }

    /** The human label — the custom text for `other`, otherwise the catalogue label. */
    public function typeLabel(): string
    {
        if ($this->documentType === 'other') {
            return $this->customType ?? 'Other';
        }

        return DocumentType::label($this->documentType);
    }

    /** e.g. "5MB", "512KB". */
    public function sizeLabel(): string
    {
        if ($this->sizeBytes >= 1024 * 1024) {
            return rtrim(rtrim(number_format($this->sizeBytes / (1024 * 1024), 1), '0'), '.') . 'MB';
        }
        if ($this->sizeBytes >= 1024) {
            return (int) round($this->sizeBytes / 1024) . 'KB';
        }

        return $this->sizeBytes . 'B';
    }

    /** @return array<string,mixed> */
    public function toArray(): array
    {
        return [
            'id'             => $this->id,
            'patient_id'     => $this->patientId,
            'uploader_role'  => $this->uploaderRole,
            'uploader_name'  => $this->uploaderName,
            'appointment_id' => $this->appointmentId,
            'document_type'  => $this->documentType,
            'custom_type'    => $this->customType,
            'type_label'     => $this->typeLabel(),
            'title'          => $this->title,
            'extension'      => $this->extension,
            'mime_type'      => $this->mimeType,
            'size_bytes'     => $this->sizeBytes,
            'size_label'     => $this->sizeLabel(),
            'created_at'     => $this->getCreatedAt()->format(DATE_ATOM),
        ];
    }
}
