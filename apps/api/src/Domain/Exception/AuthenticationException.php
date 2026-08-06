<?php

declare(strict_types=1);

namespace App\Domain\Exception;

use RuntimeException;

/** Credentials don't match or a token was rejected. Maps to HTTP 401. */
final class AuthenticationException extends RuntimeException
{
}
