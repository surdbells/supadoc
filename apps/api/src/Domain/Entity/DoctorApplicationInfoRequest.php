<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/**
 * A reviewer asked the applicant for more (spec §2.5): a message and 1–10
 * items — sections to edit, document slots to upload. Open until the applicant
 * replies (`responded_at`) or it is closed unanswered (`closed_at` +
 * `close_reason`: the review resumed, rejected, withdrawn). At most one open
 * per application.
 */
#[ORM\Entity]
#[ORM\Table(name: 'doctor_application_info_requests')]
#[ORM\Index(name: 'idx_doc_app_info_requests_app', columns: ['application_id'])]
#[ORM\HasLifecycleCallbacks]
class DoctorApplicationInfoRequest
{
    use TimestampsTrait;

    public const CLOSE_STAFF_RESUMED = 'staff_resumed';
    public const CLOSE_REJECTED      = 'rejected';
    public const CLOSE_WITHDRAWN     = 'withdrawn';

    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(name: 'application_id', type: 'uuid')]
    private string $applicationId;

    #[ORM\Column(name: 'requested_by_id', type: 'uuid', nullable: true)]
    private ?string $requestedById;

    #[ORM\Column(name: 'requested_by_name', type: 'string', length: 200)]
    private string $requestedByName;

    #[ORM\Column(type: 'text')]
    private string $message;

    /** @var list<array{kind:string, key:string, label:string}> */
    #[ORM\Column(type: 'json')]
    private array $items;

    #[ORM\Column(name: 'requested_at', type: 'datetime_immutable')]
    private DateTimeImmutable $requestedAt;

    #[ORM\Column(name: 'responded_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $respondedAt = null;

    #[ORM\Column(name: 'response_note', type: 'string', length: 1000, nullable: true)]
    private ?string $responseNote = null;

    #[ORM\Column(name: 'closed_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $closedAt = null;

    #[ORM\Column(name: 'close_reason', type: 'string', length: 16, nullable: true)]
    private ?string $closeReason = null;

    /** @param list<array{kind:string, key:string, label:string}> $items */
    public function __construct(string $applicationId, ?string $requestedById, string $requestedByName, string $message, array $items, DateTimeImmutable $at)
    {
        $this->id              = Uuid::uuid4()->toString();
        $this->applicationId   = $applicationId;
        $this->requestedById   = $requestedById !== null && Uuid::isValid($requestedById) ? $requestedById : null;
        $this->requestedByName = mb_substr(trim($requestedByName) !== '' ? trim($requestedByName) : 'Staff', 0, 200);
        $this->message         = $message;
        $this->items           = array_values($items);
        $this->requestedAt     = $at;
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function getApplicationId(): string
    {
        return $this->applicationId;
    }

    public function getMessage(): string
    {
        return $this->message;
    }

    /** @return list<array{kind:string, key:string, label:string}> */
    public function getItems(): array
    {
        return $this->items;
    }

    /** Whether a section / document slot was asked for. */
    public function asks(string $kind, string $key): bool
    {
        foreach ($this->items as $item) {
            if (($item['kind'] ?? '') === $kind && ($item['key'] ?? '') === $key) {
                return true;
            }
        }

        return false;
    }

    /** The reviewer's wording of a requested `additional` document. */
    public function additionalLabel(): ?string
    {
        foreach ($this->items as $item) {
            if (($item['kind'] ?? '') === 'document' && ($item['key'] ?? '') === 'additional') {
                return (string) ($item['label'] ?? '');
            }
        }

        return null;
    }

    public function getRequestedAt(): DateTimeImmutable
    {
        return $this->requestedAt;
    }

    public function getRespondedAt(): ?DateTimeImmutable
    {
        return $this->respondedAt;
    }

    public function getClosedAt(): ?DateTimeImmutable
    {
        return $this->closedAt;
    }

    public function isOpen(): bool
    {
        return $this->respondedAt === null && $this->closedAt === null;
    }

    public function respond(?string $note, DateTimeImmutable $at): void
    {
        $this->respondedAt  = $at;
        $this->responseNote = $note !== null && trim($note) !== '' ? mb_substr(trim($note), 0, 1000) : null;
    }

    public function close(string $reason, DateTimeImmutable $at): void
    {
        $this->closedAt    = $at;
        $this->closeReason = $reason;
    }

    /** ApplicationInfoRequestDto; `$staff` adds who asked and how it closed. @return array<string,mixed> */
    public function toArray(bool $staff = false): array
    {
        $out = [
            'id'            => $this->id,
            'message'       => $this->message,
            'items'         => $this->items,
            'requested_at'  => $this->requestedAt->format(DATE_ATOM),
            'responded_at'  => $this->respondedAt?->format(DATE_ATOM),
            'response_note' => $this->responseNote,
        ];
        if ($staff) {
            $out += [
                'requested_by_name' => $this->requestedByName,
                'closed_at'         => $this->closedAt?->format(DATE_ATOM),
                'close_reason'      => $this->closeReason,
            ];
        }

        return $out;
    }
}
