<?php

declare(strict_types=1);

namespace App\Domain\Exception;

/**
 * A coded refusal from the doctor-application endpoints (spec §3.1): the HTTP
 * status, a machine-readable `errors.code` and any extras the client needs
 * (`reference`, `attempts_left`, `steps`, `retry_after`…). The message is fixed,
 * human copy written for the person — ErrorHandler returns it as is, also for
 * the two deliberate 503s (`codes_unavailable`, `storage_unavailable`), and
 * never logs it. Plain field errors stay {@see ValidationException} (422).
 *
 * The code is `$errorCode`: `\Exception::$code` (an int) can't be redeclared.
 */
final class ApplicationProblem extends \RuntimeException
{
    public readonly string $errorCode;

    /** @param array<string,mixed> $extra e.g. ['reference' => …], ['attempts_left' => 2], ['steps' => […]] */
    public function __construct(
        public readonly int $status,
        string $code,
        string $message,
        public readonly array $extra = [],
    ) {
        parent::__construct($message);
        $this->errorCode = $code;
    }
}
