<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\PatientRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use App\Infrastructure\Service\AuthService;
use App\Infrastructure\Service\JwtService;
use App\Infrastructure\Service\SettingsCacheService;
use DI\ContainerBuilder;
use Doctrine\ORM\EntityManagerInterface;
use PHPUnit\Framework\TestCase;
use Psr\Log\LoggerInterface;

/**
 * Proves the DI wiring in config/container.php actually resolves — a typo in a
 * constructor dependency is a boot-time 500 otherwise. Everything here builds
 * lazily (predis/Doctrine don't connect on construction), so it runs with no DB
 * and no Redis.
 */
final class ContainerTest extends TestCase
{
    public function testRegisteredServicesResolve(): void
    {
        $_ENV['DB_SERVER_VERSION'] = '16';
        DoctrineEntityManagerFactory::reset();

        $builder = new ContainerBuilder();
        $builder->addDefinitions(__DIR__ . '/../../config/container.php');
        $container = $builder->build();

        foreach ([
            EntityManagerInterface::class,
            LoggerInterface::class,
            JwtService::class,
            SettingsCacheService::class,
            AuthService::class,
            UserRepository::class,
            PatientRepository::class,
            SpecialistRepository::class,
            AppointmentRepository::class,
        ] as $id) {
            $this->assertTrue($container->has($id), "container missing $id");
            $this->assertIsObject($container->get($id), "could not resolve $id");
        }
    }
}
