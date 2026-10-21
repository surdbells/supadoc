<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Action\Patient\VerifyMyPhoneAction;
use App\Domain\Enum\AuthErrorCode;
use App\Domain\Enum\SessionState;
use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Middleware\AuthMiddleware;
use App\Infrastructure\Middleware\CustomerAuthMiddleware;
use App\Infrastructure\Service\JwtService;
use App\Infrastructure\Service\SessionStateReader;
use Firebase\JWT\JWT;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * The 401 contract of the two auth middlewares: every refusal keeps its old
 * `message` and adds `errors: {auth: <message>, code, reason?}` (auth first),
 * so the portals can tell "refresh the access token and retry" (token_*) from
 * "the sign-in is over, sign out" (session_*), and a wrong-audience token (a
 * client bug) from both. Sessions are faked through SessionStateReader.
 */
final class AuthErrorCodesTest extends TestCase
{
    private const SECRET = 'unit-test-secret-that-is-at-least-32-bytes-long';

    private JwtService $jwt;

    protected function setUp(): void
    {
        $this->jwt = new JwtService(self::SECRET, 900, 43200);
    }

    protected function tearDown(): void
    {
        JWT::$timestamp = null;
    }

    // ----- Token problems: refresh and retry -----

    #[DataProvider('audiences')]
    public function testNoBearerIsTokenMissing(string $audience): void
    {
        $sessions = $this->sessions();
        foreach ([null, 'Basic dXNlcjpwYXNz', 'Bearer', 'Bearer '] as $header) {
            $res = $this->call($audience, $header, $sessions);
            $this->assertAuthError($res, 'Missing bearer token', AuthErrorCode::TOKEN_MISSING);
        }
        $this->assertSame([], $sessions->calls, 'no session lookup without a token');
    }

    #[DataProvider('audiences')]
    public function testAnExpiredAccessTokenIsTokenExpiredWithTheOldMessage(string $audience): void
    {
        $expired = (new JwtService(self::SECRET, -10, 43200))->issueAccessToken('u-1', $audience, jti: 'jti-1');
        $sessions = $this->sessions();

        $res = $this->call($audience, 'Bearer ' . $expired, $sessions);

        $this->assertAuthError($res, 'Invalid or expired token', AuthErrorCode::TOKEN_EXPIRED);
        $this->assertSame([], $sessions->calls, 'an expired token never touches the session (the refresh does)');
    }

    #[DataProvider('audiences')]
    public function testTheAccessTokenExpiresExactlyAtItsExp(string $audience): void
    {
        $token = $this->jwt->issueAccessToken('u-1', $audience, jti: 'jti-1');
        $exp   = (int) $this->claims($token)['exp'];

        JWT::$timestamp = $exp - 1;
        $this->assertSame(204, $this->call($audience, 'Bearer ' . $token, $this->sessions())->getStatusCode(), 'one second before exp: accepted');

        JWT::$timestamp = $exp;
        $this->assertAuthError($this->call($audience, 'Bearer ' . $token, $this->sessions()), 'Invalid or expired token', AuthErrorCode::TOKEN_EXPIRED);
    }

    #[DataProvider('audiences')]
    public function testUndecodableTokensAreTokenInvalid(string $audience): void
    {
        $foreign = (new JwtService('another-secret-that-is-at-least-32-bytes-long!', 900, 43200))
            ->issueAccessToken('u-1', $audience, jti: 'jti-1');
        $refresh = $this->jwt->issueRefreshToken('u-1', $audience, 'jti-1');

        foreach (['garbage', 'a.b.c', $foreign, $refresh] as $token) {
            $res = $this->call($audience, 'Bearer ' . $token, $this->sessions());
            $this->assertAuthError($res, 'Invalid or expired token', AuthErrorCode::TOKEN_INVALID);
        }
    }

    public function testAnExpiredForeignTokenIsInvalidNotExpired(): void
    {
        // The signature is checked before the expiry, so a forged token never reads as "just refresh".
        $forged = (new JwtService('another-secret-that-is-at-least-32-bytes-long!', -10, 43200))
            ->issueAccessToken('u-1', 'staff', jti: 'jti-1');

        $this->assertAuthError($this->call('staff', 'Bearer ' . $forged, $this->sessions()), 'Invalid or expired token', AuthErrorCode::TOKEN_INVALID);
    }

    public function testATokenOfTheOtherPortalIsWrongAudience(): void
    {
        $customer = $this->jwt->issueAccessToken('p-1', 'customer', jti: 'jti-1');
        $staff    = $this->jwt->issueAccessToken('u-1', 'staff', ['admin'], [], 'jti-2');
        $investor = $this->jwt->issueAccessToken('i-1', 'investor', jti: 'jti-3');

        $this->assertAuthError($this->call('staff', 'Bearer ' . $customer, $this->sessions()), 'This token is not valid for staff endpoints', AuthErrorCode::TOKEN_WRONG_AUDIENCE);
        $this->assertAuthError($this->call('staff', 'Bearer ' . $investor, $this->sessions()), 'This token is not valid for staff endpoints', AuthErrorCode::TOKEN_WRONG_AUDIENCE);
        $this->assertAuthError($this->call('customer', 'Bearer ' . $staff, $this->sessions()), 'This token is not valid for customer endpoints', AuthErrorCode::TOKEN_WRONG_AUDIENCE);
        $this->assertFalse(AuthErrorCode::TOKEN_WRONG_AUDIENCE->endsSession());
    }

