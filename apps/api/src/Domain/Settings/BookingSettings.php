<?php

declare(strict_types=1);

namespace App\Domain\Settings;

use App\Domain\Exception\ValidationException;
use App\Domain\Repository\AppSettingRepository;

/**
 * The booking-calendar rules the Platform Admin can change without a release:
 * how far ahead patients may book (`horizon_days`), the minimum notice before a
 * consultation (`lead_minutes`) and when a day reads as "few left" in the
 * calendar (`few_left` open times or fewer). Persisted in app_settings (keys
 * `booking_*`); each value is clamped to a safe range. Staff and doctors are
 * not held to the horizon — only patients are (see AvailabilityService).
 */
final class BookingSettings
{
    /** key => [default, min, max, label] */
    public const RULES = [
        'horizon_days' => [60, 7, 180, 'Booking window (days ahead)'],
        'lead_minutes' => [60, 15, 1440, 'Minimum notice (minutes)'],
        'few_left'     => [3, 1, 10, '"Few left" threshold (open times)'],
    ];

    /** @var array<string,int>|null read once per request */
    private ?array $cache = null;

    public function __construct(private readonly ?AppSettingRepository $settings = null)
    {
    }

    /** The default for `$key` (used when nothing is stored, and without a repository). */
    public static function default(string $key): int
    {
        return self::RULES[$key][0];
    }

    public function get(string $key): int
    {
        return $this->all()[$key] ?? self::default($key);
    }

    /** @return array{horizon_days:int, lead_minutes:int, few_left:int} */
    public function all(): array
    {
        if ($this->cache !== null) {
            /** @var array{horizon_days:int, lead_minutes:int, few_left:int} */
            return $this->cache;
        }
        $out = [];
        foreach (self::RULES as $key => [$default, $min, $max]) {
            $raw       = $this->settings?->get('booking_' . $key);
            $out[$key] = $raw !== null && is_numeric($raw) ? max($min, min($max, (int) $raw)) : $default;
        }

        /** @var array{horizon_days:int, lead_minutes:int, few_left:int} $out */
        return $this->cache = $out;
    }

    /**
     * Apply a partial update; returns the full set.
     *
     * @return array{horizon_days:int, lead_minutes:int, few_left:int}
     * @throws ValidationException
     */
    public function update(array $patch): array
    {
        $errors = [];
        foreach (self::RULES as $key => [, $min, $max, $label]) {
            if (!array_key_exists($key, $patch)) {
                continue;
            }
            $value = $patch[$key];
            if (!is_numeric($value) || (int) $value != $value || (int) $value < $min || (int) $value > $max) {
                $errors[$key] = sprintf('%s must be a whole number from %d to %d', $label, $min, $max);
            }
        }
        if ($errors !== []) {
            throw new ValidationException($errors);
        }
        if ($this->settings === null) {
            return $this->all();
        }
        foreach (array_keys(self::RULES) as $key) {
            if (array_key_exists($key, $patch)) {
                $this->settings->set('booking_' . $key, (string) (int) $patch[$key]);
            }
        }
        $this->cache = null;

        return $this->all();
    }
}
