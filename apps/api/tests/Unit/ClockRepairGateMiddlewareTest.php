<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Infrastructure\Middleware\ClockRepairGateMiddleware;
use App\Infrastructure\Persistence\ClockRepair;
use Doctrine\DBAL\Connection;
use Doctrine\ORM\EntityManagerInterface;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * The scheduling pause of the clock fix: while the repair (prod-migrate step
 * 13) is pending for this zone, scheduling writes answer 503
 * `scheduling_paused`; once it is recorded (or on a UTC process with no repair
 * recorded for a non-UTC zone) they go through. The check is cached per
 * process only once it passes.
 */
final class ClockRepairGateMiddlewareTest extends TestCase
{
    private string $zone = 'UTC';
    private int $handled = 0;
    private string|false $errorLog = false;

    protected function setUp(): void
    {
        $this->zone = date_default_timezone_get();
        ClockRepair::resetCache();
        unset($_ENV['CLOCK_REPAIR_GATE']);
        // A failed check is logged on purpose (class name only); keep it out of the output.
        $this->errorLog = ini_set('error_log', sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'clock-gate-test.log');
    }

    protected function tearDown(): void
    {
        date_default_timezone_set($this->zone);
        ClockRepair::resetCache();
        unset($_ENV['CLOCK_REPAIR_GATE']);
        if ($this->errorLog !== false) {
            ini_set('error_log', $this->errorLog);
        }
    }

    /** A gate whose database answers the setting read with `$fetchOne()`; `$calls` counts the reads. */
    private function gate(\Closure $fetchOne, int &$calls = 0): ClockRepairGateMiddleware
    {
        $conn = $this->createMock(Connection::class);
        $conn->method('fetchOne')->willReturnCallback(static function () use ($fetchOne, &$calls): mixed {
            ++$calls;

            return $fetchOne();
        });
        $em = $this->createMock(EntityManagerInterface::class);
        $em->method('getConnection')->willReturn($conn);

        return new ClockRepairGateMiddleware($em);
    }

    private function handle(ClockRepairGateMiddleware $gate): ResponseInterface
    {
        $handler = new class ($this) implements RequestHandlerInterface {
            public function __construct(private readonly ClockRepairGateMiddlewareTest $test)
            {
            }

            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                $this->test->handled();

                return new Response(201);
            }
        };

        return $gate->process((new ServerRequestFactory())->createServerRequest('POST', '/api/portal/appointments'), $handler);
    }

    public function handled(): void
    {
        ++$this->handled;
    }

    public function testSchedulingIsPausedWhileTheRepairIsPending(): void
    {
        date_default_timezone_set('Asia/Shanghai');
        $res = $this->handle($this->gate(static fn (): mixed => false));

        $this->assertSame(503, $res->getStatusCode());
        $this->assertSame('120', $res->getHeaderLine('Retry-After'));
        $this->assertSame([
            'status'  => 'error',
            'message' => ClockRepairGateMiddleware::MESSAGE,
            'errors'  => ['scheduling' => ClockRepairGateMiddleware::MESSAGE, 'code' => 'scheduling_paused'],
        ], json_decode((string) $res->getBody(), true));
        $this->assertSame(0, $this->handled);
    }

    public function testARecordedRepairOpensTheGateAndIsCachedForTheProcess(): void
    {
        date_default_timezone_set('Asia/Shanghai');
        $calls = 0;
        $gate  = $this->gate(static fn (): mixed => '{"zone":"Asia/Shanghai","offset":28800}', $calls);

        $this->assertSame(201, $this->handle($gate)->getStatusCode());
        $this->assertSame(201, $this->handle($gate)->getStatusCode());
        $this->assertSame(2, $this->handled);
        $this->assertSame(1, $calls, 'the second request does not ask again');
    }

    public function testARepairRecordedForAnotherZoneDoesNotCount(): void
    {
        date_default_timezone_set('Asia/Shanghai');
        $this->assertSame(503, $this->handle($this->gate(static fn (): mixed => '{"zone":"UTC"}'))->getStatusCode());
        $this->assertSame(0, $this->handled);
    }

    public function testAUtcProcessWithNoRecordedRepairGoesThroughAndIsCached(): void
    {
        date_default_timezone_set('UTC');
        $calls = 0;
        $gate  = $this->gate(static fn (): mixed => false, $calls);

        $this->assertSame(201, $this->handle($gate)->getStatusCode());
        $this->assertSame(201, $this->handle($gate)->getStatusCode());
        $this->assertSame(2, $this->handled);
        $this->assertSame(1, $calls, 'asked once (a repair recorded for another zone would pause it), then cached');
    }

    public function testAUtcProcessAfterARepairRecordedForAnotherZoneIsPaused(): void
    {
        // date.timezone changed to UTC (or the ini line is gone) after the repair ran on PRC.
        date_default_timezone_set('UTC');
        $calls = 0;
        $gate  = $this->gate(static fn (): mixed => '{"zone":"PRC","offset":28800}', $calls);

        $this->assertSame(503, $this->handle($gate)->getStatusCode());
        $this->assertSame(503, $this->handle($gate)->getStatusCode());
        $this->assertSame(0, $this->handled);
        $this->assertSame(2, $calls, 'pending is never cached');
    }

    public function testAUtcProcessWithARepairRecordedForAUtcZoneGoesThrough(): void
    {
        date_default_timezone_set('UTC');
        $this->assertSame(201, $this->handle($this->gate(static fn (): mixed => '{"zone":"Etc/UTC","offset":0}'))->getStatusCode());
        $this->assertSame(1, $this->handled);
    }

    public function testAnUnreadableRecordedZonePausesAUtcProcess(): void
    {
        date_default_timezone_set('UTC');
        $this->assertSame(503, $this->handle($this->gate(static fn (): mixed => '{"zone":"Not/AZone"}'))->getStatusCode());
        $this->assertSame(503, $this->handle($this->gate(static fn (): mixed => '{"offset":28800}'))->getStatusCode());
        $this->assertSame(0, $this->handled);
    }

    public function testTheOverrideLetsRequestsThrough(): void
    {
        date_default_timezone_set('Asia/Shanghai');
        $_ENV['CLOCK_REPAIR_GATE'] = 'off';
        $this->assertSame(201, $this->handle($this->gate(static fn (): mixed => false))->getStatusCode());
        $this->assertSame(1, $this->handled);
    }

    public function testAFailedCheckLetsTheActionAnswer(): void
    {
        date_default_timezone_set('Asia/Shanghai');
        $this->assertSame(201, $this->handle($this->gate(static fn (): mixed => throw new \RuntimeException('db down')))->getStatusCode());
        $this->assertSame(1, $this->handled);
    }
}
