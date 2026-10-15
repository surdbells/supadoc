<?php

declare(strict_types=1);

namespace App\Domain\Exception;

/**
 * A wallet posting was asked for under a ledger reference that already holds
 * a DIFFERENT posting (another wallet, direction or amount). Nothing was
 * posted: the reference is the idempotency key, so the request is neither a
 * retry of the original nor something that may be posted under that key.
 */
final class LedgerReferenceConflictException extends \RuntimeException
{
}
