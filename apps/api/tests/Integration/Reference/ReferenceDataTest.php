<?php

declare(strict_types=1);

namespace App\Tests\Integration\Reference;

use App\Action\Doctor\UpdateDoctorProfileAction;
use App\Action\Reference\CreateReferenceItemAction;
use App\Action\Reference\DeleteReferenceItemAction;
use App\Action\Specialist\CreateSpecialistAction;
use App\Action\Specialist\UpdateSpecialistAction;
use App\Domain\Entity\Specialist;
use App\Domain\Entity\User;
use App\Domain\Enum\SpecialistStatus;
use App\Domain\Exception\EntityNotFoundException;
use App\Domain\Exception\ValidationException;
use App\Domain\Reference\ReferenceCategory;
use App\Infrastructure\Reference\ReferenceSeeder;
use App\Infrastructure\Service\ReferenceDataService;
use App\Tests\Integration\Reference\Support\ReferenceHarness;
use DI\Container;
use Doctrine\DBAL\Connection;
use Doctrine\ORM\EntityManagerInterface;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * Reference data against Postgres: the specialty pick list's CRUD and audit,
 * usage counts, a rename re-labelling every doctor (and waiting change
 * request) in one transaction, delete refused while in use, the specialist
 * forms accepting only an active specialty, and prod-migrate's seeding run
 * again and again. One throw-away schema for the class, emptied per test;
 * skipped (not failed) when the local database is unreachable.
 */
final class ReferenceDataTest extends TestCase
{
    private const CATEGORY = ReferenceCategory::SPECIALTY;

    private static ?string $schema = null;

    private static ?string $skipReason = null;

    /** @var list<Container> */
    private array $opened = [];

    private string $adminId = '';

    public static function setUpBeforeClass(): void
    {
        self::$skipReason = ReferenceHarness::unavailableReason();
        self::$schema     = self::$skipReason === null ? ReferenceHarness::createSchema() : null;
    }

    public static function tearDownAfterClass(): void
    {
        if (self::$schema !== null) {
            ReferenceHarness::dropSchema(self::$schema);
            self::$schema = null;
        }
    }

    protected function setUp(): void
    {
        if (self::$skipReason !== null) {
            $this->markTestSkipped(self::$skipReason);
        }
        $this->conn()->executeStatement('TRUNCATE reference_items, audit_events, app_settings, staff_notifications, users, specialists CASCADE');

        $em    = $this->em();
        $admin = new User('ref-admin-' . bin2hex(random_bytes(3)) . '@example.test', 'Ada', 'Admin');
        $admin->setRoles(['admin']);
        $em->persist($admin);
        $em->flush();
        $this->adminId = $admin->getId();
    }

    protected function tearDown(): void
    {
        foreach ($this->opened as $container) {
            $container->get(EntityManagerInterface::class)->getConnection()->close();
        }
        $this->opened = [];
    }

    // ----- The list: add, order, duplicates, audit -----

