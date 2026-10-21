<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Enum\SessionState;

/**
 * What the auth middlewares need from the session registry: whether a token's
 * session (by `jti`) is still usable, and why an expired one ran out. Implemented
 * by {@see SessionService}; an interface so the 401 paths can be unit-tested
 * against a fake.
 */
interface SessionStateReader
{
    /** The state of a staff session; with `$touch`, a live one also has its activity recorded. */
    public function staffState(string $id, bool $touch = false): SessionState;

    /** The state of a patient session; with `$touch`, a live one also has its activity recorded. */
    public function customerState(string $id, bool $touch = false): SessionState;

    /** Why an expired staff session ran out ({@see SessionState::REASON_IDLE} / REASON_LIFETIME), else null. Read-only. */
    public function staffExpiryReason(string $id): ?string;

    /** Why an expired patient session ran out, else null. Read-only. */
    public function customerExpiryReason(string $id): ?string;
}
