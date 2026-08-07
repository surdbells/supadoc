<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use DI\ContainerBuilder;
use PHPUnit\Framework\TestCase;
use Slim\Factory\AppFactory;

/**
 * Enforces the rule that lives in config/openapi.php's header: every route must
 * be documented. Boots the real router, then asserts each registered method has
 * a matching OpenAPI path — so a new endpoint added without a spec entry fails
 * the build, not the reader.
 */
final class SwaggerCoverageTest extends TestCase
{
    /** Meta routes that serve the docs themselves — not part of the API surface. */
    private const EXCLUDED = ['/api/docs', '/api/docs/openapi.json'];

    public function testEveryRouteIsDocumented(): void
    {
        $_ENV['DB_SERVER_VERSION'] = '16';
        DoctrineEntityManagerFactory::reset();

        $builder = new ContainerBuilder();
        $builder->addDefinitions(__DIR__ . '/../../config/container.php');
        $container = $builder->build();

        AppFactory::setContainer($container);
        $app = AppFactory::create();
        (require __DIR__ . '/../../config/routes.php')($app);

        /** @var array<string, array<string, mixed>> $paths */
        $paths = (require __DIR__ . '/../../config/openapi.php')['paths'] ?? [];

        $undocumented = [];
        foreach ($app->getRouteCollector()->getRoutes() as $route) {
            $pattern = $route->getPattern();
            if (in_array($pattern, self::EXCLUDED, true)) {
                continue;
            }
            foreach ($route->getMethods() as $method) {
                if (in_array($method, ['OPTIONS', 'HEAD'], true)) {
                    continue;
                }
                if (!isset($paths[$pattern][strtolower($method)])) {
                    $undocumented[] = "$method $pattern";
                }
            }
        }

        sort($undocumented);
        $this->assertSame(
            [],
            $undocumented,
            'These routes are missing from config/openapi.php: ' . implode(', ', $undocumented),
        );
    }
}
