<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use Doctrine\ORM\Mapping as ORM;

/**
 * A prescribable product from the RxNorm "Current Prescribable Content" catalogue
 * (U.S. National Library of Medicine), keyed by its RXCUI. Loaded in bulk by
 * `bin/import-rxnorm.php`; read-only to the app. Prescriptions snapshot the
 * fields they print, so refreshing the catalogue never rewrites a prescription.
 */
#[ORM\Entity]
#[ORM\Table(name: 'drugs')]
#[ORM\Index(name: 'idx_drugs_tty', columns: ['tty'])]
class Drug
{
    #[ORM\Id]
    #[ORM\Column(type: 'string', length: 20)]
    private string $rxcui;

    /** SCD (generic), SBD (branded), GPCK / BPCK (generic / branded pack). */
    #[ORM\Column(type: 'string', length: 8)]
    private string $tty;

    /** Display name: RxNorm's prescribable name (PSN) when present, else the full name. */
    #[ORM\Column(type: 'text')]
    private string $name;

    /** The generic (non-brand) RxNorm name, e.g. "acetaminophen 500 MG Oral Tablet". */
    #[ORM\Column(name: 'generic_name', type: 'text')]
    private string $genericName;

    #[ORM\Column(type: 'string', length: 255, nullable: true)]
    private ?string $brand;

    #[ORM\Column(name: 'dose_form', type: 'string', length: 120, nullable: true)]
    private ?string $doseForm;

    #[ORM\Column(type: 'string', length: 40, nullable: true)]
    private ?string $route;

    /** Lower-cased name + synonyms + brand, for substring search. */
    #[ORM\Column(name: 'search_text', type: 'text')]
    private string $searchText;

    public function __construct(
        string $rxcui,
        string $tty,
        string $name,
        string $genericName,
        ?string $brand,
        ?string $doseForm,
        ?string $route,
        string $searchText,
    ) {
        $this->rxcui       = $rxcui;
        $this->tty         = $tty;
        $this->name        = $name;
        $this->genericName = $genericName;
        $this->brand       = $brand;
        $this->doseForm    = $doseForm;
        $this->route       = $route;
        $this->searchText  = $searchText;
    }

    public function getRxcui(): string
    {
        return $this->rxcui;
    }

    public function getName(): string
    {
        return $this->name;
    }

    public function getGenericName(): string
    {
        return $this->genericName;
    }

    public function getBrand(): ?string
    {
        return $this->brand;
    }

    public function getDoseForm(): ?string
    {
        return $this->doseForm;
    }

    public function getRoute(): ?string
    {
        return $this->route;
    }

    public function isBranded(): bool
    {
        return $this->tty === 'SBD' || $this->tty === 'BPCK';
    }

    public function toArray(): array
    {
        return [
            'rxcui'        => $this->rxcui,
            'tty'          => $this->tty,
            'name'         => $this->name,
            'generic_name' => $this->genericName,
            'brand'        => $this->brand,
            'branded'      => $this->isBranded(),
            'dose_form'    => $this->doseForm,
            'route'        => $this->route,
        ];
    }
}
