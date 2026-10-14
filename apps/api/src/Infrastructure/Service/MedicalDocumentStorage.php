<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Entity\MedicalDocument;
use Psr\Http\Message\UploadedFileInterface;

/**
 * Persists medical-document files OUTSIDE the public web root (apps/api/var), so
 * a file is only ever reachable through an authenticated, ownership-checked
 * endpoint — never a guessable public URL. Uploads are size-capped, extension-
 * whitelisted, and content-sniffed so nothing executable or mislabelled lands on
 * disk. A rejected file throws {@see DocumentRejectedException} (a user-safe
 * message, for a 422); a file it accepted but could not write throws
 * {@see DocumentStorageException} (server paths in the message — log it, 500).
 */
final class MedicalDocumentStorage
{
    private const MAX_BYTES = 10 * 1024 * 1024; // 10MB

    /** Allowed upload extension => the acceptable finfo MIME types. */
    private const TYPES = [
        'pdf'  => ['application/pdf'],
        'jpg'  => ['image/jpeg'],
        'jpeg' => ['image/jpeg'],
        'png'  => ['image/png'],
        'webp' => ['image/webp'],
        'docx' => ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip'],
        'doc'  => ['application/msword', 'application/octet-stream'],
        'dcm'  => ['application/dicom', 'application/octet-stream'],
        'mp4'  => ['video/mp4', 'application/mp4'],
        'webm' => ['video/webm'],
        'mov'  => ['video/quicktime'],
    ];

    public function maxBytes(): int
    {
        return self::MAX_BYTES;
    }

    /** Human list of accepted formats, for error copy. */
    public function acceptedLabel(): string
    {
        return 'PDF, JPG, PNG, WEBP, DOCX, DICOM (.dcm), or video (MP4, WEBM, MOV)';
    }

    /**
     * Validate + store an uploaded file for a patient. Returns the metadata the
     * caller records against a MedicalDocument row.
     *
     * @return array{stored_name: string, extension: string, mime: string, size: int, title: string}
     * @throws DocumentRejectedException|DocumentStorageException
     */
    public function store(UploadedFileInterface $file, string $patientId): array
    {
        if ($file->getError() !== UPLOAD_ERR_OK) {
            throw new DocumentRejectedException('No file was uploaded');
        }
        $client = (string) $file->getClientFilename();
        $tmp    = $file->getStream()->getMetadata('uri');
        $meta   = $this->inspect(is_string($tmp) ? $tmp : '', (int) ($file->getSize() ?? 0), $client);

        $stored = $this->newStoredName($patientId, $meta['extension']);
        try {
            $file->moveTo(self::baseDir() . '/' . $patientId . '/' . $stored);
        } catch (\Throwable $e) {
            // Slim's message names the temp and target paths: for the log only.
            throw new DocumentStorageException('Could not move the upload into document storage: ' . $e->getMessage(), 0, $e);
        }

        return ['stored_name' => $stored] + $meta + ['title' => $this->titleFrom($client)];
    }

    /**
     * File a file already on this server into a patient's documents, under the
     * same checks as an upload (bin/prod-migrate.php brings the old public
     * booking attachments in this way). It is copied, leaving the source for
     * the caller to delete once the MedicalDocument row is saved — or, with
     * `$move`, moved there (the caller moves it back if the row isn't saved).
     *
     * @return array{stored_name: string, extension: string, mime: string, size: int, title: string}
     * @throws DocumentRejectedException|DocumentStorageException
     */
    public function import(string $sourcePath, string $patientId, string $title, bool $move = false): array
    {
        $meta   = $this->checkImport($sourcePath);
        $stored = $this->newStoredName($patientId, $meta['extension']);
        $target = self::baseDir() . '/' . $patientId . '/' . $stored;
        if (!($move ? @rename($sourcePath, $target) : @copy($sourcePath, $target))) {
            throw new DocumentStorageException(sprintf('Could not %s %s into document storage (%s)', $move ? 'move' : 'copy', $sourcePath, $target));
        }

        return ['stored_name' => $stored] + $meta + ['title' => mb_substr(trim($title) !== '' ? trim($title) : 'Document', 0, 200)];
    }

    /**
     * The checks {@see import()} makes, without copying anything (a dry run).
     *
     * @return array{extension: string, mime: string, size: int}
     * @throws DocumentRejectedException
     */
    public function checkImport(string $sourcePath): array
    {
        if (!is_file($sourcePath) || !is_readable($sourcePath)) {
            throw new DocumentRejectedException('The file is missing or unreadable');
        }

        return $this->inspect($sourcePath, (int) (filesize($sourcePath) ?: 0), basename($sourcePath));
    }

    /** Absolute path to a stored document's file. */
    public function path(MedicalDocument $doc): string
    {
        return self::baseDir() . '/' . $doc->getPatientId() . '/' . $doc->getStoredName();
    }

    public function exists(MedicalDocument $doc): bool
    {
        return is_file($this->path($doc));
    }

    public function delete(MedicalDocument $doc): void
    {
        $path = $this->path($doc);
        if (is_file($path)) {
            @unlink($path);
        }
    }

    public static function baseDir(): string
    {
        return dirname(__DIR__, 3) . '/var/medical-docs';
    }

