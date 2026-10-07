<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use Doctrine\ORM\Mapping as ORM;

/**
 * A signed-in device/session for a staff user (doctor or back-office). The id
 * is the token's `jti`, so the staff middleware and the refresh endpoint can
 * reject a token whose session was signed out or has run out (idle / absolute
 * lifetime — see SessionLifecycleTrait). Mirrors the patient {@see Session}.
 */
#[ORM\Entity]
#[ORM\Table(name: 'staff_sessions')]
#[ORM\Index(name: 'idx_staff_sessions_user', columns: ['user_id'])]
#[ORM\HasLifecycleCallbacks]
class StaffSession
{
    use TimestampsTrait;
    use SessionLifecycleTrait;

    #[ORM\Id]
    #[ORM\Column(type: 'string', length: 64)]
    private string $id;

    #[ORM\ManyToOne(targetEntity: User::class)]
    #[ORM\JoinColumn(name: 'user_id', referencedColumnName: 'id', nullable: false, onDelete: 'CASCADE')]
    private User $user;

    #[ORM\Column(name: 'user_agent', type: 'text', nullable: true)]
    private ?string $userAgent = null;

    #[ORM\Column(name: 'ip_address', type: 'string', length: 64, nullable: true)]
    private ?string $ip = null;

    public function __construct(string $id, User $user, ?string $userAgent, ?string $ip)
    {
        $this->id        = $id;
        $this->user      = $user;
        $this->userAgent = $userAgent !== null && $userAgent !== '' ? $userAgent : null;
        $this->ip        = $ip !== null && $ip !== '' ? $ip : null;
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function getUser(): User
    {
        return $this->user;
    }
}
