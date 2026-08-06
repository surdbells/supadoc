<?php

declare(strict_types=1);

namespace App\Domain\Exception;

use RuntimeException;

/** Request failed validation. Carries per-field errors; maps to HTTP 422. */
final class ValidationException extends RuntimeException
{
    /** @param array<string,string> $errors */
    public function __construct(
        private readonly array $errors,
        string $message = 'Validation failed',
    ) {
        parent::__construct($message);
    }

    /** @return array<string,string> */
    public function getErrors(): array
    {
        return $this->errors;
    }
}
