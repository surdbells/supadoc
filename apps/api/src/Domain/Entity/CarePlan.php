<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/**
 * The care plan for a consultation — one per appointment, a checklist of
 * actionable items the patient should follow. Editable by the doctor until
 * `published`, at which point it appears in the patient's consultation view.
 */
#[ORM\Entity]
#[ORM\Table(name: 'care_plans')]
#[ORM\UniqueConstraint(name: 'uniq_care_plans_appointment', columns: ['appointment_id'])]
#[ORM\HasLifecycleCallbacks]
class CarePlan
{
    use TimestampsTrait;

    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(name: 'appointment_id', type: 'uuid')]
    private string $appointmentId;

    /** @var list<string> */
    #[ORM\Column(type: 'json')]
    private array $items = [];

    #[ORM\Column(type: 'boolean', options: ['default' => false])]
    private bool $published = false;

    #[ORM\Column(name: 'author_name', type: 'string', length: 200, nullable: true)]
    private ?string $authorName = null;

    public function __construct(string $appointmentId)
    {
        $this->id            = Uuid::uuid4()->toString();
        $this->appointmentId = $appointmentId;
    }

    public function isPublished(): bool
    {
        return $this->published;
    }

    /** @param list<mixed> $items */
    public function setItems(array $items): void
    {
        $this->items = array_values(array_filter(array_map(
            static fn ($t): string => trim((string) $t),
            $items,
        ), static fn (string $t): bool => $t !== ''));
    }

    /** @return list<string> */
    public function getItems(): array
    {
        return $this->items;
    }

    public function publish(string $author): void
    {
        $this->published  = true;
        $this->authorName = $author;
    }

    public function toArray(): array
    {
        return [
            'appointment_id' => $this->appointmentId,
            'items'          => $this->items,
            'published'      => $this->published,
            'author'         => $this->authorName,
            'updated_at'     => $this->getUpdatedAt()->format(DATE_ATOM),
        ];
    }
}
