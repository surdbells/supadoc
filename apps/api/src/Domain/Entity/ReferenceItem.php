<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/**
 * One entry of a back-office-managed pick list ("reference data"): a
 * `category` (e.g. `specialty`, later `language`…; see
 * {@see \App\Domain\Reference\ReferenceCategory}), a stable `code` slug, the
 * `label` people see, its place in the list and whether it is offered.
 *
 * Labels are unique per category regardless of case and spacing: `label_key`
 * holds the label as compared ({@see keyOf()}) under a unique constraint, so
 * "Cardiology" and " cardiology " can never both exist. The code is set once
 * (from the label when not given) and never changes, so a rename keeps it.
 *
 * Records that use an item store its LABEL (a specialist's `specialty` is the
 * label string), so renaming one is propagated to them by the service.
 */
#[ORM\Entity]
#[ORM\Table(name: 'reference_items')]
#[ORM\UniqueConstraint(name: 'uniq_reference_items_code', columns: ['category', 'code'])]
#[ORM\UniqueConstraint(name: 'uniq_reference_items_label', columns: ['category', 'label_key'])]
#[ORM\Index(name: 'idx_reference_items_order', columns: ['category', 'sort_order'])]
#[ORM\HasLifecycleCallbacks]
class ReferenceItem
{
    use TimestampsTrait;

    public const CODE_MAX  = 80;
    public const LABEL_MAX = 120;

    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(type: 'string', length: 40)]
    private string $category;

    #[ORM\Column(type: 'string', length: self::CODE_MAX)]
    private string $code;

    #[ORM\Column(type: 'string', length: self::LABEL_MAX)]
    private string $label;

    /** The label as compared for uniqueness: {@see keyOf()}. */
    #[ORM\Column(name: 'label_key', type: 'string', length: self::LABEL_MAX)]
    private string $labelKey;

    #[ORM\Column(name: 'sort_order', type: 'integer', options: ['default' => 0])]
    private int $sortOrder = 0;

    #[ORM\Column(type: 'boolean', options: ['default' => true])]
    private bool $active = true;

    public function __construct(string $category, string $code, string $label, int $sortOrder = 0, bool $active = true)
    {
        $this->id        = Uuid::uuid4()->toString();
        $this->category  = $category;
        $this->code      = $code;
        $this->sortOrder = $sortOrder;
        $this->active    = $active;
        $this->rename($label);
    }

    /**
     * A label as stored: trimmed, inner runs of whitespace collapsed to one
     * space (spelling and case kept).
     */
    public static function normaliseLabel(string $label): string
    {
        return trim((string) preg_replace('/\s+/u', ' ', $label));
    }

    /** A label as compared: normalised and lower-cased ("  ENT  (Otolaryngology)" → "ent (otolaryngology)"). */
    public static function keyOf(string $label): string
    {
        return mb_strtolower(self::normaliseLabel($label));
    }

    /**
     * A code slug from a label: lower-case ASCII letters and digits joined by
     * single hyphens ("Nutrition & Dietetics" → "nutrition-dietetics"), at
     * most {@see CODE_MAX} characters; "item" when nothing is left.
     */
    public static function slugOf(string $label): string
    {
        $ascii = $label;
        if (function_exists('iconv')) {
            $converted = @iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $label);
            if (is_string($converted)) {
                $ascii = $converted;
            }
        }
        $slug = trim((string) preg_replace('/[^a-z0-9]+/', '-', strtolower($ascii)), '-');
        $slug = rtrim(substr($slug, 0, self::CODE_MAX), '-');

        return $slug !== '' ? $slug : 'item';
    }

    /** Whether a string is a valid code: lower-case letters / digits in hyphen-separated runs. */
    public static function isValidCode(string $code): bool
    {
        return strlen($code) <= self::CODE_MAX && preg_match('/^[a-z0-9]+(?:-[a-z0-9]+)*$/', $code) === 1;
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function getCategory(): string
    {
        return $this->category;
    }

    public function getCode(): string
    {
        return $this->code;
    }

    public function getLabel(): string
    {
        return $this->label;
    }

    public function getLabelKey(): string
    {
        return $this->labelKey;
    }

    /** Set the label (normalised) and its comparison key together. */
    public function rename(string $label): void
    {
        $this->label    = self::normaliseLabel($label);
        $this->labelKey = self::keyOf($label);
    }

    public function getSortOrder(): int
    {
        return $this->sortOrder;
    }

    public function setSortOrder(int $sortOrder): void
    {
        $this->sortOrder = $sortOrder;
    }

    public function isActive(): bool
    {
        return $this->active;
    }

    public function setActive(bool $active): void
    {
        $this->active = $active;
    }

    /**
     * The public shape (pick lists): what a form needs to offer the item.
     *
     * @return array{id:string, code:string, label:string, sort_order:int}
     */
    public function toPublicArray(): array
    {
        return [
            'id'         => $this->id,
            'code'       => $this->code,
            'label'      => $this->label,
            'sort_order' => $this->sortOrder,
        ];
    }

    /**
     * The back-office shape, with how many records use it.
     *
     * @return array<string,mixed>
     */
    public function toArray(int $usageCount = 0): array
    {
        return $this->toPublicArray() + [
            'category'    => $this->category,
            'active'      => $this->active,
            'usage_count' => $usageCount,
            'created_at'  => self::iso($this->createdAt ?? null),
            'updated_at'  => self::iso($this->updatedAt ?? null),
        ];
    }

    private static function iso(?DateTimeImmutable $at): ?string
    {
        return $at?->format(DATE_ATOM);
    }
}
