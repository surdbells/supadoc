<?php

declare(strict_types=1);

namespace App\Infrastructure\Application;

use Predis\Client as RedisClient;

/** {@see CodeStore} on Redis (keys under the app's REDIS_PREFIX). */
final class RedisCodeStore implements CodeStore
{
    public function __construct(private readonly RedisClient $redis)
    {
    }

    public function get(string $key): ?string
    {
        $value = $this->redis->get($key);

        return is_string($value) ? $value : null;
    }

    public function setEx(string $key, string $value, int $ttl): void
    {
        $this->redis->setex($key, max(1, $ttl), $value);
    }

    public function setNx(string $key, string $value, int $ttl): bool
    {
        return $this->redis->set($key, $value, 'EX', max(1, $ttl), 'NX') !== null;
    }

    public function del(string $key): void
    {
        $this->redis->del([$key]);
    }

    public function ttl(string $key): int
    {
        return (int) $this->redis->ttl($key);
    }

    public function count(string $key, int $ttl): int
    {
        $this->redis->set($key, 0, 'EX', max(1, $ttl), 'NX');

        return (int) $this->redis->incr($key);
    }

    public function decrement(string $key): void
    {
        // DECR on a key that expired meanwhile creates it at -1 with no TTL: drop that one.
        if ((int) $this->redis->decr($key) < 0) {
            $this->redis->del([$key]);
        }
    }

    public function peek(string $key): int
    {
        return (int) ($this->redis->get($key) ?? 0);
    }
}
