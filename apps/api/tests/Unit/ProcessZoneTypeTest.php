<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Entity\Appointment;
use App\Infrastructure\Persistence\ClockRepair;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use App\Infrastructure\Persistence\ProcessZoneDateTimeImmutableType;
use DateTimeImmutable;
use DateTimeZone;
use Doctrine\DBAL\Platforms\PostgreSQLPlatform;
use Doctrine\DBAL\Types\DateImmutableType;
use Doctrine\DBAL\Types\Type;
use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\EntityManagerInterface;
use Doctrine\ORM\Query\ParameterTypeInferer;
use PHPUnit\Framework\TestCase;

/**
 * The clock fix's guarantee: every `datetime_immutable` value is stored on the
 * PHP process clock, whatever offset it carries (production runs PHP on PRC
 * while clients send UTC instants). Entity writes, DQL parameters and typed raw
 * parameters all go through the registered type; `date_immutable` is untouched.
 */
final class ProcessZoneTypeTest extends TestCase
{
    private string $zone = 'UTC';

    protected function setUp(): void
    {
        $this->zone = date_default_timezone_get();
        $_ENV['DB_SERVER_VERSION'] = '16';
    }

    protected function tearDown(): void
    {
        date_default_timezone_set($this->zone);
        ClockRepair::resetCache();
        DoctrineEntityManagerFactory::reset();
    }

    private function em(): EntityManagerInterface
    {
        DoctrineEntityManagerFactory::reset();

        return DoctrineEntityManagerFactory::create();
    }

    public function testTheFactoryRegistersTheProcessZoneType(): void
    {
        $this->em();
        $this->assertInstanceOf(ProcessZoneDateTimeImmutableType::class, Type::getType(Types::DATETIME_IMMUTABLE));

        DoctrineEntityManagerFactory::reset();
        $this->em(); // registering again (already the override) does not throw
        $this->assertInstanceOf(ProcessZoneDateTimeImmutableType::class, Type::getType(Types::DATETIME_IMMUTABLE));

        $this->assertSame(DateImmutableType::class, Type::getType(Types::DATE_IMMUTABLE)::class, 'calendar days are never shifted');
    }

    public function testAnInstantIsStoredOnTheProcessClock(): void
    {
        $conn = $this->em()->getConnection();
        date_default_timezone_set('Asia/Shanghai');

        $this->assertSame('2026-10-21 17:00:00', $conn->convertToDatabaseValue(new DateTimeImmutable('2026-10-21T09:00:00Z'), Types::DATETIME_IMMUTABLE));
        $this->assertSame('2026-10-21 17:00:00', $conn->convertToDatabaseValue(new DateTimeImmutable('2026-10-21T10:00:00+01:00'), Types::DATETIME_IMMUTABLE));
        $this->assertSame(
            '2026-10-21 17:00:00',
            $conn->convertToDatabaseValue(new DateTimeImmutable('2026-10-21 17:00:00', new DateTimeZone('Asia/Shanghai')), Types::DATETIME_IMMUTABLE),
            'a process-zone value passes through unchanged',
        );
        $this->assertNull($conn->convertToDatabaseValue(null, Types::DATETIME_IMMUTABLE));

        // …and reads back as the same instant.
        $back = Type::getType(Types::DATETIME_IMMUTABLE)->convertToPHPValue('2026-10-21 17:00:00', new PostgreSQLPlatform());
        $this->assertInstanceOf(DateTimeImmutable::class, $back);
        $this->assertSame((new DateTimeImmutable('2026-10-21T09:00:00Z'))->getTimestamp(), $back->getTimestamp());
    }

    public function testOnAUtcProcessNothingShifts(): void
    {
        $conn = $this->em()->getConnection();
        date_default_timezone_set('UTC');

        $this->assertSame('2026-10-21 09:00:00', $conn->convertToDatabaseValue(new DateTimeImmutable('2026-10-21T09:00:00Z'), Types::DATETIME_IMMUTABLE));
    }

    public function testADqlParameterIsConvertedToo(): void
    {
        $em = $this->em();
        date_default_timezone_set('Asia/Shanghai');
        $from = new DateTimeImmutable('2026-10-21T09:00:00+00:00');

        $query = $em->createQueryBuilder()
            ->select('a.id')
            ->from(Appointment::class, 'a')
            ->andWhere('a.scheduledAt >= :from')
            ->setParameter('from', $from)
            ->getQuery();
        $this->assertStringContainsString('scheduled_at >= ?', $query->getSQL());

        $type = ParameterTypeInferer::inferType($from);
        $this->assertSame(Types::DATETIME_IMMUTABLE, $type);
        $this->assertSame('2026-10-21 17:00:00', $em->getConnection()->convertToDatabaseValue($from, $type));
    }

    public function testTheSqlDeclarationIsUnchanged(): void
    {
        $this->em();
        $this->assertSame(
            'TIMESTAMP(0) WITHOUT TIME ZONE',
            Type::getType(Types::DATETIME_IMMUTABLE)->getSQLDeclaration([], new PostgreSQLPlatform()),
            'no schema diff',
        );
    }
}
