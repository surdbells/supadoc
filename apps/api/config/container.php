<?php

declare(strict_types=1);

use App\Domain\Repository\AppointmentReminderRepository;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\AppSettingRepository;
use App\Domain\Repository\AuditEventRepository;
use App\Domain\Repository\AvailabilitySlotRepository;
use App\Domain\Repository\CarePlanRepository;
use App\Domain\Repository\ClinicalNoteRepository;
use App\Domain\Repository\ConsultationConsentRepository;
use App\Domain\Repository\CopilotDraftRepository;
use App\Domain\Repository\LabOrderRepository;
use App\Domain\Repository\MedicalCertificateRepository;
use App\Domain\Repository\MedicalDocumentRepository;
use App\Domain\Repository\MessageRepository;
use App\Domain\Repository\PayoutAccountRepository;
use App\Domain\Repository\PayoutRepository;
use App\Domain\Repository\PrescriptionRepository;
use App\Domain\Repository\RecordingRepository;
use App\Domain\Repository\ReviewRepository;
use App\Domain\Repository\StaffNotificationRepository;
use App\Domain\Repository\SupportMessageRepository;
use App\Domain\Repository\SupportTicketRepository;
use App\Domain\Repository\ReferralRepository;
use App\Domain\Repository\SessionMetricRepository;
use App\Domain\Repository\TranscriptSegmentRepository;
use App\Domain\Repository\WalletRepository;
use App\Domain\Repository\WalletTransactionRepository;
use App\Domain\Repository\NotificationRepository;
use App\Domain\Repository\PatientRepository;
use App\Domain\Repository\SessionRepository;
use App\Domain\Repository\StaffSessionRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Agora\AgoraKickingService;
use App\Infrastructure\Agora\AgoraRecordingService;
use App\Infrastructure\Agora\AgoraTokenService;
use App\Infrastructure\Document\ClinicalDocumentRenderer;
use App\Infrastructure\Email\EmailOtpService;
use App\Infrastructure\Email\MailService;
use App\Infrastructure\Email\WalletMailer;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use App\Infrastructure\Service\AppointmentCheckout;
use App\Infrastructure\Service\AppointmentInvites;
use App\Infrastructure\Service\AppointmentPaymentService;
use App\Infrastructure\Service\FollowUpService;
use App\Infrastructure\Service\AuditLogger;
use App\Infrastructure\Service\AuthService;
use App\Infrastructure\Service\CopilotService;
use App\Infrastructure\Service\AvailabilityService;
use App\Infrastructure\Service\EarningsService;
use App\Infrastructure\Service\PatientNotifier;
use App\Infrastructure\Service\ReminderService;
use App\Infrastructure\Service\StaffNotifier;
use App\Infrastructure\Service\FirebaseIdTokenVerifier;
use App\Infrastructure\Service\JwtService;
use App\Infrastructure\Service\MedicalDocumentStorage;
use App\Infrastructure\Service\PricingService;
use App\Infrastructure\Service\RecordingStorage;
use App\Infrastructure\Service\CallPresence;
use App\Infrastructure\Service\GuestConsent;
use App\Infrastructure\Service\GuestInvitations;
use App\Infrastructure\Service\SessionService;
use App\Infrastructure\Service\SettingsCacheService;
use App\Infrastructure\Service\PaystackService;
use App\Infrastructure\Service\TermiiService;
use App\Infrastructure\Service\TotpService;
use App\Infrastructure\Service\WalletService;
use App\Domain\Repository\DrugRepository;
use App\Infrastructure\Drug\DrugCatalogueImporter;
use App\Domain\Repository\PrescriptionCheckThrottleRepository;
use App\Infrastructure\Prescription\PrescriptionCheckService;
use App\Infrastructure\Prescription\PrescriptionExpiryService;
use App\Infrastructure\Prescription\PrescriptionNumberGenerator;
use App\Infrastructure\Prescription\PrescriptionPdfRenderer;
use App\Infrastructure\Prescription\PrescriptionService;
use App\Infrastructure\Prescription\PrescriptionSettings;
use App\Infrastructure\Prescription\SignatureStore;
use App\Infrastructure\Storage\FileVault;
use App\Domain\Repository\VitalReadingRepository;
use App\Infrastructure\Vitals\VitalsService;
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

// The clinic calendar for date-only prescription rules (today / valid-until /
// expiry / the date in the number). The process timezone is left untouched.
\App\Domain\Settings\ClinicTime::configure(trim((string) ($_ENV['APP_TIMEZONE'] ?? '')));

