<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Enum\AuthErrorCode;
use App\Domain\Enum\SessionState;
use App\Domain\Exception\AuthenticationException;
use App\Infrastructure\Middleware\ErrorHandler;
use PHPUnit\Framework\TestCase;
use Psr\Log\NullLogger;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

/**
 * Session states map onto the 401 codes, and an AuthenticationException with
 * a code reaches the browser as `errors {auth, code, ...}` through the error
 * handler (a plain credential failure keeps its bare envelope).
 */
final class SessionStateTest extends TestCase
{
    public function testEachStateHasItsCodeAndUnchangedMessage(): void
    {
        $this->assertNull(SessionState::ACTIVE->code());
        $this->assertSame(AuthErrorCode::SESSION_EXPIRED, SessionState::EXPIRED->code());
        $this->assertSame(AuthErrorCode::SESSION_REVOKED, SessionState::REVOKED->code());
        $this->assertSame(AuthErrorCode::SESSION_INVALID, SessionState::UNKNOWN->code());

        $this->assertSame('Your session has expired. Please sign in again.', SessionState::EXPIRED->message());
        $this->assertSame('This session has been signed out. Please sign in again.', SessionState::REVOKED->message());
        $this->assertSame('Your session is no longer valid. Please sign in again.', SessionState::UNKNOWN->message());
    }

    public function testTheWireValuesAreTheAgreedContract(): void
    {
        $this->assertSame(
            ['token_missing', 'token_expired', 'token_invalid', 'token_wrong_audience', 'session_expired', 'session_revoked', 'session_invalid', 'refresh_invalid', 'account_missing', 'account_deactivated'],
            array_map(static fn (AuthErrorCode $c): string => $c->value, AuthErrorCode::cases()),
        );
        $this->assertSame(['idle', 'lifetime'], [SessionState::REASON_IDLE, SessionState::REASON_LIFETIME]);
    }

    public function testAnExceptionWithACodeCarriesTheErrorsObject(): void
    {
        $e = new AuthenticationException('Your session has expired. Please sign in again.', AuthErrorCode::SESSION_EXPIRED, ['reason' => 'idle']);
        $this->assertSame(
            ['auth' => 'Your session has expired. Please sign in again.', 'code' => 'session_expired', 'reason' => 'idle'],
            $e->errors(),
        );
        $this->assertSame(0, $e->getCode());
        $this->assertSame([], (new AuthenticationException('Invalid email or password'))->errors());
    }

    public function testTheErrorHandlerSendsTheCodeOn401(): void
    {
        $body = $this->handle(new AuthenticationException('This session has been signed out. Please sign in again.', AuthErrorCode::SESSION_REVOKED), $res);

        $this->assertSame(401, $res->getStatusCode());
        $this->assertSame('This session has been signed out. Please sign in again.', $body['message']);
        $this->assertSame(['auth', 'code'], array_keys($body['errors']));
        $this->assertSame('session_revoked', $body['errors']['code']);
        $this->assertStringContainsString('Retry-After', $res->getHeaderLine('Access-Control-Expose-Headers'), 'CORS is re-applied, with the exposed headers');
    }

    public function testAPlainCredentialFailureHasNoErrors(): void
    {
        $body = $this->handle(new AuthenticationException('Invalid email or password'), $res);

        $this->assertSame(401, $res->getStatusCode());
        $this->assertSame(['status' => 'error', 'message' => 'Invalid email or password'], $body);
    }

    /** @return array<string,mixed> */
    private function handle(\Throwable $e, mixed &$response = null): array
    {
        $handler  = new ErrorHandler(new ResponseFactory(), new NullLogger());
        $request  = (new ServerRequestFactory())->createServerRequest('POST', '/api/auth/refresh');
        $response = $handler($request, $e, false, false, false);

        return json_decode((string) $response->getBody(), true);
    }
}
