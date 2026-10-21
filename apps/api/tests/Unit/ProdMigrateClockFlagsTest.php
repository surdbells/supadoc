<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use PHPUnit\Framework\TestCase;

/**
 * prod-migrate's clock-repair flags are checked before anything runs (before
 * the mode check and before an EntityManager exists): a malformed one stops it
 * with a usage error, so a fix run can never silently become a plain run. Every
 * case passes --dry-run, so even a regression could never write.
 */
final class ProdMigrateClockFlagsTest extends TestCase
{
    /** @return array{0:int, 1:string, 2:string} [exit code, stdout, stderr] */
    private function migrate(string ...$args): array
    {
        $pipes   = [];
        $process = proc_open(
            [PHP_BINARY, 'bin/prod-migrate.php', ...$args],
            [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
            $pipes,
            dirname(__DIR__, 2),
        );
        $this->assertIsResource($process);
        fclose($pipes[0]);
        $out = (string) stream_get_contents($pipes[1]);
        $err = (string) stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);

        return [proc_close($process), $out, $err];
    }

    public function testMalformedClockFlagsStopBeforeAnythingRuns(): void
    {
        foreach ([
            [['--dry-run', '--fix-clock='], '--fix-clock needs the zone'],
            [['--dry-run', '--fix-clock'], '--fix-clock needs a value'],
            [['--dry-run', '--fix-clock', 'PRC'], '--fix-clock needs a value'],
            [['--dry-run', '--clock-decide'], '--clock-decide needs a value'],
        ] as [$args, $message]) {
            [$code, $out, $err] = $this->migrate(...$args);
            $this->assertSame(1, $code, implode(' ', $args));
            $this->assertStringContainsString($message, $err, implode(' ', $args));
            $this->assertSame('', $out, 'no report: nothing ran');
        }

        [$code, $out, $err] = $this->migrate('--dry-run', '--clock-decide=x:move');
        $this->assertSame(1, $code);
        $this->assertStringStartsWith('--clock-decide:', $err);
        $this->assertSame('', $out);
    }
}
