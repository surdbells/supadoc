<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Action\Reference\CreateReferenceItemAction;
use App\Action\Reference\DeleteReferenceItemAction;
use App\Action\Reference\ListReferenceItemsAction;
use App\Action\Reference\PublicReferenceListAction;
use App\Action\Reference\ReorderReferenceItemsAction;
use App\Action\Reference\UpdateReferenceItemAction;
use App\Domain\Entity\ReferenceItem;
use App\Domain\Exception\EntityNotFoundException;
use App\Domain\Exception\ValidationException;
use App\Domain\Reference\ReferenceCategory;
use App\Domain\Repository\AuditEventRepository;
use App\Domain\Repository\ReferenceItemRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use App\Infrastructure\Reference\ReferenceSeeder;
use App\Infrastructure\Service\AuditLogger;
use App\Infrastructure\Service\ReferenceDataService;
use DI\ContainerBuilder;
use Doctrine\ORM\EntityManagerInterface;
use PHPUnit\Framework\TestCase;
use Slim\Factory\AppFactory;
use Slim\Routing\RoutingResults;

/**
 * Reference data, offline: label normalisation / keys / codes, the seeding
 * plan, the mapping and DQL, the routes, and the validation that needs no
 * database. (The database-backed behaviour — rename propagation, delete
 * refused while in use, the specialist forms, seeding re-runs — is in
 * tests/Integration/Reference.)
 */
final class ReferenceDataTest extends TestCase
{
    private function em(): EntityManagerInterface
    {
        $_ENV['DB_SERVER_VERSION'] = '16';
        DoctrineEntityManagerFactory::reset();

        return DoctrineEntityManagerFactory::create();
    }

    private function service(): ReferenceDataService
    {
        $em = $this->em();

        return new ReferenceDataService(
            $em,
            new ReferenceItemRepository($em),
            new SpecialistRepository($em),
            new AuditLogger(new AuditEventRepository($em)),
        );
    }

    public function testLabelsCompareRegardlessOfCaseAndSpacing(): void
    {
        $this->assertSame('ENT (Otolaryngology)', ReferenceItem::normaliseLabel("  ENT \t (Otolaryngology)  "));
        $this->assertSame('ent (otolaryngology)', ReferenceItem::keyOf('  ENT   (Otolaryngology) '));
        $this->assertSame(ReferenceItem::keyOf('Cardiology'), ReferenceItem::keyOf(' cardiology'));
        $this->assertSame('ébène', ReferenceItem::keyOf('ÉBÈNE'), 'multibyte lower-casing');

        $item = new ReferenceItem(ReferenceCategory::SPECIALTY, 'cardiology', '  Cardiology  ', 10);
        $this->assertSame('Cardiology', $item->getLabel());
        $this->assertSame('cardiology', $item->getLabelKey());
        $this->assertTrue($item->isActive());
        $item->rename('Cardiovascular  Medicine');
        $this->assertSame('cardiovascular medicine', $item->getLabelKey());
        $this->assertSame('cardiology', $item->getCode(), 'a rename keeps the code');
        $this->assertSame(['id', 'code', 'label', 'sort_order'], array_keys($item->toPublicArray()));
        $this->assertSame(['id', 'code', 'label', 'sort_order', 'category', 'active', 'usage_count', 'created_at', 'updated_at'], array_keys($item->toArray(3)));
        $this->assertSame(3, $item->toArray(3)['usage_count']);
        $this->assertNull($item->toArray()['created_at'], 'not saved yet');
    }

    public function testCodesAreSlugs(): void
    {
        $this->assertSame('nutrition-dietetics', ReferenceItem::slugOf('Nutrition & Dietetics'));
        $this->assertSame('ent-otolaryngology', ReferenceItem::slugOf('ENT (Otolaryngology)'));
        $this->assertSame('item', ReferenceItem::slugOf('—'));
        $this->assertLessThanOrEqual(ReferenceItem::CODE_MAX, strlen(ReferenceItem::slugOf(str_repeat('ab ', 60))));
        $this->assertTrue(ReferenceItem::isValidCode('general-practice'));
        $this->assertFalse(ReferenceItem::isValidCode('General Practice'));
        $this->assertFalse(ReferenceItem::isValidCode('a--b'));
        $this->assertFalse(ReferenceItem::isValidCode('-a'));
        $this->assertFalse(ReferenceItem::isValidCode(str_repeat('a', ReferenceItem::CODE_MAX + 1)));
    }

    public function testCategoriesAndTheStandardSpecialties(): void
    {
        $this->assertTrue(ReferenceCategory::exists('specialty'));
        $this->assertFalse(ReferenceCategory::exists('Specialty'));
        $this->assertFalse(ReferenceCategory::exists('language'), 'not a list (yet)');
        $this->assertSame(['specialty'], ReferenceCategory::all());
        $this->assertSame('1 doctor', ReferenceCategory::usedBy('specialty', 1));
        $this->assertSame('3 doctors', ReferenceCategory::usedBy('specialty', 3));

        $standard = ReferenceCategory::STANDARD_SPECIALTIES;
        $this->assertCount(24, $standard);
        $this->assertCount(24, array_unique(array_map(ReferenceItem::keyOf(...), $standard)));
        $this->assertCount(24, array_unique(array_map(ReferenceItem::slugOf(...), $standard)));
        foreach ($standard as $label) {
            $this->assertSame($label, ReferenceItem::normaliseLabel($label));
        }
    }

