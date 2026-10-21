<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Infrastructure\Persistence\ClockRepair;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use DI\ContainerBuilder;
use PHPUnit\Framework\TestCase;
use Slim\Factory\AppFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

/**
 * /health/ready reports the clock fix (`clock.marker`, `clock.repair`) next to
 * its existing keys — whatever the database and Redis answer (they may be down
 * here; readiness itself does not depend on the clock block).
 */
final class HealthClockTest extends TestCase
{
    private string $zone = 'UTC';

    protected function setUp(): void
    {
        $this->zone = date_default_timezone_get();
        date_default_timezone_set('UTC');
        ClockRepair::resetCache();
    }

    protected function tearDown(): void
    {
        date_default_timezone_set($this->zone);
        ClockRepair::resetCache();
        DoctrineEntityManagerFactory::reset();
    }

    public function testReadinessReportsTheClockFix(): void
    {
        $_ENV['DB_SERVER_VERSION'] = '16';
        DoctrineEntityManagerFactory::reset();
        $builder = new ContainerBuilder();
        $builder->addDefinitions(__DIR__ . '/../../config/container.php');
        AppFactory::setContainer($builder->build());
        $app = AppFactory::create();
        (require __DIR__ . '/../../config/routes.php')($app);

        $response = $app->handle((new ServerRequestFactory())->createServerRequest('GET', '/health/ready'));
        $body     = json_decode((string) $response->getBody(), true);

        $this->assertIsArray($body);
        $this->assertContains($response->getStatusCode(), [200, 503]);
        foreach (['status', 'checks', 'tz', 'clock'] as $key) {
            $this->assertArrayHasKey($key, $body);
        }
        $this->assertIsBool($body['clock']['marker']);
        // A UTC process reads the recorded repair too (one recorded for another zone
        // would pause it): with the database down that read fails, and it says so.
        if ($body['checks']['database'] === true) {
            $this->assertSame('not_needed', $body['clock']['repair'], 'a UTC process, no repair recorded: nothing was stored on another clock');
        } else {
            $this->assertSame('unknown', $body['clock']['repair'], 'the database is down: the recorded repair cannot be read');
        }
        $this->assertSame('UTC', $body['tz']);
    }
}
