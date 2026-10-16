<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Infrastructure\Storage\PhotoRejectedException;
use App\Infrastructure\Storage\ProfilePhotoStore;
use PHPUnit\Framework\TestCase;
use Slim\Psr7\UploadedFile;

/**
 * Doctor headshots (ProfilePhotoStore): the checks shared by the doctor's own
 * upload and the back office's (POST /api/specialists/{id}/photo), where they
 * are stored, what may be deleted, and the back office's photo_url rule (no
 * links — uploads only).
 */
final class SpecialistPhotoTest extends TestCase
{
    private const SPECIALIST = '0a6c2b8e-4c1f-4c55-9d8b-2f0e8f1b7a10';
    private const OTHER      = '7f1d2c3b-aaaa-4bbb-8ccc-1234567890ab';

    /** 1×1 PNG / GIF. */
    private const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    private const GIF = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

    private string $root;

    /** @var list<string> */
    private array $temp = [];

    protected function setUp(): void
    {
        $this->root = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'photo-test-' . bin2hex(random_bytes(4));
        mkdir($this->root . '/uploads/avatars', 0o775, true);
    }

    protected function tearDown(): void
    {
        foreach ($this->temp as $file) {
            @unlink($file);
        }
        foreach (glob($this->root . '/uploads/avatars/*') ?: [] as $file) {
            @unlink($file);
        }
        @rmdir($this->root . '/uploads/avatars');
        @rmdir($this->root . '/uploads');
        @rmdir($this->root);
    }

    private function store(): ProfilePhotoStore
    {
        return new ProfilePhotoStore($this->root);
    }

    private function upload(string $bytes, ?int $size = null, int $error = UPLOAD_ERR_OK, string $name = 'photo.jpg'): UploadedFile
    {
        $path = tempnam(sys_get_temp_dir(), 'up');
        file_put_contents($path, $bytes);
        $this->temp[] = $path;

        return new UploadedFile($path, $name, 'image/jpeg', $size ?? strlen($bytes), $error);
    }

    private function rejection(callable $fn): string
    {
        try {
            $fn();
        } catch (PhotoRejectedException $e) {
            return $e->getMessage();
        }
        $this->fail('Expected the photo to be rejected');
    }

    public function testMissingOrFailedUploadIsRejected(): void
    {
        $store = $this->store();

        $this->assertSame('No image was uploaded', $this->rejection(static fn () => $store->validate(null)));
        $this->assertSame('No image was uploaded', $this->rejection(static fn () => $store->validate('not a file')));
        $this->assertSame('No image was uploaded', $this->rejection(fn () => $store->validate($this->upload('', 0, UPLOAD_ERR_NO_FILE))));
        $this->assertSame('Image must be 2MB or smaller', $this->rejection(fn () => $store->validate($this->upload('', 0, UPLOAD_ERR_INI_SIZE))));
    }

    public function testOversizedUploadIsRejected(): void
    {
        $store = $this->store();
        $big   = $this->upload(base64_decode(self::PNG), ProfilePhotoStore::MAX_BYTES + 1);

        $this->assertSame('Image must be 2MB or smaller', $this->rejection(static fn () => $store->validate($big, ProfilePhotoStore::STAFF_TYPES)));
    }

    public function testBytesDecideTheTypeNotTheFilename(): void
    {
        $store = $this->store();

        // A PHP script named like a photo is not an image.
        $script = $this->upload('<?php echo "pwned"; ?>', null, UPLOAD_ERR_OK, 'face.png');
        $this->assertSame('Only JPG, PNG or WEBP images are allowed', $this->rejection(static fn () => $store->validate($script, ProfilePhotoStore::STAFF_TYPES)));

        // A real PNG named .gif is stored as .png.
        $this->assertSame('png', $store->validate($this->upload(base64_decode(self::PNG), null, UPLOAD_ERR_OK, 'face.gif'), ProfilePhotoStore::STAFF_TYPES));
    }

    public function testStaffUploadsAreJpgPngOrWebpOnly(): void
    {
        $store = $this->store();
        $gif   = base64_decode(self::GIF);

        $this->assertSame(
            'Only JPG, PNG or WEBP images are allowed',
            $this->rejection(fn () => $store->validate($this->upload($gif), ProfilePhotoStore::STAFF_TYPES)),
        );
        // The doctor's own upload keeps accepting GIF, as before.
        $this->assertSame('gif', $store->validate($this->upload($gif), ProfilePhotoStore::DOCTOR_TYPES));
        $this->assertSame(
            'Only JPG, PNG, WEBP or GIF images are allowed',
            $this->rejection(fn () => $store->validate($this->upload('plain text'), ProfilePhotoStore::DOCTOR_TYPES)),
        );
    }