    // ----- internals -----

    /**
     * Size cap, extension allowlist and content sniff for the file at `$path`,
     * named `$clientName` by whoever supplied it.
     *
     * @return array{extension: string, mime: string, size: int}
     * @throws DocumentRejectedException
     */
    private function inspect(string $path, int $size, string $clientName): array
    {
        if ($size <= 0) {
            throw new DocumentRejectedException('The file is empty');
        }
        if ($size > self::MAX_BYTES) {
            throw new DocumentRejectedException('File must be 10MB or smaller');
        }

        $ext = strtolower(pathinfo($clientName, PATHINFO_EXTENSION));
        if ($ext === '' || !isset(self::TYPES[$ext])) {
            throw new DocumentRejectedException('Unsupported file type. Allowed: ' . $this->acceptedLabel());
        }

        // fileinfo is bundled with PHP but guard anyway — a missing extension must
        // degrade to extension-based validation, never fatal the whole upload.
        $mime = '';
        if ($path !== '' && is_file($path) && class_exists('\finfo')) {
            $sniffed = (new \finfo(FILEINFO_MIME_TYPE))->file($path);
            $mime    = is_string($sniffed) ? $sniffed : '';
        }

        if (!$this->contentMatches($ext, $mime, $path)) {
            throw new DocumentRejectedException('The file content does not match its extension');
        }

        $canonExt = $this->canonicalExtension($ext);

        return [
            'extension' => $canonExt,
            'mime'      => $mime !== '' ? $mime : $this->fallbackMime($canonExt),
            'size'      => $size,
        ];
    }

    /** A fresh random file name in the patient's folder (created if needed). */
    private function newStoredName(string $patientId, string $extension): string
    {
        $dir = self::baseDir() . '/' . $patientId;
        if (!is_dir($dir)) {
            @mkdir($dir, 0o775, true);
        }

        return bin2hex(random_bytes(16)) . '.' . $extension;
    }

    private function contentMatches(string $ext, string $mime, string $tmp): bool
    {
        $allowed = self::TYPES[$ext] ?? [];

        switch ($ext) {
            case 'jpg':
            case 'jpeg':
            case 'png':
            case 'webp':
                $info = $tmp !== '' ? @getimagesize($tmp) : false;
                $type = is_array($info) ? ($info[2] ?? 0) : 0;

                return ($ext === 'png' && $type === IMAGETYPE_PNG)
                    || ($ext === 'webp' && $type === IMAGETYPE_WEBP)
                    || (($ext === 'jpg' || $ext === 'jpeg') && $type === IMAGETYPE_JPEG);
            case 'docx':
                // OOXML is a zip; require the PK signature and an acceptable MIME.
                return $this->startsWith($tmp, "PK\x03\x04") && ($mime === '' || in_array($mime, $allowed, true) || $mime === 'application/zip');
            case 'dcm':
                // DICOM files carry "DICM" at byte offset 128 (preamble); some
                // legacy files omit it, so also accept a generic binary MIME.
                return $this->dicomMagic($tmp) || $mime === '' || in_array($mime, $allowed, true);
            case 'mp4':
            case 'webm':
            case 'mov':
                return str_starts_with($mime, 'video/') || in_array($mime, $allowed, true) || $mime === 'application/octet-stream' || $mime === '';
            default: // pdf, doc
                return $mime === '' || in_array($mime, $allowed, true);
        }
    }

    private function dicomMagic(string $tmp): bool
    {
        if ($tmp === '' || !is_file($tmp)) {
            return false;
        }
        $fh = @fopen($tmp, 'rb');
        if ($fh === false) {
            return false;
        }
        $magic = '';
        if (@fseek($fh, 128) === 0) {
            $magic = (string) @fread($fh, 4);
        }
        @fclose($fh);

        return $magic === 'DICM';
    }

    private function startsWith(string $tmp, string $signature): bool
    {
        if ($tmp === '' || !is_file($tmp)) {
            return false;
        }
        $fh = @fopen($tmp, 'rb');
        if ($fh === false) {
            return false;
        }
        $head = (string) @fread($fh, strlen($signature));
        @fclose($fh);

        return $head === $signature;
    }

    private function canonicalExtension(string $ext): string
    {
        return $ext === 'jpeg' ? 'jpg' : $ext;
    }

    private function fallbackMime(string $ext): string
    {
        return match ($ext) {
            'pdf'  => 'application/pdf',
            'jpg'  => 'image/jpeg',
            'png'  => 'image/png',
            'webp' => 'image/webp',
            'docx' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'doc'  => 'application/msword',
            'dcm'  => 'application/dicom',
            'mp4'  => 'video/mp4',
            'webm' => 'video/webm',
            'mov'  => 'video/quicktime',
            default => 'application/octet-stream',
        };
    }

    /** Display title from the client filename (drop extension, clamp length). */
    private function titleFrom(string $clientName): string
    {
        $base = pathinfo($clientName, PATHINFO_FILENAME);
        $base = trim(preg_replace('/\s+/', ' ', $base) ?? '');
        if ($base === '') {
            $base = 'Document';
        }

        return mb_substr($base, 0, 200);
    }
}