    public function testSeedPlanAddsMissingLabelsOnceInTheDoctorsSpelling(): void
    {
        $plan = ReferenceSeeder::plan(
            ['General Practice'],
            ['Cardiology' => 1, 'cardiology' => 1, 'ENT (otolaryngology)' => 3, ' ' => 2, 'Zoology' => 1, '  sleep   medicine ' => 2, '123' => 1],
            ['General practice', 'Cardiology', 'ENT (Otolaryngology)'],
        );

        $this->assertSame(
            ['Cardiology', 'ENT (otolaryngology)', '123', 'sleep medicine', 'Zoology'],
            $plan,
            'standard first (existing ones skipped, the doctors\' majority spelling, a tie to the one sorting first), then the rest alphabetically; blanks skipped',
        );
        $this->assertSame(['Zoology'], ReferenceSeeder::plan(['cardiology', 'ent (otolaryngology)'], ['Zoology' => 1, 'CARDIOLOGY' => 4], []), 'once seeded, only doctors\' missing ones');
        $this->assertSame([], ReferenceSeeder::plan(['A', 'b'], ['a' => 1, 'B ' => 1], ['a', 'B']));
        $this->assertSame(['Most'], ReferenceSeeder::plan([], ['most' => 1, 'Most' => 2], []));
    }

    public function testMappingAndQueriesCompileOffline(): void
    {
        $em   = $this->em();
        $meta = $em->getClassMetadata(ReferenceItem::class);
        $this->assertSame('reference_items', $meta->getTableName());
        $this->assertSame(['category', 'code'], $meta->table['uniqueConstraints']['uniq_reference_items_code']['columns']);
        $this->assertSame(['category', 'label_key'], $meta->table['uniqueConstraints']['uniq_reference_items_label']['columns']);
        $this->assertSame('label_key', $meta->getColumnName('labelKey'));
        $this->assertSame('sort_order', $meta->getColumnName('sortOrder'));

        $list = (new ReferenceItemRepository($em))->listQuery('specialty', true)->getSQL();
        $this->assertStringContainsStringIgnoringCase('reference_items', $list);
        $this->assertStringContainsStringIgnoringCase('ORDER BY', $list);
        $this->assertStringContainsStringIgnoringCase('sort_order', $list);

        $usage = (new SpecialistRepository($em))->specialtyUsageQuery()->getSQL();
        $this->assertStringContainsStringIgnoringCase('GROUP BY', $usage);
        $this->assertStringContainsStringIgnoringCase('deleted_at IS NULL', $usage);
    }

    public function testValidationThatNeedsNoDatabase(): void
    {
        $service = $this->service();

        try {
            $service->publicItems('language');
            $this->fail('an unknown list is a 404');
        } catch (EntityNotFoundException) {
            $this->addToAssertionCount(1);
        }

        foreach ([[], ['label' => '   '], ['label' => ['x']]] as $body) {
            try {
                $service->create('specialty', $body, null, 'Admin');
                $this->fail('a blank label is refused');
            } catch (ValidationException $e) {
                $this->assertSame('Enter a name', $e->getErrors()['label']);
            }
        }

        foreach (['nope', null, [], [1, 2], ['a', 'a']] as $ids) {
            try {
                $service->reorder('specialty', $ids, null, 'Admin');
                $this->fail('a bad id list is refused');
            } catch (ValidationException $e) {
                $this->assertArrayHasKey('ids', $e->getErrors());
            }
        }

        $this->assertNull($service->resolveChoice('specialty', '   '), 'blank is never a choice');
    }

    public function testRoutesResolveToTheReferenceActions(): void
    {
        $_ENV['DB_SERVER_VERSION'] = '16';
        DoctrineEntityManagerFactory::reset();
        $builder = new ContainerBuilder();
        $builder->addDefinitions(__DIR__ . '/../../config/container.php');
        $container = $builder->build();
        AppFactory::setContainer($container);
        $app = AppFactory::create();
        (require __DIR__ . '/../../config/routes.php')($app);
        $resolver = $app->getRouteResolver();

        foreach ([
            ['GET', '/api/public/reference/specialty', PublicReferenceListAction::class],
            ['GET', '/api/reference/specialty', ListReferenceItemsAction::class],
            ['POST', '/api/reference/specialty', CreateReferenceItemAction::class],
            ['POST', '/api/reference/specialty/reorder', ReorderReferenceItemsAction::class],
            ['PATCH', '/api/reference/specialty/0b0c6f0e-0000-4000-8000-000000000001', UpdateReferenceItemAction::class],
            ['DELETE', '/api/reference/specialty/0b0c6f0e-0000-4000-8000-000000000001', DeleteReferenceItemAction::class],
        ] as [$method, $path, $action]) {
            $result = $resolver->computeRoutingResults($path, $method);
            $this->assertSame(RoutingResults::FOUND, $result->getRouteStatus(), "$method $path");
            $this->assertSame($action, $resolver->resolveRoute((string) $result->getRouteIdentifier())->getCallable(), "$method $path");
            $this->assertIsObject($container->get($action));
        }
    }
}
