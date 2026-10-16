<?php

declare(strict_types=1);

namespace App\Tests\Integration\Dashboard;

use App\Action\Doctor\UploadDoctorAvatarAction;
use App\Action\Specialist\DeleteSpecialistPhotoAction;
use App\Action\Specialist\UpdateSpecialistAction;
use App\Action\Specialist\UploadSpecialistPhotoAction;
use App\Domain\Entity\AuditEvent;
use App\Domain\Entity\Specialist;
use App\Domain\Entity\User;
use App\Domain\Repository\AuditEventRepository;
use App\Domain\Repository\ReferenceItemRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\AuditLogger;
use App\Infrastructure\Service\ReferenceDataService;
use App\Infrastructure\Storage\ProfilePhotoStore;
use App\Tests\Integration\Wallet\Support\WalletHarness;
use Doctrine\ORM\EntityManagerInterface;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;
use Slim\Psr7\UploadedFile;

/**
 * POST / DELETE /api/specialists/{id}/photo end to end against Postgres (a
 * throw-away schema; skipped when the local database is unreachable): the
 * file lands in the avatar folder, the profile points at it, the old upload
 * is deleted, and each change is audited with its before/after. Also the
 * PATCH /specialists/{id} photo_url rule (clear or unchanged only), and the
 * doctor's own upload never deleting a file that isn't theirs.
 */
final class SpecialistPhotoActionsTest extends TestCase
{
    private const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    private const GIF = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

    private static ?string $schema = null;

    private static ?string $skipReason = null;

    private ?EntityManagerInterface $em = null;

    private string $root = '';

    public static function setUpBeforeClass(): void
    {
        self::$skipReason = WalletHarness::unavailableReason();
        self::$schema     = self::$skipReason === null ? WalletHarness::createSchema() : null;
    }

    public static function tearDownAfterClass(): void
    {
        if (self::$schema !== null) {
            WalletHarness::dropSchema(self::$schema);
            self::$schema = null;
        }
    }

    protected function setUp(): void
    {
        if (self::$skipReason !== null) {
            $this->markTestSkipped(self::$skipReason);
        }
        $this->em   = WalletHarness::entityManager((string) self::$schema, 'photo_it');
        $this->root = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'photo-it-' . bin2hex(random_bytes(4));
        mkdir($this->root . '/uploads/avatars', 0o775, true);
    }

    protected function tearDown(): void
    {
        $this->em?->getConnection()->close();
        $this->em = null;
        foreach (glob($this->root . '/uploads/avatars/*') ?: [] as $file) {
            @unlink($file);
        }
        @rmdir($this->root . '/uploads/avatars');
        @rmdir($this->root . '/uploads');
        @rmdir($this->root);
    }

    private function request(string $bytes, string $field = 'photo', string $userId = ''): \Psr\Http\Message\ServerRequestInterface
    {
        $path = (string) tempnam(sys_get_temp_dir(), 'up');
        file_put_contents($path, $bytes);

        return (new ServerRequestFactory())->createServerRequest('POST', '/api/specialists/x/photo')
            ->withUploadedFiles([$field => new UploadedFile($path, 'face.png', 'image/png', strlen($bytes))])
            ->withAttribute('user_id', $userId);
    }

