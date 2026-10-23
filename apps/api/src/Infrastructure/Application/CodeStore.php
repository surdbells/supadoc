<?php

declare(strict_types=1);

namespace App\Infrastructure\Application;

/**
 * The few key/value operations the applicant codes need (spec §2.8) — Redis in
 * production ({@see RedisCodeStore}), in memory in tests ({@see ArrayCodeStore}).
 * Any failure throws; ApplicationCodeService turns that into 503
 * `codes_unavailable` (fail closed).
 */
interface CodeStore
{
    public function get(string $key): ?string;

    public function setEx(string $key, string $value, int $ttl): void;

    /** SET NX EX — true when the key was free and is now set. */
    public function setNx(string $key, string $value, int $ttl): bool;

    public function del(string $key): void;

    /** Seconds left (≤ 0 when missing or without expiry). */
    public function ttl(string $key): int;

    /**
     * Add one to a counter whose window starts with its first count: the TTL is
     * set only when the key is created (`SET key 0 EX ttl NX`, then `INCR`), so
     * later counts never extend it. Returns the new count.
     */
    public function count(string $key, int $ttl): int;

    /**
     * Take one back from a counter (an attempt counted up front that turned out
     * not to be a failure). Keeps the counter's window; a counter that had
     * already expired is not recreated.
     */
    public function decrement(string $key): void;

    /** A counter's current value (0 when missing). */
    public function peek(string $key): int;
}
