<?php

declare(strict_types=1);

namespace App\Infrastructure\Storage;

use App\Domain\Exception\ApplicationProblem;
use App\Domain\Exception\ValidationException;
use Predis\Client as RedisClient;
use Psr\Http\Message\UploadedFileInterface;
use Psr\Log\LoggerInterface;

/**
 * Doctor applicants' documents (spec §3.4): a PDF, PNG or JPG of at most 5MB,
 * checked by its content as well as its name ({@see CredentialStore::inspect()}),
 * then sealed in the {@see FileVault} under `applications/`. A sibling of
 * CredentialStore with the same lazily-built vault.
 *
 * The vault is on the API box's disk, so on top of the per-application caps
 * (20 files, 40MB — DoctorApplicationService) every upload reserves its bytes
 * in a global daily budget in Redis (`onb:bytes:day`, APPLICATION_UPLOAD_DAILY_BYTES,
 * default 2GB); a failed write gives them back. A spent budget, Redis down or a
 * vault failure: 503 `storage_unavailable`. Logs carry the exception class only.
 */
final class ApplicationDocumentStore
{
    public const MAX_BYTES = 5 * 1024 * 1024;

    public const FOLDER = 'applications';

    public const BUDGET_KEY = 'onb:bytes:day';

    public const UNAVAILABLE = "Documents can't be uploaded right now. Please try again later.";

    private ?FileVault $vault = null;

    /** @param FileVault|callable():FileVault $vaultFactory */
    public function __construct(
        private readonly mixed $vaultFactory,
        private readonly ?LoggerInterface $logger = null,
        private readonly ?RedisClient $redis = null,
        private readonly int $dailyBytes = 2147483648,
    ) {
    }

    /**
     * Validate an upload and read it.
     *
     * @return array{bytes:string, name:string, mime:string, size:int, sha256:string}
     * @throws ApplicationProblem 422 file_invalid (with `file`: the message)
     */
    public function read(UploadedFileInterface $file): array
    {
        if ($file->getError() !== UPLOAD_ERR_OK) {
            $this->invalid($file->getError() === UPLOAD_ERR_INI_SIZE || $file->getError() === UPLOAD_ERR_FORM_SIZE
                ? CredentialStore::tooLarge(self::MAX_BYTES)
                : 'No file was uploaded');
        }
        if ((int) ($file->getSize() ?? 0) > self::MAX_BYTES) {
            $this->invalid(CredentialStore::tooLarge(self::MAX_BYTES));
        }

        return self::inspect((string) $file->getStream(), (string) $file->getClientFilename());
    }

    /**
     * The content checks on their own (pure).
     *
     * @return array{bytes:string, name:string, mime:string, size:int, sha256:string}
     * @throws ApplicationProblem
     */
    public static function inspect(string $bytes, string $clientName): array
    {
        try {
            return CredentialStore::inspect($bytes, $clientName, self::MAX_BYTES, 'PDF, PNG or JPG');
        } catch (ValidationException $e) {
            $message = (string) ($e->getErrors()['file'] ?? 'Upload a PDF, PNG or JPG file.');

            throw new ApplicationProblem(422, 'file_invalid', $message, ['file' => $message]);
        }
    }

    /**
     * Reserve `$bytes` of today's global budget (given back by {@see release()}).
     *
     * @throws ApplicationProblem 503 storage_unavailable
     */
    public function reserve(int $bytes): void
    {
        if ($this->redis === null) {
            return;
        }
        try {
            $this->redis->set(self::BUDGET_KEY, 0, 'EX', 86400, 'NX');
            $used = (int) $this->redis->incrby(self::BUDGET_KEY, $bytes);
        } catch (\Throwable $e) {
            $this->logger?->error('Application upload budget unavailable', ['error' => $e::class]);

            throw new ApplicationProblem(503, 'storage_unavailable', self::UNAVAILABLE);
        }
        if ($used > $this->dailyBytes) {
            $this->release($bytes);
            $this->logger?->warning('Application upload budget spent for today', ['budget' => $this->dailyBytes]);

            throw new ApplicationProblem(503, 'storage_unavailable', self::UNAVAILABLE);
        }
    }

    public function release(int $bytes): void
    {
        if ($this->redis === null || $bytes <= 0) {
            return;
        }
        try {
            $this->redis->decrby(self::BUDGET_KEY, $bytes);
        } catch (\Throwable) {
            // the window resets on its own
        }
    }

    /** @throws ApplicationProblem 503 storage_unavailable */
    public function store(string $bytes): string
    {
        try {
            return $this->vault()->put(self::FOLDER, $bytes);
        } catch (\Throwable $e) {
            $this->logger?->error('Application document could not be stored', ['error' => $e::class]);

            throw new ApplicationProblem(503, 'storage_unavailable', self::UNAVAILABLE);
        }
    }

    /** The bytes, or null when missing or unreadable (logged by class only). */
    public function bytes(string $key): ?string
    {
        try {
            $bytes = $this->vault()->get($key);
        } catch (\Throwable $e) {
            $this->logger?->error('Application document could not be read', ['error' => $e::class]);

            return null;
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

    /** @throws ApplicationProblem */
    private function invalid(string $message): never
    {
        throw new ApplicationProblem(422, 'file_invalid', $message, ['file' => $message]);
    }

    private function vault(): FileVault
    {
        if ($this->vault === null) {
            $this->vault = $this->vaultFactory instanceof FileVault ? $this->vaultFactory : ($this->vaultFactory)();
        }

        return $this->vault;
    }
}
