<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/**
 * A referral raised during a consultation — to a specialist, hospital, lab or
 * imaging service. Created signed by the doctor and visible to the patient.
 */
#[ORM\Entity]
#[ORM\Table(name: 'referrals')]
#[ORM\Index(name: 'idx_referrals_appointment', columns: ['appointment_id'])]
#[ORM\HasLifecycleCallbacks]
class Referral
{
    use TimestampsTrait;

    public const TYPES = ['specialist', 'hospital', 'laboratory', 'imaging'];

    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(name: 'appointment_id', type: 'uuid')]
    private string $appointmentId;

    #[ORM\Column(name: 'patient_id', type: 'uuid')]
    private string $patientId;

    #[ORM\Column(name: 'referral_type', type: 'string', length: 20)]
    private string $referralType = 'specialist';

    /** Target specialty or facility, e.g. "Cardiology" or "Lagos General Hospital". */
    #[ORM\Column(type: 'string', length: 200)]
    private string $target = '';

    #[ORM\Column(type: 'text')]
    private string $reason = '';

    #[ORM\Column(name: 'clinical_summary', type: 'text', nullable: true)]
    private ?string $clinicalSummary = null;

    #[ORM\Column(type: 'string', length: 20, options: ['default' => 'routine'])]
    private string $priority = 'routine';

    #[ORM\Column(type: 'string', length: 20, options: ['default' => 'created'])]
    private string $status = 'created';

    #[ORM\Column(name: 'author_name', type: 'string', length: 200, nullable: true)]
    private ?string $authorName = null;

    public function __construct(string $appointmentId, string $patientId)
    {
        $this->id            = Uuid::uuid4()->toString();
        $this->appointmentId = $appointmentId;
        $this->patientId     = $patientId;
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function setType(string $type): void
    {
        $this->referralType = in_array($type, self::TYPES, true) ? $type : 'specialist';
    }

    public function setTarget(string $target): void
    {
        $this->target = trim($target);
    }

    public function getTarget(): string
    {
        return $this->target;
    }

    public function setReason(string $reason): void
    {
        $this->reason = trim($reason);
    }

    public function getReason(): string
    {
        return $this->reason;
    }

    public function setClinicalSummary(?string $v): void
    {
        $this->clinicalSummary = $v !== null && trim($v) !== '' ? trim($v) : null;
    }

    public function setPriority(string $priority): void
    {
        $this->priority = in_array($priority, ['routine', 'urgent'], true) ? $priority : 'routine';
    }

    public function setAuthor(string $author): void
    {
        $this->authorName = $author;
    }

    public function toArray(): array
    {
        return [
            'id'               => $this->id,
            'appointment_id'   => $this->appointmentId,
            'referral_type'    => $this->referralType,
            'target'           => $this->target,
            'reason'           => $this->reason,
            'clinical_summary' => $this->clinicalSummary,
            'priority'         => $this->priority,
            'status'           => $this->status,
            'author'           => $this->authorName,
            'created_at'       => $this->getCreatedAt()->format(DATE_ATOM),
        ];
    }
}
