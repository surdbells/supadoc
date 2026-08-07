<?php

declare(strict_types=1);

use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\PatientRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use App\Infrastructure\Service\AuthService;
use App\Infrastructure\Service\FirebaseIdTokenVerifier;
use App\Infrastructure\Service\JwtService;
use App\Infrastructure\Service\SettingsCacheService;
use Doctrine\ORM\EntityManagerInterface;
use Monolog\Handler\StreamHandler;
use Monolog\Level;
use Monolog\Logger;
use Predis\Client as RedisClient;
use Psr\Container\ContainerInterface;
use Psr\Log\LoggerInterface;

/**
 * DI definitions. Two rules (see ARCHITECTURE §5):
 *   1. Actions are autowired — never register them.
 *   2. Services and repositories are registered explicitly here.
 * Constructor scalars (e.g. a `string $secret`) break autowiring, which is why
 * every service that needs one is built by an explicit factory below.
 *
 * This array is intentionally the single wiring surface; split per-domain and
 * merge with several addDefinitions() files once it grows past a screen or two.
 */
return [
    // ----- Core -----
    EntityManagerInterface::class => static fn (): EntityManagerInterface =>
        DoctrineEntityManagerFactory::create(),

    LoggerInterface::class => static function (): LoggerInterface {
        $logger = new Logger('app');
        $logger->pushHandler(new StreamHandler(
            __DIR__ . '/../var/logs/app.log',
            ($_ENV['APP_ENV'] ?? 'production') === 'production' ? Level::Info : Level::Debug,
        ));

        return $logger;
    },

    RedisClient::class => static fn (): RedisClient => new RedisClient([
        'scheme' => 'tcp',
        'host'   => $_ENV['REDIS_HOST'] ?? '127.0.0.1',
        'port'   => (int) ($_ENV['REDIS_PORT'] ?? 6379),
    ], [
        'prefix' => $_ENV['REDIS_PREFIX'] ?? 'app:',
    ]),

    // ----- Services -----
    JwtService::class => static fn (): JwtService => new JwtService(
        secret:     $_ENV['JWT_SECRET'] ?? 'change-me',
        accessTtl:  (int) ($_ENV['JWT_ACCESS_TTL'] ?? 900),
        refreshTtl: (int) ($_ENV['JWT_REFRESH_TTL'] ?? 1209600),
    ),

    SettingsCacheService::class => static fn (ContainerInterface $c): SettingsCacheService =>
        new SettingsCacheService($c->get(RedisClient::class)),

    FirebaseIdTokenVerifier::class => static fn (): FirebaseIdTokenVerifier =>
        new FirebaseIdTokenVerifier($_ENV['FIREBASE_PROJECT_ID'] ?? ''),

    AuthService::class => static fn (ContainerInterface $c): AuthService => new AuthService(
        $c->get(UserRepository::class),
        $c->get(PatientRepository::class),
        $c->get(JwtService::class),
    ),

    // ----- Repositories -----
    UserRepository::class => static fn (ContainerInterface $c): UserRepository =>
        new UserRepository($c->get(EntityManagerInterface::class)),

    PatientRepository::class => static fn (ContainerInterface $c): PatientRepository =>
        new PatientRepository($c->get(EntityManagerInterface::class)),

    SpecialistRepository::class => static fn (ContainerInterface $c): SpecialistRepository =>
        new SpecialistRepository($c->get(EntityManagerInterface::class)),

    AppointmentRepository::class => static fn (ContainerInterface $c): AppointmentRepository =>
        new AppointmentRepository($c->get(EntityManagerInterface::class)),
];
