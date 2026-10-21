<?php

declare(strict_types=1);

namespace App\Infrastructure\Persistence;

use App\Domain\Settings\ProcessClock;
use DateTimeImmutable;
use Doctrine\DBAL\Platforms\AbstractPlatform;
use Doctrine\DBAL\Types\DateTimeImmutableType;

/**
 * `datetime_immutable`, stored on the process clock. The columns are TIMESTAMP(0)
 * WITHOUT TIME ZONE and hydrate in the process zone, so a value carrying any other
 * offset (a client's "…+00:00" / "…Z") is converted first — the stock type stores
 * the object's own wall-clock time, which reads back shifted by the difference.
 * Registered over the stock type by {@see DoctrineEntityManagerFactory}; the SQL
 * declaration and the read side are the parent's (no schema diff).
 */
final class ProcessZoneDateTimeImmutableType extends DateTimeImmutableType
{
    public function convertToDatabaseValue(mixed $value, AbstractPlatform $platform): ?string
    {
        if ($value instanceof DateTimeImmutable) {
            $value = ProcessClock::normalize($value);
        }

        return parent::convertToDatabaseValue($value, $platform);
    }
}
