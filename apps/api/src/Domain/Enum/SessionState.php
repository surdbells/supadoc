<?php

declare(strict_types=1);

namespace App\Domain\Enum;

/** Why a session token is (or isn't) still usable — drives the 401 message. */
enum SessionState: string
{
    case ACTIVE  = 'active';
    case EXPIRED = 'expired';   // idle too long or past its absolute lifetime
    case REVOKED = 'revoked';   // signed out (by the user, another device or logout)
    case UNKNOWN = 'unknown';   // no such session

    public function message(): string
    {
        return match ($this) {
            self::ACTIVE  => '',
            self::EXPIRED => 'Your session has expired. Please sign in again.',
            self::REVOKED => 'This session has been signed out. Please sign in again.',
            self::UNKNOWN => 'Your session is no longer valid. Please sign in again.',
        };
    }
}
