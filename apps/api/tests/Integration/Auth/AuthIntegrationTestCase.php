<?php

declare(strict_types=1);

namespace App\Tests\Integration\Auth;

use App\Domain\Entity\Patient;
use App\Domain\Entity\User;
use App\Infrastructure\Service\AuthService;
use App\Infrastructure\Service\JwtService;
use App\Tests\Integration\Auth\Support\AuthHarness;
use DI\Container;
use Doctrine\DBAL\Connection;
use Doctrine\ORM\EntityManagerInterface;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\Psr7\Factory\ServerRequestFactory;

/**
 * Shared fixture for the session / token integration tests: one throw-away
 * schema per class (emptied per test), real sign-ins through AuthService,
 * requests through the whole app, and SQL helpers to age a session. Skipped
 * (not failed) when the local database is unreachable.
 *
 * No token or secret is ever printed: assertions compare codes and messages.
 */
abstract class AuthIntegrationTestCase extends TestCase
{
    protected const PASSWORD = 'correct-horse-battery';

    private static ?string $schema = null;

    private static ?string $skipReason = null;

    /** @var list<Container> */
    private array $opened = [];

    /** A client address of this test's own, so per-IP buckets never leak between tests. */
    protected string $ip = '';

    public static function setUpBeforeClass(): void
    {
        self::$skipReason = AuthHarness::unavailableReason();
        self::$schema     = self::$skipReason === null ? AuthHarness::createSchema() : null;
    }

    public static function tearDownAfterClass(): void
    {
        if (self::$schema !== null) {
            AuthHarness::dropSchema(self::$schema);
            self::$schema = null;
        }
        AuthHarness::cleanRedis();
        AuthHarness::restoreEnv();
    }

    protected function setUp(): void
    {
        if (self::$skipReason !== null) {
            $this->markTestSkipped(self::$skipReason);
        }
        AuthHarness::generousLimits(); // again, after a test that lowered one
        $this->conn()->executeStatement('TRUNCATE staff_sessions, sessions, notifications, users, patients CASCADE');
        $this->ip = sprintf('10.%d.%d.%d', random_int(0, 255), random_int(0, 255), random_int(1, 254));
    }

    protected function tearDown(): void
    {
        foreach ($this->opened as $container) {
            $container->get(EntityManagerInterface::class)->getConnection()->close();
        }
        $this->opened = [];
    }

    // ----- the app -----

    protected function container(): Container
    {
        $container      = AuthHarness::container((string) self::$schema);
        $this->opened[] = $container;

        return $container;
    }

    protected function em(): EntityManagerInterface
    {
        return $this->container()->get(EntityManagerInterface::class);
    }

    protected function conn(): Connection
    {
        return $this->em()->getConnection();
    }

    protected function auth(): AuthService
    {
        return $this->container()->get(AuthService::class);
    }

    /** The real JWT service (the app's secret) — or one with other lifetimes, to mint expired tokens. */
    protected function jwt(?int $accessTtl = null, ?int $refreshTtl = null): JwtService
    {
        return new JwtService(
            (string) $_ENV['JWT_SECRET'],
            $accessTtl ?? AuthHarness::ACCESS,
            $refreshTtl ?? AuthHarness::ABSOLUTE,
        );
    }

    /**
     * One request through the whole app (a fresh container, so no identity map
     * survives between requests).
     *
     * @param array<string,mixed>|null $json
     * @return array{status:int, body:array<string,mixed>, response:ResponseInterface}
     */
    protected function send(string $method, string $path, ?string $bearer = null, ?array $json = null): array
    {
        $app = AuthHarness::app((string) self::$schema);
        $this->opened[] = $app->getContainer();

        $request = (new ServerRequestFactory())
            ->createServerRequest($method, $path, ['REMOTE_ADDR' => $this->ip])
            ->withHeader('Content-Type', 'application/json');
        if ($bearer !== null) {
            $request = $request->withHeader('Authorization', 'Bearer ' . $bearer);
        }
        if ($json !== null) {
            $request->getBody()->write((string) json_encode($json));
            $request->getBody()->rewind();
        }
        $response = $app->handle($request);

        return [
            'status'   => $response->getStatusCode(),
            'body'     => (array) json_decode((string) $response->getBody(), true),
            'response' => $response,
        ];
    }

    // ----- people and sessions -----

