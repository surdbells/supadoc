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
        $group->get('/public/specialists/{id}', Action\Public\GetPublicSpecialistAction::class);
        $group->get('/public/pricing', Action\Public\PublicPricingAction::class);
        // Preauthenticated join — the signed token in the path IS the credential.
        $group->get('/public/call/{token}', Action\Call\JoinCallAction::class);

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

            $group->patch('/settings/pricing', Action\Settings\UpdatePricingAction::class)
                ->add(new RbacMiddleware('settings.manage'));

            // Back-office: list + edit specialists (incl. their contact email).
            $group->get('/specialists', Action\Specialist\ListSpecialistsAdminAction::class)
                ->add(new RbacMiddleware('specialists.manage'));
            $group->patch('/specialists/{id}', Action\Specialist\UpdateSpecialistAction::class)
                ->add(new RbacMiddleware('specialists.manage'));

            // Minimal doctor portal — a doctor login (role 'doctor') sees only
            // their own consultations. The action enforces the doctor role.
            $group->get('/doctor/appointments', Action\Doctor\DoctorAppointmentsAction::class);

            // In-consultation clinical documentation. Each action re-checks that
            // the signed-in doctor owns the appointment (ResolvesDoctorAppointment).
            $group->get('/doctor/appointments/{id}/note', Action\Doctor\GetClinicalNoteAction::class);
            $group->put('/doctor/appointments/{id}/note', Action\Doctor\SaveClinicalNoteAction::class);
            $group->post('/doctor/appointments/{id}/note/finalize', Action\Doctor\FinalizeClinicalNoteAction::class);

            // ePrescription — build + issue, list issued.
            $group->get('/doctor/appointments/{id}/prescriptions', Action\Doctor\ListPrescriptionsAction::class);
            $group->post('/doctor/appointments/{id}/prescriptions', Action\Doctor\CreatePrescriptionAction::class);

            // Lab orders + care plan.
            $group->get('/doctor/appointments/{id}/lab-orders', Action\Doctor\ListLabOrdersAction::class);
            $group->post('/doctor/appointments/{id}/lab-orders', Action\Doctor\CreateLabOrderAction::class);
            $group->get('/doctor/appointments/{id}/care-plan', Action\Doctor\GetCarePlanAction::class);
            $group->put('/doctor/appointments/{id}/care-plan', Action\Doctor\SaveCarePlanAction::class);

            // Referrals + consent (doctor reads consent to know what's permitted).
            $group->get('/doctor/appointments/{id}/referrals', Action\Doctor\ListReferralsAction::class);
            $group->post('/doctor/appointments/{id}/referrals', Action\Doctor\CreateReferralAction::class);
            $group->get('/doctor/appointments/{id}/consents', Action\Doctor\DoctorConsentsAction::class);

            // Cloud recording — consent-gated start/stop + status.
            $group->get('/doctor/appointments/{id}/recording', Action\Doctor\GetRecordingAction::class);
            $group->post('/doctor/appointments/{id}/recording/start', Action\Doctor\StartRecordingAction::class);
            $group->post('/doctor/appointments/{id}/recording/stop', Action\Doctor\StopRecordingAction::class);

            // RTC connection-quality sample from the doctor's call client.
            $group->post('/doctor/appointments/{id}/metrics', Action\Doctor\ReportMetricAction::class);

            // Live transcription (consent-gated) + AI copilot draft.
            $group->get('/doctor/appointments/{id}/transcript', Action\Doctor\GetTranscriptAction::class);
            $group->post('/doctor/appointments/{id}/transcript', Action\Doctor\AppendTranscriptAction::class);
            $group->get('/doctor/appointments/{id}/copilot', Action\Doctor\GetCopilotDraftAction::class);
            $group->post('/doctor/appointments/{id}/copilot/draft', Action\Doctor\GenerateCopilotDraftAction::class);

            // Back-office consultation monitoring (real data: activity, recordings, audit).
            $group->get('/admin/monitoring/overview', Action\Admin\MonitoringOverviewAction::class)
                ->add(new RbacMiddleware('monitoring.view'));
            $group->get('/admin/monitoring/consultations', Action\Admin\MonitoringConsultationsAction::class)
                ->add(new RbacMiddleware('monitoring.view'));
            $group->get('/admin/monitoring/recordings', Action\Admin\MonitoringRecordingsAction::class)
                ->add(new RbacMiddleware('monitoring.view'));
            $group->get('/admin/monitoring/audit', Action\Admin\MonitoringAuditAction::class)
                ->add(new RbacMiddleware('monitoring.view'));
            $group->get('/admin/monitoring/quality', Action\Admin\MonitoringQualityAction::class)
                ->add(new RbacMiddleware('monitoring.view'));
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
            $group->post('/appointment-documents', Action\Appointment\UploadAppointmentDocumentAction::class);
            $group->get('/appointments/{id}', Action\Appointment\GetMyAppointmentAction::class);
            $group->get('/appointments/{id}/call-token', Action\Appointment\GetCallTokenAction::class);
            $group->get('/appointments/{id}/consultation', Action\Appointment\GetMyConsultationAction::class);
            $group->get('/appointments/{id}/prescriptions', Action\Appointment\MyPrescriptionsAction::class);
            $group->get('/appointments/{id}/lab-orders', Action\Appointment\MyLabOrdersAction::class);
            $group->get('/appointments/{id}/care-plan', Action\Appointment\MyCarePlanAction::class);
            $group->get('/appointments/{id}/referrals', Action\Appointment\MyReferralsAction::class);
            $group->get('/appointments/{id}/consents', Action\Appointment\MyConsentsAction::class);
            $group->post('/appointments/{id}/consents', Action\Appointment\SetConsentAction::class);
            $group->get('/appointments/{id}/recordings', Action\Appointment\MyRecordingsAction::class);
            $group->post('/appointments/{id}/metrics', Action\Appointment\ReportMyMetricAction::class);
            $group->get('/appointments/{id}/transcript', Action\Appointment\GetMyTranscriptAction::class);
            $group->post('/appointments/{id}/transcript', Action\Appointment\AppendMyTranscriptAction::class);
            $group->get('/notifications', Action\Notification\ListNotificationsAction::class);
            $group->post('/notifications/read-all', Action\Notification\MarkAllNotificationsReadAction::class);
            $group->post('/notifications/{id}/read', Action\Notification\MarkNotificationReadAction::class);
        })->add(new CustomerAuthMiddleware($jwt, $sessions));
    });
};
