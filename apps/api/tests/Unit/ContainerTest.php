<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\PatientRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use App\Infrastructure\Service\AuthService;
use App\Infrastructure\Service\CallPresence;
use App\Infrastructure\Service\JwtService;
use App\Infrastructure\Service\SettingsCacheService;
use DI\ContainerBuilder;
use Doctrine\ORM\EntityManagerInterface;
use PHPUnit\Framework\TestCase;
use Psr\Log\LoggerInterface;
use Slim\Factory\AppFactory;
use Slim\Routing\RoutingResults;

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
        $this->assertIsObject($container->get(CallPresence::class));

        // Document sharing: the policy, the service and its collaborators, every action.
        foreach ([
            \App\Infrastructure\Document\DocumentAccessPolicy::class,
            \App\Infrastructure\Document\DocumentSharingService::class,
            \App\Infrastructure\Document\DocumentSharingViews::class,
            \App\Infrastructure\Document\DocumentAccessSweeper::class,
            \App\Infrastructure\Document\DocumentAccessNotifier::class,
            \App\Infrastructure\Service\SpecialistSuspensionService::class,
        ] as $id) {
            $this->assertIsObject($container->get($id), "could not resolve $id");
        }
        $this->assertSame(
            $container->get(\App\Infrastructure\Document\DocumentAccessNoticeQueue::class),
            $container->get(\App\Infrastructure\Document\DocumentAccessNoticeQueue::class),
            'one notice queue per request (container)',
        );
        $actions = array_map(
            static fn (string $file): string => 'App\\Action\\DocumentSharing\\' . basename($file, '.php'),
            glob(__DIR__ . '/../../src/Action/DocumentSharing/*Action.php') ?: [],
        );
        $this->assertCount(18, $actions, 'the 18 patient sharing actions');
        foreach ([
            ...$actions,
            \App\Action\Doctor\DoctorDocumentAccessAction::class,
            \App\Action\Doctor\RequestDocumentAccessAction::class,
            \App\Action\Doctor\CancelDocumentAccessRequestAction::class,
            \App\Action\Doctor\ListPatientDocumentsAction::class,
            \App\Action\Doctor\DownloadPatientDocumentAction::class,
            \App\Action\Doctor\RescheduleDoctorAppointmentAction::class,
            \App\Action\Patient\UploadMyDocumentAction::class,
            \App\Action\Patient\ListMyDocumentsAction::class,
            \App\Action\Appointment\UploadAppointmentDocumentAction::class,
            \App\Action\Appointment\CreateMyAppointmentAction::class,
            \App\Action\Appointment\GetMyAppointmentAction::class,
            \App\Action\Appointment\ReschedulePortalAppointmentAction::class,
        ] as $class) {
            $this->assertIsObject($container->get($class), "could not resolve $class");
        }
    }

    /**
     * The route table compiles: FastRoute refuses a static route registered after
     * a variable one that shadows it (e.g. /appointments/presence after
     * /appointments/{id}) — and then every request is a 500.
     */
    public function testRouteTableCompiles(): void
    {
        $_ENV['DB_SERVER_VERSION'] = '16';
        DoctrineEntityManagerFactory::reset();
        $builder = new ContainerBuilder();
        $builder->addDefinitions(__DIR__ . '/../../config/container.php');
        AppFactory::setContainer($builder->build());
        $app = AppFactory::create();
        (require __DIR__ . '/../../config/routes.php')($app);

        $result = $app->getRouteResolver()->computeRoutingResults('/api/portal/appointments/presence', 'GET');
        $this->assertSame(RoutingResults::FOUND, $result->getRouteStatus());
    }

    /**
     * The whole app boots the way public/index.php builds it — global
     * middleware included — and a request makes it through the pipeline.
     * (A `static` closure passed to $app->add() makes Slim's bind fail, so
     * every request in production was a fatal error while the other tests
     * stayed green.)
     */
    public function testTheAppBootsWithItsMiddlewareAndHandlesARequest(): void
    {
        $_ENV['DB_SERVER_VERSION'] = '16';
        DoctrineEntityManagerFactory::reset();
        $builder = new ContainerBuilder();
        $builder->addDefinitions(__DIR__ . '/../../config/container.php');
        AppFactory::setContainer($builder->build());
        $app = AppFactory::create();
        (require __DIR__ . '/../../config/middleware.php')($app);
        (require __DIR__ . '/../../config/routes.php')($app);

        // The Paystack webhook skips the rate limiter (no Redis needed) and
        // refuses an unsigned event before touching the database.
        $request = (new \Slim\Psr7\Factory\ServerRequestFactory())
            ->createServerRequest('POST', '/api/webhooks/paystack')
            ->withHeader('Content-Type', 'application/json');
        $request->getBody()->write('{"event":"charge.success","data":{"reference":"x"}}');
        $request->getBody()->rewind();

        $this->assertSame(401, $app->handle($request)->getStatusCode());
    }
}
