<?php

declare(strict_types=1);

use App\Action;
use App\Infrastructure\Middleware\AuthMiddleware;
use App\Infrastructure\Middleware\CustomerAuthMiddleware;
use App\Infrastructure\Middleware\RbacMiddleware;
use App\Infrastructure\Service\JwtService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Slim\App;
use Slim\Routing\RouteCollectorProxy;

/**
 * Every route, grouped. Public routes first, then a protected group guarded by
 * the audience-scoped auth middleware, with per-route RBAC (see ARCHITECTURE §8).
 */
return static function (App $app): void {
    $container = $app->getContainer();
    $jwt       = $container->get(JwtService::class);

    // NB: route/group closures must NOT be `static` — Slim binds them to the
    // container via Closure::bindTo(), which returns null for static closures.
    $app->get('/health', function (
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $response->getBody()->write(json_encode(['status' => 'ok']));

        return $response->withHeader('Content-Type', 'application/json');
    });

    $app->group('/api', function (RouteCollectorProxy $group) use ($jwt): void {
        // ----- Public -----
        $group->post('/auth/login', Action\Auth\LoginAction::class);            // staff
        $group->post('/portal/auth/login', Action\Auth\CustomerLoginAction::class); // customer
        $group->post('/auth/refresh', Action\Auth\RefreshAction::class);

        // ----- Staff (default audience) -----
        $group->group('', function (RouteCollectorProxy $group): void {
            $group->get('/me', Action\Auth\MeAction::class);

            $group->get('/appointments', Action\Appointment\ListAppointmentsAction::class)
                ->add(new RbacMiddleware('appointments.view'));

            $group->get('/appointments/{id}', Action\Appointment\GetAppointmentAction::class)
                ->add(new RbacMiddleware('appointments.view'));

            $group->post('/appointments', Action\Appointment\CreateAppointmentAction::class)
                // Array + default requireAll:false means ANY of these permissions.
                ->add(new RbacMiddleware(['appointments.create', 'appointments.book']));

            $group->patch('/appointments/{id}/status', Action\Appointment\UpdateAppointmentStatusAction::class)
                ->add(new RbacMiddleware('appointments.update'));
        })->add(new AuthMiddleware($jwt));

        // ----- Customer portal (customer audience) -----
        $group->group('/portal', function (RouteCollectorProxy $group): void {
            $group->get('/me', Action\Patient\MyProfileAction::class);
            $group->get('/specialists', Action\Specialist\ListSpecialistsAction::class);
            $group->get('/appointments', Action\Appointment\ListMyAppointmentsAction::class);
            $group->get('/appointments/{id}', Action\Appointment\GetMyAppointmentAction::class);
        })->add(new CustomerAuthMiddleware($jwt));
    });
};
