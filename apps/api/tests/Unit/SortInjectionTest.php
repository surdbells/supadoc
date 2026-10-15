<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\NotificationRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use App\Infrastructure\Service\ApiResponse;
use Doctrine\ORM\EntityManagerInterface;
use PHPUnit\Framework\TestCase;

/**
 * `?sort_by=` reaches ORDER BY, so it must never carry DQL: only an
 * allow-listed, mapped field of the entity gets through (offline — no DB).
 */
final class SortInjectionTest extends TestCase
{
    private function em(): EntityManagerInterface
    {
        $_ENV['DB_SERVER_VERSION'] = '16';
        DoctrineEntityManagerFactory::reset();

        return DoctrineEntityManagerFactory::create();
    }

    /** @return array{sort_by:string} */
    private function params(string $raw): array
    {
        $helper = new class {
            use ApiResponse;

            /** @return array<string, mixed> */
            public function parse(array $q): array
            {
                return $this->getPaginationParams($q);
            }
        };

        return $helper->parse(['sort_by' => $raw]);
    }

    public function testRequestHelperDropsAnythingButAPlainFieldName(): void
    {
        $this->assertSame('scheduledAt', $this->params('scheduled_at')['sort_by']);
        foreach ([
            "id,\t(SELECT u.password FROM App\\Domain\\Entity\\User u)",
            "createdAt\nASC",
            'name)--',
            'a.b',
            '',
        ] as $evil) {
            $this->assertSame('createdAt', $this->params($evil)['sort_by'], $evil);
        }
    }

    public function testRepositoriesOnlySortByTheirAllowList(): void
    {
        $em = $this->em();
        $appointments = new AppointmentRepository($em);
        $specialists  = new SpecialistRepository($em);
        $notifications = new NotificationRepository($em);

        $this->assertSame('scheduledAt', $appointments->safeSortField('scheduledAt'));
        $this->assertSame('rating', $specialists->safeSortField('rating'));

        // Mapped but not allow-listed (private columns), unmapped, or crafted.
        $this->assertSame('createdAt', $appointments->safeSortField('notes'));
        $this->assertSame('createdAt', $specialists->safeSortField('phone'));
        $this->assertSame('createdAt', $specialists->safeSortField('dateOfBirth'));
        $this->assertSame('createdAt', $appointments->safeSortField('noSuchField'));
        $this->assertSame('createdAt', $appointments->safeSortField("id,\t(SELECT 1)"));
        $this->assertSame('createdAt', $notifications->safeSortField('readAt'));
    }
}
