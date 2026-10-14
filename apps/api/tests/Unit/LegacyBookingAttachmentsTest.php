<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Document\DocumentType;
use App\Domain\Entity\MedicalDocument;
use App\Infrastructure\Document\LegacyBookingAttachments;
use App\Infrastructure\Service\MedicalDocumentStorage;
use PHPUnit\Framework\TestCase;

/**
 * bin/prod-migrate.php step 7, file side: every old public booking attachment
 * either moves into private document storage (its last row MOVES it, so a
 * filed file leaves nothing public and nothing for a re-run to file twice) or
 * moves to the private quarantine folder — none is ever left public.
 */
final class LegacyBookingAttachmentsTest extends TestCase
{
    /** A 1×1 lossless WEBP — the old booking upload accepted these. */
    private const WEBP = 'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';

    private const PATIENT = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
    private const OTHER   = '7e6d5c4b-3a29-4180-9f7e-6d5c4b3a2918';

    /** The storage folder these tests file into (removed afterwards). */
    private const STORE_AS = 'test-legacy-patient';

    private string $root;
    private string $public;
    private string $quarantine;
    private LegacyBookingAttachments $legacy;

    protected function setUp(): void
    {
        $this->root       = sys_get_temp_dir() . '/legacy-att-' . bin2hex(random_bytes(4));
        $this->public     = $this->root . '/public/uploads/appointment-docs';
        $this->quarantine = $this->root . '/var/quarantine/appointment-docs';
        mkdir($this->public, 0o775, true);
        file_put_contents($this->public . '/.gitignore', "*\n!.gitignore\n");
        $this->legacy = new LegacyBookingAttachments(new MedicalDocumentStorage(), $this->public, $this->quarantine);
    }

    protected function tearDown(): void
    {
        $this->removeTree($this->root);
        $this->removeTree(MedicalDocumentStorage::baseDir() . '/' . self::STORE_AS);
    }

    public function testOnlyTheOldUploadsFileNamesNameAPatient(): void
    {
        self::assertSame(self::PATIENT, LegacyBookingAttachments::ownerOf(self::PATIENT . '-0a1b2c3d.png'));
        self::assertNull(LegacyBookingAttachments::ownerOf('report.pdf'));
        self::assertNull(LegacyBookingAttachments::ownerOf(self::PATIENT . '-0a1b2c3d.exe'));
        self::assertNull(LegacyBookingAttachments::ownerOf('../' . self::PATIENT . '-0a1b2c3d.png'));
    }

    public function testRowsAreGroupedByFileAndAMismatchedOwnerIsHeld(): void
    {
        $mine   = self::PATIENT . '-0a1b2c3d.png';
        $theirs = self::OTHER . '-11223344.pdf';
        $grouped = $this->legacy->group([
            $this->row('a1', LegacyBookingAttachments::URL_PREFIX . $mine),
            $this->row('a2', LegacyBookingAttachments::URL_PREFIX . $mine), // reused by hand
            $this->row('a3', LegacyBookingAttachments::URL_PREFIX . $theirs), // names another patient
            $this->row('a4', '/uploads/avatars/' . $mine),
            $this->row('a5', LegacyBookingAttachments::URL_PREFIX . 'notes.pdf'),
        ]);

        self::assertSame([$mine], array_keys($grouped['files']));
        self::assertSame(['a1', 'a2'], array_column($grouped['files'][$mine], 'id'));
        self::assertSame([$theirs], array_keys($grouped['held']));
        self::assertSame(['a4', 'a5'], array_column($grouped['skipped'], 'appointment_id'));
    }

    public function testEveryOtherPublicFileIsUnclaimedButTheDotfileIsNot(): void
    {
        $claimed = self::PATIENT . '-0a1b2c3d.png';
        foreach ([$claimed, self::OTHER . '-11223344.pdf', 'stray.txt'] as $name) {
            file_put_contents($this->public . '/' . $name, 'x');
        }

        // A stray non-attachment is still returned: the script quarantines it.
        self::assertSame([self::OTHER . '-11223344.pdf', 'stray.txt'], $this->legacy->unclaimed([$claimed]));
    }

    public function testAFileIsCopiedForEachRowAndMovedByTheLast(): void
    {
        $name  = $this->publicWebp();
        $saved = [];
        $this->legacy->file($name, [$this->row('a1'), $this->row('a2')], function (array $row, array $columns) use (&$saved): void {
            $saved[] = $columns;
        });

        self::assertFileDoesNotExist($this->public . '/' . $name, 'nothing public left, and nothing to delete');
        self::assertSame(['a1', 'a2'], array_column($saved, 'appointment_id'));
        foreach ($saved as $columns) {
            self::assertSame(self::STORE_AS, $columns['patient_id']);
            self::assertSame(DocumentType::BOOKING_ATTACHMENT, $columns['document_type']);
            self::assertSame(MedicalDocument::UPLOADER_PATIENT, $columns['uploader_role']);
            self::assertSame('Ada Obi', $columns['uploader_name']);
            self::assertSame('webp', $columns['extension']);
            self::assertSame('2026-09-01 10:00:00', $columns['created_at']);
            self::assertFileExists(MedicalDocumentStorage::baseDir() . '/' . self::STORE_AS . '/' . $columns['stored_name']);
        }
        self::assertNotSame($saved[0]['stored_name'], $saved[1]['stored_name'], 'each appointment gets its own copy');
    }