    public function testUploadReplaceAndRemove(): void
    {
        $em = $this->em;
        \assert($em instanceof EntityManagerInterface);
        $specialist = new Specialist('Dr. Photo Test', 'Cardiology');
        $specialist->setPhotoUrl('https://images.example.com/old.jpg'); // an older hand-entered link
        $em->persist($specialist);
        $em->flush();
        $id = $specialist->getId();

        $store  = new ProfilePhotoStore($this->root);
        $repo   = new SpecialistRepository($em);
        $users  = new UserRepository($em);
        $audit  = new AuditLogger(new AuditEventRepository($em));
        $upload = new UploadSpecialistPhotoAction($repo, $users, $audit, $store);
        $remove = new DeleteSpecialistPhotoAction($repo, $users, $audit, $store);

        // A GIF is refused for staff uploads (422 on `photo`), nothing changes.
        $refused = $upload($this->request((string) base64_decode(self::GIF)), new Response(), ['id' => $id]);
        $this->assertSame(422, $refused->getStatusCode());
        $this->assertStringContainsString('Only JPG, PNG or WEBP images are allowed', (string) $refused->getBody());

        // Upload: stored under the doctor's name, profile updated, audited.
        $first = $upload($this->request((string) base64_decode(self::PNG)), new Response(), ['id' => $id]);
        $this->assertSame(200, $first->getStatusCode(), (string) $first->getBody());
        $firstUrl = json_decode((string) $first->getBody(), true)['data']['photo_url'];
        $this->assertTrue(ProfilePhotoStore::isOwnSpecialistUpload($firstUrl, $id));
        $this->assertFileExists($this->root . $firstUrl);

        // Replace: the previous upload is deleted.
        $second    = $upload($this->request((string) base64_decode(self::PNG)), new Response(), ['id' => $id]);
        $secondUrl = json_decode((string) $second->getBody(), true)['data']['photo_url'];
        $this->assertNotSame($firstUrl, $secondUrl);
        $this->assertFileDoesNotExist($this->root . $firstUrl);
        $this->assertFileExists($this->root . $secondUrl);

        // Remove: cleared and the file deleted; removing again is a no-op.
        $gone = $remove((new ServerRequestFactory())->createServerRequest('DELETE', '/')->withAttribute('user_id', ''), new Response(), ['id' => $id]);
        $this->assertSame(200, $gone->getStatusCode());
        $this->assertNull(json_decode((string) $gone->getBody(), true)['data']['photo_url']);
        $this->assertFileDoesNotExist($this->root . $secondUrl);
        $again = $remove((new ServerRequestFactory())->createServerRequest('DELETE', '/')->withAttribute('user_id', ''), new Response(), ['id' => $id]);
        $this->assertSame(200, $again->getStatusCode());

        // (Events written in the same second have no order — match them by content.)
        $trail = array_map(
            static fn (AuditEvent $e): array => ['action' => $e->toArray()['action']] + $e->toArray()['metadata'],
            (new AuditEventRepository($em))->forResource('specialist', $id),
        );
        $this->assertCount(3, $trail, 'two uploads and one removal');
        $this->assertSame(['specialist.updated'], array_values(array_unique(array_column($trail, 'action'))));
        $changes = array_map(static fn (array $m): array => [$m['via'], $m['before']['photo_url'], $m['after']['photo_url']], $trail);
        $this->assertContains(['photo_upload', 'https://images.example.com/old.jpg', $firstUrl], $changes);
        $this->assertContains(['photo_upload', $firstUrl, $secondUrl], $changes);
        $this->assertContains(['photo_remove', $secondUrl, null], $changes);
    }

