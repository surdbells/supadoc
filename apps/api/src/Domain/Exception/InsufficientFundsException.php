<?php

declare(strict_types=1);

namespace App\Domain\Exception;

/** Raised when a wallet debit would take the balance below zero. */
final class InsufficientFundsException extends \RuntimeException
{
}
