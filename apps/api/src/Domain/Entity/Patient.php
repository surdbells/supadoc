<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use App\Domain\Settings\HealthProfile;
use App\Domain\Settings\PatientSettings;
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

    #[ORM\Column(type: 'string', length: 20, nullable: true)]
    private ?string $gender = null;

    #[ORM\Column(type: 'string', length: 500, nullable: true)]
    private ?string $address = null;

    /** Relative URL of the uploaded avatar (e.g. /uploads/avatars/x.jpg), or null. */
    #[ORM\Column(name: 'avatar_url', type: 'string', length: 300, nullable: true)]
    private ?string $avatarUrl = null;

    #[ORM\Column(name: 'phone_verified_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $phoneVerifiedAt = null;

    /** Sparse override map of app preferences; see {@see PatientSettings}. */
    #[ORM\Column(type: 'json', nullable: true)]
    private ?array $settings = null;

    /** Health-profile sections; see {@see HealthProfile}. Each replaced wholesale on save. */
    #[ORM\Column(name: 'emergency_contact', type: 'json', nullable: true)]
    private ?array $emergencyContact = null;

    #[ORM\Column(type: 'json', nullable: true)]
    private ?array $insurance = null;

    #[ORM\Column(type: 'json', nullable: true)]
    private ?array $medical = null;

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

    /**
     * Change the account email. Normalised to match the constructor and
     * {@see PatientRepository::findByEmail()} (lower-cased, trimmed). Callers
     * must have verified ownership of the new address (OTP) and confirmed it is
     * not already taken.
     */
    public function setEmail(string $email): void
    {
        $this->email = strtolower(trim($email));
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

    public function getGender(): ?string
    {
        return $this->gender;
    }

    public function setGender(?string $gender): void
    {
        $this->gender = $gender !== null && $gender !== '' ? $gender : null;
    }

    public function getAddress(): ?string
    {
        return $this->address;
    }

    public function setAddress(?string $address): void
    {
        $this->address = $address !== null && $address !== '' ? $address : null;
    }

    public function getAvatarUrl(): ?string
    {
        return $this->avatarUrl;
    }

    public function setAvatarUrl(?string $avatarUrl): void
    {
        $this->avatarUrl = $avatarUrl !== null && $avatarUrl !== '' ? $avatarUrl : null;
    }

    public function markPhoneVerified(): void
    {
        $this->phoneVerifiedAt = new DateTimeImmutable();
    }

    public function isPhoneVerified(): bool
    {
        return $this->phoneVerifiedAt !== null;
    }

    /** Full preferences map (stored overrides overlaid on the defaults). */
    public function getSettings(): array
    {
        return PatientSettings::withDefaults($this->settings ?? []);
    }

    /** Apply a partial preferences patch; returns the resulting full map. */
    public function updateSettings(array $patch): array
    {
        $this->settings = PatientSettings::merge($this->settings ?? [], $patch);

        return $this->getSettings();
    }

    public function getEmergencyContact(): array
    {
        return $this->emergencyContact ?? HealthProfile::emptyEmergencyContact();
    }

    public function setEmergencyContact(array $data): void
    {
        $this->emergencyContact = HealthProfile::normalizeEmergencyContact($data);
    }

    public function getInsurance(): array
    {
        return $this->insurance ?? HealthProfile::emptyInsurance();
    }

    public function setInsurance(array $data): void
    {
        $this->insurance = HealthProfile::normalizeInsurance($data);
    }

    public function getMedical(): array
    {
        return $this->medical ?? HealthProfile::emptyMedical();
    }

    public function setMedical(array $data): void
    {
        $this->medical = HealthProfile::normalizeMedical($data);
    }

    /** All three health-profile sections, as returned by the API. */
    public function getHealthProfile(): array
    {
        return [
            'emergency_contact' => $this->getEmergencyContact(),
            'insurance'         => $this->getInsurance(),
            'medical'           => $this->getMedical(),
        ];
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
            'gender'         => $this->gender,
            'address'        => $this->address,
            'avatar_url'     => $this->avatarUrl,
            'created_at'     => $this->createdAt->format(DATE_ATOM),
        ];
    }
}
