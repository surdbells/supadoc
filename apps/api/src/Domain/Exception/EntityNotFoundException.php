<?php

declare(strict_types=1);

namespace App\Domain\Exception;

use RuntimeException;

/** A requested record does not exist. Maps to HTTP 404. */
final class EntityNotFoundException extends RuntimeException
{
    public static function for(string $entity, string $id): self
    {
        return new self(sprintf('%s "%s" not found', $entity, $id));
    }
}
