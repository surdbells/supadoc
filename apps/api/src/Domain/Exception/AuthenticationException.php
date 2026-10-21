<?php

declare(strict_types=1);

namespace App\Domain\Exception;

use App\Domain\Enum\AuthErrorCode;
use RuntimeException;

/**
 * Credentials don't match or a token was rejected. Maps to HTTP 401.
 *
 * With an `$authCode` (a token / session refusal) the response also carries
 * `errors: {auth: <message>, code, ...$details}` so a client can tell "refresh
 * and retry" from "sign out now"; a plain credential failure (wrong password)
 * has no `errors`, as before.
 */
final class AuthenticationException extends RuntimeException
{
    /** @param array<string,string> $details extra machine-readable fields, e.g. ['reason' => 'idle'] */
    public function __construct(
        string $message = '',
        public readonly ?AuthErrorCode $authCode = null,
        public readonly array $details = [],
        ?\Throwable $previous = null,
    ) {
        parent::__construct($message, 0, $previous);
    }

    /** @return array<string,string> the `errors` object of the 401 (empty without a code) */
    public function errors(): array
    {
        if ($this->authCode === null) {
            return [];
        }

        return ['auth' => $this->getMessage(), 'code' => $this->authCode->value] + $this->details;
    }
}
