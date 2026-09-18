<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use DateTimeImmutable;
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

    /** The specialist's gender ('male' / 'female'), for the directory filter. */
    #[ORM\Column(type: 'string', length: 20, nullable: true)]
    private ?string $gender = null;

    /** Doctor contact email — used server-side for confirmations; never in toArray. */
    #[ORM\Column(type: 'string', length: 255, nullable: true)]
    private ?string $email = null;

    /** Public headshot URL (absolute, or a relative /uploads path). */
    #[ORM\Column(name: 'photo_url', type: 'string', length: 300, nullable: true)]
    private ?string $photoUrl = null;

    /** Whether they also offer in-person visits (all offer online/telehealth). */
    #[ORM\Column(name: 'offers_in_person', type: 'boolean', options: ['default' => false])]
    private bool $offersInPerson = false;

    /** Public "about me" blurb. */
    #[ORM\Column(type: 'text', nullable: true)]
    private ?string $bio = null;

    /** Qualifications / credentials, e.g. "MBBS, FMCP · MDCN 12345". */
    #[ORM\Column(type: 'string', length: 300, nullable: true)]
    private ?string $qualifications = null;

    /** Contact phone for the doctor (self-service profile). */
    #[ORM\Column(type: 'string', length: 40, nullable: true)]
    private ?string $phone = null;

    #[ORM\Column(name: 'date_of_birth', type: 'date_immutable', nullable: true)]
    private ?DateTimeImmutable $dateOfBirth = null;

    /** Country / region, distinct from the free-text `location`. */
    #[ORM\Column(type: 'string', length: 120, nullable: true)]
    private ?string $country = null;

    /**
     * Areas of expertise (chips), e.g. ["Heart Failure", "Hypertension"].
     *
     * @var list<string>|null
     */
    #[ORM\Column(type: 'json', nullable: true)]
    private ?array $expertise = null;

    /**
     * Structured qualifications: each {title, institution, year}. Kept alongside
     * the legacy `qualifications` string (still used by the public directory).
     *
     * @var list<array{title:string,institution:string,year:string}>|null
     */
    #[ORM\Column(name: 'qualification_entries', type: 'json', nullable: true)]
    private ?array $qualificationEntries = null;

    /**
     * Certifications: each {name, body, year}.
     *
     * @var list<array{name:string,body:string,year:string}>|null
     */
    #[ORM\Column(type: 'json', nullable: true)]
    private ?array $certifications = null;

    /** Default consultation length in minutes for generated slots (15/30/45/60). */
    #[ORM\Column(name: 'slot_minutes', type: 'integer', options: ['default' => 30])]
    private int $slotMinutes = 30;

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

    public function setGender(?string $gender): void
    {
        $this->gender = $gender !== null && $gender !== '' ? strtolower($gender) : null;
    }

    public function getEmail(): ?string
    {
        return $this->email;
    }

    public function setEmail(?string $email): void
    {
        $this->email = $email !== null && $email !== '' ? $email : null;
    }

    public function getPhotoUrl(): ?string
    {
        return $this->photoUrl;
    }

    public function setPhotoUrl(?string $url): void
    {
        $this->photoUrl = $url !== null && $url !== '' ? $url : null;
    }

    public function setOffersInPerson(bool $offers): void
    {
        $this->offersInPerson = $offers;
    }

    public function setBio(?string $bio): void
    {
        $this->bio = $bio !== null && trim($bio) !== '' ? trim($bio) : null;
    }

    public function setQualifications(?string $qualifications): void
    {
        $this->qualifications = $qualifications !== null && trim($qualifications) !== '' ? trim($qualifications) : null;
    }

    public function setName(string $name): void
    {
        $this->name = trim($name);
    }

    public function setSpecialty(string $specialty): void
    {
        $this->specialty = trim($specialty);
    }

    public function getPhone(): ?string
    {
        return $this->phone;
    }

    public function setPhone(?string $phone): void
    {
        $this->phone = $phone !== null && trim($phone) !== '' ? trim($phone) : null;
    }

    public function getDateOfBirth(): ?DateTimeImmutable
    {
        return $this->dateOfBirth;
    }

    public function setDateOfBirth(?DateTimeImmutable $dob): void
    {
        $this->dateOfBirth = $dob;
    }

    public function setCountry(?string $country): void
    {
        $this->country = $country !== null && trim($country) !== '' ? trim($country) : null;
    }

    /** @return list<string> */
    public function getExpertise(): array
    {
        return $this->expertise ?? [];
    }

    /** @param list<string> $expertise */
    public function setExpertise(array $expertise): void
    {
        $clean = array_values(array_filter(array_map(
            static fn (mixed $x): string => trim((string) $x),
            $expertise,
        ), static fn (string $x): bool => $x !== ''));
        $this->expertise = $clean !== [] ? $clean : null;
    }

    /** @return list<array{title:string,institution:string,year:string}> */
    public function getQualificationEntries(): array
    {
        return $this->qualificationEntries ?? [];
    }

    /** @param list<array{title:string,institution:string,year:string}> $entries */
    public function setQualificationEntries(array $entries): void
    {
        $this->qualificationEntries = $entries !== [] ? array_values($entries) : null;
    }

    /** @return list<array{name:string,body:string,year:string}> */
    public function getCertifications(): array
    {
        return $this->certifications ?? [];
    }

    /** @param list<array{name:string,body:string,year:string}> $entries */
    public function setCertifications(array $entries): void
    {
        $this->certifications = $entries !== [] ? array_values($entries) : null;
    }

    public function getSlotMinutes(): int
    {
        return $this->slotMinutes > 0 ? $this->slotMinutes : 30;
    }

    public function setSlotMinutes(int $minutes): void
    {
        $this->slotMinutes = in_array($minutes, [15, 30, 45, 60], true) ? $minutes : 30;
    }

    public function toArray(): array
    {
        return [
            'id'               => $this->id,
            'name'             => $this->name,
            'specialty'        => $this->specialty,
            'location'         => $this->location,
            'country'          => $this->country,
            'consultation_fee' => $this->consultationFee,
            'rating'           => $this->rating,
            'reviews_count'    => $this->reviewsCount,
            'available'        => $this->available,
            'years_experience' => $this->yearsExperience,
            'languages'        => $this->languages,
            'verified'         => $this->verified,
            'gender'           => $this->gender,
            'offers_in_person' => $this->offersInPerson,
            'photo_url'        => $this->photoUrl,
            'bio'              => $this->bio,
            'qualifications'   => $this->qualifications,
            'expertise'        => $this->getExpertise(),
            'qualification_entries' => $this->getQualificationEntries(),
            'certifications'   => $this->getCertifications(),
            'slot_minutes'     => $this->getSlotMinutes(),
        ];
    }

    /**
     * The authenticated doctor's own profile — the public {@see toArray} plus the
     * personal fields (phone, date of birth) that must never appear in the public
     * directory.
     *
     * @return array<string,mixed>
     */
    public function toPrivateArray(): array
    {
        return $this->toArray() + [
            'email'         => $this->email,
            'phone'         => $this->phone,
            'date_of_birth' => $this->dateOfBirth?->format('Y-m-d'),
            'weekly_hours'  => $this->weeklyHours,
        ];
    }
}
