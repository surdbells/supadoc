<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/**
 * A bookable specialist. `consultationFee` is `decimal` mapped to STRING — money
 * never touches a float (see ARCHITECTURE §6); do arithmetic with bcmath.
 */
#[ORM\Entity]
#[ORM\Table(name: 'specialists')]
#[ORM\HasLifecycleCallbacks]
class Specialist
{
    use TimestampsTrait;
    use SoftDeleteTrait;

    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(type: 'string', length: 200)]
    private string $name;

    #[ORM\Column(type: 'string', length: 120)]
    private string $specialty;

    #[ORM\Column(type: 'string', length: 200, nullable: true)]
    private ?string $location = null;

    #[ORM\Column(type: 'decimal', precision: 12, scale: 2)]
    private string $consultationFee = '0.00';

    #[ORM\Column(type: 'decimal', precision: 3, scale: 2)]
    private string $rating = '0.00';

    #[ORM\Column(type: 'integer')]
    private int $reviewsCount = 0;

    #[ORM\Column(type: 'boolean')]
    private bool $available = true;

    public function __construct(string $name, string $specialty)
    {
        $this->id        = Uuid::uuid4()->toString();
        $this->name      = $name;
        $this->specialty = $specialty;
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function getName(): string
    {
        return $this->name;
    }

    public function getSpecialty(): string
    {
        return $this->specialty;
    }

    public function getConsultationFee(): string
    {
        return $this->consultationFee;
    }

    public function setConsultationFee(string $fee): void
    {
        $this->consultationFee = $fee;
    }

    public function setLocation(?string $location): void
    {
        $this->location = $location;
    }

    /** @param numeric-string $rating */
    public function setRating(string $rating): void
    {
        $this->rating = $rating;
    }

    public function setReviewsCount(int $count): void
    {
        $this->reviewsCount = $count;
    }

    public function setAvailable(bool $available): void
    {
        $this->available = $available;
    }

    public function isAvailable(): bool
    {
        return $this->available;
    }

    public function toArray(): array
    {
        return [
            'id'               => $this->id,
            'name'             => $this->name,
            'specialty'        => $this->specialty,
            'location'         => $this->location,
            'consultation_fee' => $this->consultationFee,
            'rating'           => $this->rating,
            'reviews_count'    => $this->reviewsCount,
            'available'        => $this->available,
        ];
    }
}