    public function testItemsAreAddedInOrderWithSlugCodesAndNoCaseDuplicates(): void
    {
        $ref = $this->service();
        $a   = $ref->create(self::CATEGORY, ['label' => 'Cardiology'], $this->adminId, 'Ada Admin');
        $b   = $ref->create(self::CATEGORY, ['label' => '  Nutrition   &  Dietetics '], $this->adminId, 'Ada Admin');
        $c   = $ref->create(self::CATEGORY, ['label' => 'Allergy', 'sort_order' => 0, 'code' => 'allergy-immunology'], $this->adminId, 'Ada Admin');

        $this->assertSame('cardiology', $a['code']);
        $this->assertSame(10, $a['sort_order'], 'the first item of a list');
        $this->assertSame('Nutrition & Dietetics', $b['label'], 'spacing tidied, spelling kept');
        $this->assertSame('nutrition-dietetics', $b['code']);
        $this->assertSame(10, $b['sort_order'] - $a['sort_order'], 'a new item goes after the last');
        $this->assertSame(
            ['Allergy', 'Cardiology', 'Nutrition & Dietetics'],
            array_column($this->service()->publicItems(self::CATEGORY), 'label'),
        );
        $this->assertSame(['id', 'code', 'label', 'sort_order'], array_keys($this->service()->publicItems(self::CATEGORY)[0]));

        $this->assertValidation(fn () => $this->service()->create(self::CATEGORY, ['label' => ' CARDIOLOGY '], null, 'X'), 'label', 'That specialty is already in the list');
        $this->assertValidation(fn () => $this->service()->create(self::CATEGORY, ['label' => '   '], null, 'X'), 'label', 'Enter a name');
        $this->assertValidation(fn () => $this->service()->create(self::CATEGORY, ['label' => str_repeat('x', 121)], null, 'X'), 'label');
        $this->assertValidation(fn () => $this->service()->create(self::CATEGORY, ['label' => 'Urology', 'code' => 'Not A Slug'], null, 'X'), 'code');
        $this->assertValidation(fn () => $this->service()->create(self::CATEGORY, ['label' => 'Urology', 'code' => 'cardiology'], null, 'X'), 'code');
        $this->assertValidation(fn () => $this->service()->create(self::CATEGORY, ['label' => 'Urology', 'sort_order' => -1], null, 'X'), 'sort_order');
        $this->assertValidation(fn () => $this->service()->create(self::CATEGORY, ['label' => 'Urology', 'active' => 'maybe'], null, 'X'), 'active');

        // A switched-off duplicate says so.
        $this->service()->update(self::CATEGORY, $c['id'], ['active' => false], null, 'X');
        $this->assertValidation(fn () => $this->service()->create(self::CATEGORY, ['label' => 'allergy'], null, 'X'), 'label', 'That specialty is already in the list but switched off — turn it back on instead');

        // Same slug from a different label gets a suffix.
        $d = $this->service()->create(self::CATEGORY, ['label' => 'Cardiology!'], null, 'X');
        $this->assertSame('cardiology-2', $d['code']);

        $this->assertSame(4, $this->auditCount('reference.created'));
        $this->assertSame($this->adminId, $this->conn()->fetchOne("SELECT actor_id FROM audit_events WHERE action = 'reference.created' AND resource_id = ?", [$a['id']]));
        $this->assertNotFound(fn () => $this->service()->publicItems('nope'));
        $this->assertNotFound(fn () => $this->service()->update(self::CATEGORY, '00000000-0000-4000-8000-000000000000', ['label' => 'X'], null, 'X'));
    }

    public function testTheCreateEndpointAnswers201WithTheStaffShape(): void
    {
        $action   = $this->container()->get(CreateReferenceItemAction::class);
        $response = $action($this->request(['label' => 'Oncology']), new Response(), ['category' => self::CATEGORY]);
        $body     = $this->body($response);

        $this->assertSame(201, $response->getStatusCode());
        $this->assertSame('Oncology', $body['data']['label']);
        $this->assertTrue($body['data']['active']);
        $this->assertSame(0, $body['data']['usage_count']);
        $this->assertSame(self::CATEGORY, $body['data']['category']);
    }

    // ----- Usage counts, deactivation, delete -----

    public function testUsageCountsGroupSpellingsAndDeleteIsRefusedWhileInUse(): void
    {
        $cardio = $this->service()->create(self::CATEGORY, ['label' => 'Cardiology'], null, 'X');
        $derm   = $this->service()->create(self::CATEGORY, ['label' => 'Dermatology'], null, 'X');
        $this->service()->create(self::CATEGORY, ['label' => 'Neurology'], null, 'X'); // keeps one switched on
        $this->specialist('Dr A', 'Cardiology');
        $this->specialist('Dr B', ' cardiology ');
        $this->specialist('Dr Gone', 'Cardiology', deleted: true);

        $byLabel = array_column($this->service()->staffItems(self::CATEGORY), 'usage_count', 'label');
        $this->assertSame(['Cardiology' => 2, 'Dermatology' => 0, 'Neurology' => 0], $byLabel);

        $this->assertValidation(
            fn () => $this->service()->delete(self::CATEGORY, $cardio['id'], null, 'X'),
            'item',
            'In use by 2 doctors — deactivate it instead',
        );
        $response = $this->container()->get(DeleteReferenceItemAction::class);
        try {
            $response($this->request([]), new Response(), ['category' => self::CATEGORY, 'id' => $cardio['id']]);
            $this->fail('an item in use is not deleted');
        } catch (ValidationException $e) {
            $this->assertSame('In use by 2 doctors — deactivate it instead', $e->getMessage());
        }

        // Switched off: gone from the pick list, kept (and counted) for the doctors who have it.
        $off = $this->service()->update(self::CATEGORY, $cardio['id'], ['active' => false], $this->adminId, 'Ada Admin');
        $this->assertFalse($off['active']);
        $this->assertSame(2, $off['usage_count']);
        $this->assertSame(['Dermatology', 'Neurology'], array_column($this->service()->publicItems(self::CATEGORY), 'label'));
        $this->assertSame(2, (int) $this->conn()->fetchOne("SELECT COUNT(*) FROM specialists WHERE TRIM(LOWER(specialty)) = 'cardiology' AND deleted_at IS NULL"));

        // Unused: deleted, and audited.
        $this->service()->delete(self::CATEGORY, $derm['id'], $this->adminId, 'Ada Admin');
        $this->assertSame(['Cardiology', 'Neurology'], array_column($this->service()->staffItems(self::CATEGORY), 'label'));
        $this->assertSame(1, $this->auditCount('reference.deleted'));
        $this->assertNotFound(fn () => $this->service()->delete(self::CATEGORY, $derm['id'], null, 'X'));
    }