    public function testStoredUnderAServerGeneratedNameInTheAvatarFolder(): void
    {
        $store = $this->store();
        $url   = $store->storeSpecialistPhoto(self::SPECIALIST, $this->upload(base64_decode(self::PNG), null, UPLOAD_ERR_OK, '../../evil.php'), ProfilePhotoStore::STAFF_TYPES);

        $this->assertMatchesRegularExpression('#^/uploads/avatars/dr-' . self::SPECIALIST . '-[0-9a-f]{8}\.png$#', $url);
        $this->assertFileExists($this->root . $url);
        $this->assertTrue(ProfilePhotoStore::isOwnSpecialistUpload($url, self::SPECIALIST));
        $this->assertFalse(ProfilePhotoStore::isOwnSpecialistUpload($url, self::OTHER));

        $store->deleteLocal($url);
        $this->assertFileDoesNotExist($this->root . $url);
    }

    public function testDeleteNeverLeavesTheAvatarFolder(): void
    {
        $store   = $this->store();
        $outside = $this->root . '/uploads/secret.txt';
        file_put_contents($outside, 'keep me');
        $this->temp[] = $outside;

        $store->deleteLocal('/uploads/avatars/../secret.txt');
        $store->deleteLocal('/uploads/secret.txt');
        $store->deleteLocal('https://cdn.example.com/uploads/avatars/x.png');
        $store->deleteLocal(null);

        $this->assertFileExists($outside);
    }

    public function testOwnUploadPatternIsStrict(): void
    {
        $own = '/uploads/avatars/dr-' . self::SPECIALIST . '-0123abcd.webp';

        $this->assertTrue(ProfilePhotoStore::isOwnSpecialistUpload($own, self::SPECIALIST));
        $this->assertFalse(ProfilePhotoStore::isOwnSpecialistUpload($own . '.php', self::SPECIALIST));
        $this->assertFalse(ProfilePhotoStore::isOwnSpecialistUpload('/uploads/avatars/dr-' . self::SPECIALIST . '-../../x.png', self::SPECIALIST));
        $this->assertFalse(ProfilePhotoStore::isOwnSpecialistUpload('/uploads/avatars/' . self::SPECIALIST . '-0123abcd.png', self::SPECIALIST)); // a patient-style name
        $this->assertFalse(ProfilePhotoStore::isOwnSpecialistUpload(null, self::SPECIALIST));
        $this->assertFalse(ProfilePhotoStore::isOwnSpecialistUpload($own, ''));
    }

    public function testStaffPhotoUrlAcceptsOnlyClearOrUnchanged(): void
    {
        $own     = '/uploads/avatars/dr-' . self::SPECIALIST . '-0123abcd.png';
        $earlier = '/uploads/avatars/dr-' . self::SPECIALIST . '-89abcdef.png';
        $legacy  = 'https://images.example.com/doctor.jpg';
        $refusal = 'Upload a photo instead — links are not accepted';

        // Clearing, or re-sending what the form loaded (even an older link).
        $this->assertNull(ProfilePhotoStore::staffPhotoUrlError('', $legacy));
        $this->assertNull(ProfilePhotoStore::staffPhotoUrlError('', null));
        $this->assertNull(ProfilePhotoStore::staffPhotoUrlError($legacy, $legacy));
        $this->assertNull(ProfilePhotoStore::staffPhotoUrlError($own, $own));

        // Anything else is refused — a new link, someone else's file, another
        // /uploads path, and even this doctor's earlier upload (its file went
        // when it was replaced).
        $this->assertSame($refusal, ProfilePhotoStore::staffPhotoUrlError('https://evil.example.com/x.png', null));
        $this->assertSame($refusal, ProfilePhotoStore::staffPhotoUrlError('http://example.com/x.png', $own));
        $this->assertSame($refusal, ProfilePhotoStore::staffPhotoUrlError($earlier, $own));
        $this->assertSame($refusal, ProfilePhotoStore::staffPhotoUrlError($own, null));
        $this->assertSame($refusal, ProfilePhotoStore::staffPhotoUrlError('/uploads/avatars/dr-' . self::OTHER . '-0123abcd.png', null));
        $this->assertSame($refusal, ProfilePhotoStore::staffPhotoUrlError('/uploads/avatars/patient-1.png', null));
        $this->assertSame($refusal, ProfilePhotoStore::staffPhotoUrlError('/uploads/avatars/../../config/x', null));
    }
}
