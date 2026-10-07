<?php

declare(strict_types=1);

namespace App\Infrastructure\Prescription;

use App\Domain\Exception\ValidationException;
use App\Domain\Repository\AppSettingRepository;

/**
 * The prescription rules the Platform Admin can change without a release
 * (GVM-RX-02 "Ground rules"): default validity, the expiry-reminder lead time,
 * the pharmacist check lock-out and the download-link lifetime. Persisted in
 * app_settings; each value is clamped to a safe range.
 */
final class PrescriptionSettings
{
    /** key => [default, min, max, label] */
    public const RULES = [
        'valid_days'         => [30, 1, 365, 'Default validity (days)'],
        'reminder_days'      => [3, 1, 30, 'Expiry reminder (days before)'],
        'check_max_attempts' => [5, 3, 20, 'Check page: wrong tries before lock'],
        'check_lock_minutes' => [15, 1, 1440, 'Check page: lock length (minutes)'],
        'link_minutes'       => [15, 1, 60, 'Download link lifetime (minutes)'],
    ];

    public function __construct(private readonly AppSettingRepository $settings)
    {
    }

    public function get(string $key): int
    {
        [$default, $min, $max] = self::RULES[$key];
        $raw = $this->settings->get('rx_' . $key);

        return $raw !== null && is_numeric($raw) ? max($min, min($max, (int) $raw)) : $default;
    }

    /** @return array<string,int> */
    public function all(): array
    {
        $out = [];
        foreach (array_keys(self::RULES) as $key) {
            $out[$key] = $this->get($key);
        }

        return $out;
    }

    /**
     * Apply a partial update; returns the full set.
     *
     * @return array<string,int>
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
        foreach (array_keys(self::RULES) as $key) {
            if (array_key_exists($key, $patch)) {
                $this->settings->set('rx_' . $key, (string) (int) $patch[$key]);
            }
        }

        return $this->all();
    }
}