    public function testDeleteIsRefusedWhileAWaitingChangeRequestAsksForTheItem(): void
    {
        $neuro = $this->service()->create(self::CATEGORY, ['label' => 'Neurology'], null, 'X');
        $this->service()->create(self::CATEGORY, ['label' => 'Dermatology'], null, 'X');
        $this->specialist('Dr Asking', 'Dermatology', SpecialistStatus::APPROVED, pending: ' NEUROLOGY ');
        $this->specialist('Dr Gone', 'Dermatology', SpecialistStatus::APPROVED, deleted: true, pending: 'Neurology');

        // Nobody has it yet (usage 0), but a live doctor asked for it.
        $this->assertSame(0, array_column($this->service()->staffItems(self::CATEGORY), 'usage_count', 'label')['Neurology']);
        $this->assertSame(['neurology' => 1], $this->service()->requestedByKey(self::CATEGORY));
        $this->assertValidation(
            fn () => $this->service()->delete(self::CATEGORY, $neuro['id'], null, 'X'),
            'item',
            'Requested by 1 doctor — deactivate it instead',
        );
        $this->assertSame(0, $this->auditCount('reference.deleted'));

        // Once the request is gone (withdrawn / decided), it can be deleted.
        $this->conn()->executeStatement('UPDATE specialists SET pending_changes = NULL');
        $this->service()->delete(self::CATEGORY, $neuro['id'], $this->adminId, 'Ada Admin');
        $this->assertSame(1, $this->auditCount('reference.deleted'));
    }

    // ----- Rename propagation -----

