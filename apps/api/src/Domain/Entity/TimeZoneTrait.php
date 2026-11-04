<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use App\Domain\Settings\ClinicTime;
use App\Domain\Settings\TimeZones;
use DateTimeZone;
use Doctrine\ORM\Mapping as ORM;

/**
 * A person's IANA time zone (doctors and patients): detected from a browser
 * ('auto') or chosen ('manual'). Never set means the clinic's zone
 * ({@see ClinicTime}, Africa/Lagos) — today's behaviour — so the columns are
 * nullable and need no backfill. Server-written text for this person uses
 * {@see timeZone()}.
 */
trait TimeZoneTrait
{
    public const TIMEZONE_SOURCES = ['auto', 'manual'];

    /** IANA zone (e.g. "America/Chicago"); null = never set → ClinicTime::zone(). */
    #[ORM\Column(name: 'timezone', type: 'string', length: 64, nullable: true)]
    private ?string $timezone = null;

    /** 'auto' (detected from a browser) | 'manual' (chosen); null = never set. */
    #[ORM\Column(name: 'timezone_source', type: 'string', length: 10, nullable: true)]
    private ?string $timezoneSource = null;

    /** The stored zone name (null when never set). */
    public function getTimezone(): ?string
    {
        return $this->timezone;
    }

    public function getTimezoneSource(): ?string
    {
        return $this->timezoneSource;
    }

    /** The effective zone: the stored one when valid, else the clinic's. */
    public function timeZone(): DateTimeZone
    {
        return TimeZones::zoneOr($this->timezone);
    }

    /**
     * The zone only when it was ever set (detected or chosen) — for labels shown
     * to someone else, so a person never detected isn't mislabelled as WAT.
     */
    public function knownTimeZone(): ?DateTimeZone
    {
        return $this->timezoneSource !== null ? $this->timeZone() : null;
    }

    /** Store a zone (the caller has validated it with {@see TimeZones::isValid()}). $source ∈ {auto, manual}. */
    public function setTimezone(string $tz, string $source): void
    {
        $this->timezone       = trim($tz);
        $this->timezoneSource = in_array($source, self::TIMEZONE_SOURCES, true) ? $source : 'manual';
    }
}