    /** @param list<string> $roles */
    protected function staffUser(array $roles = ['admin'], bool $active = true): User
    {
        $em   = $this->em();
        $user = new User('staff-' . bin2hex(random_bytes(4)) . '@example.test', 'Sam', 'Staff');
        $user->setRoles($roles);
        $user->setPassword(self::PASSWORD);
        $user->setActive($active);
        $em->persist($user);
        $em->flush();

        return $user;
    }

    protected function patient(): Patient
    {
        $em      = $this->em();
        $patient = new Patient('patient-' . bin2hex(random_bytes(4)) . '@example.test', 'Pat', 'Patient');
        $patient->setPassword(self::PASSWORD);
        $em->persist($patient);
        $em->flush();

        return $patient;
    }

    /** @return array{access:string, refresh:string, jti:string, sub:string} a real staff sign-in */
    protected function signInStaff(?User $user = null): array
    {
        $user ??= $this->staffUser();
        $tokens = $this->auth()->loginStaff($user->getEmail(), self::PASSWORD, 'PHPUnit', $this->ip);

        return $this->session($tokens);
    }

    /** @return array{access:string, refresh:string, jti:string, sub:string} a real patient sign-in */
    protected function signInPatient(?Patient $patient = null): array
    {
        $patient ??= $this->patient();
        $tokens = $this->auth()->loginCustomer((string) $patient->toArray()['email'], self::PASSWORD, 'PHPUnit', $this->ip);

        return $this->session($tokens);
    }

    /** Set a session's sign-in / last-activity time to that many seconds ago. */
    protected function age(string $jti, ?int $createdSecondsAgo = null, ?int $activeSecondsAgo = null): void
    {
        $table = $this->sessionTable($jti);
        if ($createdSecondsAgo !== null) {
            $this->conn()->executeStatement("UPDATE {$table} SET created_at = ? WHERE id = ?", [$this->ago($createdSecondsAgo), $jti]);
        }
        if ($activeSecondsAgo !== null) {
            $this->conn()->executeStatement("UPDATE {$table} SET last_active_at = ? WHERE id = ?", [$this->ago($activeSecondsAgo), $jti]);
        }
    }

    /** Seconds since the session's recorded activity (null: none recorded). */
    protected function secondsSinceActive(string $jti): ?int
    {
        $at = $this->conn()->fetchOne("SELECT last_active_at FROM {$this->sessionTable($jti)} WHERE id = ?", [$jti]);

        return $at === null || $at === false ? null : time() - (new \DateTimeImmutable((string) $at))->getTimestamp();
    }

    protected function isRevoked(string $jti): bool
    {
        return $this->conn()->fetchOne("SELECT revoked_at FROM {$this->sessionTable($jti)} WHERE id = ?", [$jti]) !== null;
    }

    /**
     * Assert the 401 contract: unchanged `message`, `errors.auth` (first) and `errors.code`.
     *
     * @param array{status:int, body:array<string,mixed>} $result
     */
    protected function assertAuthError(array $result, string $code, string $message, ?string $reason = null): void
    {
        $this->assertSame(401, $result['status'], 'status for ' . $code);
        $this->assertSame($message, $result['body']['message'] ?? null);
        $errors = (array) ($result['body']['errors'] ?? []);
        $this->assertSame('auth', array_key_first($errors), 'the human message is the first error field');
        $this->assertSame($message, $errors['auth'] ?? null);
        $this->assertSame($code, $errors['code'] ?? null);
        $this->assertSame($reason, $errors['reason'] ?? null, 'errors.reason');
    }

    /**
     * @param array<string,mixed> $tokens
     * @return array{access:string, refresh:string, jti:string, sub:string}
     */
    private function session(array $tokens): array
    {
        $claims = $this->jwt()->validateAccessToken((string) $tokens['access_token']);

        return [
            'access'  => (string) $tokens['access_token'],
            'refresh' => (string) $tokens['refresh_token'],
            'jti'     => (string) $claims->jti,
            'sub'     => (string) $claims->sub,
        ];
    }

    private function sessionTable(string $jti): string
    {
        $staff = (int) $this->conn()->fetchOne('SELECT COUNT(*) FROM staff_sessions WHERE id = ?', [$jti]);

        return $staff > 0 ? 'staff_sessions' : 'sessions';
    }

    private function ago(int $seconds): string
    {
        return (new \DateTimeImmutable('-' . $seconds . ' seconds'))->format('Y-m-d H:i:s');
    }
}