    public function testPatchOnlyClearsOrKeepsThePhoto(): void
    {
        $em = $this->em;
        \assert($em instanceof EntityManagerInterface);
        $specialist = new Specialist('Dr. Patch Photo', 'Cardiology');
        $em->persist($specialist);
        $em->flush();
        $id = $specialist->getId();

        $store  = new ProfilePhotoStore($this->root);
        $repo   = new SpecialistRepository($em);
        $users  = new UserRepository($em);
        $audit  = new AuditLogger(new AuditEventRepository($em));
        $upload = new UploadSpecialistPhotoAction($repo, $users, $audit, $store);
        $patch  = new UpdateSpecialistAction(
            $repo,
            $users,
            $audit,
            new ReferenceDataService($em, new ReferenceItemRepository($em), $repo, $audit),
            $store,
        );
        $send = fn (array $body): ResponseInterface => $patch(
            (new ServerRequestFactory())->createServerRequest('PATCH', '/')->withParsedBody($body)->withAttribute('user_id', ''),
            new Response(),
            ['id' => $id],
        );

        $earlier = json_decode((string) $upload($this->request((string) base64_decode(self::PNG)), new Response(), ['id' => $id])->getBody(), true)['data']['photo_url'];
        $current = json_decode((string) $upload($this->request((string) base64_decode(self::PNG)), new Response(), ['id' => $id])->getBody(), true)['data']['photo_url'];
        $this->assertFileDoesNotExist($this->root . $earlier, 'replaced, so its file is gone');

        // Pointing back at the earlier upload (a missing file), a link, or someone else's path: 422.
        foreach ([$earlier, 'https://images.example.com/x.png', '/uploads/avatars/patient-1.png', ['x']] as $value) {
            $refused = $send(['photo_url' => $value]);
            $this->assertSame(422, $refused->getStatusCode(), (string) json_encode($value));
            $this->assertSame('Upload a photo instead — links are not accepted', json_decode((string) $refused->getBody(), true)['errors']['photo_url']);
        }
        $this->assertSame($current, $this->photoOf($id));

        // The current value again: a no-op (nothing audited beyond the two uploads).
        $same = $send(['photo_url' => ' ' . $current . ' ', 'bio' => 'Heart doctor']);
        $this->assertSame(200, $same->getStatusCode(), (string) $same->getBody());
        $this->assertSame($current, $this->photoOf($id));
        $this->assertFileExists($this->root . $current);

        // Cleared: the profile has no photo and the stored upload is deleted, audited.
        $cleared = $send(['photo_url' => '']);
        $this->assertSame(200, $cleared->getStatusCode());
        $this->assertNull(json_decode((string) $cleared->getBody(), true)['data']['photo_url']);
        $this->assertNull($this->photoOf($id));
        $this->assertFileDoesNotExist($this->root . $current);
        $photoEdits = array_values(array_filter(
            array_map(static fn (AuditEvent $e): array => $e->toArray()['metadata'], (new AuditEventRepository($em))->forResource('specialist', $id)),
            static fn (array $m): bool => !isset($m['via']) && array_key_exists('photo_url', $m['before'] ?? []),
        ));
        $this->assertSame([['photo_url' => $current]], array_column($photoEdits, 'before'));
        $this->assertSame([['photo_url' => null]], array_column($photoEdits, 'after'));
    }

    public function testDoctorsOwnUploadNeverDeletesSomeoneElsesFile(): void
    {
        $em = $this->em;
        \assert($em instanceof EntityManagerInterface);
        $doctor = new Specialist('Dr. Own Avatar', 'Cardiology');
        $em->persist($doctor);
        $login = new User('own-avatar-' . bin2hex(random_bytes(4)) . '@example.test', 'Own', 'Avatar');
        $login->setRoles(['doctor']);
        $login->setSpecialistId($doctor->getId());
        $em->persist($login);

        // Another doctor's stored headshot, which this doctor's photo_url was
        // pointed at (PATCH /doctor/profile accepts any /uploads path).
        $victim = ProfilePhotoStore::URL_PREFIX . 'dr-7f1d2c3b-aaaa-4bbb-8ccc-1234567890ab-0123abcd.png';
        file_put_contents($this->root . $victim, (string) base64_decode(self::PNG));
        $doctor->setPhotoUrl($victim);
        $em->flush();

        $action  = new UploadDoctorAvatarAction(new UserRepository($em), new SpecialistRepository($em), new ProfilePhotoStore($this->root));
        $request = fn (): \Psr\Http\Message\ServerRequestInterface => $this->request((string) base64_decode(self::PNG), 'avatar', $login->getId());

        $first = $action($request(), new Response());
        $this->assertSame(200, $first->getStatusCode(), (string) $first->getBody());
        $this->assertFileExists($this->root . $victim, "someone else's file is never deleted");
        $own = (string) json_decode((string) $first->getBody(), true)['data']['photo_url'];
        $this->assertTrue(ProfilePhotoStore::isOwnSpecialistUpload($own, $doctor->getId()));

        // Their own previous upload still goes when they replace it.
        $second = $action($request(), new Response());
        $this->assertSame(200, $second->getStatusCode());
        $this->assertFileDoesNotExist($this->root . $own);
        $this->assertFileExists($this->root . (string) json_decode((string) $second->getBody(), true)['data']['photo_url']);
    }

    private function photoOf(string $id): ?string
    {
        $em = $this->em;
        \assert($em instanceof EntityManagerInterface);
        $value = $em->getConnection()->fetchOne('SELECT photo_url FROM specialists WHERE id = ?', [$id]);

        return $value === false || $value === null ? null : (string) $value;
    }
}
