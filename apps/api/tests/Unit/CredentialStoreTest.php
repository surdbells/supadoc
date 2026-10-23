<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Exception\ApplicationProblem;
use App\Domain\Exception\ValidationException;
use App\Infrastructure\Storage\ApplicationDocumentStore;
use App\Infrastructure\Storage\CredentialStore;
use App\Infrastructure\Storage\FileVault;
use PHPUnit\Framework\TestCase;

/** Spec §3.4: inspect with a 5MB limit and its message; content must match the extension; storage failures are 503. */
final class CredentialStoreTest extends TestCase
{
    private const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

    public function testTheLimitBuildsItsMessage(): void
    {
        $big = '%PDF-' . str_repeat('x', 5 * 1024 * 1024);
        try {
            CredentialStore::inspect($big, 'cv.pdf', 5 * 1024 * 1024);
            $this->fail('over 5MB');
        } catch (ValidationException $e) {
            $this->assertSame('The file must be 5MB or smaller', $e->getErrors()['file']);
        }
        $this->assertSame('application/pdf', CredentialStore::inspect($big, 'cv.pdf')['mime'], 'doctors keep 10MB');
        $this->assertSame('The file must be 10MB or smaller', CredentialStore::tooLarge(CredentialStore::MAX_BYTES));
    }

    public function testApplicantUploadsAreCodedAndWordedForThem(): void
    {
        $png = (string) base64_decode(self::PNG, true);
        $this->assertSame('image/png', ApplicationDocumentStore::inspect($png, 'id.PNG')['mime']);
        foreach ([
            ['%PDF-1.4', 'cv.png', 'The file content does not match its type. Upload a PDF, PNG or JPG file.'],
            ['plain text', 'cv.pdf', 'The file content does not match its type. Upload a PDF, PNG or JPG file.'],
            ['%PDF-1.4', 'cv.docx', 'Upload a PDF, PNG or JPG file.'],
            ['', 'cv.pdf', 'The file is empty'],
        ] as [$bytes, $name, $message]) {
            try {
                ApplicationDocumentStore::inspect($bytes, $name);
                $this->fail("refused: {$name}");
            } catch (ApplicationProblem $p) {
                $this->assertSame(422, $p->status);
                $this->assertSame('file_invalid', $p->errorCode);
                $this->assertSame($message, $p->getMessage());
                $this->assertSame($message, $p->extra['file']);
            }
        }
        $this->assertSame('cv.pdf', ApplicationDocumentStore::inspect('%PDF-1.4', '../../cv.pdf')['name'], 'a safe name');
    }

    public function testAVaultFailureIs503(): void
    {
        $store = new ApplicationDocumentStore(static fn (): FileVault => throw new \RuntimeException('FILE_ENCRYPTION_KEY is not set'));
        try {
            $store->store('%PDF-1.4');
            $this->fail('no vault');
        } catch (ApplicationProblem $p) {
            $this->assertSame(503, $p->status);
            $this->assertSame('storage_unavailable', $p->errorCode);
        }
        $this->assertNull($store->bytes('applications/' . str_repeat('a', 32) . '.bin'));
    }

    public function testTheVaultFolderIsApplications(): void
    {
        $dir   = sys_get_temp_dir() . '/docapp-vault-' . bin2hex(random_bytes(4));
        $store = new ApplicationDocumentStore(new FileVault($dir, str_repeat('k', 32)));
        $key   = $store->store('%PDF-1.4 hello');
        $this->assertStringStartsWith('applications/', $key);
        $this->assertSame('%PDF-1.4 hello', $store->bytes($key));
        $store->delete($key);
        $this->assertNull($store->bytes($key));
        @rmdir($dir . '/applications');
        @rmdir($dir);
    }
}
