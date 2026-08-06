<?php

declare(strict_types=1);

/**
 * Sentry bootstrap. A no-op unless SENTRY_DSN is set, so local/dev never needs
 * the sentry SDK installed. Only 5xx are reported (wired in the error handler).
 */
return static function (): void {
    $dsn = $_ENV['SENTRY_DSN'] ?? '';
    if ($dsn === '' || !function_exists('\Sentry\init')) {
        return;
    }

    \Sentry\init([
        'dsn'         => $dsn,
        'environment' => $_ENV['APP_ENV'] ?? 'production',
        'release'     => $_ENV['APP_RELEASE'] ?? null,
    ]);
};
