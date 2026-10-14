<?php

declare(strict_types=1);

namespace App\Infrastructure\Document;

use App\Domain\Document\DocumentType;
use App\Domain\Entity\MedicalDocument;
use App\Infrastructure\Service\DocumentRejectedException;
use App\Infrastructure\Service\DocumentStorageException;
use App\Infrastructure\Service\MedicalDocumentStorage;
use DateTimeImmutable;

/**
 * The file side of bin/prod-migrate.php step 7. A booking attachment used to
 * be saved in the PUBLIC folder public/uploads/appointment-docs as
 * {patient id}-{8 hex}.{ext} — reachable by anyone with the URL, and never
 * shown to the doctor. Each one moves into private document storage as the
 * patient's Booking Attachment, and anything that can't be filed moves to a
 * private quarantine folder instead, so nothing is left public either way.
 * The script does the database side.
 */
final class LegacyBookingAttachments
{
    /** A file name the old upload wrote; group 1 is the patient's id. */
    public const NAME = '/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-[0-9a-f]{8}\.(pdf|jpg|png|webp)$/';

    /** What an appointment's document_url holds before the file name. */
    public const URL_PREFIX = '/uploads/appointment-docs/';

    public function __construct(
        private readonly MedicalDocumentStorage $storage,
        private readonly string $publicDir,
        private readonly string $quarantineDir,
    ) {
    }

    /** The patient id a legacy file name starts with, or null when it isn't one. */
    public static function ownerOf(string $name): ?string
    {
        $m = [];

        return preg_match(self::NAME, $name, $m) === 1 ? $m[1] : null;
    }

    /**
     * Sort the appointments that point at a file by file. A row whose URL is
     * not one of these files is skipped. A file whose name names a different
     * patient than an appointment pointing at it is held — with every row for
     * it — for a look by hand.
     *
     * @param list<array<string,mixed>> $rows appointments: id, document_url, patient_id, …
     * @return array{files: array<string, list<array<string,mixed>>>, held: array<string, list<array<string,mixed>>>, skipped: list<array<string,mixed>>}
     */
    public function group(array $rows): array
    {
        $files   = [];
        $held    = [];
        $skipped = [];
        foreach ($rows as $row) {
            $url   = (string) $row['document_url'];
            $name  = basename($url);
            $owner = self::ownerOf($name);
            if ($url !== self::URL_PREFIX . $name || $owner === null) {
                $skipped[] = ['appointment_id' => $row['id'], 'reason' => 'document_url is not an appointment-docs file'];
                continue;
            }
            $files[$name][] = $row;
            if ($owner !== strtolower((string) $row['patient_id'])) {
                $held[$name] = true;
            }
        }

        $heldRows = [];
        foreach (array_keys($held) as $name) {
            $heldRows[$name] = $files[$name];
            unset($files[$name]);
        }

        return ['files' => $files, 'held' => $heldRows, 'skipped' => $skipped];
    }

    /**
     * The public folder's other files: none of `$claimed` (the names
     * appointments point at) and no dotfile (its .gitignore). One named like
     * an attachment is a booking that was never made; anything else is still
     * treated as a patient's upload, so it is quarantined rather than left.
     *
     * @param list<string> $claimed
     * @return list<string> file names
     */
    public function unclaimed(array $claimed): array
    {
        $names = [];
        foreach (is_dir($this->publicDir) ? (scandir($this->publicDir) ?: []) : [] as $name) {
            if (!str_starts_with($name, '.') && !in_array($name, $claimed, true) && is_file($this->publicDir . '/' . $name)) {
                $names[] = $name;
            }
        }
        sort($names);

        return $names;
    }