// Patient / doctor sites this API serves (several deployments share one API):
// links in emails, notifications and printed prescriptions follow each user.
\App\Domain\Settings\WebUrls::configureFromEnv($_ENV);

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
        'scheme'   => 'tcp',
        'host'     => $_ENV['REDIS_HOST'] ?? '127.0.0.1',
        'port'     => (int) ($_ENV['REDIS_PORT'] ?? 6379),
        // Only sent when set — leave REDIS_PASSWORD empty for an unauthenticated Redis.
        'password' => ($_ENV['REDIS_PASSWORD'] ?? '') !== '' ? $_ENV['REDIS_PASSWORD'] : null,
    ], [
        'prefix' => $_ENV['REDIS_PREFIX'] ?? 'app:',
    ]),

    // ----- Services -----
    JwtService::class => static fn (): JwtService => new JwtService(
        secret:     $_ENV['JWT_SECRET'] ?? 'change-me',
        accessTtl:  (int) ($_ENV['JWT_ACCESS_TTL'] ?? 900),
        refreshTtl: (int) ($_ENV['JWT_REFRESH_TTL'] ?? 43200),
    ),

    SettingsCacheService::class => static fn (ContainerInterface $c): SettingsCacheService =>
        new SettingsCacheService($c->get(RedisClient::class)),

    AvailabilityService::class => static fn (ContainerInterface $c): AvailabilityService =>
        new AvailabilityService(
            $c->get(AppointmentRepository::class),
            $c->get(AvailabilitySlotRepository::class),
            $c->get(\App\Domain\Settings\BookingSettings::class),
        ),

    // Booking-calendar rules (app_settings), and the directory + alternative-doctor
    // suggestions built on availability.
    \App\Domain\Settings\BookingSettings::class => static fn (ContainerInterface $c): \App\Domain\Settings\BookingSettings =>
        new \App\Domain\Settings\BookingSettings($c->get(AppSettingRepository::class)),

    \App\Infrastructure\Availability\DirectorySearch::class => static fn (ContainerInterface $c): \App\Infrastructure\Availability\DirectorySearch =>
        new \App\Infrastructure\Availability\DirectorySearch(
            $c->get(SpecialistRepository::class),
            $c->get(AvailabilityService::class),
        ),

    \App\Infrastructure\Availability\SpecialistSuggestions::class => static fn (ContainerInterface $c): \App\Infrastructure\Availability\SpecialistSuggestions =>
        new \App\Infrastructure\Availability\SpecialistSuggestions(
            $c->get(SpecialistRepository::class),
            $c->get(AvailabilityService::class),
        ),

    FirebaseIdTokenVerifier::class => static fn (): FirebaseIdTokenVerifier =>
        new FirebaseIdTokenVerifier($_ENV['FIREBASE_PROJECT_ID'] ?? ''),

    WalletService::class => static fn (ContainerInterface $c): WalletService => new WalletService(
        $c->get(EntityManagerInterface::class),
        $c->get(WalletRepository::class),
        $c->get(WalletTransactionRepository::class),
        $c->get(WalletMailer::class),
        $c->get(NotificationRepository::class),
        $c->get(PatientRepository::class),
        // Supported wallet currencies; the first is the default (NGN).
        array_values(array_filter(array_map(
            static fn (string $x): string => strtoupper(trim($x)),
            explode(',', (string) ($_ENV['WALLET_CURRENCIES'] ?? 'NGN')),
        ))) ?: ['NGN'],
    ),

    WalletMailer::class => static fn (ContainerInterface $c): WalletMailer => new WalletMailer(
        $c->get(PatientRepository::class),
        $c->get(MailService::class),
    ),

    AppointmentPaymentService::class => static fn (ContainerInterface $c): AppointmentPaymentService =>
        new AppointmentPaymentService($c->get(WalletService::class)),

    // Card checkout (pay-init + verify) shared by booking and accepting a follow-up.
    AppointmentCheckout::class => static fn (ContainerInterface $c): AppointmentCheckout => new AppointmentCheckout(
        $c->get(PaystackService::class),
        $c->get(PricingService::class),
        $c->get(AppointmentRepository::class),
        $c->get(PatientNotifier::class),
        $c->get(AppointmentPaymentService::class),
    ),

    // The join-link invite emails sent once a consultation is booked / a follow-up accepted.
    AppointmentInvites::class => static fn (ContainerInterface $c): AppointmentInvites => new AppointmentInvites(
        $c->get(MailService::class),
        $c->get(JwtService::class),
        $c->get(PricingService::class),
        $c->get(GuestInvitations::class),
    ),

    // The patient's guests: invite / remove / re-send after booking, their links and emails.
    GuestInvitations::class => static fn (ContainerInterface $c): GuestInvitations => new GuestInvitations(
        $c->get(AppointmentRepository::class),
        $c->get(AppointmentPaymentService::class),
        $c->get(AppointmentCheckout::class),
        $c->get(PricingService::class),
        $c->get(MailService::class),
        $c->get(JwtService::class),
        $c->get(AuditLogger::class),
        $c->get(PatientNotifier::class),
        $c->get(StaffNotifier::class),
        $c->get(CallPresence::class),
        $c->get(AgoraKickingService::class),
    ),

    // A guest's acceptance of the recording + privacy notice, and recording's wait for it.
    GuestConsent::class => static fn (ContainerInterface $c): GuestConsent => new GuestConsent(
        $c->get(ConsultationConsentRepository::class),
        $c->get(RecordingRepository::class),
        $c->get(AgoraRecordingService::class),
        $c->get(CallPresence::class),
    ),

    // Follow-up proposals: propose / accept / decline / withdraw, plus the cron's expiry + nudge.
    FollowUpService::class => static fn (ContainerInterface $c): FollowUpService => new FollowUpService(
        $c->get(AppointmentRepository::class),
        $c->get(AvailabilityService::class),
        $c->get(PricingService::class),
        $c->get(AppointmentPaymentService::class),
        $c->get(AppointmentCheckout::class),
        $c->get(AppointmentInvites::class),
        $c->get(PatientNotifier::class),
        $c->get(StaffNotifier::class),
        $c->get(MailService::class),
        $c->get(AuditLogger::class),
    ),

    ReminderService::class => static fn (ContainerInterface $c): ReminderService => new ReminderService(
        $c->get(AppointmentRepository::class),
        $c->get(AppointmentReminderRepository::class),
        $c->get(NotificationRepository::class),
        $c->get(MailService::class),
        $c->get(JwtService::class),
        $c->get(StaffNotifier::class),
        // Minutes-before offsets for join reminders (largest first); default 24h + 1h.
        array_values(array_filter(array_map(
            static fn (string $x): int => (int) trim($x),
            explode(',', (string) ($_ENV['REMINDER_OFFSETS'] ?? '1440,60')),
        ), static fn (int $m): bool => $m > 0)) ?: [1440, 60],
    ),

    PaystackService::class => static fn (): PaystackService => new PaystackService(
        // Wallet funding fulfillment. Blank secret key => funding endpoints 503.
        secretKey: trim($_ENV['PAYSTACK_SECRET_KEY'] ?? ''),
        publicKey: trim($_ENV['PAYSTACK_PUBLIC_KEY'] ?? ''),
        baseUrl:   trim($_ENV['PAYSTACK_BASE_URL'] ?? '') !== '' ? trim($_ENV['PAYSTACK_BASE_URL']) : 'https://api.paystack.co',
    ),

    CopilotService::class => static fn (): CopilotService => new CopilotService(
        // Anthropic Messages API. Blank key => isConfigured() false => copilot 503
        // (transcription still works — it needs no server credentials).
        apiKey:  trim($_ENV['COPILOT_API_KEY'] ?? ''),
        model:   trim($_ENV['COPILOT_MODEL'] ?? '') ?: 'claude-sonnet-4-5',
        baseUrl: trim($_ENV['COPILOT_BASE_URL'] ?? '') ?: 'https://api.anthropic.com',
    ),

    TermiiService::class => static fn (): TermiiService => new TermiiService(
        apiKey:   $_ENV['TERMII_API_KEY'] ?? '',
        senderId: $_ENV['TERMII_SENDER_ID'] ?? '',
        baseUrl:  $_ENV['TERMII_BASE_URL'] ?? 'https://api.ng.termii.com',
    ),

    AgoraTokenService::class => static fn (ContainerInterface $c): AgoraTokenService => new AgoraTokenService(
        // trim(): a trailing newline/space pasted into .env silently corrupts the
        // HMAC signature → Agora rejects the token ("invalid token, authorized failed").
        appId:          trim($_ENV['AGORA_APP_ID'] ?? ''),
        appCertificate: trim($_ENV['AGORA_APP_CERTIFICATE'] ?? ''),
        // TEMPORARY stopgap while Agora resolves the certificate desync: a fixed
        // Console token + its channel. Both blank in normal operation, and
        // ignored (with a logged error) in production — one shared channel for
        // every consultation is a privacy breach.
        staticToken:    trim($_ENV['AGORA_STATIC_TOKEN'] ?? ''),
        staticChannel:  trim($_ENV['AGORA_STATIC_CHANNEL'] ?? ''),
        production:     ($_ENV['APP_ENV'] ?? 'production') === 'production',
        logger:         $c->get(LoggerInterface::class),
    ),

    // Cloud recording — RESTful API (Customer ID/Secret) + cloud storage config.
    // Blank customer key/secret or bucket => isConfigured() false => endpoints 503.
    AgoraRecordingService::class => static fn (): AgoraRecordingService => new AgoraRecordingService(
        appId:          trim($_ENV['AGORA_APP_ID'] ?? ''),
        customerId:     trim($_ENV['AGORA_CUSTOMER_ID'] ?? ''),
        customerSecret: trim($_ENV['AGORA_CUSTOMER_SECRET'] ?? ''),
        storage:        [
            'vendor'    => (int) ($_ENV['AGORA_RECORDING_VENDOR'] ?? 0),
            'region'    => (int) ($_ENV['AGORA_RECORDING_REGION'] ?? 0),
            'bucket'    => trim($_ENV['AGORA_RECORDING_BUCKET'] ?? ''),
            'accessKey' => trim($_ENV['AGORA_RECORDING_ACCESS_KEY'] ?? ''),
            'secretKey' => trim($_ENV['AGORA_RECORDING_SECRET_KEY'] ?? ''),
        ],
    ),

    // Puts a removed guest (or the guests of a cancelled consultation) out of the
    // channel at once — Agora's kicking rule, same Customer ID/Secret as recording.
    // Blank => does nothing (logged once); their short-lived token then just expires.
    AgoraKickingService::class => static fn (ContainerInterface $c): AgoraKickingService => new AgoraKickingService(
        appId:          trim($_ENV['AGORA_APP_ID'] ?? ''),
        customerId:     trim($_ENV['AGORA_CUSTOMER_ID'] ?? ''),
        customerSecret: trim($_ENV['AGORA_CUSTOMER_SECRET'] ?? ''),
        logger:         $c->get(LoggerInterface::class),
    ),

    // Resolves recording file keys to playback/download URLs (public/CDN base,
    // or an S3 SigV4 presigned URL). Not configured => url() returns null.
    RecordingStorage::class => static fn (): RecordingStorage => new RecordingStorage(
        publicBase: trim($_ENV['AGORA_RECORDING_PUBLIC_BASE'] ?? ''),
        bucket:     trim($_ENV['AGORA_RECORDING_BUCKET'] ?? ''),
        region:     trim($_ENV['AGORA_RECORDING_S3_REGION'] ?? ''),
        accessKey:  trim($_ENV['AGORA_RECORDING_ACCESS_KEY'] ?? ''),
        secretKey:  trim($_ENV['AGORA_RECORDING_SECRET_KEY'] ?? ''),
        endpoint:   trim($_ENV['AGORA_RECORDING_S3_ENDPOINT'] ?? ''),
    ),

    EmailOtpService::class => static fn (ContainerInterface $c): EmailOtpService => new EmailOtpService(
        $c->get(RedisClient::class),
        $c->get(MailService::class),
        ($_ENV['APP_ENV'] ?? 'production') !== 'production',
    ),

    // Patient medical-document files (stored outside the web root).
    MedicalDocumentStorage::class => static fn (): MedicalDocumentStorage => new MedicalDocumentStorage(),

    // Printable clinical documents (prescription / referral / certificate).
    ClinicalDocumentRenderer::class => static fn (): ClinicalDocumentRenderer => new ClinicalDocumentRenderer(
        clinicName:    trim($_ENV['CLINIC_NAME'] ?? '') !== '' ? trim($_ENV['CLINIC_NAME']) : 'VideoMed',
        clinicTagline: trim($_ENV['CLINIC_TAGLINE'] ?? '') !== '' ? trim($_ENV['CLINIC_TAGLINE']) : 'Telehealth Consultations',
        clinicContact: trim($_ENV['CLINIC_CONTACT'] ?? ''),
    ),

    MailService::class => static fn (ContainerInterface $c): MailService => new MailService(
        token:       $_ENV['ZEPTOMAIL_TOKEN'] ?? '',
        fromAddress: $_ENV['ZEPTOMAIL_FROM_ADDRESS'] ?? '',
        fromName:    $_ENV['ZEPTOMAIL_FROM_NAME'] ?? 'VideoMed',
        baseUrl:     $_ENV['ZEPTOMAIL_BASE_URL'] ?? 'https://api.zeptomail.com',
        logger:      $c->get(LoggerInterface::class),
    ),

    AuthService::class => static fn (ContainerInterface $c): AuthService => new AuthService(
        $c->get(UserRepository::class),
        $c->get(PatientRepository::class),
        $c->get(JwtService::class),
        $c->get(SessionService::class),
        $c->get(TotpService::class),
        $c->get(NotificationRepository::class),
        $c->get(MailService::class),
        $c->get(SpecialistRepository::class),
    ),

    TotpService::class => static fn (): TotpService => new TotpService(),

    // Sessions die after SESSION_IDLE_TIMEOUT seconds without an authenticated
    // request, and JWT_REFRESH_TTL after sign-in regardless (absolute lifetime).
    // Keep the idle window at least the portals' client idle timeout + 5 min.
    SessionService::class => static fn (ContainerInterface $c): SessionService => new SessionService(
        $c->get(SessionRepository::class),
        $c->get(StaffSessionRepository::class),
        idleTimeout:     (int) ($_ENV['SESSION_IDLE_TIMEOUT'] ?? 3600),
        absoluteTimeout: (int) ($_ENV['JWT_REFRESH_TTL'] ?? 43200),
    ),

    PricingService::class => static fn (ContainerInterface $c): PricingService =>
        new PricingService($c->get(AppSettingRepository::class)),

    // Doctor earnings: platform keeps DOCTOR_COMMISSION_PERCENT of gross (default 0).
    EarningsService::class => static fn (ContainerInterface $c): EarningsService => new EarningsService(
        $c->get(AppointmentRepository::class),
        $c->get(PayoutRepository::class),
        (float) ($_ENV['DOCTOR_COMMISSION_PERCENT'] ?? 0),
    ),

    // Past consultations nobody closed (the reminders cron): completed on proof,
    // never-confirmed requests expired + refunded, no-shows marked missed.
    \App\Infrastructure\Service\PastAppointmentCloser::class => static fn (ContainerInterface $c): \App\Infrastructure\Service\PastAppointmentCloser =>
        new \App\Infrastructure\Service\PastAppointmentCloser(
            $c->get(EntityManagerInterface::class),
            $c->get(AppointmentRepository::class),
            $c->get(\App\Infrastructure\Service\ConsultationCompleter::class),
            $c->get(AppointmentPaymentService::class),
            $c->get(\App\Domain\Settings\BookingSettings::class),
            $c->get(AuditLogger::class),
            $c->get(PatientNotifier::class),
            $c->get(StaffNotifier::class),
            $c->get(MailService::class),
            $c->get(PricingService::class),
            $c->get(CallPresence::class),
        ),

    // The back office closing / correcting a consultation (cancel, held, no-show, refund), audited.
    \App\Infrastructure\Service\AppointmentResolver::class => static fn (ContainerInterface $c): \App\Infrastructure\Service\AppointmentResolver =>
        new \App\Infrastructure\Service\AppointmentResolver(
            $c->get(AppointmentRepository::class),
            $c->get(AppointmentPaymentService::class),
            $c->get(\App\Infrastructure\Service\ConsultationCompleter::class),
            $c->get(\App\Infrastructure\Service\PastAppointmentCloser::class),
            $c->get(GuestInvitations::class),
            $c->get(AuditLogger::class),
            $c->get(PatientNotifier::class),
            $c->get(StaffNotifier::class),
            $c->get(MailService::class),
            $c->get(PricingService::class),
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

    AvailabilitySlotRepository::class => static fn (ContainerInterface $c): AvailabilitySlotRepository =>
        new AvailabilitySlotRepository($c->get(EntityManagerInterface::class)),

    AppointmentReminderRepository::class => static fn (ContainerInterface $c): AppointmentReminderRepository =>
        new AppointmentReminderRepository($c->get(EntityManagerInterface::class)),

    PayoutAccountRepository::class => static fn (ContainerInterface $c): PayoutAccountRepository =>
        new PayoutAccountRepository($c->get(EntityManagerInterface::class)),

    PayoutRepository::class => static fn (ContainerInterface $c): PayoutRepository =>
        new PayoutRepository($c->get(EntityManagerInterface::class)),

    ReviewRepository::class => static fn (ContainerInterface $c): ReviewRepository =>
        new ReviewRepository($c->get(EntityManagerInterface::class)),

    StaffNotificationRepository::class => static fn (ContainerInterface $c): StaffNotificationRepository =>
        new StaffNotificationRepository($c->get(EntityManagerInterface::class)),

    MessageRepository::class => static fn (ContainerInterface $c): MessageRepository =>
        new MessageRepository($c->get(EntityManagerInterface::class)),

    MedicalCertificateRepository::class => static fn (ContainerInterface $c): MedicalCertificateRepository =>
        new MedicalCertificateRepository($c->get(EntityManagerInterface::class)),

    MedicalDocumentRepository::class => static fn (ContainerInterface $c): MedicalDocumentRepository =>
        new MedicalDocumentRepository($c->get(EntityManagerInterface::class)),

    SupportTicketRepository::class => static fn (ContainerInterface $c): SupportTicketRepository =>
        new SupportTicketRepository($c->get(EntityManagerInterface::class)),

    SupportMessageRepository::class => static fn (ContainerInterface $c): SupportMessageRepository =>
        new SupportMessageRepository($c->get(EntityManagerInterface::class)),

    StaffNotifier::class => static fn (ContainerInterface $c): StaffNotifier => new StaffNotifier(
        $c->get(StaffNotificationRepository::class),
        $c->get(UserRepository::class),
    ),

    // Doctor onboarding: one-time set-password links (invite / forgot password)
    // and the checklist → review → approval flow. Outside production, so the flow
    // is testable without mail, an invite link is returned to the signed-in admin
    // who sent it, and a reset link is written to the app log — never returned by
    // the public forgot-password endpoint.
    \App\Infrastructure\Service\StaffPasswordService::class => static fn (ContainerInterface $c): \App\Infrastructure\Service\StaffPasswordService =>
        new \App\Infrastructure\Service\StaffPasswordService(
            $c->get(UserRepository::class),
            $c->get(AuthService::class),
            $c->get(MailService::class),
            $c->get(RedisClient::class),
            ($_ENV['APP_ENV'] ?? 'production') !== 'production',
            $c->get(LoggerInterface::class),
        ),

    \App\Infrastructure\Service\DoctorOnboardingService::class => static fn (ContainerInterface $c): \App\Infrastructure\Service\DoctorOnboardingService =>
        new \App\Infrastructure\Service\DoctorOnboardingService(
            $c->get(SpecialistRepository::class),
            $c->get(UserRepository::class),
            $c->get(AvailabilitySlotRepository::class),
            $c->get(PayoutAccountRepository::class),
            $c->get(\App\Infrastructure\Service\StaffPasswordService::class),
            $c->get(MailService::class),
            $c->get(StaffNotifier::class),
            $c->get(\App\Domain\Repository\SpecialistCredentialRepository::class),
            $c->get(\App\Domain\Repository\SpecialistStatusEventRepository::class),
            $c->get(AuditLogger::class),
            // Link in the "doctor ready for review" email to the reviewers.
            \App\Infrastructure\Service\DoctorOnboardingService::backofficeUrlFromEnv($_ENV),
        ),

    // ----- Doctor management: documents, standing, suspension, licence cron -----
    \App\Domain\Repository\SpecialistCredentialRepository::class => static fn (ContainerInterface $c): \App\Domain\Repository\SpecialistCredentialRepository =>
        new \App\Domain\Repository\SpecialistCredentialRepository($c->get(EntityManagerInterface::class)),

    \App\Domain\Repository\SpecialistStatusEventRepository::class => static fn (ContainerInterface $c): \App\Domain\Repository\SpecialistStatusEventRepository =>
        new \App\Domain\Repository\SpecialistStatusEventRepository($c->get(EntityManagerInterface::class)),

    // Licensing documents sealed in the vault (resolved lazily, like signatures).
    \App\Infrastructure\Storage\CredentialStore::class => static fn (ContainerInterface $c): \App\Infrastructure\Storage\CredentialStore =>
        new \App\Infrastructure\Storage\CredentialStore(
            static fn (): FileVault => $c->get(FileVault::class),
            $c->get(LoggerInterface::class),
        ),

    \App\Infrastructure\Service\DoctorCredentialService::class => static fn (ContainerInterface $c): \App\Infrastructure\Service\DoctorCredentialService =>
        new \App\Infrastructure\Service\DoctorCredentialService(
            $c->get(\App\Domain\Repository\SpecialistCredentialRepository::class),
            $c->get(SpecialistRepository::class),
            $c->get(\App\Infrastructure\Storage\CredentialStore::class),
            $c->get(AuditLogger::class),
            $c->get(StaffNotifier::class),
            $c->get(MailService::class),
            $c->get(UserRepository::class),
            $c->get(\App\Infrastructure\Service\DoctorOnboardingService::class),
        ),

    \App\Infrastructure\Service\SpecialistSuspensionService::class => static fn (ContainerInterface $c): \App\Infrastructure\Service\SpecialistSuspensionService =>
        new \App\Infrastructure\Service\SpecialistSuspensionService(
            $c->get(SpecialistRepository::class),
            $c->get(AppointmentRepository::class),
            $c->get(AppointmentPaymentService::class),
            $c->get(FollowUpService::class),
            $c->get(GuestInvitations::class),
            $c->get(PatientNotifier::class),
            $c->get(StaffNotifier::class),
            $c->get(MailService::class),
            $c->get(PricingService::class),
            $c->get(AuditLogger::class),
            $c->get(\App\Domain\Repository\SpecialistStatusEventRepository::class),
            $c->get(\App\Domain\Repository\SpecialistCredentialRepository::class),
            $c->get(SessionService::class),
            $c->get(UserRepository::class),
            $c->get(\App\Infrastructure\Service\ConsultationCompleter::class),
        ),

    // Licence reminders (LICENCE_REMINDER_DAYS, default 30,14,7,1 days before) and
    // automatic suspension LICENCE_GRACE_DAYS (default 0) after a licence expires.
    \App\Infrastructure\Service\CredentialExpiryService::class => static fn (ContainerInterface $c): \App\Infrastructure\Service\CredentialExpiryService =>
        new \App\Infrastructure\Service\CredentialExpiryService(
            $c->get(SpecialistRepository::class),
            $c->get(\App\Domain\Repository\SpecialistCredentialRepository::class),
            $c->get(\App\Infrastructure\Service\SpecialistSuspensionService::class),
            $c->get(\App\Infrastructure\Service\DoctorOnboardingService::class),
            $c->get(StaffNotifier::class),
            $c->get(MailService::class),
            $c->get(UserRepository::class),
            \App\Infrastructure\Service\CredentialExpiryService::cleanStages(explode(',', (string) ($_ENV['LICENCE_REMINDER_DAYS'] ?? '30,14,7,1'))),
            max(0, (int) ($_ENV['LICENCE_GRACE_DAYS'] ?? 0)),
        ),

    // Keeps doctors who may not practise out of clinical routes (see DoctorStanding).
    \App\Infrastructure\Middleware\DoctorStandingMiddleware::class => static fn (ContainerInterface $c): \App\Infrastructure\Middleware\DoctorStandingMiddleware =>
        new \App\Infrastructure\Middleware\DoctorStandingMiddleware(
            $c->get(UserRepository::class),
            $c->get(SpecialistRepository::class),
            $c->get(AppointmentRepository::class),
            $c->get(PrescriptionRepository::class),
        ),

    PatientNotifier::class => static fn (ContainerInterface $c): PatientNotifier =>
        new PatientNotifier($c->get(NotificationRepository::class)),

    ClinicalNoteRepository::class => static fn (ContainerInterface $c): ClinicalNoteRepository =>
        new ClinicalNoteRepository($c->get(EntityManagerInterface::class)),

    PrescriptionRepository::class => static fn (ContainerInterface $c): PrescriptionRepository =>
        new PrescriptionRepository($c->get(EntityManagerInterface::class)),

    LabOrderRepository::class => static fn (ContainerInterface $c): LabOrderRepository =>
        new LabOrderRepository($c->get(EntityManagerInterface::class)),

    CarePlanRepository::class => static fn (ContainerInterface $c): CarePlanRepository =>
        new CarePlanRepository($c->get(EntityManagerInterface::class)),

    ReferralRepository::class => static fn (ContainerInterface $c): ReferralRepository =>
        new ReferralRepository($c->get(EntityManagerInterface::class)),

    ConsultationConsentRepository::class => static fn (ContainerInterface $c): ConsultationConsentRepository =>
        new ConsultationConsentRepository($c->get(EntityManagerInterface::class)),

    RecordingRepository::class => static fn (ContainerInterface $c): RecordingRepository =>
        new RecordingRepository($c->get(EntityManagerInterface::class)),

    SessionMetricRepository::class => static fn (ContainerInterface $c): SessionMetricRepository =>
        new SessionMetricRepository($c->get(EntityManagerInterface::class)),

    // Patient health readings: append-only history + the latest-per-type cache.
    VitalReadingRepository::class => static fn (ContainerInterface $c): VitalReadingRepository =>
        new VitalReadingRepository($c->get(EntityManagerInterface::class)),

    VitalsService::class => static fn (ContainerInterface $c): VitalsService => new VitalsService(
        $c->get(VitalReadingRepository::class),
        $c->get(PatientRepository::class),
    ),

    WalletRepository::class => static fn (ContainerInterface $c): WalletRepository =>
        new WalletRepository($c->get(EntityManagerInterface::class)),

    WalletTransactionRepository::class => static fn (ContainerInterface $c): WalletTransactionRepository =>
        new WalletTransactionRepository($c->get(EntityManagerInterface::class)),

    TranscriptSegmentRepository::class => static fn (ContainerInterface $c): TranscriptSegmentRepository =>
        new TranscriptSegmentRepository($c->get(EntityManagerInterface::class)),

    CopilotDraftRepository::class => static fn (ContainerInterface $c): CopilotDraftRepository =>
        new CopilotDraftRepository($c->get(EntityManagerInterface::class)),

    AuditEventRepository::class => static fn (ContainerInterface $c): AuditEventRepository =>
        new AuditEventRepository($c->get(EntityManagerInterface::class)),

    AuditLogger::class => static fn (ContainerInterface $c): AuditLogger =>
        new AuditLogger($c->get(AuditEventRepository::class)),

    NotificationRepository::class => static fn (ContainerInterface $c): NotificationRepository =>
        new NotificationRepository($c->get(EntityManagerInterface::class)),

    SessionRepository::class => static fn (ContainerInterface $c): SessionRepository =>
        new SessionRepository($c->get(EntityManagerInterface::class)),

    StaffSessionRepository::class => static fn (ContainerInterface $c): StaffSessionRepository =>
        new StaffSessionRepository($c->get(EntityManagerInterface::class)),

    AppSettingRepository::class => static fn (ContainerInterface $c): AppSettingRepository =>
        new AppSettingRepository($c->get(EntityManagerInterface::class)),

    // ----- E-prescribing -----
    // Encrypted-at-rest files (signatures) live outside the web root in var/vault.
    FileVault::class => static fn (): FileVault => new FileVault(
        dirname(__DIR__) . '/var/vault',
        FileVault::keyFrom(
            (string) ($_ENV['FILE_ENCRYPTION_KEY'] ?? ''),
            (string) ($_ENV['JWT_SECRET'] ?? 'change-me'),
            ($_ENV['APP_ENV'] ?? 'development') === 'production',
        ),
    ),

    // The vault is resolved lazily so a missing FILE_ENCRYPTION_KEY only blocks
    // signature operations (clearly logged), not the whole module.
    SignatureStore::class => static fn (ContainerInterface $c): SignatureStore => new SignatureStore(
        static fn (): FileVault => $c->get(FileVault::class),
        $c->get(LoggerInterface::class),
    ),

    PrescriptionNumberGenerator::class => static fn (ContainerInterface $c): PrescriptionNumberGenerator =>
        new PrescriptionNumberGenerator($c->get(EntityManagerInterface::class)->getConnection()),

    PrescriptionSettings::class => static fn (ContainerInterface $c): PrescriptionSettings =>
        new PrescriptionSettings($c->get(AppSettingRepository::class)),

    PrescriptionPdfRenderer::class => static fn (): PrescriptionPdfRenderer => new PrescriptionPdfRenderer(
        clinicName:    trim($_ENV['CLINIC_NAME'] ?? '') !== '' ? trim($_ENV['CLINIC_NAME']) : 'VideoMed',
        clinicTagline: trim($_ENV['CLINIC_TAGLINE'] ?? '') !== '' ? trim($_ENV['CLINIC_TAGLINE']) : 'Telehealth Consultations',
        clinicContact: trim($_ENV['CLINIC_CONTACT'] ?? ''),
        timezone:      trim($_ENV['APP_TIMEZONE'] ?? '') !== '' ? trim($_ENV['APP_TIMEZONE']) : 'Africa/Lagos',
    ),

    PrescriptionService::class => static fn (ContainerInterface $c): PrescriptionService => new PrescriptionService(
        $c->get(PrescriptionRepository::class),
        $c->get(DrugRepository::class),
        $c->get(PatientRepository::class),
        $c->get(SpecialistRepository::class),
        $c->get(AppointmentRepository::class),
        $c->get(PrescriptionNumberGenerator::class),
        $c->get(PrescriptionSettings::class),
        $c->get(SignatureStore::class),
        $c->get(PrescriptionPdfRenderer::class),
        $c->get(JwtService::class),
        $c->get(PatientNotifier::class),
        $c->get(MailService::class),
        $c->get(AuditLogger::class),
        $c->get(VitalsService::class),
        $c->get(DrugCatalogueImporter::class),
    ),

    // Loads resources/rxnorm into `drugs` (bin/import-rxnorm.php, or lazily on
    // the first medicine search if that deploy step was skipped).
    DrugCatalogueImporter::class => static fn (ContainerInterface $c): DrugCatalogueImporter => new DrugCatalogueImporter(
        $c->get(EntityManagerInterface::class)->getConnection(),
        dirname(__DIR__) . '/resources/rxnorm/rxnorm-prescribable.tsv.gz',
        $c->get(LoggerInterface::class),
    ),

    PrescriptionCheckService::class => static fn (ContainerInterface $c): PrescriptionCheckService => new PrescriptionCheckService(
        $c->get(PrescriptionRepository::class),
        $c->get(PatientRepository::class),
        $c->get(PrescriptionCheckThrottleRepository::class),
        $c->get(PrescriptionSettings::class),
        $c->get(AuditLogger::class),
    ),

    PrescriptionExpiryService::class => static fn (ContainerInterface $c): PrescriptionExpiryService => new PrescriptionExpiryService(
        $c->get(PrescriptionRepository::class),
        $c->get(PatientRepository::class),
        $c->get(PrescriptionSettings::class),
        $c->get(PatientNotifier::class),
        $c->get(MailService::class),
    ),

    DrugRepository::class => static fn (ContainerInterface $c): DrugRepository =>
        new DrugRepository($c->get(EntityManagerInterface::class)),

    PrescriptionCheckThrottleRepository::class => static fn (ContainerInterface $c): PrescriptionCheckThrottleRepository =>
        new PrescriptionCheckThrottleRepository($c->get(EntityManagerInterface::class)),
];
