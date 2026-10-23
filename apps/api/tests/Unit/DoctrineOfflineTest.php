<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Entity\Appointment;
use App\Domain\Repository\NotificationRepository;
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

    /** Doctor applications: every query compiles; instants are bound (never SQL now()). */
    public function testDoctorApplicationQueriesCompile(): void
    {
        $em   = $this->em();
        $apps = new \App\Domain\Repository\DoctorApplicationRepository($em);
        $now  = new \DateTimeImmutable('2026-10-23 10:00:00');
        $sqls = [
            $apps->findByReferenceQuery('GVM-DR-2026-12345')->getSQL(),
            $apps->openForEmailQuery('a@b.co', '00000000-0000-0000-0000-000000000000')->getSQL(),
            $apps->approvedForEmailQuery('a@b.co')->getSQL(),
            $apps->draftsForEmailQuery('a@b.co', $now)->getSQL(),
            $apps->expiredDraftsQuery($now, 20)->getSQL(),
            $apps->queueCountsQuery(1_800_000_000, 1_799_990_000, 1_800_076_400)->getSQL(),
            (new \App\Domain\Repository\DoctorApplicationDocumentRepository($em))->usageQuery('00000000-0000-0000-0000-000000000000')->getSQL(),
            (new \App\Domain\Repository\DoctorApplicationDocumentRepository($em))->forApplicationQuery('00000000-0000-0000-0000-000000000000')->getSQL(),
            (new \App\Domain\Repository\DoctorApplicationEventRepository($em))->forApplicationQuery('00000000-0000-0000-0000-000000000000')->getSQL(),
            (new \App\Domain\Repository\DoctorApplicationInfoRequestRepository($em))->openForQuery('00000000-0000-0000-0000-000000000000')->getSQL(),
            (new \App\Domain\Repository\DoctorApplicationNoteRepository($em))->forApplicationQuery('00000000-0000-0000-0000-000000000000')->getSQL(),
            (new \App\Domain\Repository\SpecialistRepository($em))->findByEmailQuery('a@b.co')->getSQL(),
        ];
        foreach (['all', 'needs_action', 'approved'] as $filter) {
            foreach (['waiting', 'newest', 'interview'] as $sort) {
                $sqls[] = $apps->adminListQuery('ada 0803', $filter, 'abroad', $sort, 1_800_000_000)->getQuery()->getSQL();
            }
        }
        foreach ($sqls as $sql) {
            $this->assertStringNotContainsStringIgnoringCase('now()', $sql);
            $this->assertStringNotContainsStringIgnoringCase('current_timestamp', $sql);
        }
        $this->assertStringContainsString('interview_epoch', $sqls[5]);
        $this->assertStringContainsStringIgnoringCase('COALESCE', $apps->adminListQuery(null, 'needs_action', null, 'waiting', 1)->getQuery()->getSQL());
    }

    public function testNotificationCountsByTypeCompiles(): void
    {
        $sql = (new NotificationRepository($this->em()))->countsByTypeQuery('00000000-0000-0000-0000-000000000000')->getSQL();

        $this->assertStringContainsStringIgnoringCase('notifications', $sql);
        $this->assertStringContainsStringIgnoringCase('read_at IS NULL', $sql);
        $this->assertStringContainsStringIgnoringCase('GROUP BY', $sql);
    }
}
