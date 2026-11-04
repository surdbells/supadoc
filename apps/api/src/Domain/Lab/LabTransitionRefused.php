<?php

declare(strict_types=1);

namespace App\Domain\Lab;

/**
 * A lab request transition the status machine refuses (spec §1.7): the HTTP
 * status, the error code (`status_changed`, `expired`, `not_allowed`) and the
 * message of spec §2.1; `errors.status` is the effective status.
 */
final class LabTransitionRefused extends \RuntimeException
{
    /** @param array<string,mixed> $errors */
    public function __construct(
        public readonly int $status,
        public readonly string $errorCode,
        string $message,
        public readonly array $errors = [],
    ) {
        parent::__construct($message);
    }
}
