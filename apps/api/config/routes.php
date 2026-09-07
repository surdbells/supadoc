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
        $group->post('/portal/auth/2fa', Action\Auth\VerifyTwoFactorLoginAction::class); // 2FA sign-in step
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

        // Paystack webhook (public) — signature-verified + re-verified server-side.
        $group->post('/webhooks/paystack', Action\Wallet\PaystackWebhookAction::class);

        // ----- Staff (default audience) -----
        $group->group('', function (RouteCollectorProxy $group): void {
            $group->get('/me', Action\Auth\MeAction::class);
            $group->post('/me/password', Action\Auth\ChangePasswordAction::class);
            $group->get('/me/notifications', Action\Auth\ListStaffNotificationsAction::class);
            $group->get('/me/notifications/unread', Action\Auth\UnreadStaffNotificationsAction::class);
            $group->post('/me/notifications/read-all', Action\Auth\MarkAllStaffNotificationsReadAction::class);
            $group->post('/me/notifications/{id}/read', Action\Auth\MarkStaffNotificationReadAction::class);

            $group->get('/appointments', Action\Appointment\ListAppointmentsAction::class)
                ->add(new RbacMiddleware('appointments.view'));

            $group->get('/appointments/{id}', Action\Appointment\GetAppointmentAction::class)
                ->add(new RbacMiddleware('appointments.view'));

            $group->post('/appointments', Action\Appointment\CreateAppointmentAction::class)
                // Array + default requireAll:false means ANY of these permissions.
                ->add(new RbacMiddleware(['appointments.create', 'appointments.book']));

            // Staff patient lookup for booking on a patient's behalf.
            $group->get('/patients', Action\Admin\SearchPatientsAction::class)
                ->add(new RbacMiddleware(['appointments.create', 'appointments.book']));

            // Staff & role management.
            // Payouts (back office).
            $group->get('/admin/payouts', Action\Admin\ListPayoutsAction::class)
                ->add(new RbacMiddleware('payouts.manage'));
            $group->post('/admin/payouts/{id}/approve', Action\Admin\ApprovePayoutAction::class)
                ->add(new RbacMiddleware('payouts.manage'));
            $group->post('/admin/payouts/{id}/mark-paid', Action\Admin\MarkPayoutPaidAction::class)
                ->add(new RbacMiddleware('payouts.manage'));
            $group->post('/admin/payouts/{id}/reject', Action\Admin\RejectPayoutAction::class)
                ->add(new RbacMiddleware('payouts.manage'));

            // Staff & role management.
            $group->get('/staff', Action\Admin\ListStaffAction::class)
                ->add(new RbacMiddleware('staff.manage'));
            $group->post('/staff', Action\Admin\CreateStaffAction::class)
                ->add(new RbacMiddleware('staff.manage'));
            $group->patch('/staff/{id}', Action\Admin\UpdateStaffAction::class)
                ->add(new RbacMiddleware('staff.manage'));
            $group->post('/staff/{id}/password', Action\Admin\ResetStaffPasswordAction::class)
                ->add(new RbacMiddleware('staff.manage'));

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
            $group->get('/doctor/dashboard', Action\Doctor\DoctorDashboardAction::class);
            $group->get('/doctor/appointments', Action\Doctor\DoctorAppointmentsAction::class);
            $group->get('/doctor/appointments/history', Action\Doctor\DoctorAppointmentHistoryAction::class);
            $group->post('/doctor/appointments/{id}/confirm', Action\Doctor\ConfirmDoctorAppointmentAction::class);
            $group->post('/doctor/appointments/{id}/decline', Action\Doctor\DeclineDoctorAppointmentAction::class);
            $group->post('/doctor/appointments/{id}/reschedule', Action\Doctor\RescheduleDoctorAppointmentAction::class);
            $group->get('/doctor/patients', Action\Doctor\DoctorPatientsAction::class);
            $group->get('/doctor/patients/{id}', Action\Doctor\DoctorPatientDetailAction::class);
            $group->get('/doctor/reviews', Action\Doctor\DoctorReviewsAction::class);
            $group->get('/doctor/reviews/summary', Action\Doctor\DoctorReviewsSummaryAction::class);
            $group->post('/doctor/reviews/{id}/respond', Action\Doctor\RespondToReviewAction::class);
            $group->get('/doctor/profile', Action\Doctor\GetDoctorProfileAction::class);
            $group->patch('/doctor/profile', Action\Doctor\UpdateDoctorProfileAction::class);
            // Earnings + payouts (doctor self-service).
            $group->get('/doctor/earnings', Action\Doctor\DoctorEarningsAction::class);
            $group->get('/doctor/earnings/transactions', Action\Doctor\DoctorEarningsTransactionsAction::class);
            $group->get('/doctor/payout-account', Action\Doctor\GetPayoutAccountAction::class);
            $group->put('/doctor/payout-account', Action\Doctor\SavePayoutAccountAction::class);
            $group->get('/doctor/payouts', Action\Doctor\ListDoctorPayoutsAction::class);
            $group->post('/doctor/payouts', Action\Doctor\RequestPayoutAction::class);

            // Secure async thread with the patient (per-appointment).
            $group->get('/doctor/appointments/{id}/messages', Action\Doctor\ListDoctorMessagesAction::class);
            $group->post('/doctor/appointments/{id}/messages', Action\Doctor\PostDoctorMessageAction::class);

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

            // Medical certificates + printable clinical documents.
            $group->get('/doctor/appointments/{id}/certificates', Action\Doctor\ListCertificatesAction::class);
            $group->post('/doctor/appointments/{id}/certificates', Action\Doctor\CreateCertificateAction::class);
            $group->get('/doctor/appointments/{id}/documents/{kind}/{docId}', Action\Doctor\RenderDoctorDocumentAction::class);
            $group->get('/doctor/appointments/{id}/consents', Action\Doctor\DoctorConsentsAction::class);

            // Cloud recording — consent-gated start/stop + status.
            $group->get('/doctor/appointments/{id}/recording', Action\Doctor\GetRecordingAction::class);
            $group->get('/doctor/appointments/{id}/recording/files', Action\Doctor\GetRecordingFilesAction::class);
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
            $group->get('/admin/recordings/{id}/files', Action\Admin\AdminRecordingFilesAction::class)
                ->add(new RbacMiddleware('monitoring.view'));
            $group->get('/admin/monitoring/audit', Action\Admin\MonitoringAuditAction::class)
                ->add(new RbacMiddleware('monitoring.view'));
            $group->get('/admin/monitoring/quality', Action\Admin\MonitoringQualityAction::class)
                ->add(new RbacMiddleware('monitoring.view'));

            // Booking + revenue analytics.
            $group->get('/admin/analytics', Action\Admin\AnalyticsAction::class)
                ->add(new RbacMiddleware('monitoring.view'));

            // Support desk (back office).
            $group->get('/admin/support/tickets', Action\Admin\ListSupportTicketsAction::class)
                ->add(new RbacMiddleware('support.manage'));
            $group->get('/admin/support/tickets/{id}', Action\Admin\GetSupportTicketAction::class)
                ->add(new RbacMiddleware('support.manage'));
            $group->post('/admin/support/tickets/{id}/messages', Action\Admin\ReplySupportTicketAction::class)
                ->add(new RbacMiddleware('support.manage'));
            $group->patch('/admin/support/tickets/{id}', Action\Admin\UpdateSupportTicketAction::class)
                ->add(new RbacMiddleware('support.manage'));
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
            $group->post('/me/email/request-otp', Action\Patient\RequestEmailChangeOtpAction::class);
            $group->post('/me/email', Action\Patient\ChangeMyEmailAction::class);
            $group->post('/me/2fa/setup', Action\Patient\SetupTwoFactorAction::class);
            $group->post('/me/2fa/enable', Action\Patient\EnableTwoFactorAction::class);
            $group->post('/me/2fa/disable', Action\Patient\DisableTwoFactorAction::class);
            $group->get('/specialists/specialties', Action\Specialist\ListSpecialtiesAction::class);
            $group->get('/specialists', Action\Specialist\ListSpecialistsAction::class);
            $group->get('/appointments', Action\Appointment\ListMyAppointmentsAction::class);
            $group->post('/appointments', Action\Appointment\CreateMyAppointmentAction::class);
            $group->post('/appointment-documents', Action\Appointment\UploadAppointmentDocumentAction::class);
            $group->get('/appointments/{id}', Action\Appointment\GetMyAppointmentAction::class);
            $group->post('/appointments/{id}/cancel', Action\Appointment\CancelMyAppointmentAction::class);
            $group->post('/appointments/{id}/review', Action\Patient\SubmitReviewAction::class);
            $group->get('/appointments/{id}/call-token', Action\Appointment\GetCallTokenAction::class);
            $group->get('/appointments/{id}/consultation', Action\Appointment\GetMyConsultationAction::class);
            $group->get('/appointments/{id}/messages', Action\Appointment\MyMessagesAction::class);
            $group->post('/appointments/{id}/messages', Action\Appointment\PostMyMessageAction::class);
            $group->get('/appointments/{id}/prescriptions', Action\Appointment\MyPrescriptionsAction::class);
            $group->get('/appointments/{id}/lab-orders', Action\Appointment\MyLabOrdersAction::class);
            $group->get('/appointments/{id}/care-plan', Action\Appointment\MyCarePlanAction::class);
            $group->get('/appointments/{id}/referrals', Action\Appointment\MyReferralsAction::class);
            $group->get('/appointments/{id}/certificates', Action\Appointment\MyCertificatesAction::class);
            $group->get('/appointments/{id}/documents/{kind}/{docId}', Action\Appointment\RenderMyDocumentAction::class);
            $group->get('/appointments/{id}/consents', Action\Appointment\MyConsentsAction::class);
            $group->post('/appointments/{id}/consents', Action\Appointment\SetConsentAction::class);
            $group->get('/appointments/{id}/recordings', Action\Appointment\MyRecordingsAction::class);
            $group->post('/appointments/{id}/metrics', Action\Appointment\ReportMyMetricAction::class);
            $group->get('/appointments/{id}/transcript', Action\Appointment\GetMyTranscriptAction::class);
            $group->post('/appointments/{id}/transcript', Action\Appointment\AppendMyTranscriptAction::class);
            // Wallet — balance, ledger, and Paystack-funded top-ups.
            $group->get('/wallet', Action\Wallet\GetWalletAction::class);
            $group->get('/wallet/transactions', Action\Wallet\ListWalletTransactionsAction::class);
            $group->post('/wallet/fund', Action\Wallet\FundWalletAction::class);
            $group->post('/wallet/verify', Action\Wallet\VerifyFundingAction::class);

            $group->get('/notifications', Action\Notification\ListNotificationsAction::class);
            $group->post('/notifications/read-all', Action\Notification\MarkAllNotificationsReadAction::class);
            $group->post('/notifications/{id}/read', Action\Notification\MarkNotificationReadAction::class);

            // Support tickets (patient side).
            $group->get('/support/tickets', Action\Support\ListMyTicketsAction::class);
            $group->post('/support/tickets', Action\Support\CreateTicketAction::class);
            $group->get('/support/tickets/{id}', Action\Support\GetMyTicketAction::class);
            $group->post('/support/tickets/{id}/messages', Action\Support\ReplyToMyTicketAction::class);
        })->add(new CustomerAuthMiddleware($jwt, $sessions));
    });
};
