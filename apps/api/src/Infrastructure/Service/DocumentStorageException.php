<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

/**
 * {@see MedicalDocumentStorage} could not write a file it had accepted (a
 * folder it can't create or write to, a failed move or copy). A server fault:
 * the message names server paths, so it is logged and never shown — callers
 * answer 500.
 *
 * Deliberately NOT a RuntimeException: callers that read any RuntimeException
 * from the storage as a rejection (a 422 showing its message) must not catch
 * this one.
 */
final class DocumentStorageException extends \Exception
{
}