    public function testRenameRelabelsEveryDoctorAndWaitingRequestInOneTransaction(): void
    {
        $cardio = $this->service()->create(self::CATEGORY, ['label' => 'Cardiology'], null, 'X');
        $this->service()->create(self::CATEGORY, ['label' => 'Dermatology'], null, 'X');
        $a       = $this->specialist('Dr A', 'Cardiology');
        $b       = $this->specialist('Dr B', ' cardiology');
        $other   = $this->specialist('Dr C', 'Dermatology');
        $waiting = $this->specialist('Dr D', 'Dermatology', SpecialistStatus::APPROVED, pending: 'CARDIOLOGY');
        $before  = (string) $this->conn()->fetchOne('SELECT updated_at FROM specialists WHERE id = ?', [$a]);
        sleep(1);

        // Renaming onto another item's label (any case) is refused and changes nothing.
        $this->assertValidation(fn () => $this->service()->update(self::CATEGORY, $cardio['id'], ['label' => 'dermatology'], null, 'X'), 'label', 'That specialty is already in the list');
        $this->assertSame('Cardiology', $this->specialtyOf($a));

        $result = $this->service()->update(self::CATEGORY, $cardio['id'], ['label' => 'Cardiovascular  Medicine'], $this->adminId, 'Ada Admin');

        $this->assertSame('Cardiovascular Medicine', $result['label']);
        $this->assertSame('cardiology', $result['code'], 'the code survives a rename');
        $this->assertSame(2, $result['specialists_updated']);
        $this->assertSame(2, $result['usage_count']);
        $this->assertSame('Cardiovascular Medicine', $this->specialtyOf($a));
        $this->assertSame('Cardiovascular Medicine', $this->specialtyOf($b));
        $this->assertSame('Dermatology', $this->specialtyOf($other));
        $this->assertSame('Dermatology', $this->specialtyOf($waiting), 'the live specialty of a doctor with a waiting request is theirs until approved');
        $pending = json_decode((string) $this->conn()->fetchOne('SELECT pending_changes FROM specialists WHERE id = ?', [$waiting]), true);
        $this->assertSame('Cardiovascular Medicine', $pending['fields']['specialty']);
        $this->assertNotSame($before, (string) $this->conn()->fetchOne('SELECT updated_at FROM specialists WHERE id = ?', [$a]));

        // Audited: the item (before/after) and each doctor on their own history.
        $item = json_decode((string) $this->conn()->fetchOne("SELECT metadata FROM audit_events WHERE action = 'reference.updated'"), true);
        $this->assertSame(['label' => 'Cardiology'], $item['before']);
        $this->assertSame(['label' => 'Cardiovascular Medicine'], $item['after']);
        $this->assertSame(2, $item['specialists_updated']);
        $this->assertSame(1, $item['requests_updated']);
        $doctorEvents = $this->conn()->fetchAllAssociative("SELECT resource_id, metadata, actor_id FROM audit_events WHERE action = 'specialist.updated' AND resource_type = 'specialist' ORDER BY resource_id");
        $this->assertCount(3, $doctorEvents);
        $byDoctor = [];
        foreach ($doctorEvents as $event) {
            $byDoctor[trim((string) $event['resource_id'])] = json_decode((string) $event['metadata'], true);
            $this->assertSame($this->adminId, trim((string) $event['actor_id']));
        }
        $this->assertSame(['specialty' => ' cardiology'], $byDoctor[$b]['before']);
        $this->assertSame(['specialty' => 'Cardiovascular Medicine'], $byDoctor[$b]['after']);
        $this->assertSame(['requested_specialty' => 'CARDIOLOGY'], $byDoctor[$waiting]['before']);

        // A case-only rename tidies stored spellings and keeps the count.
        $this->specialist('Dr E', 'cardiovascular medicine');
        $tidy = $this->service()->update(self::CATEGORY, $cardio['id'], ['label' => 'Cardiovascular medicine'], null, 'X');
        $this->assertSame(3, $tidy['specialists_updated']);
        $this->assertSame(3, $tidy['usage_count']);
    }

    public function testAFailedRenameRollsBackTheDoctorsToo(): void
    {
        $cardio = $this->service()->create(self::CATEGORY, ['label' => 'Cardiology'], null, 'X');
        $a      = $this->specialist('Dr A', 'Cardiology');

        // Make the audit insert fail inside the rename's transaction.
        $this->conn()->executeStatement('ALTER TABLE audit_events ADD CONSTRAINT reference_it_no_audit CHECK (action <> \'specialist.updated\')');
        $failed = null;
        try {
            $this->service()->update(self::CATEGORY, $cardio['id'], ['label' => 'Heart'], null, 'X');
        } catch (\Doctrine\DBAL\Exception $e) {
            $failed = $e;
        } finally {
            $this->conn()->executeStatement('ALTER TABLE audit_events DROP CONSTRAINT reference_it_no_audit');
        }

        $this->assertNotNull($failed, 'the rename failed on its audit');
        $this->assertStringContainsString('reference_it_no_audit', $failed->getMessage());
        $this->assertSame('Cardiology', $this->specialtyOf($a));
        $this->assertSame('Cardiology', $this->conn()->fetchOne('SELECT label FROM reference_items WHERE id = ?', [$cardio['id']]));
    }

    // ----- Reorder -----