    /**
     * File `$name` once for each appointment row, in order: every row but the
     * last gets a copy, and the last one MOVES the file — so a finished file
     * leaves nothing public behind and nothing to delete afterwards (a delete
     * that failed used to leave it for a re-run to file again, as a duplicate).
     * `$save` writes a row's database side, in its own transaction, from the
     * medical_documents columns it is given; if it throws, that row's stored
     * file is undone — a moved one goes back to the public folder — so a
     * re-run finds the file again.
     *
     * @param list<array<string,mixed>> $rows each: id (the appointment, or null for none), patient_id, first_name, last_name, created_at
     * @param callable(array<string,mixed> $row, array<string,mixed> $columns): void $save
     * @throws DocumentRejectedException|DocumentStorageException|\Throwable
     */
    public function file(string $name, array $rows, callable $save): void
    {
        $source = $this->publicDir . '/' . $name;
        $last   = count($rows) - 1;
        foreach (array_values($rows) as $i => $row) {
            $move      = $i === $last;
            $patientId = (string) $row['patient_id'];
            $meta      = $this->storage->import($source, $patientId, 'Booking attachment', $move);
            $uploader  = trim((string) ($row['first_name'] ?? '') . ' ' . (string) ($row['last_name'] ?? '')) ?: 'Patient';
            // The entity is only built for its id and stored path.
            $document  = new MedicalDocument($patientId, MedicalDocument::UPLOADER_PATIENT, $uploader, DocumentType::BOOKING_ATTACHMENT, $meta['title'], $meta['stored_name'], $meta['mime'], $meta['extension'], $meta['size']);
            $stored    = $this->storage->path($document);
            $this->inheritOwner(MedicalDocumentStorage::baseDir(), dirname($stored), $stored);

            try {
                $save($row, [
                    'id'             => $document->getId(),
                    'patient_id'     => $patientId,
                    'uploader_role'  => MedicalDocument::UPLOADER_PATIENT,
                    'uploader_name'  => mb_substr($uploader, 0, 200),
                    'appointment_id' => $row['id'] !== null ? (string) $row['id'] : null,
                    'document_type'  => DocumentType::BOOKING_ATTACHMENT,
                    'custom_type'    => null,
                    'title'          => $meta['title'],
                    'stored_name'    => $meta['stored_name'],
                    'mime_type'      => mb_substr($meta['mime'], 0, 120),
                    'extension'      => $meta['extension'],
                    'size_bytes'     => $meta['size'],
                    'created_at'     => (string) $row['created_at'], // when it was attached, so it sorts where it belongs
                    'updated_at'     => (new DateTimeImmutable())->format('Y-m-d H:i:s'),
                ]);
            } catch (\Throwable $e) {
                if (!$move) {
                    $this->storage->delete($document);
                } elseif (!@rename($stored, $source)) {
                    throw new \RuntimeException(sprintf('%s — and %s could not be moved back to %s: move it back by hand before re-running', $e->getMessage(), $stored, $source), 0, $e);
                }
                throw $e;
            }
        }
    }

    /**
     * Move `$name` out of the public folder into the quarantine folder
     * (created 0700, outside the web root) for a look by hand. Returns where
     * it is now — also when an earlier run already moved it — or null when it
     * is in neither place.
     *
     * @throws \RuntimeException when the move failed: the file is still public
     */
    public function quarantine(string $name): ?string
    {
        $source = $this->publicDir . '/' . $name;
        $target = $this->quarantinePath($name);
        if (!is_file($source)) {
            return is_file($target) ? $target : null;
        }
        if (!is_dir($this->quarantineDir)) {
            @mkdir($this->quarantineDir, 0o700, true);
        }
        @chmod($this->quarantineDir, 0o700);
        if (file_exists($target)) {
            $target .= '.' . bin2hex(random_bytes(4)); // never overwrite one held earlier
        }
        if (!@rename($source, $target)) {
            throw new \RuntimeException(sprintf('Could not move %s into %s', $source, $this->quarantineDir));
        }

        return $target;
    }

    /** Where {@see quarantine()} puts `$name` (also what a dry run reports). */
    public function quarantinePath(string $name): string
    {
        return $this->quarantineDir . '/' . $name;
    }

    /**
     * Run as root (as the deploy runs it), the folders and files this creates
     * would be root's, and php-fpm could no longer save a new upload into that
     * patient's folder. They get var/'s owner instead — the web user, after
     * any earlier deploy's chown — so a run that stops before the deploy's own
     * chown never breaks uploads.
     */
    private function inheritOwner(string ...$paths): void
    {
        if (!function_exists('posix_geteuid') || posix_geteuid() !== 0) {
            return;
        }
        $reference = dirname(MedicalDocumentStorage::baseDir());
        $uid       = @fileowner($reference);
        $gid       = @filegroup($reference);
        if ($uid === false || $gid === false) {
            return;
        }
        foreach ($paths as $path) {
            @chown($path, $uid);
            @chgrp($path, $gid);
        }
    }
}
