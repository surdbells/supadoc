<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Enum\AppointmentStatus;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\JwtService;
use PHPUnit\Framework\TestCase;

/** Pure-logic units: the state machine, the JWT scope guard, pagination parsing. */
final class DomainTest extends TestCase
{
    public function testAppointmentStateMachine(): void
    {
        $this->assertTrue(AppointmentStatus::PENDING->canTransitionTo(AppointmentStatus::CONFIRMED));
        $this->assertTrue(AppointmentStatus::CONFIRMED->canTransitionTo(AppointmentStatus::COMPLETED));
        $this->assertFalse(AppointmentStatus::COMPLETED->canTransitionTo(AppointmentStatus::PENDING));
        $this->assertFalse(AppointmentStatus::CANCELLED->canTransitionTo(AppointmentStatus::CONFIRMED));
        $this->assertTrue(AppointmentStatus::COMPLETED->isTerminal());
        $this->assertFalse(AppointmentStatus::PENDING->isTerminal());
    }

    /** php-jwt v7 requires a ≥32-byte HS256 secret, so use a realistic one. */
    private const SECRET = 'test-secret-please-change-to-32+bytes-in-prod';

    public function testJwtRoundTripCarriesScopeAndClaims(): void
    {
        $jwt   = new JwtService(self::SECRET, 900, 1209600);
        $token = $jwt->issueAccessToken('user-1', 'staff', ['admin'], ['appointments.read']);

        $claims = $jwt->validateAccessToken($token);
        $this->assertSame('user-1', $claims->sub);
        $this->assertSame('staff', $claims->scope);   // audience the middleware checks
        $this->assertContains('appointments.read', $claims->permissions);
    }

    public function testAccessValidationRejectsARefreshToken(): void
    {
        $jwt     = new JwtService(self::SECRET, 900, 1209600);
        $refresh = $jwt->issueRefreshToken('user-1', 'staff');

        // A refresh token is not interchangeable with an access token.
        $this->assertSame('user-1', $jwt->validateRefreshToken($refresh)->sub);
        $this->expectException(\RuntimeException::class);
        $jwt->validateAccessToken($refresh);
    }

    public function testPaginationClampsAndCamelCasesSort(): void
    {
        $helper = new class {
            use ApiResponse;

            /** @param array<string,mixed> $q @return array<string,mixed> */
            public function parse(array $q): array
            {
                return $this->getPaginationParams($q);
            }
        };

        $p = $helper->parse(['page' => '3', 'per_page' => '500', 'sort_by' => 'scheduled_at', 'sort_dir' => 'asc']);

        $this->assertSame(3, $p['page']);
        $this->assertSame(100, $p['per_page']);            // clamped 1..100
        $this->assertSame(200, $p['offset']);              // (3-1) * 100
        $this->assertSame('scheduledAt', $p['sort_by']);   // snake_case -> camelCase
        $this->assertSame('asc', $p['sort_dir']);          // normalised lowercase
    }
}