    public function testReorderPutsTheListInTheOrderAskedAndAuditsIt(): void
    {
        $a = $this->service()->create(self::CATEGORY, ['label' => 'A'], null, 'X');
        $b = $this->service()->create(self::CATEGORY, ['label' => 'B'], null, 'X');
        $c = $this->service()->create(self::CATEGORY, ['label' => 'C'], null, 'X');

        $list = $this->service()->reorder(self::CATEGORY, [$c['id'], $a['id']], $this->adminId, 'Ada Admin');
        $this->assertSame(['C', 'A', 'B'], array_column($list, 'label'));
        $this->assertSame([10, 20, 30], array_column($list, 'sort_order'));
        $audit = json_decode((string) $this->conn()->fetchOne("SELECT metadata FROM audit_events WHERE action = 'reference.reordered'"), true);
        $this->assertSame(['A', 'B', 'C'], $audit['before']);
        $this->assertSame(['C', 'A', 'B'], $audit['after']);

        $this->assertValidation(fn () => $this->service()->reorder(self::CATEGORY, [$a['id'], $a['id']], null, 'X'), 'ids');
        $this->assertValidation(fn () => $this->service()->reorder(self::CATEGORY, [$a['id'], 'not-in-this-list'], null, 'X'), 'ids');
        $this->assertValidation(fn () => $this->service()->reorder(self::CATEGORY, 'nope', null, 'X'), 'ids');
        $this->assertValidation(fn () => $this->service()->reorder(self::CATEGORY, [], null, 'X'), 'ids');
    }

    // ----- The forms that store a specialty -----

    public function testNewSpecialistNeedsAnActiveSpecialtyAndGetsTheListsSpelling(): void
    {
        $this->service()->create(self::CATEGORY, ['label' => 'Cardiology'], null, 'X');
        $derm = $this->service()->create(self::CATEGORY, ['label' => 'Dermatology'], null, 'X');
        $this->service()->update(self::CATEGORY, $derm['id'], ['active' => false], null, 'X');

        $refused = $this->createSpecialist(['name' => 'Dr New', 'specialty' => 'Neurology']);
        $this->assertSame(422, $refused->getStatusCode());
        $this->assertSame('Choose a specialty from the list', $this->body($refused)['errors']['specialty']);

        $off = $this->createSpecialist(['name' => 'Dr New', 'specialty' => 'Dermatology']);
        $this->assertSame(422, $off->getStatusCode(), 'a switched-off specialty is not offered');

        $blank = $this->createSpecialist(['name' => 'Dr New', 'specialty' => ' ']);
        $this->assertSame('Speciality is required', $this->body($blank)['errors']['specialty']);

        $ok = $this->createSpecialist(['name' => 'Dr New', 'specialty' => ' CARDIOLOGY ']);
        $this->assertSame(201, $ok->getStatusCode());
        $this->assertSame('Cardiology', $this->body($ok)['data']['specialty']);
    }

    public function testBackOfficeEditsSpecialtyOnlyWhileOnboarding(): void
    {
        $this->service()->create(self::CATEGORY, ['label' => 'Cardiology'], null, 'X');
        $derm = $this->service()->create(self::CATEGORY, ['label' => 'Dermatology'], null, 'X');
        $this->service()->update(self::CATEGORY, $derm['id'], ['active' => false], null, 'X');
        $onboarding = $this->specialist('Dr Onboarding', 'Dermatology', SpecialistStatus::INVITED);
        $approved   = $this->specialist('Dr Approved', 'Dermatology', SpecialistStatus::APPROVED);

        $this->assertSame('Choose a specialty from the list', $this->body($this->updateSpecialist($onboarding, ['specialty' => 'Neurology']))['errors']['specialty']);

        $saved = $this->updateSpecialist($onboarding, ['specialty' => 'cardiology']);
        $this->assertSame(200, $saved->getStatusCode());
        $this->assertSame('Cardiology', $this->specialtyOf($onboarding));
        $audit = json_decode((string) $this->conn()->fetchOne("SELECT metadata FROM audit_events WHERE action = 'specialist.updated' AND resource_id = ?", [$onboarding]), true);
        $this->assertSame(['specialty' => 'Dermatology'], $audit['before']);
        $this->assertSame(['specialty' => 'Cardiology'], $audit['after']);

        // Approved: re-sending the current (switched-off) specialty is fine, a new one is refused.
        $same = $this->updateSpecialist($approved, ['specialty' => 'dermatology', 'bio' => 'Skin doctor']);
        $this->assertSame(200, $same->getStatusCode());
        $this->assertSame('Dermatology', $this->specialtyOf($approved));
        $locked = $this->updateSpecialist($approved, ['specialty' => 'Cardiology']);
        $this->assertSame(422, $locked->getStatusCode());
        $this->assertStringContainsString('change request', $this->body($locked)['errors']['specialty']);
    }

