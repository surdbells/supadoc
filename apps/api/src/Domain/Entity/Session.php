<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;

/**
 * A signed-in device/session for a patient. The id is the token's `jti`, so the
 * customer middleware can reject a token whose session was revoked. `toArray()`
 * is the serialisation boundary and derives a friendly device label from the
 * stored user agent.
 */
#[ORM\Entity]
#[ORM\Table(name: 'sessions')]
#[ORM\Index(name: 'idx_sessions_patient', columns: ['patient_id'])]
#[ORM\HasLifecycleCallbacks]
class Session
{
    use TimestampsTrait;

    #[ORM\Id]
    #[ORM\Column(type: 'string', length: 64)]
    private string $id;

    #[ORM\ManyToOne(targetEntity: Patient::class)]
    #[ORM\JoinColumn(name: 'patient_id', referencedColumnName: 'id', nullable: false)]
    private Patient $patient;

    #[ORM\Column(name: 'user_agent', type: 'text', nullable: true)]
    private ?string $userAgent = null;

    #[ORM\Column(name: 'ip_address', type: 'string', length: 64, nullable: true)]
    private ?string $ip = null;

    #[ORM\Column(name: 'revoked_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $revokedAt = null;

    public function __construct(
        string $id,
        Patient $patient,
        ?string $userAgent,
        ?string $ip,
    ) {
        $this->id        = $id;
        $this->patient   = $patient;
        $this->userAgent = $userAgent !== null && $userAgent !== '' ? $userAgent : null;
        $this->ip        = $ip !== null && $ip !== '' ? $ip : null;
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function isRevoked(): bool
    {
        return $this->revokedAt !== null;
    }

    public function revoke(): void
    {
        $this->revokedAt ??= new DateTimeImmutable();
    }

    public function toArray(string $currentId = ''): array
    {
        [$device, $icon] = self::describe($this->userAgent ?? '');

        return [
            'id'         => $this->id,
            'device'     => $device,
            'icon'       => $icon,
            'ip'         => $this->ip,
            'created_at' => $this->createdAt->format(DATE_ATOM),
            'current'    => $this->id === $currentId && $currentId !== '',
        ];
    }

    /**
     * Friendly "Chrome on Windows" label + a laptop/smartphone icon from a raw
     * user-agent string.
     *
     * @return array{0:string,1:string}
     */
    public static function describe(string $ua): array
    {
        $browser = match (true) {
            str_contains($ua, 'Edg/')                      => 'Edge',
            str_contains($ua, 'OPR/') || str_contains($ua, 'Opera') => 'Opera',
            str_contains($ua, 'Chrome/')                   => 'Chrome',
            str_contains($ua, 'Firefox/')                  => 'Firefox',
            str_contains($ua, 'Safari/')                   => 'Safari',
            default                                        => 'Browser',
        };
        // iOS/Android first — an iPhone UA also contains "like Mac OS X".
        $os = match (true) {
            str_contains($ua, 'iPhone') || str_contains($ua, 'iPad') || str_contains($ua, 'iPod') => 'iOS',
            str_contains($ua, 'Android')                   => 'Android',
            str_contains($ua, 'Windows')                   => 'Windows',
            str_contains($ua, 'Mac OS X') || str_contains($ua, 'Macintosh') => 'macOS',
            str_contains($ua, 'Linux')                     => 'Linux',
            default                                        => 'Unknown device',
        };
        $mobile = (bool) preg_match('/Mobi|Android|iPhone|iPad|iPod/', $ua);

        $label = $ua === '' ? 'Unknown device' : "$browser on $os";

        return [$label, $mobile ? 'smartphone' : 'laptop'];
    }
}