    // ----- Session problems: sign out now -----

    /** @return iterable<string, array{string, SessionState, ?string, AuthErrorCode, string}> */
    public static function deadSessions(): iterable
    {
        foreach (['staff', 'customer'] as $audience) {
            yield "$audience idle"     => [$audience, SessionState::EXPIRED, SessionState::REASON_IDLE, AuthErrorCode::SESSION_EXPIRED, 'Your session has expired. Please sign in again.'];
            yield "$audience lifetime" => [$audience, SessionState::EXPIRED, SessionState::REASON_LIFETIME, AuthErrorCode::SESSION_EXPIRED, 'Your session has expired. Please sign in again.'];
            yield "$audience revoked"  => [$audience, SessionState::REVOKED, null, AuthErrorCode::SESSION_REVOKED, 'This session has been signed out. Please sign in again.'];
            yield "$audience unknown"  => [$audience, SessionState::UNKNOWN, null, AuthErrorCode::SESSION_INVALID, 'Your session is no longer valid. Please sign in again.'];
        }
    }

    #[DataProvider('deadSessions')]
    public function testADeadSessionSaysWhyAndEndsTheSignIn(string $audience, SessionState $state, ?string $reason, AuthErrorCode $code, string $message): void
    {
        $token    = $this->jwt->issueAccessToken('u-1', $audience, jti: 'jti-1');
        $sessions = $this->sessions($state, $reason);

        $res  = $this->call($audience, 'Bearer ' . $token, $sessions);
        $body = $this->assertAuthError($res, $message, $code);

        $this->assertTrue($code->endsSession());
        if ($state === SessionState::EXPIRED) {
            $this->assertSame(['auth', 'code', 'reason'], array_keys($body['errors']));
            $this->assertSame($reason, $body['errors']['reason']);
        } else {
            $this->assertArrayNotHasKey('reason', $body['errors']);
        }
        $this->assertSame([[$audience, 'jti-1', true]], array_slice($sessions->calls, 0, 1), 'the session is looked up (and would be touched if live)');
    }

    #[DataProvider('audiences')]
    public function testATokenWithoutAJtiFailsClosed(string $audience): void
    {
        $token    = $this->jwt->issueAccessToken('u-1', $audience);
        $sessions = $this->sessions(SessionState::ACTIVE);

        $this->assertAuthError(
            $this->call($audience, 'Bearer ' . $token, $sessions),
            'Your session is no longer valid. Please sign in again.',
            AuthErrorCode::SESSION_INVALID,
        );
    }

    public function testWithoutASessionRegistryTheStaffMiddlewareTrustsTheTokenAlone(): void
    {
        // The unit-test seam: routes.php always passes the registry.
        $token   = $this->jwt->issueAccessToken('u-1', 'staff', ['admin'], ['x.y']);
        $handler = $this->handler();
        $res     = (new AuthMiddleware($this->jwt))->process($this->request('Bearer ' . $token), $handler);

        $this->assertSame(204, $res->getStatusCode());
        $this->assertSame('u-1', $handler->seen?->getAttribute('user_id'));
    }

    // ----- A live session passes, and is touched -----

    public function testALiveStaffSessionPassesAndIsTouched(): void
    {
        $token    = $this->jwt->issueAccessToken('u-1', 'staff', ['doctor'], ['notes.write'], 'jti-1');
        $sessions = $this->sessions(SessionState::ACTIVE);
        $handler  = $this->handler();

        $res = (new AuthMiddleware($this->jwt, $sessions))->process($this->request('Bearer ' . $token), $handler);

        $this->assertSame(204, $res->getStatusCode());
        $this->assertSame([['staff', 'jti-1', true]], $sessions->calls);
        $this->assertSame('u-1', $handler->seen?->getAttribute('user_id'));
        $this->assertSame(['doctor'], $handler->seen?->getAttribute('user_roles'));
        $this->assertSame(['notes.write'], $handler->seen?->getAttribute('user_permissions'));
        $this->assertSame('jti-1', $handler->seen?->getAttribute('session_id'));
    }