    public function testDoctorsOwnProfileTakesAnActiveSpecialtyOrKeepsTheirOwn(): void
    {
        $this->service()->create(self::CATEGORY, ['label' => 'Cardiology'], null, 'X');
        $derm = $this->service()->create(self::CATEGORY, ['label' => 'Dermatology'], null, 'X');
        $this->service()->update(self::CATEGORY, $derm['id'], ['active' => false], null, 'X');

        // Onboarding: applied at once, in the list's spelling.
        $onboarding = $this->specialist('Dr Onboarding', 'Dermatology', SpecialistStatus::INVITED);
        $login      = $this->doctorLogin($onboarding);
        $this->assertSame('Choose a specialty from the list', $this->body($this->updateProfile($login, ['specialty' => 'Neurology']))['errors']['specialty']);
        $this->assertSame(200, $this->updateProfile($login, ['specialty' => 'dermatology', 'bio' => 'Kept'])->getStatusCode(), 'their own (switched-off) specialty is kept');
        $this->assertSame('Dermatology', $this->specialtyOf($onboarding));
        $this->assertSame(200, $this->updateProfile($login, ['specialty' => 'cardiology'])->getStatusCode());
        $this->assertSame('Cardiology', $this->specialtyOf($onboarding));

        // Approved: an active specialty is staged for review; their own stays as it is.
        $approved = $this->specialist('Dr Approved', 'Dermatology', SpecialistStatus::APPROVED);
        $doctor   = $this->doctorLogin($approved);
        $kept     = $this->updateProfile($doctor, ['specialty' => 'Dermatology', 'bio' => 'Same']);
        $this->assertSame(200, $kept->getStatusCode());
        $this->assertNull($this->conn()->fetchOne('SELECT pending_changes FROM specialists WHERE id = ?', [$approved]), 'no change request for an unchanged specialty');
        $this->assertSame(422, $this->updateProfile($doctor, ['specialty' => 'Neurology'])->getStatusCode());

        $staged = $this->updateProfile($doctor, ['specialty' => 'CARDIOLOGY']);
        $this->assertSame(200, $staged->getStatusCode());
        $this->assertSame('Dermatology', $this->specialtyOf($approved));
        $pending = json_decode((string) $this->conn()->fetchOne('SELECT pending_changes FROM specialists WHERE id = ?', [$approved]), true);
        $this->assertSame('Cardiology', $pending['fields']['specialty']);
    }

    public function testTheLastActiveItemCanBeNeitherSwitchedOffNorDeleted(): void
    {
        $last = 'Keep at least one specialty switched on — the forms need something to offer';
        // A list can't start with only a switched-off item either.
        $this->assertValidation(
            fn () => $this->service()->create(self::CATEGORY, ['label' => 'Sleep Medicine', 'active' => false], null, 'X'),
            'active',
            $last,
        );
        $cardio = $this->service()->create(self::CATEGORY, ['label' => 'Cardiology'], null, 'X');
        $derm   = $this->service()->create(self::CATEGORY, ['label' => 'Dermatology'], null, 'X');
        $this->assertFalse($this->service()->create(self::CATEGORY, ['label' => 'Sleep Medicine', 'active' => false], null, 'X')['active']);

        $this->service()->update(self::CATEGORY, $cardio['id'], ['active' => false], $this->adminId, 'Ada Admin');
        $this->assertValidation(
            fn () => $this->service()->update(self::CATEGORY, $derm['id'], ['active' => false], $this->adminId, 'Ada Admin'),
            'active',
            $last,
        );
        $this->assertValidation(
            fn () => $this->service()->delete(self::CATEGORY, $derm['id'], $this->adminId, 'Ada Admin'),
            'item',
            $last,
        );
        // A rename or reorder of the last active item is still fine, and an
        // inactive item may go while another stays on.
        $renamed = $this->service()->update(self::CATEGORY, $derm['id'], ['label' => 'Dermatology & Venereology'], $this->adminId, 'Ada Admin');
        $this->assertTrue($renamed['active']);
        $this->service()->delete(self::CATEGORY, $cardio['id'], $this->adminId, 'Ada Admin');
        $this->assertSame(['Dermatology & Venereology'], array_column($this->service()->publicItems(self::CATEGORY), 'label'));
        $this->assertSame(['Dermatology & Venereology', 'Sleep Medicine'], array_column($this->service()->staffItems(self::CATEGORY), 'label'));
    }

