<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use Predis\Client as RedisClient;

/**
 * Read-through cache for app settings. Minimal scaffold: env-backed with a Redis
 * cache in front. Replace the backing store with a `settings` table/repository
 * as the domain grows — the public shape (get/set/forget) stays the same.
 */
final class SettingsCacheService
{
    private const TTL = 300;

    public function __construct(private readonly RedisClient $redis)
    {
    }

    public function get(string $key, mixed $default = null): mixed
    {
        try {
            $cached = $this->redis->get("settings:$key");
            if ($cached !== null) {
                return json_decode($cached, true);
            }
        } catch (\Throwable) {
            // Redis unavailable — fall through to env.
        }

        $value = $_ENV[strtoupper($key)] ?? $default;
        $this->remember($key, $value);

        return $value;
    }

    public function remember(string $key, mixed $value): void
    {
        try {
            $this->redis->setex("settings:$key", self::TTL, json_encode($value));
        } catch (\Throwable) {
            // Best effort — a cache miss next time is fine.
        }
    }

    public function forget(string $key): void
    {
        try {
            $this->redis->del("settings:$key");
        } catch (\Throwable) {
            // No-op.
        }
    }
}
