<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Entity\Appointment;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use Doctrine\ORM\EntityManagerInterface;
use Doctrine\ORM\Tools\SchemaValidator;
use PHPUnit\Framework\TestCase;

/**
 * The highest-leverage tests here: with `serverVersion` pinned, DBAL resolves
 * the platform WITHOUT connecting, so mapping + DQL are validated offline (see
 * ARCHITECTURE §12). Catches "field doesn't exist" / bad-mapping errors that
 * otherwise only surface as a production 500.
 */
final class DoctrineOfflineTest extends TestCase
{
    private function em(): EntityManagerInterface
    {
        $_ENV['DB_SERVER_VERSION'] = '16';
        DoctrineEntityManagerFactory::reset();

        return DoctrineEntityManagerFactory::create();
    }

    public function testEntityMappingIsValid(): void
    {
        $errors = (new SchemaValidator($this->em()))->validateMapping();

        $this->assertSame([], $errors, print_r($errors, true));
    }

    public function testRepositoryDqlCompilesToSql(): void
    {
        // Throws on a bad field name / bad DQL — that's the whole point.
        $sql = $this->em()->createQueryBuilder()
            ->select('a')
            ->from(Appointment::class, 'a')
            ->andWhere('a.status IN (:statuses)')
            ->andWhere('a.deletedAt IS NULL')
            ->setParameter('statuses', ['pending', 'confirmed'])
            ->orderBy('a.createdAt', 'DESC')
            ->getQuery()
            ->getSQL();

        $this->assertStringContainsStringIgnoringCase('appointments', $sql);
        $this->assertStringContainsStringIgnoringCase('created_at', $sql);
    }
}