    public function testFreeTextIsTakenUntilTheListIsSeeded(): void
    {
        $this->assertSame('Sleep Medicine', $this->service()->resolveChoice(self::CATEGORY, ' Sleep  Medicine '));
        $this->assertNull($this->service()->resolveChoice(self::CATEGORY, '  '));
        $ok = $this->createSpecialist(['name' => 'Dr Early', 'specialty' => 'Sleep Medicine']);
        $this->assertSame(201, $ok->getStatusCode());

        $this->service()->create(self::CATEGORY, ['label' => 'Cardiology'], null, 'X');
        $this->assertNull($this->service()->resolveChoice(self::CATEGORY, 'Sleep Medicine'), 'once the list has items, only they are taken');
    }

    // ----- Seeding (bin/prod-migrate.php step 11) -----

    public function testSeedingAddsDoctorsSpecialtiesAndTheStandardListOnceWithoutDuplicates(): void
    {
        $this->specialist('Dr A', 'cardiology');
        $this->specialist('Dr B', 'cardiology');
        $this->specialist('Dr C', 'Cardiology');
        $this->specialist('Dr D', ' Sleep  Medicine ');
        $this->specialist('Dr E', 'DERMATOLOGY');
        $this->specialist('Dr Gone', 'Old Thing', deleted: true);
        // The back office already has dermatology (switched off) — it is never duplicated.
        $this->conn()->insert('reference_items', [
            'id' => '11111111-1111-4111-8111-111111111111', 'category' => self::CATEGORY, 'code' => 'dermatology', 'label' => 'dermatology',
            'label_key' => 'dermatology', 'sort_order' => 50, 'active' => false, 'created_at' => '2026-10-01 00:00:00', 'updated_at' => '2026-10-01 00:00:00',
        ], ['active' => \Doctrine\DBAL\ParameterType::BOOLEAN]);
        $specialtiesBefore = $this->conn()->fetchFirstColumn('SELECT specialty FROM specialists ORDER BY name');

        $first = $this->seed();
        $this->assertSame('seeded', $first['standard']);
        $expected = array_values(array_filter(
            array_map(static fn (string $l): string => $l === 'Cardiology' ? 'cardiology' : $l, ReferenceCategory::STANDARD_SPECIALTIES),
            static fn (string $l): bool => $l !== 'Dermatology',
        ));
        $expected[] = 'Sleep Medicine';
        $this->assertSame($expected, $first['added'], 'standard list in order (doctors\' majority spelling), then the doctors\' others');
        $this->assertNotContains('Old Thing', $first['added'], 'a deleted doctor\'s specialty is not offered');

        $rows = $this->conn()->fetchAllAssociative("SELECT label, label_key, code, sort_order, active FROM reference_items WHERE category = 'specialty' ORDER BY sort_order");
        $this->assertSame(count($rows), count(array_unique(array_column($rows, 'label_key'))), 'no label twice in any case');
        $this->assertSame(count($rows), count(array_unique(array_column($rows, 'code'))));
        $this->assertSame('dermatology', $rows[0]['label'], 'the existing item keeps its place');
        $this->assertSame(60, (int) $rows[1]['sort_order'], 'new items go after the existing ones');
        $this->assertSame('ent-otolaryngology', $this->conn()->fetchOne("SELECT code FROM reference_items WHERE label = 'ENT (Otolaryngology)'"));
        $this->assertSame($specialtiesBefore, $this->conn()->fetchFirstColumn('SELECT specialty FROM specialists ORDER BY name'), 'no doctor is changed');

        // Again: nothing to add.
        $count  = (int) $this->conn()->fetchOne('SELECT COUNT(*) FROM reference_items');
        $second = $this->seed();
        $this->assertSame(['added' => [], 'standard' => 'already seeded'], $second);
        $this->assertSame($count, (int) $this->conn()->fetchOne('SELECT COUNT(*) FROM reference_items'));

        // A standard specialty the back office deleted stays deleted; a doctor's new one is added.
        $psych = (string) $this->conn()->fetchOne("SELECT id FROM reference_items WHERE label = 'Psychology'");
        $this->service()->delete(self::CATEGORY, trim($psych), null, 'X');
        $this->specialist('Dr F', 'Tropical Medicine');
        $third = $this->seed();
        $this->assertSame(['Tropical Medicine'], $third['added']);
        $this->assertFalse($this->conn()->fetchOne("SELECT 1 FROM reference_items WHERE label = 'Psychology'"));
    }