    public function testAnUnlinkedFileIsFiledWithNoAppointment(): void
    {
        $name  = $this->publicWebp();
        $saved = [];
        $this->legacy->file($name, [['id' => null] + $this->row('ignored')], function (array $row, array $columns) use (&$saved): void {
            $saved[] = $columns;
        });

        self::assertCount(1, $saved);
        self::assertNull($saved[0]['appointment_id']);
    }

    public function testAFailedSaveOfTheMovingRowPutsTheFileBack(): void
    {
        $name = $this->publicWebp();

        try {
            $this->legacy->file($name, [$this->row('a1')], static function (): void {
                throw new \RuntimeException('insert failed');
            });
            self::fail('the save error must propagate');
        } catch (\RuntimeException $e) {
            self::assertSame('insert failed', $e->getMessage());
        }

        // Back where a re-run finds it — and no orphan in private storage.
        self::assertFileExists($this->public . '/' . $name);
        self::assertSame([], $this->stored());
    }

    public function testAFailedSaveOfACopyRemovesTheCopyAndKeepsTheSource(): void
    {
        $name  = $this->publicWebp();
        $calls = 0;

        try {
            $this->legacy->file($name, [$this->row('a1'), $this->row('a2')], static function () use (&$calls): void {
                $calls++;
                throw new \RuntimeException('insert failed');
            });
            self::fail('the save error must propagate');
        } catch (\RuntimeException) {
        }

        self::assertSame(1, $calls, 'stops at the first failure');
        self::assertFileExists($this->public . '/' . $name);
        self::assertSame([], $this->stored());
    }

    public function testQuarantineTakesAFileOutOfThePublicFolder(): void
    {
        $name = self::OTHER . '-11223344.pdf';
        file_put_contents($this->public . '/' . $name, '%PDF-1.4 held');

        $at = $this->legacy->quarantine($name);

        self::assertSame($this->legacy->quarantinePath($name), $at);
        self::assertFileDoesNotExist($this->public . '/' . $name);
        self::assertSame('%PDF-1.4 held', file_get_contents((string) $at));
        self::assertStringNotContainsString('/public/', str_replace('\\', '/', (string) $at));
        // Re-run: already moved, so it reports where it is; unknown: null.
        self::assertSame($at, $this->legacy->quarantine($name));
        self::assertNull($this->legacy->quarantine('no-such-file.pdf'));
    }

    public function testQuarantineNeverOverwritesAFileHeldEarlier(): void
    {
        $name = 'stray.txt';
        file_put_contents($this->public . '/' . $name, 'first');
        $first = (string) $this->legacy->quarantine($name);
        file_put_contents($this->public . '/' . $name, 'second');
        $second = (string) $this->legacy->quarantine($name);

        self::assertNotSame($first, $second);
        self::assertSame('first', file_get_contents($first));
        self::assertSame('second', file_get_contents($second));
    }

    /** An appointment row as the script selects it. */
    private function row(string $id, string $url = ''): array
    {
        return [
            'id'           => $id,
            'document_url' => $url,
            'patient_id'   => $url === '' ? self::STORE_AS : self::PATIENT,
            'first_name'   => 'Ada',
            'last_name'    => 'Obi',
            'created_at'   => '2026-09-01 10:00:00',
        ];
    }

    /** A valid legacy attachment in the public folder; returns its name. */
    private function publicWebp(): string
    {
        $name = self::PATIENT . '-0a1b2c3d.webp';
        file_put_contents($this->public . '/' . $name, (string) base64_decode(self::WEBP));

        return $name;
    }

    /** @return list<string> the files filed into the test patient's storage folder */
    private function stored(): array
    {
        return array_map('basename', glob(MedicalDocumentStorage::baseDir() . '/' . self::STORE_AS . '/*') ?: []);
    }

    private function removeTree(string $path): void
    {
        if (is_file($path) || is_link($path)) {
            @unlink($path);

            return;
        }
        if (!is_dir($path)) {
            return;
        }
        foreach (scandir($path) ?: [] as $entry) {
            if ($entry !== '.' && $entry !== '..') {
                $this->removeTree($path . '/' . $entry);
            }
        }
        @rmdir($path);
    }
}
