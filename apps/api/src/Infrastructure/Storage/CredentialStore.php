<?php

declare(strict_types=1);

namespace App\Infrastructure\Storage;

use App\Domain\Exception\ValidationException;
use DomainException;
use Psr\Http\Message\UploadedFileInterface;
use Psr\Log\LoggerInterface;

/**
 * Doctors' licensing documents (MDCN certificate, practising licence,
 * specialist certificates): a PDF, JPG or PNG of at most 10MB, checked by its
 * content as well as its name, then sealed in the {@see FileVault} under
 * `credentials/` — outside the web root, encrypted at rest, readable only
 * through the owner's and the reviewers' endpoints.
 *
 * The vault is built on first use (like {@see \App\Infrastructure\Prescription\SignatureStore}),
 * so a missing FILE_ENCRYPTION_KEY only stops document uploads, with a clear
 * message and a log entry.
 */
final class CredentialStore
{
    public const MAX_BYTES = 10 * 1024 * 1024;

    /** extension => MIME stored with the file */
    private const TYPES = ['pdf' => 'application/pdf', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'png' => 'image/png'];

    private ?FileVault $vault = null;

    /** @param FileVault|callable():FileVault $vaultFactory */
    public function __construct(
        private readonly mixed $vaultFactory,
        private readonly ?LoggerInterface $logger = null,
    ) {
    }

    /**
     * Validate an upload and read it: the bytes, a safe display name, the
     * MIME type (from the content) and the sha256.
     *
     * @return array{bytes:string, name:string, mime:string, size:int, sha256:string}
     * @throws ValidationException (field `file`)
     */
    public function read(UploadedFileInterface $file): array
    {
        if ($file->getError() !== UPLOAD_ERR_OK) {
            throw new ValidationException(['file' => $file->getError() === UPLOAD_ERR_INI_SIZE || $file->getError() === UPLOAD_ERR_FORM_SIZE
                ? self::tooLarge(self::MAX_BYTES)
                : 'No file was uploaded']);
        }
        $size = (int) ($file->getSize() ?? 0);
        if ($size > self::MAX_BYTES) {
            throw new ValidationException(['file' => self::tooLarge(self::MAX_BYTES)]);
        }
        $bytes = (string) $file->getStream();

        return self::inspect($bytes, (string) $file->getClientFilename());
    }

    /**
     * The content checks on their own (pure, for tests).
     *
     * @return array{bytes:string, name:string, mime:string, size:int, sha256:string}
     * @throws ValidationException
     */
    public static function inspect(string $bytes, string $clientName, int $maxBytes = self::MAX_BYTES, string $kinds = 'PDF, JPG or PNG'): array
    {
        $size = strlen($bytes);
        if ($size === 0) {
            throw new ValidationException(['file' => 'The file is empty']);
        }
        if ($size > $maxBytes) {
            throw new ValidationException(['file' => self::tooLarge($maxBytes)]);
        }
        $ext = strtolower(pathinfo($clientName, PATHINFO_EXTENSION));
        if (!isset(self::TYPES[$ext])) {
            throw new ValidationException(['file' => 'Upload a ' . $kinds . ' file' . ($kinds === 'PDF, JPG or PNG' ? '' : '.')]);
        }

        $matches = match ($ext) {
            'pdf'          => str_starts_with($bytes, '%PDF-'),
            'png'          => self::imageType($bytes) === IMAGETYPE_PNG,
            default        => self::imageType($bytes) === IMAGETYPE_JPEG,
        };
        if (!$matches) {
            throw new ValidationException(['file' => 'The file content does not match its type. Upload a ' . $kinds . ' file.']);
        }

        $base = trim(preg_replace('/[^\p{L}\p{N} ._()-]+/u', '_', pathinfo($clientName, PATHINFO_FILENAME)) ?? '');
        $name = mb_substr($base !== '' ? $base : 'document', 0, 180) . '.' . ($ext === 'jpeg' ? 'jpg' : $ext);

        return [
            'bytes'  => $bytes,
            'name'   => $name,
            'mime'   => self::TYPES[$ext],
            'size'   => $size,
            'sha256' => hash('sha256', $bytes),
        ];
    }

    /** "The file must be 10MB or smaller" — built from the limit. */
    public static function tooLarge(int $maxBytes): string
    {
        return 'The file must be ' . intdiv($maxBytes, 1024 * 1024) . 'MB or smaller';
    }

    /** @throws DomainException when secure storage isn't set up */
    public function store(string $bytes): string
    {
        try {
            return $this->vault()->put('credentials', $bytes);
        } catch (\Throwable $e) {
            $this->logger?->error('Credential document could not be stored', ['error' => $e->getMessage()]);

            throw new DomainException('Documents can’t be uploaded right now because secure file storage isn’t set up on the server. Please contact support.');
        }
    }

    /** The document's bytes, or null when missing or unreadable (logged). */
    public function bytes(string $key): ?string
    {
        try {
            $bytes = $this->vault()->get($key);
        } catch (\Throwable $e) {
            $this->logger?->error('Credential document could not be read from the vault', ['key' => $key, 'error' => $e->getMessage()]);

            return null;
        }
        if ($bytes === null) {
            $this->logger?->error('Credential document is missing or failed to decrypt (was FILE_ENCRYPTION_KEY changed?)', ['key' => $key]);
        }

        return $bytes;
    }

    public function delete(string $key): void
    {
        try {
            $this->vault()->delete($key);
        } catch (\Throwable) {
            // already gone / invalid key — nothing to remove
        }
    }

    private function vault(): FileVault
    {
        if ($this->vault === null) {
            $this->vault = $this->vaultFactory instanceof FileVault ? $this->vaultFactory : ($this->vaultFactory)();
        }

        return $this->vault;
    }

    private static function imageType(string $bytes): int
    {
        $info = @getimagesizefromstring($bytes);

        return is_array($info) ? (int) ($info[2] ?? 0) : 0;
    }
}
