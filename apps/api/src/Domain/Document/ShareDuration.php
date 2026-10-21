<?php

declare(strict_types=1);

namespace App\Domain\Document;

use DateInterval;
use DateTimeImmutable;

/**
 * How long a patient's document share lasts (spec §1.2). The end is always
 * computed on the server clock and is exclusive (`expires_at`):
 *
 *  - `24h` / `7d` / `30d`: relative to the moment the share is made;
 *  - `until`: the client's exclusive end (start of the day after the chosen date);
 *  - `indefinite`: no end (NULL) until the patient stops sharing;
 *  - `after_24h` / `after_7d` / `after_30d`: anchored to the linked
 *    consultation's end ({@see \App\Domain\Appointment\AppointmentLifecycle::endsAt()}),
 *    and inactive while that consultation is cancelled or deleted.
 */
enum ShareDuration: string
{
    case H24        = '24h';
    case D7         = '7d';
    case D30        = '30d';
    case UNTIL      = 'until';
    case INDEFINITE = 'indefinite';
    case AFTER_24H  = 'after_24h';
    case AFTER_7D   = 'after_7d';
    case AFTER_30D  = 'after_30d';

    /** Anchored to a consultation's end (`after_*`). */
    public function isAnchored(): bool
    {
        return in_array($this, [self::AFTER_24H, self::AFTER_7D, self::AFTER_30D], true);
    }

    /** The length added to "now" (relative) or to the consultation's end (anchored); null for `until` / `indefinite`. */
    public function offset(): ?DateInterval
    {
        return match ($this) {
            self::H24, self::AFTER_24H => new DateInterval('PT24H'),
            self::D7, self::AFTER_7D   => new DateInterval('P7D'),
            self::D30, self::AFTER_30D => new DateInterval('P30D'),
            self::UNTIL, self::INDEFINITE => null,
        };
    }

    /**
     * The exclusive end of a share made at `$now`: `$until` for `until`, the
     * consultation's end plus the offset for `after_*`, NULL for `indefinite`.
     *
     * @throws \InvalidArgumentException when `until` has no date or `after_*` no consultation end
     */
    public function expiryFrom(DateTimeImmutable $now, ?DateTimeImmutable $until, ?DateTimeImmutable $appointmentEnd): ?DateTimeImmutable
    {
        return match ($this) {
            self::INDEFINITE => null,
            self::UNTIL      => $until ?? throw new \InvalidArgumentException('An `until` share needs its end'),
            self::H24, self::D7, self::D30 => $now->add($this->offset()),
            self::AFTER_24H, self::AFTER_7D, self::AFTER_30D => ($appointmentEnd ?? throw new \InvalidArgumentException('An `after_*` share needs the consultation'))->add($this->offset()),
        };
    }

    /** "24 hours" / "7 days" / "30 days" for the preset lengths; null for `until` / `indefinite`. */
    public function lengthLabel(): ?string
    {
        return match ($this) {
            self::H24, self::AFTER_24H => '24 hours',
            self::D7, self::AFTER_7D   => '7 days',
            self::D30, self::AFTER_30D => '30 days',
            self::UNTIL, self::INDEFINITE => null,
        };
    }

    /** @return list<string> every code */
    public static function codes(): array
    {
        return array_map(static fn (self $d): string => $d->value, self::cases());
    }

    /** @return list<string> the codes a booking may send (`document_share.duration`) */
    public static function bookingCodes(): array
    {
        return [self::AFTER_24H->value, self::AFTER_7D->value, self::AFTER_30D->value, self::INDEFINITE->value];
    }

    /** @return list<string> the anchored codes */
    public static function anchoredCodes(): array
    {
        return [self::AFTER_24H->value, self::AFTER_7D->value, self::AFTER_30D->value];
    }
}
