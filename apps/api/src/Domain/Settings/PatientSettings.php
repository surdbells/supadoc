<?php

declare(strict_types=1);

namespace App\Domain\Settings;

/**
 * Canonical schema + defaults for a patient's app preferences. Everything is a
 * boolean toggle grouped by area. This is the single source of truth: the API
 * only ever accepts, persists, and returns these keys, so unknown/renamed keys
 * from a client are ignored and new keys added here default in for everyone.
 */
final class PatientSettings
{
    private const DEFAULTS = [
        'notifications' => [
            'appointment_reminder'    => true,
            'consultation_updates'    => true,
            'payment_notifications'   => true,
            'account_security_alerts' => true,
            'marketing_announcements' => false,
        ],
        'delivery' => [
            'sms'   => false,
            'push'  => true,
            'email' => true,
        ],
        'privacy' => [
            'two_factor' => false,
            'biometrics' => false,
        ],
    ];

    /** The full default settings map. */
    public static function defaults(): array
    {
        return self::DEFAULTS;
    }

    /** Defaults overlaid with any stored (known) values — always complete. */
    public static function withDefaults(array $stored): array
    {
        $out = self::DEFAULTS;
        foreach (self::DEFAULTS as $group => $keys) {
            foreach ($keys as $key => $_default) {
                if (isset($stored[$group]) && is_array($stored[$group]) && array_key_exists($key, $stored[$group])) {
                    $out[$group][$key] = (bool) $stored[$group][$key];
                }
            }
        }

        return $out;
    }

    /**
     * Merge a (possibly partial) patch onto current settings, keeping only known
     * keys and coercing values to booleans. Returns the full settings map.
     */
    public static function merge(array $current, array $patch): array
    {
        $out = self::withDefaults($current);
        foreach (self::DEFAULTS as $group => $keys) {
            if (!isset($patch[$group]) || !is_array($patch[$group])) {
                continue;
            }
            foreach ($keys as $key => $_default) {
                if (array_key_exists($key, $patch[$group])) {
                    $out[$group][$key] = (bool) $patch[$group][$key];
                }
            }
        }

        return $out;
    }

    /** True when the patch references at least one known key (else it's a no-op). */
    public static function hasKnownKeys(array $patch): bool
    {
        foreach (self::DEFAULTS as $group => $keys) {
            if (!isset($patch[$group]) || !is_array($patch[$group])) {
                continue;
            }
            foreach (array_keys($keys) as $key) {
                if (array_key_exists($key, $patch[$group])) {
                    return true;
                }
            }
        }

        return false;
    }
}