    // ----- Helpers -----

    private function container(): Container
    {
        $container      = ReferenceHarness::container((string) self::$schema);
        $this->opened[] = $container;

        return $container;
    }

    private function em(): EntityManagerInterface
    {
        return $this->container()->get(EntityManagerInterface::class);
    }

    private function conn(): Connection
    {
        return $this->em()->getConnection();
    }

    private function service(): ReferenceDataService
    {
        return $this->container()->get(ReferenceDataService::class);
    }

    /** @return array{added: list<string>, standard: string} */
    private function seed(): array
    {
        $conn = $this->conn();

        return $conn->transactional(static fn (Connection $c): array => ReferenceSeeder::seedSpecialties($c));
    }

    /** A saved specialist; returns their id. */
    private function specialist(
        string $name,
        string $specialty,
        ?SpecialistStatus $status = null,
        bool $deleted = false,
        ?string $pending = null,
    ): string {
        $em = $this->em();
        $s  = new Specialist($name, 'placeholder');
        // The raw stored value (the setter would trim it), as legacy rows have it.
        (new \ReflectionProperty(Specialist::class, 'specialty'))->setValue($s, $specialty);
        if ($status !== null) {
            $s->setStatus($status);
        }
        if ($pending !== null) {
            $s->stageChanges(['specialty' => $pending]);
        }
        if ($deleted) {
            $s->softDelete();
        }
        $em->persist($s);
        $em->flush();

        return $s->getId();
    }

    private function doctorLogin(string $specialistId): string
    {
        $em   = $this->em();
        $user = new User('doc-' . bin2hex(random_bytes(4)) . '@example.test', 'Doc', 'Tor');
        $user->setRoles(['doctor']);
        $user->setSpecialistId($specialistId);
        $em->persist($user);
        $em->flush();

        return $user->getId();
    }

    private function specialtyOf(string $id): string
    {
        return (string) $this->conn()->fetchOne('SELECT specialty FROM specialists WHERE id = ?', [$id]);
    }

    private function auditCount(string $action): int
    {
        return (int) $this->conn()->fetchOne('SELECT COUNT(*) FROM audit_events WHERE action = ?', [$action]);
    }

    /** @param array<string,mixed> $body */
    private function request(array $body, ?string $userId = null): ServerRequestInterface
    {
        return (new ServerRequestFactory())->createServerRequest('POST', '/api/test')
            ->withParsedBody($body)
            ->withAttribute('user_id', $userId ?? $this->adminId)
            ->withAttribute('user_roles', ['admin']);
    }

    /** @param array<string,mixed> $body */
    private function createSpecialist(array $body): ResponseInterface
    {
        return $this->container()->get(CreateSpecialistAction::class)($this->request($body), new Response());
    }

    /** @param array<string,mixed> $body */
    private function updateSpecialist(string $id, array $body): ResponseInterface
    {
        return $this->container()->get(UpdateSpecialistAction::class)($this->request($body), new Response(), ['id' => $id]);
    }

    /** @param array<string,mixed> $body */
    private function updateProfile(string $doctorUserId, array $body): ResponseInterface
    {
        return $this->container()->get(UpdateDoctorProfileAction::class)($this->request($body, $doctorUserId), new Response());
    }

    /** @return array<string,mixed> */
    private function body(ResponseInterface $response): array
    {
        return (array) json_decode((string) $response->getBody(), true);
    }

    private function assertValidation(callable $fn, string $field, ?string $message = null): void
    {
        try {
            $fn();
            $this->fail("expected a 422 on {$field}");
        } catch (ValidationException $e) {
            $this->assertArrayHasKey($field, $e->getErrors(), json_encode($e->getErrors()) ?: '');
            if ($message !== null) {
                $this->assertSame($message, $e->getErrors()[$field]);
            }
        }
    }

    private function assertNotFound(callable $fn): void
    {
        try {
            $fn();
            $this->fail('expected a 404');
        } catch (EntityNotFoundException) {
            $this->addToAssertionCount(1);
        }
    }
}
