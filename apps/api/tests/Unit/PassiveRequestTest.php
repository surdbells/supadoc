<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Enum\SessionState;
use App\Infrastructure\Middleware\AuthMiddleware;
use App\Infrastructure\Middleware\CorsMiddleware;
use App\Infrastructure\Middleware\CustomerAuthMiddleware;
use App\Infrastructure\Service\JwtService;
use App\Infrastructure\Service\SessionStateReader;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * Background polls (`X-SD-Passive: 1`, spec §2.8): both auth middlewares still
 * check the session (an expired one is still refused with its code) but never
 * touch it, so a poll can't keep an idle session alive; any other request does.
 * CORS lets browsers send the header.
 */
final class PassiveRequestTest extends TestCase
{
    private const SECRET = 'unit-test-secret-that-is-at-least-32-bytes-long';

    public function testAStaffPollIsCheckedButNotTouched(): void
    {
        $jwt      = new JwtService(self::SECRET, 900, 43200);
        $token    = $jwt->issueAccessToken('u-1', 'staff', ['doctor'], [], 'jti-1');
        $sessions = $this->sessions(SessionState::ACTIVE);
        $mw       = new AuthMiddleware($jwt, $sessions);

        $this->assertSame(204, $mw->process($this->request($token, true), $this->handler())->getStatusCode());
        $this->assertSame(204, $mw->process($this->request($token, false), $this->handler())->getStatusCode());
        $this->assertSame(204, $mw->process($this->request($token, false, '0'), $this->handler())->getStatusCode());
        $this->assertSame([['staff', 'jti-1', false], ['staff', 'jti-1', true], ['staff', 'jti-1', true]], $sessions->calls);
    }

    public function testACustomerPollIsCheckedButNotTouched(): void
    {
        $jwt      = new JwtService(self::SECRET, 900, 43200);
        $token    = $jwt->issueAccessToken('p-1', 'customer', jti: 'jti-9');
        $sessions = $this->sessions(SessionState::ACTIVE);
        $mw       = new CustomerAuthMiddleware($jwt, $sessions);

        $mw->process($this->request($token, true), $this->handler());
        $mw->process($this->request($token, false), $this->handler());
        $this->assertSame([['customer', 'jti-9', false], ['customer', 'jti-9', true]], $sessions->calls);
    }

    public function testAnExpiredSessionIsStillRefusedOnAPoll(): void
    {
        $jwt   = new JwtService(self::SECRET, 900, 43200);
        $token = $jwt->issueAccessToken('p-1', 'customer', jti: 'jti-9');
        $res   = (new CustomerAuthMiddleware($jwt, $this->sessions(SessionState::EXPIRED)))->process($this->request($token, true), $this->handler());

        $this->assertSame(401, $res->getStatusCode());
        $this->assertSame('session_expired', json_decode((string) $res->getBody(), true)['errors']['code']);
    }

    public function testCorsAllowsThePassiveHeader(): void
    {
        $request = (new ServerRequestFactory())->createServerRequest('OPTIONS', '/api/doctor/appointments/x/document-access')
            ->withHeader('Origin', 'https://doctor.example');
        $res = (new CorsMiddleware(['https://doctor.example']))->process($request, $this->handler());

        $this->assertStringContainsString('X-SD-Passive', $res->getHeaderLine('Access-Control-Allow-Headers'));
        $this->assertStringContainsString('Authorization', $res->getHeaderLine('Access-Control-Allow-Headers'));
        $this->assertSame('X-SD-Passive', AuthMiddleware::PASSIVE_HEADER);
    }

    private function request(string $token, bool $passive, ?string $value = null): ServerRequestInterface
    {
        $request = (new ServerRequestFactory())->createServerRequest('GET', '/api/x')->withHeader('Authorization', 'Bearer ' . $token);
        if ($passive) {
            $request = $request->withHeader('X-SD-Passive', '1');
        } elseif ($value !== null) {
            $request = $request->withHeader('X-SD-Passive', $value);
        }

        return $request;
    }

    private function handler(): RequestHandlerInterface
    {
        return new class implements RequestHandlerInterface {
            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                return new Response(204);
            }
        };
    }

    private function sessions(SessionState $state): SessionStateReader
    {
        return new class ($state) implements SessionStateReader {
            /** @var list<array{string,string,bool}> */
            public array $calls = [];

            public function __construct(private SessionState $state)
            {
            }

            public function staffState(string $id, bool $touch = false): SessionState
            {
                $this->calls[] = ['staff', $id, $touch];

                return $this->state;
            }

            public function customerState(string $id, bool $touch = false): SessionState
            {
                $this->calls[] = ['customer', $id, $touch];

                return $this->state;
            }

            public function staffExpiryReason(string $id): ?string
            {
                return null;
            }

            public function customerExpiryReason(string $id): ?string
            {
                return null;
            }
        };
    }
}
