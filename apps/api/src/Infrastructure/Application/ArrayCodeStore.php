<?php

declare(strict_types=1);

namespace App\Infrastructure\Application;

/**
 * {@see CodeStore} in memory, for tests: an injectable clock moves time on,
 * and `$failing` makes every call throw (Redis down).
 */
final class ArrayCodeStore implements CodeStore
{
    /** @var array<string, array{v:string, exp:int}> */
    private array $data = [];

    public bool $failing = false;

    public int $now;

    public function __construct(?int $now = null)
    {
        $this->now = $now ?? time();
    }

    public function advance(int $seconds): void
    {
        $this->now += $seconds;
    }

    public function get(string $key): ?string
    {
        $this->check();

        return $this->live($key) ? $this->data[$key]['v'] : null;
    }

    public function setEx(string $key, string $value, int $ttl): void
    {
        $this->check();
        $this->data[$key] = ['v' => $value, 'exp' => $this->now + max(1, $ttl)];
    }

    public function setNx(string $key, string $value, int $ttl): bool
    {
        $this->check();
        if ($this->live($key)) {
            return false;
        }
        $this->data[$key] = ['v' => $value, 'exp' => $this->now + max(1, $ttl)];

        return true;
    }

    public function del(string $key): void
    {
        $this->check();
        unset($this->data[$key]);
    }

    public function ttl(string $key): int
    {
        $this->check();

        return $this->live($key) ? $this->data[$key]['exp'] - $this->now : -2;
    }

    public function count(string $key, int $ttl): int
    {
        $this->check();
        if (!$this->live($key)) {
            $this->data[$key] = ['v' => '0', 'exp' => $this->now + max(1, $ttl)];
        }
        $this->data[$key]['v'] = (string) ((int) $this->data[$key]['v'] + 1);

        return (int) $this->data[$key]['v'];
    }

    public function decrement(string $key): void
    {
        $this->check();
        if ($this->live($key)) {
            $this->data[$key]['v'] = (string) max(0, (int) $this->data[$key]['v'] - 1);
        }
    }

    public function peek(string $key): int
    {
        $this->check();

        return $this->live($key) ? (int) $this->data[$key]['v'] : 0;
    }

    private function live(string $key): bool
    {
        if (!isset($this->data[$key])) {
            return false;
        }
        if ($this->data[$key]['exp'] <= $this->now) {
            unset($this->data[$key]);

            return false;
        }

        return true;
    }

    private function check(): void
    {
        if ($this->failing) {
            throw new \RuntimeException('code store unavailable');
        }
    }
}
