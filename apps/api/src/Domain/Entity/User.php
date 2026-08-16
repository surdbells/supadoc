<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/**
 * Staff user. Roles and permissions are stored on the row and copied into the
 * JWT at sign-in, so a permission change takes effect at next login (see
 * ARCHITECTURE §8). `toArray()` is the serialisation boundary.
 */
#[ORM\Entity]
#[ORM\Table(name: 'users')]
#[ORM\UniqueConstraint(name: 'uniq_users_email', columns: ['email'])]
#[ORM\HasLifecycleCallbacks]
class User
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

    /** @var list<string> */
    #[ORM\Column(type: 'json')]
    private array $roles = [];

    /** @var list<string> */
    #[ORM\Column(type: 'json')]
    private array $permissions = [];

    #[ORM\Column(type: 'boolean')]
    private bool $active = true;

    /**
     * For doctor accounts, the Specialist profile this login represents (so a
     * doctor sees only their own consultations). Null for ordinary staff.
     */
    #[ORM\Column(name: 'specialist_id', type: 'uuid', nullable: true)]
    private ?string $specialistId = null;

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

    /** @return list<string> */
    public function getRoles(): array
    {
        return $this->roles;
    }

    /** @param list<string> $roles */
    public function setRoles(array $roles): void
    {
        $this->roles = array_values($roles);
    }

    /** @return list<string> */
    public function getPermissions(): array
    {
        return $this->permissions;
    }

    /** @param list<string> $permissions */
    public function setPermissions(array $permissions): void
    {
        $this->permissions = array_values($permissions);
    }

    public function isActive(): bool
    {
        return $this->active;
    }

    public function getSpecialistId(): ?string
    {
        return $this->specialistId;
    }

    public function setSpecialistId(?string $specialistId): void
    {
        $this->specialistId = $specialistId !== null && $specialistId !== '' ? $specialistId : null;
    }

    public function toArray(): array
    {
        return [
            'id'            => $this->id,
            'email'         => $this->email,
            'first_name'    => $this->firstName,
            'last_name'     => $this->lastName,
            'roles'         => $this->roles,
            'permissions'   => $this->permissions,
            'active'        => $this->active,
            'specialist_id' => $this->specialistId,
            'created_at'    => $this->createdAt->format(DATE_ATOM),
        ];
    }
}
