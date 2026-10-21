<?php

declare(strict_types=1);

namespace App\Domain\Enum;

/** Why a session token is (or isn't) still usable: drives the 401 message and code. */
enum SessionState: string
{
    case ACTIVE  = 'active';
    case EXPIRED = 'expired';   // idle too long or past its absolute lifetime
    case REVOKED = 'revoked';   // signed out (by the user, another device or logout)
    case UNKNOWN = 'unknown';   // no such session

    /** `errors.reason` of an EXPIRED session: no authenticated request for the idle window. */
    public const REASON_IDLE = 'idle';

    /** `errors.reason` of an EXPIRED session: older than the absolute lifetime. */
    public const REASON_LIFETIME = 'lifetime';

    public function message(): string
    {
        return match ($this) {
            self::ACTIVE  => '',
            self::EXPIRED => 'Your session has expired. Please sign in again.',
            self::REVOKED => 'This session has been signed out. Please sign in again.',
            self::UNKNOWN => 'Your session is no longer valid. Please sign in again.',
        };
    }

    /** The 401 `errors.code` for this state (null for a live session). */
    public function code(): ?AuthErrorCode
    {
        return match ($this) {
            self::ACTIVE  => null,
            self::EXPIRED => AuthErrorCode::SESSION_EXPIRED,
            self::REVOKED => AuthErrorCode::SESSION_REVOKED,
            self::UNKNOWN => AuthErrorCode::SESSION_INVALID,
        };
    }
}
