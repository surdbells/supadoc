<?php

declare(strict_types=1);

use App\Action;
use App\Infrastructure\Middleware\AuthMiddleware;
use App\Infrastructure\Middleware\CustomerAuthMiddleware;
use App\Infrastructure\Middleware\RbacMiddleware;
use App\Infrastructure\Service\JwtService;
use App\Infrastructure\Service\SessionService;
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
    $sessions  = $container->get(SessionService::class);

    // NB: route/group closures must NOT be `static` — Slim binds them to the
    // container via Closure::bindTo(), which returns null for static closures.
    $app->get('/health', function (
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $response->getBody()->write(json_encode(['status' => 'ok']));

        return $response->withHeader('Content-Type', 'application/json');
    });

    // API docs (public): Swagger UI + the raw OpenAPI document.
    $app->get('/api/docs', Action\Docs\SwaggerUiAction::class);
    $app->get('/api/docs/openapi.json', Action\Docs\OpenApiAction::class);

    $app->group('/api', function (RouteCollectorProxy $group) use ($jwt, $sessions): void {
        // ----- Public -----
        $group->post('/auth/login', Action\Auth\LoginAction::class);            // staff
        $group->post('/portal/auth/login', Action\Auth\CustomerLoginAction::class); // customer
        $group->post('/portal/auth/google', Action\Auth\GoogleLoginAction::class);  // customer (Google)
        $group->post('/portal/auth/email/request-otp', Action\Auth\RequestEmailOtpAction::class);
        $group->post('/portal/auth/email/verify-otp', Action\Auth\VerifyEmailOtpAction::class);
        $group->post('/portal/auth/register', Action\Auth\RegisterAction::class);
        $group->post('/portal/auth/reset-password', Action\Auth\ResetPasswordAction::class);
        $group->post('/portal/auth/phone/request-otp', Action\Auth\RequestPhoneOtpAction::class);
        $group->post('/portal/auth/phone/verify-otp', Action\Auth\VerifyPhoneOtpAction::class);
        $group->post('/portal/auth/phone/register', Action\Auth\RegisterByPhoneAction::class);
        $group->post('/portal/auth/phone/login', Action\Auth\LoginByPhoneAction::class);
        $group->post('/auth/refresh', Action\Auth\RefreshAction::class);

        // ----- Public marketing data (no auth) -----
        $group->get('/public/specialties', Action\Public\PublicSpecialtiesAction::class);
        $group->get('/public/facets', Action\Public\PublicFacetsAction::class);
        $group->get('/public/specialists', Action\Public\PublicSpecialistsAction::class);
        $group->get('/public/specialists/{id}/slots', Action\Specialist\GetSpecialistSlotsAction::class);

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
            $group->patch('/me', Action\Patient\UpdateMyProfileAction::class);
            $group->post('/me/password', Action\Patient\ChangeMyPasswordAction::class);
            $group->post('/me/avatar', Action\Patient\UploadMyAvatarAction::class);
            $group->delete('/me/avatar', Action\Patient\DeleteMyAvatarAction::class);
            $group->get('/me/settings', Action\Patient\MySettingsAction::class);
            $group->patch('/me/settings', Action\Patient\UpdateMySettingsAction::class);
            $group->get('/me/health-profile', Action\Patient\MyHealthProfileAction::class);
            $group->patch('/me/health-profile', Action\Patient\UpdateMyHealthProfileAction::class);
            $group->get('/me/sessions', Action\Patient\MySessionsAction::class);
            $group->delete('/me/sessions/{id}', Action\Patient\RevokeSessionAction::class);
            $group->post('/me/verify-phone', Action\Patient\VerifyMyPhoneAction::class);
            $group->get('/specialists/specialties', Action\Specialist\ListSpecialtiesAction::class);
            $group->get('/specialists', Action\Specialist\ListSpecialistsAction::class);
            $group->get('/appointments', Action\Appointment\ListMyAppointmentsAction::class);
            $group->post('/appointments', Action\Appointment\CreateMyAppointmentAction::class);
            $group->get('/appointments/{id}', Action\Appointment\GetMyAppointmentAction::class);
            $group->get('/appointments/{id}/call-token', Action\Appointment\GetCallTokenAction::class);
            $group->get('/notifications', Action\Notification\ListNotificationsAction::class);
            $group->post('/notifications/read-all', Action\Notification\MarkAllNotificationsReadAction::class);
            $group->post('/notifications/{id}/read', Action\Notification\MarkNotificationReadAction::class);
        })->add(new CustomerAuthMiddleware($jwt, $sessions));
    });
};
