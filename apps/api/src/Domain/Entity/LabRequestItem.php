<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/**
 * One investigation of a lab request (spec §1.2): a snapshot of its catalogue
 * item at send — label, name, short, kind, specimen (lab) or preparation
 * (imaging) and the safety flags — so a later catalogue never rewrites a sent
 * request. Immutable after send.
 */
#[ORM\Entity]
#[ORM\Table(name: 'lab_request_items')]
#[ORM\UniqueConstraint(name: 'uniq_lab_request_items_code', columns: ['lab_request_id', 'code'])]
#[ORM\Index(name: 'idx_lab_request_items_request', columns: ['lab_request_id', 'position'])]
class LabRequestItem
{
    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\ManyToOne(targetEntity: LabRequest::class, inversedBy: 'items')]
    #[ORM\JoinColumn(name: 'lab_request_id', referencedColumnName: 'id', nullable: false, onDelete: 'RESTRICT')]
    private LabRequest $request;

    #[ORM\Column(type: 'smallint')]
    private int $position;

    #[ORM\Column(type: 'string', length: 40)]
    private string $code;

    #[ORM\Column(type: 'string', length: 16)]
    private string $kind;

    #[ORM\Column(type: 'string', length: 20)]
    private string $category;

    #[ORM\Column(type: 'string', length: 12, nullable: true)]
    private ?string $modality;

    #[ORM\Column(type: 'string', length: 16, nullable: true)]
    private ?string $site;

    #[ORM\Column(type: 'string', length: 120)]
    private string $label;

    #[ORM\Column(type: 'string', length: 160)]
    private string $name;

    #[ORM\Column(type: 'string', length: 60)]
    private string $short;

    #[ORM\Column(name: 'specimen_mode', type: 'string', length: 10, nullable: true)]
    private ?string $specimenMode;

    #[ORM\Column(name: 'specimen_code', type: 'string', length: 32, nullable: true)]
    private ?string $specimenCode;

    #[ORM\Column(name: 'specimen_label', type: 'string', length: 80, nullable: true)]
    private ?string $specimenLabel;

    #[ORM\Column(name: 'preparation_code', type: 'string', length: 16, nullable: true)]
    private ?string $preparationCode;

    #[ORM\Column(name: 'preparation_label', type: 'string', length: 40, nullable: true)]
    private ?string $preparationLabel;

    #[ORM\Column(name: 'contrast_possible', type: 'boolean', options: ['default' => false])]
    private bool $contrastPossible;

    #[ORM\Column(type: 'boolean', options: ['default' => false])]
    private bool $ionising;

    /** @param array<string,mixed> $s a LabRequestForm item snapshot */
    public function __construct(LabRequest $request, int $position, array $s)
    {
        $this->id               = Uuid::uuid4()->toString();
        $this->request          = $request;
        $this->position         = $position;
        $this->code             = (string) $s['code'];
        $this->kind             = (string) $s['kind'];
        $this->category         = (string) $s['category'];
        $this->modality         = $s['modality'] ?? null;
        $this->site             = $s['site'] ?? null;
        $this->label            = (string) $s['label'];
        $this->name             = (string) $s['name'];
        $this->short            = (string) $s['short'];
        $this->specimenMode     = $s['specimen_mode'] ?? null;
        $this->specimenCode     = $s['specimen_code'] ?? null;
        $this->specimenLabel    = $s['specimen_label'] ?? null;
        $this->preparationCode  = $s['preparation_code'] ?? null;
        $this->preparationLabel = $s['preparation_label'] ?? null;
        $this->contrastPossible = (bool) ($s['contrast_possible'] ?? false);
        $this->ionising         = (bool) ($s['ionising'] ?? false);
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function getRequest(): LabRequest
    {
        return $this->request;
    }

    public function getPosition(): int
    {
        return $this->position;
    }

    public function getCode(): string
    {
        return $this->code;
    }

    public function getKind(): string
    {
        return $this->kind;
    }

    public function getCategory(): string
    {
        return $this->category;
    }

    public function getModality(): ?string
    {
        return $this->modality;
    }

    public function getSite(): ?string
    {
        return $this->site;
    }

    public function getLabel(): string
    {
        return $this->label;
    }

    public function getName(): string
    {
        return $this->name;
    }

    public function getShort(): string
    {
        return $this->short;
    }

    public function getSpecimenMode(): ?string
    {
        return $this->specimenMode;
    }

    public function getSpecimenCode(): ?string
    {
        return $this->specimenCode;
    }

    public function getSpecimenLabel(): ?string
    {
        return $this->specimenLabel;
    }

    public function getPreparationCode(): ?string
    {
        return $this->preparationCode;
    }

    public function getPreparationLabel(): ?string
    {
        return $this->preparationLabel;
    }

    public function isContrastPossible(): bool
    {
        return $this->contrastPossible;
    }

    public function isIonising(): bool
    {
        return $this->ionising;
    }
}
