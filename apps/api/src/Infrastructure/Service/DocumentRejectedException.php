<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

/**
 * A file {@see MedicalDocumentStorage} turned down — empty, too big, a type it
 * doesn't take, or content that doesn't match its name. The message is written
 * for the patient, so callers show it as a 422.
 */
final class DocumentRejectedException extends \RuntimeException
{
}
