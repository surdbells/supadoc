<?php

declare(strict_types=1);

namespace App\Domain\Document;

/**
 * A document-sharing request refused by a rule (spec §2.5, §3.2): the HTTP
 * status, the human message and the error map (`{field: message}` and/or a
 * machine-readable `code`, plus data such as `status` / `available_at`).
 *
 * Thrown inside a pair-locked transaction it rolls back everything the call
 * did; the action answers it with its status, message and errors. A service may
 * also RETURN one from the locked work instead of throwing it, when what the
 * work already did must be kept (e.g. a request expired lazily) — the
 * service then throws it after the commit.
 */
final class DomainRefusal extends \RuntimeException
{
    /** @param array<string,mixed> $errors */
    public function __construct(
        public readonly int $status,
        string $message,
        public readonly array $errors = [],
    ) {
        parent::__construct($message);
    }

    /** @param array<string,mixed> $extra */
    public static function code(int $status, string $code, string $message, array $extra = []): self
    {
        return new self($status, $message, ['code' => $code] + $extra);
    }

    /** A 422 on one field (`{field: message}`, optionally with a code). */
    public static function field(string $field, string $message, ?string $code = null): self
    {
        return new self(422, $message, [$field => $message] + ($code !== null ? ['code' => $code] : []));
    }

    /** @param array<string,string> $errors */
    public static function validation(array $errors, string $message = 'Validation failed'): self
    {
        return new self(422, $message, $errors);
    }

    public static function notFound(string $message = 'Not found'): self
    {
        return new self(404, $message);
    }

    /** The kill switch is off (spec §2.10). */
    public static function unavailable(): self
    {
        return self::code(503, 'sharing_unavailable', DocumentSharingRules::UNAVAILABLE_MESSAGE);
    }

    public function errorCode(): ?string
    {
        $code = $this->errors['code'] ?? null;

        return is_string($code) ? $code : null;
    }
}
