<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/** Customer-portal account. Authenticated with a `customer`-scoped token. */
#[ORM\Entity]
#[ORM\Table(name: 'patients')]
#[ORM\UniqueConstraint(name: 'uniq_patients_email', columns: ['email'])]
#[ORM\HasLifecycleCallbacks]
class Patient
{
    use TimestampsTrait;
    use SoftDeleteTrait;

    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(type: 'string', length: 255)]
    private string $email;

    #[ORM\Column(type: 'string', length: 255)]
    private string $passwordHash = '';

    #[ORM\Column(type: 'string', length: 120)]
    private string $firstName;

    #[ORM\Column(type: 'string', length: 120)]
    private string $lastName;

    #[ORM\Column(type: 'string', length: 32, nullable: true)]
    private ?string $phone = null;

    #[ORM\Column(type: 'date_immutable', nullable: true)]
    private ?DateTimeImmutable $dateOfBirth = null;

    #[ORM\Column(name: 'phone_verified_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $phoneVerifiedAt = null;

    public function __construct(string $email, string $firstName, string $lastName)
    {
        $this->id        = Uuid::uuid4()->toString();
        $this->email     = strtolower(trim($email));
        $this->firstName = $firstName;
        $this->lastName  = $lastName;
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function getEmail(): string
    {
        return $this->email;
    }

    public function setPassword(string $plain): void
    {
        $this->passwordHash = password_hash($plain, PASSWORD_DEFAULT);
    }

    public function verifyPassword(string $plain): bool
    {
        return $this->passwordHash !== '' && password_verify($plain, $this->passwordHash);
    }

    public function getPhone(): ?string
    {
        return $this->phone;
    }

    public function setFirstName(string $firstName): void
    {
        $this->firstName = $firstName;
    }

    public function setLastName(string $lastName): void
    {
        $this->lastName = $lastName;
    }

    public function setPhone(?string $phone): void
    {
        // Changing the number invalidates a previous verification.
        if ($phone !== $this->phone) {
            $this->phoneVerifiedAt = null;
        }
        $this->phone = $phone;
    }

    public function setDateOfBirth(?DateTimeImmutable $dob): void
    {
        $this->dateOfBirth = $dob;
    }

    public function markPhoneVerified(): void
    {
        $this->phoneVerifiedAt = new DateTimeImmutable();
    }

    public function isPhoneVerified(): bool
    {
        return $this->phoneVerifiedAt !== null;
    }

    public function toArray(): array
    {
        return [
            'id'             => $this->id,
            'email'          => $this->email,
            'first_name'     => $this->firstName,
            'last_name'      => $this->lastName,
            'phone'          => $this->phone,
            'phone_verified' => $this->phoneVerifiedAt !== null,
            'date_of_birth'  => $this->dateOfBirth?->format('Y-m-d'),
            'created_at'     => $this->createdAt->format(DATE_ATOM),
        ];
    }
}
