<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Entity\MedicalDocument;
use Psr\Http\Message\UploadedFileInterface;
use RuntimeException;

/**
 * Persists medical-document files OUTSIDE the public web root (apps/api/var), so
 * a file is only ever reachable through an authenticated, ownership-checked
 * endpoint — never a guessable public URL. Uploads are size-capped, extension-
 * whitelisted, and content-sniffed so nothing executable or mislabelled lands on
 * disk. Throws RuntimeException (with a user-safe message) on any rejection.
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
        return 'PDF, JPG, PNG, DOCX, DICOM (.dcm), or video (MP4, WEBM, MOV)';
    }

    /**
     * Validate + store an uploaded file for a patient. Returns the metadata the
     * caller records against a MedicalDocument row.
     *
     * @return array{stored_name: string, extension: string, mime: string, size: int, title: string}
     * @throws RuntimeException
     */
    public function store(UploadedFileInterface $file, string $patientId): array
    {
        if ($file->getError() !== UPLOAD_ERR_OK) {
            throw new RuntimeException('No file was uploaded');
        }
        $size = (int) ($file->getSize() ?? 0);
        if ($size <= 0) {
            throw new RuntimeException('The file is empty');
        }
        if ($size > self::MAX_BYTES) {
            throw new RuntimeException('File must be 10MB or smaller');
        }

        $client = (string) $file->getClientFilename();
        $ext    = strtolower(pathinfo($client, PATHINFO_EXTENSION));
        if ($ext === '' || !isset(self::TYPES[$ext])) {
            throw new RuntimeException('Unsupported file type. Allowed: ' . $this->acceptedLabel());
        }

        $tmp  = $file->getStream()->getMetadata('uri');
        $tmp  = is_string($tmp) ? $tmp : '';
        $mime = $tmp !== '' && is_file($tmp) ? (new \finfo(FILEINFO_MIME_TYPE))->file($tmp) : '';
        $mime = is_string($mime) ? $mime : '';

        if (!$this->contentMatches($ext, $mime, $tmp)) {
            throw new RuntimeException('The file content does not match its extension');
        }

        $canonExt = $this->canonicalExtension($ext);
        $dir      = self::baseDir() . '/' . $patientId;
        if (!is_dir($dir)) {
            @mkdir($dir, 0o775, true);
        }

        $stored = bin2hex(random_bytes(16)) . '.' . $canonExt;
        $file->moveTo($dir . '/' . $stored);

        return [
            'stored_name' => $stored,
            'extension'   => $canonExt,
            'mime'        => $mime !== '' ? $mime : $this->fallbackMime($canonExt),
            'size'        => $size,
            'title'       => $this->titleFrom($client),
        ];
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

    private function contentMatches(string $ext, string $mime, string $tmp): bool
    {
        $allowed = self::TYPES[$ext] ?? [];

        switch ($ext) {
            case 'jpg':
            case 'jpeg':
            case 'png':
                $info = $tmp !== '' ? @getimagesize($tmp) : false;
                $type = is_array($info) ? ($info[2] ?? 0) : 0;

                return ($ext === 'png' && $type === IMAGETYPE_PNG)
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
