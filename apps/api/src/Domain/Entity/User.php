<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use DateTimeImmutable;
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
#[ORM\Index(name: 'idx_users_password_token', columns: ['password_token_hash'])]
#[ORM\HasLifecycleCallbacks]
class User
{
    /** What a one-time set-password link is for. */
    public const TOKEN_INVITE = 'invite';
    public const TOKEN_RESET  = 'reset';

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

    /**
     * The web app this person last signed in from (one of the configured
     * sites — see WebUrls), so emailed and printed links send them back there.
     */
    #[ORM\Column(name: 'web_origin', type: 'string', length: 255, nullable: true)]
    private ?string $webOrigin = null;

    /**
     * One-time set-password link (an invite or a password reset). Only the
     * SHA-256 of the emailed token is stored, with what it is for and when it
     * stops working; it is cleared as soon as it is used.
     */
    #[ORM\Column(name: 'password_token_hash', type: 'string', length: 64, nullable: true)]
    private ?string $passwordTokenHash = null;

    #[ORM\Column(name: 'password_token_purpose', type: 'string', length: 10, nullable: true)]
    private ?string $passwordTokenPurpose = null;

    #[ORM\Column(name: 'password_token_expires_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $passwordTokenExpiresAt = null;

    /** When the person last chose their own password (from an invite or reset link). */
    #[ORM\Column(name: 'password_set_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $passwordSetAt = null;

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
     * Changing the address voids any outstanding invite / reset link: one
     * already emailed to the old (perhaps mistyped) address must not keep
     * working for whoever owns that inbox.
     */
    public function setEmail(string $email): void
    {
        $email = strtolower(trim($email));
        if ($email !== $this->email) {
            $this->clearPasswordToken();
        }
        $this->email = $email;
    }

    public function setFirstName(string $firstName): void
    {
        $this->firstName = $firstName;
    }

    public function setLastName(string $lastName): void
    {
        $this->lastName = $lastName;
    }

    public function setActive(bool $active): void
    {
        $this->active = $active;
    }

    /**
     * Set the password (an admin reset, a change in Settings, or a link). Any
     * outstanding invite / reset link stops working — the password it would
     * have replaced is gone.
     */
    public function setPassword(string $plain): void
    {
        $this->passwordHash = password_hash($plain, PASSWORD_DEFAULT);
        $this->clearPasswordToken();
    }

    public function verifyPassword(string $plain): bool
    {
        return $this->passwordHash !== '' && password_verify($plain, $this->passwordHash);
    }

    /** False for an invited login that has never had a password. */
    public function hasPassword(): bool
    {
        return $this->passwordHash !== '';
    }

    /** The person sets their own password from a one-time link (which is used up). */
    public function choosePassword(string $plain, ?DateTimeImmutable $now = null): void
    {
        $this->setPassword($plain);
        $this->passwordSetAt = $now ?? new DateTimeImmutable();
        $this->clearPasswordToken();
    }

    /**
     * Start a one-time set-password link: returns the plain token to email (never
     * stored) and keeps only its hash. A new link replaces any earlier one.
     */
    public function issuePasswordToken(string $purpose, int $ttlSeconds, ?DateTimeImmutable $now = null): string
    {
        $plain = bin2hex(random_bytes(32));

        $this->passwordTokenHash      = self::hashPasswordToken($plain);
        $this->passwordTokenPurpose   = $purpose;
        $this->passwordTokenExpiresAt = ($now ?? new DateTimeImmutable())->modify('+' . max(1, $ttlSeconds) . ' seconds');

        return $plain;
    }

    /** How a plain token is stored (and looked up). */
    public static function hashPasswordToken(string $plain): string
    {
        return hash('sha256', $plain);
    }

    /** Is $plain this user's live link for $purpose (right purpose, not expired)? */
    public function passwordTokenMatches(string $plain, string $purpose, ?DateTimeImmutable $now = null): bool
    {
        return $this->passwordTokenHash !== null
            && $this->passwordTokenPurpose === $purpose
            && $this->passwordTokenExpiresAt !== null
            && $this->passwordTokenExpiresAt > ($now ?? new DateTimeImmutable())
            && hash_equals($this->passwordTokenHash, self::hashPasswordToken($plain));
    }

    public function clearPasswordToken(): void
    {
        $this->passwordTokenHash      = null;
        $this->passwordTokenPurpose   = null;
        $this->passwordTokenExpiresAt = null;
    }

    /** An invite link has been sent and is still usable. */
    public function hasPendingInvite(?DateTimeImmutable $now = null): bool
    {
        return $this->passwordTokenPurpose === self::TOKEN_INVITE
            && $this->passwordTokenExpiresAt !== null
            && $this->passwordTokenExpiresAt > ($now ?? new DateTimeImmutable());
    }

    public function getPasswordTokenExpiresAt(): ?DateTimeImmutable
    {
        return $this->passwordTokenExpiresAt;
    }

    public function getFirstName(): string
    {
        return $this->firstName;
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

    public function getWebOrigin(): ?string
    {
        return $this->webOrigin;
    }

    public function setWebOrigin(?string $origin): void
    {
        $this->webOrigin = $origin !== null && $origin !== '' ? $origin : null;
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
            'password_set'  => $this->hasPassword(),
            // An invite email is out and its link still works (never the token itself).
            'invite_pending'    => $this->hasPendingInvite(),
            'invite_expires_at' => $this->passwordTokenPurpose === self::TOKEN_INVITE
                ? $this->passwordTokenExpiresAt?->format(DATE_ATOM)
                : null,
            'created_at'    => $this->createdAt->format(DATE_ATOM),
        ];
    }
}
