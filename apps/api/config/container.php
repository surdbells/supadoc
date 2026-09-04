<?php

declare(strict_types=1);

use App\Domain\Repository\AppointmentReminderRepository;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\AppSettingRepository;
use App\Domain\Repository\AuditEventRepository;
use App\Domain\Repository\CarePlanRepository;
use App\Domain\Repository\ClinicalNoteRepository;
use App\Domain\Repository\ConsultationConsentRepository;
use App\Domain\Repository\CopilotDraftRepository;
use App\Domain\Repository\LabOrderRepository;
use App\Domain\Repository\PrescriptionRepository;
use App\Domain\Repository\RecordingRepository;
use App\Domain\Repository\ReferralRepository;
use App\Domain\Repository\SessionMetricRepository;
use App\Domain\Repository\TranscriptSegmentRepository;
use App\Domain\Repository\WalletRepository;
use App\Domain\Repository\WalletTransactionRepository;
use App\Domain\Repository\NotificationRepository;
use App\Domain\Repository\PatientRepository;
use App\Domain\Repository\SessionRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Agora\AgoraRecordingService;
use App\Infrastructure\Agora\AgoraTokenService;
use App\Infrastructure\Email\EmailOtpService;
use App\Infrastructure\Email\MailService;
use App\Infrastructure\Email\WalletMailer;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use App\Infrastructure\Service\AppointmentPaymentService;
use App\Infrastructure\Service\AuditLogger;
use App\Infrastructure\Service\AuthService;
use App\Infrastructure\Service\CopilotService;
use App\Infrastructure\Service\AvailabilityService;
use App\Infrastructure\Service\ReminderService;
use App\Infrastructure\Service\FirebaseIdTokenVerifier;
use App\Infrastructure\Service\JwtService;
use App\Infrastructure\Service\PricingService;
use App\Infrastructure\Service\SessionService;
use App\Infrastructure\Service\SettingsCacheService;
use App\Infrastructure\Service\PaystackService;
use App\Infrastructure\Service\TermiiService;
use App\Infrastructure\Service\WalletService;
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
        refreshTtl: (int) ($_ENV['JWT_REFRESH_TTL'] ?? 1209600),
    ),

    SettingsCacheService::class => static fn (ContainerInterface $c): SettingsCacheService =>
        new SettingsCacheService($c->get(RedisClient::class)),

    AvailabilityService::class => static fn (ContainerInterface $c): AvailabilityService =>
        new AvailabilityService($c->get(AppointmentRepository::class)),

    FirebaseIdTokenVerifier::class => static fn (): FirebaseIdTokenVerifier =>
        new FirebaseIdTokenVerifier($_ENV['FIREBASE_PROJECT_ID'] ?? ''),

    WalletService::class => static fn (ContainerInterface $c): WalletService => new WalletService(
        $c->get(EntityManagerInterface::class),
        $c->get(WalletRepository::class),
        $c->get(WalletTransactionRepository::class),
        $c->get(WalletMailer::class),
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

    ReminderService::class => static fn (ContainerInterface $c): ReminderService => new ReminderService(
        $c->get(AppointmentRepository::class),
        $c->get(AppointmentReminderRepository::class),
        $c->get(NotificationRepository::class),
        $c->get(MailService::class),
        $c->get(JwtService::class),
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

    AgoraTokenService::class => static fn (): AgoraTokenService => new AgoraTokenService(
        // trim(): a trailing newline/space pasted into .env silently corrupts the
        // HMAC signature → Agora rejects the token ("invalid token, authorized failed").
        appId:          trim($_ENV['AGORA_APP_ID'] ?? ''),
        appCertificate: trim($_ENV['AGORA_APP_CERTIFICATE'] ?? ''),
        // TEMPORARY stopgap while Agora resolves the certificate desync: a fixed
        // Console token + its channel. Both blank in normal operation.
        staticToken:    trim($_ENV['AGORA_STATIC_TOKEN'] ?? ''),
        staticChannel:  trim($_ENV['AGORA_STATIC_CHANNEL'] ?? ''),
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

    EmailOtpService::class => static fn (ContainerInterface $c): EmailOtpService => new EmailOtpService(
        $c->get(RedisClient::class),
        $c->get(MailService::class),
        ($_ENV['APP_ENV'] ?? 'production') !== 'production',
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
    ),

    SessionService::class => static fn (ContainerInterface $c): SessionService =>
        new SessionService($c->get(SessionRepository::class)),

    PricingService::class => static fn (ContainerInterface $c): PricingService =>
        new PricingService($c->get(AppSettingRepository::class)),

    // ----- Repositories -----
    UserRepository::class => static fn (ContainerInterface $c): UserRepository =>
        new UserRepository($c->get(EntityManagerInterface::class)),

    PatientRepository::class => static fn (ContainerInterface $c): PatientRepository =>
        new PatientRepository($c->get(EntityManagerInterface::class)),

    SpecialistRepository::class => static fn (ContainerInterface $c): SpecialistRepository =>
        new SpecialistRepository($c->get(EntityManagerInterface::class)),

    AppointmentRepository::class => static fn (ContainerInterface $c): AppointmentRepository =>
        new AppointmentRepository($c->get(EntityManagerInterface::class)),

    AppointmentReminderRepository::class => static fn (ContainerInterface $c): AppointmentReminderRepository =>
        new AppointmentReminderRepository($c->get(EntityManagerInterface::class)),

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

    AppSettingRepository::class => static fn (ContainerInterface $c): AppSettingRepository =>
        new AppSettingRepository($c->get(EntityManagerInterface::class)),
];
