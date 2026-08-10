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

    #[ORM\Column(name: 'years_experience', type: 'integer', nullable: true)]
    private ?int $yearsExperience = null;

    /** Comma-separated spoken languages, e.g. "English, French". */
    #[ORM\Column(type: 'string', length: 200, nullable: true)]
    private ?string $languages = null;

    #[ORM\Column(type: 'boolean', options: ['default' => true])]
    private bool $verified = true;

    /**
     * Recurring weekly availability: map of weekday ("0"=Sun … "6"=Sat) to a
     * list of [start, end] "HH:MM" windows. Null falls back to a default in
     * {@see \App\Infrastructure\Service\AvailabilityService}.
     */
    #[ORM\Column(name: 'weekly_hours', type: 'json', nullable: true)]
    private ?array $weeklyHours = null;

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

    public function setYearsExperience(?int $years): void
    {
        $this->yearsExperience = $years;
    }

    public function setLanguages(?string $languages): void
    {
        $this->languages = $languages !== null && $languages !== '' ? $languages : null;
    }

    public function setVerified(bool $verified): void
    {
        $this->verified = $verified;
    }

    /** @return array<string, list<array{0:string,1:string}>>|null */
    public function getWeeklyHours(): ?array
    {
        return $this->weeklyHours;
    }

    /** @param array<string, list<array{0:string,1:string}>>|null $hours */
    public function setWeeklyHours(?array $hours): void
    {
        $this->weeklyHours = $hours;
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
            'years_experience' => $this->yearsExperience,
            'languages'        => $this->languages,
            'verified'         => $this->verified,
        ];
    }
}
