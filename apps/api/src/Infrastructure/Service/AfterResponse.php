<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

/**
 * Work to do once the HTTP reply has gone out — slow side effects such as
 * sending email, so they neither delay the person waiting nor make the reply's
 * timing depend on them (e.g. forgot-password must take as long for an unknown
 * address as for a real account).
 *
 * Under PHP-FPM the queued tasks run at shutdown, after fastcgi_finish_request()
 * has flushed and closed the response. On the CLI (scripts, tests) there is no
 * response to wait for, so a task runs immediately. A failing task is logged to
 * the PHP error log and never affects the others.
 */
final class AfterResponse
{
    /** @var list<callable(): void> */
    private static array $tasks = [];

    private static bool $registered = false;

    /** @param callable(): void $task */
    public static function defer(callable $task): void
    {
        if (PHP_SAPI === 'cli' || PHP_SAPI === 'phpdbg') {
            self::runSafely($task);

            return;
        }

        self::$tasks[] = $task;
        if (!self::$registered) {
            self::$registered = true;
            register_shutdown_function([self::class, 'flush']);
        }
    }

    /** @internal Shutdown hook: finish the reply, then run what was queued. */
    public static function flush(): void
    {
        ignore_user_abort(true);
        if (function_exists('fastcgi_finish_request')) {
            fastcgi_finish_request();
        } elseif (function_exists('litespeed_finish_request')) {
            litespeed_finish_request();
        }

        while (self::$tasks !== []) {
            self::runSafely(array_shift(self::$tasks));
        }
    }

    /** @param callable(): void $task */
    private static function runSafely(callable $task): void
    {
        try {
            $task();
        } catch (\Throwable $e) {
            error_log('Deferred task failed: ' . $e::class . ': ' . $e->getMessage());
        }
    }
}