    public function testALiveCustomerSessionPassesAndIsTouched(): void
    {
        $token    = $this->jwt->issueAccessToken('p-1', 'customer', jti: 'jti-9');
        $sessions = $this->sessions(SessionState::ACTIVE);
        $handler  = $this->handler();

        $res = (new CustomerAuthMiddleware($this->jwt, $sessions))->process($this->request('bearer  ' . $token), $handler);

        $this->assertSame(204, $res->getStatusCode());
        $this->assertSame([['customer', 'jti-9', true]], $sessions->calls);
        $this->assertSame('p-1', $handler->seen?->getAttribute('customer_id'));
        $this->assertSame('jti-9', $handler->seen?->getAttribute('session_id'));
    }

    // ----- Not a session problem: never a 401 -----

    public function testAnExpiredPhoneProofIsA422NotA401(): void
    {
        // A 401 would make the portal refresh and retry; the sign-in is fine, only the SMS proof ran out.
        $action = new VerifyMyPhoneAction(
            $this->jwt,
            (new \ReflectionClass(PatientRepository::class))->newInstanceWithoutConstructor(), // untouched on this path
        );
        $expiredProof = $this->jwt->issuePhoneProof('+2348000000000', -10);

        foreach ([$expiredProof, 'garbage'] as $proof) {
            $request = (new ServerRequestFactory())->createServerRequest('POST', '/api/portal/me/verify-phone')
                ->withAttribute('customer_id', 'p-1')
                ->withParsedBody(['verification_token' => $proof]);
            $res  = $action($request, new Response());
            $body = json_decode((string) $res->getBody(), true);

            $this->assertSame(422, $res->getStatusCode());
            $this->assertSame('Phone verification expired — please verify again', $body['message']);
            $this->assertSame(['verification_token', 'code'], array_keys($body['errors']));
            $this->assertSame('phone_proof_expired', $body['errors']['code']);
        }
    }

    public function testOnlyTheSessionCodesEndTheSignIn(): void
    {
        $refresh = [];
        foreach (AuthErrorCode::cases() as $code) {
            if (!$code->endsSession()) {
                $refresh[] = $code->value;
            }
        }
        $this->assertSame(['token_missing', 'token_expired', 'token_invalid', 'token_wrong_audience'], $refresh);
    }

    // ----- helpers -----

    /** @return iterable<string, array{string}> */
    public static function audiences(): iterable
    {
        yield 'staff' => ['staff'];
        yield 'customer' => ['customer'];
    }

    /** @return array<string,mixed> the decoded body, after asserting the 401 contract */
    private function assertAuthError(ResponseInterface $res, string $message, AuthErrorCode $code): array
    {
        $this->assertSame(401, $res->getStatusCode());
        $body = json_decode((string) $res->getBody(), true);
        $this->assertSame('error', $body['status']);
        $this->assertSame($message, $body['message'], 'the message is unchanged');
        $this->assertSame(['auth', 'code'], array_slice(array_keys($body['errors']), 0, 2), 'the human message first, then the code');
        $this->assertSame($message, $body['errors']['auth']);
        $this->assertSame($code->value, $body['errors']['code']);

        return $body;
    }

    private function call(string $audience, ?string $authorization, SessionStateReader $sessions): ResponseInterface
    {
        $middleware = $audience === 'staff'
            ? new AuthMiddleware($this->jwt, $sessions)
            : new CustomerAuthMiddleware($this->jwt, $sessions);

        return $middleware->process($this->request($authorization), $this->handler());
    }

    private function request(?string $authorization): ServerRequestInterface
    {
        $request = (new ServerRequestFactory())->createServerRequest('GET', '/api/me');

        return $authorization === null ? $request : $request->withHeader('Authorization', $authorization);
    }

    /** A 204 handler that keeps the request it was handed in `->seen`. */
    private function handler(): RequestHandlerInterface
    {
        return new class implements RequestHandlerInterface {
            public ?ServerRequestInterface $seen = null;

            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                $this->seen = $request;

                return new Response(204);
            }
        };
    }

    /** @return array<string,mixed> */
    private function claims(string $token): array
    {
        return json_decode(base64_decode(strtr(explode('.', $token)[1], '-_', '+/')), true);
    }

    /** A session registry answering `$state` for every jti (and '' → UNKNOWN, as the real one does). */
    private function sessions(SessionState $state = SessionState::ACTIVE, ?string $reason = null): SessionStateReader
    {
        return new class ($state, $reason) implements SessionStateReader {
            /** @var list<array{string,string,bool}> */
            public array $calls = [];

            public function __construct(private SessionState $state, private ?string $reason)
            {
            }

            public function staffState(string $id, bool $touch = false): SessionState
            {
                $this->calls[] = ['staff', $id, $touch];

                return $id === '' ? SessionState::UNKNOWN : $this->state;
            }

            public function customerState(string $id, bool $touch = false): SessionState
            {
                $this->calls[] = ['customer', $id, $touch];

                return $id === '' ? SessionState::UNKNOWN : $this->state;
            }

            public function staffExpiryReason(string $id): ?string
            {
                return $this->reason;
            }

            public function customerExpiryReason(string $id): ?string
            {
                return $this->reason;
            }
        };
    }
}
