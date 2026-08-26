<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/**
 * A lab / investigation order placed during a consultation — one or more tests
 * with a priority and optional instructions. Created already "ordered" (the
 * doctor signs it as it's sent), so the patient sees it immediately.
 */
#[ORM\Entity]
#[ORM\Table(name: 'lab_orders')]
#[ORM\Index(name: 'idx_lab_orders_appointment', columns: ['appointment_id'])]
#[ORM\HasLifecycleCallbacks]
class LabOrder
{
    use TimestampsTrait;

    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(name: 'appointment_id', type: 'uuid')]
    private string $appointmentId;

    #[ORM\Column(name: 'patient_id', type: 'uuid')]
    private string $patientId;

    /** @var list<string> */
    #[ORM\Column(type: 'json')]
    private array $tests = [];

    #[ORM\Column(type: 'text', nullable: true)]
    private ?string $instructions = null;

    #[ORM\Column(type: 'string', length: 20, options: ['default' => 'routine'])]
    private string $priority = 'routine';

    #[ORM\Column(type: 'string', length: 20, options: ['default' => 'ordered'])]
    private string $status = 'ordered';

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

    /** @param list<mixed> $tests */
    public function setTests(array $tests): void
    {
        $this->tests = array_values(array_filter(array_map(
            static fn ($t): string => trim((string) $t),
            $tests,
        ), static fn (string $t): bool => $t !== ''));
    }

    /** @return list<string> */
    public function getTests(): array
    {
        return $this->tests;
    }

    public function setInstructions(?string $v): void
    {
        $this->instructions = $v !== null && trim($v) !== '' ? trim($v) : null;
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
            'id'             => $this->id,
            'appointment_id' => $this->appointmentId,
            'tests'          => $this->tests,
            'instructions'   => $this->instructions,
            'priority'       => $this->priority,
            'status'         => $this->status,
            'author'         => $this->authorName,
            'created_at'     => $this->getCreatedAt()->format(DATE_ATOM),
        ];
    }
}
