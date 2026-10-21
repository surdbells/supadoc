<?php

declare(strict_types=1);

namespace App\Domain\Enum;

/**
 * Why a session-bound request was refused with 401, sent as `errors.code` next
 * to the human message in `errors.auth` (first, so a client that shows the
 * first error field still shows words). `message` itself is unchanged, so a
 * client that ignores the code behaves exactly as before. The portals branch on
 * it:
 *
 *  - TOKEN_MISSING / TOKEN_EXPIRED / TOKEN_INVALID: only the access token is the
 *    problem: refresh once, retry once;
 *  - TOKEN_WRONG_AUDIENCE: a patient token on a staff route (or the reverse), a
 *    client bug that no refresh fixes;
 *  - SESSION_* / REFRESH_INVALID / ACCOUNT_*: the sign-in itself is over: sign
 *    out now, showing the server's message.
 *
 * SESSION_EXPIRED may carry `errors.reason`: `idle` or `lifetime`
 * ({@see SessionState::REASON_IDLE}).
 */
enum AuthErrorCode: string
{
    case TOKEN_MISSING        = 'token_missing';
    case TOKEN_EXPIRED        = 'token_expired';
    case TOKEN_INVALID        = 'token_invalid';
    case TOKEN_WRONG_AUDIENCE = 'token_wrong_audience';
    case SESSION_EXPIRED      = 'session_expired';
    case SESSION_REVOKED      = 'session_revoked';
    case SESSION_INVALID      = 'session_invalid';
    case REFRESH_INVALID      = 'refresh_invalid';
    case ACCOUNT_MISSING      = 'account_missing';
    case ACCOUNT_DEACTIVATED  = 'account_deactivated';

    /** Whether the sign-in is over (sign out), rather than just its access token (refresh). */
    public function endsSession(): bool
    {
        return match ($this) {
            self::TOKEN_MISSING, self::TOKEN_EXPIRED, self::TOKEN_INVALID, self::TOKEN_WRONG_AUDIENCE => false,
            default                                                                                => true,
        };
    }
}
