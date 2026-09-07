<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/**
 * A patient support request. Holds a thread of {@see SupportMessage}s; a few
 * fields (patient name/email, last-message preview) are denormalised so the
 * back-office queue renders from a single query.
 */
#[ORM\Entity]
#[ORM\Table(name: 'support_tickets')]
#[ORM\Index(name: 'idx_support_tickets_patient', columns: ['patient_id', 'created_at'])]
#[ORM\Index(name: 'idx_support_tickets_status', columns: ['status', 'last_message_at'])]
#[ORM\HasLifecycleCallbacks]
class SupportTicket
{
    use TimestampsTrait;

    public const CATEGORIES = ['general', 'billing', 'technical', 'appointment'];
    public const STATUSES   = ['open', 'pending', 'resolved', 'closed'];

    public const ROLE_PATIENT = 'patient';
    public const ROLE_STAFF   = 'staff';

    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(name: 'patient_id', type: 'uuid')]
    private string $patientId;

    #[ORM\Column(name: 'patient_name', type: 'string', length: 200)]
    private string $patientName;

    #[ORM\Column(name: 'patient_email', type: 'string', length: 255)]
    private string $patientEmail;

    #[ORM\Column(type: 'string', length: 200)]
    private string $subject;

    #[ORM\Column(type: 'string', length: 20)]
    private string $category = 'general';

    #[ORM\Column(type: 'string', length: 20)]
    private string $status = 'open';

    #[ORM\Column(name: 'last_message_at', type: 'datetime_immutable')]
    private DateTimeImmutable $lastMessageAt;

    #[ORM\Column(name: 'last_message_preview', type: 'string', length: 200)]
    private string $lastMessagePreview = '';

    #[ORM\Column(name: 'last_message_role', type: 'string', length: 10)]
    private string $lastMessageRole = self::ROLE_PATIENT;

    public function __construct(string $patientId, string $patientName, string $patientEmail, string $subject, string $category)
    {
        $this->id            = Uuid::uuid4()->toString();
        $this->patientId     = $patientId;
        $this->patientName   = $patientName !== '' ? $patientName : 'Patient';
        $this->patientEmail  = $patientEmail;
        $this->subject       = $subject;
        $this->category      = in_array($category, self::CATEGORIES, true) ? $category : 'general';
        $this->lastMessageAt = new DateTimeImmutable();
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function getPatientId(): string
    {
        return $this->patientId;
    }

    public function getStatus(): string
    {
        return $this->status;
    }

    public function setStatus(string $status): void
    {
        if (in_array($status, self::STATUSES, true)) {
            $this->status = $status;
        }
    }

    /** Record activity: refresh the preview + timestamp and move the ticket status. */
    public function registerMessage(string $role, string $body): void
    {
        $this->lastMessageAt      = new DateTimeImmutable();
        $this->lastMessageRole    = $role === self::ROLE_STAFF ? self::ROLE_STAFF : self::ROLE_PATIENT;
        $preview                  = trim(preg_replace('/\s+/', ' ', $body) ?? $body);
        $this->lastMessagePreview = mb_substr($preview, 0, 197) . (mb_strlen($preview) > 197 ? '…' : '');

        // A patient reply reopens the ticket; a staff reply marks it awaiting the patient.
        if ($this->status !== 'closed') {
            $this->status = $this->lastMessageRole === self::ROLE_STAFF ? 'pending' : 'open';
        }
    }

    /** @return array<string,mixed> */
    public function toArray(): array
    {
        return [
            'id'                   => $this->id,
            'patient_id'           => $this->patientId,
            'patient_name'         => $this->patientName,
            'patient_email'        => $this->patientEmail,
            'subject'              => $this->subject,
            'category'             => $this->category,
            'status'               => $this->status,
            'last_message_at'      => $this->lastMessageAt->format(DATE_ATOM),
            'last_message_preview' => $this->lastMessagePreview,
            'last_message_role'    => $this->lastMessageRole,
            'created_at'           => $this->getCreatedAt()->format(DATE_ATOM),
        ];
    }
}
