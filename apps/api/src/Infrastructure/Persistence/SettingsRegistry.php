<?php

declare(strict_types=1);

namespace App\Infrastructure\Persistence;

use App\Infrastructure\Service\SettingsCacheService;

/**
 * Deliberately narrow static registrar for code that genuinely can't take DI
 * (traits mixed into many Actions). Rules (see ARCHITECTURE §9):
 *   - exposes exactly ONE type — resist adding a second;
 *   - callers MUST handle null (CLI/tests never set it).
 */
final class SettingsRegistry
{
    private static ?SettingsCacheService $settings = null;

    public static function set(SettingsCacheService $settings): void
    {
        self::$settings = $settings;
    }

    public static function get(): ?SettingsCacheService
    {
        return self::$settings;
    }
}
