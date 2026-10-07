<?php

declare(strict_types=1);

namespace App\Infrastructure\Storage;

use RuntimeException;

/**
 * Encrypted-at-rest blob storage for sensitive files (doctors' signatures, the
 * signature frozen into each prescription). Files live outside the web root and
 * are sealed with AES-256-GCM; the storage key is bound in as associated data,
 * so a blob copied to another key fails to decrypt instead of being served.
 *
 * Key: FILE_ENCRYPTION_KEY (base64 of 32 random bytes). A malformed key is
 * refused outright, and in production the key is required — a silent fallback
 * would later strand every stored file when the "real" key is finally set.
 * Outside production, an unset key falls back to one derived from JWT_SECRET.
 */
final class FileVault
{
    private const CIPHER = 'aes-256-gcm';

    public function __construct(
        private readonly string $baseDir,
        private readonly string $key,
    ) {
        if (strlen($key) !== 32) {
            throw new RuntimeException('FileVault needs a 32-byte key');
        }
    }

    /**
     * The 32-byte key from FILE_ENCRYPTION_KEY. Throws when the value is set but
     * malformed, or unset in production; otherwise (dev/test, unset) derives one
     * from the app secret.
     */
    public static function keyFrom(string $configured, string $fallbackSecret, bool $production = false): string
    {
        $configured = trim($configured);
        if ($configured !== '') {
            $raw = base64_decode($configured, true);
            if ($raw === false || strlen($raw) !== 32) {
                throw new RuntimeException('FILE_ENCRYPTION_KEY must be base64 of exactly 32 bytes — generate one with: openssl rand -base64 32');
            }

            return $raw;
        }
        if ($production) {
            throw new RuntimeException('FILE_ENCRYPTION_KEY is not set. Generate one with: openssl rand -base64 32 — add it to .env once, and never change it.');
        }

        return hash('sha256', 'videomed-file-vault|' . $fallbackSecret, true);
    }

    /** Whether a blob is stored under `$key` (readable or not). */
    public function exists(string $key): bool
    {
        try {
            return is_file($this->path($key));
        } catch (\Throwable) {
            return false;
        }
    }

    /** Seal and store `$bytes` under a fresh key in `$folder`; returns the key. */
    public function put(string $folder, string $bytes): string
    {
        $folder = trim(preg_replace('/[^a-z0-9\-]/', '', strtolower($folder)) ?? '', '-');
        $key    = ($folder !== '' ? $folder : 'misc') . '/' . bin2hex(random_bytes(16)) . '.bin';
        $iv     = random_bytes(12);
        $tag    = '';
        $sealed = openssl_encrypt($bytes, self::CIPHER, $this->key, OPENSSL_RAW_DATA, $iv, $tag, $key);
        if ($sealed === false) {
            throw new RuntimeException('Could not encrypt the file');
        }

        $path = $this->path($key);
        $dir  = dirname($path);
        if (!is_dir($dir) && !@mkdir($dir, 0o770, true) && !is_dir($dir)) {
            throw new RuntimeException(sprintf('vault directory not writable by the web user: %s (chown -R www:www var)', $dir));
        }
        if (@file_put_contents($path, $iv . $tag . $sealed, LOCK_EX) === false) {
            throw new RuntimeException(sprintf('vault directory not writable by the web user: %s (chown -R www:www var)', $dir));
        }

        return $key;
    }

    /** The decrypted bytes, or null when missing or tampered with. */
    public function get(string $key): ?string
    {
        $path = $this->path($key);
        if (!is_file($path)) {
            return null;
        }
        $blob = (string) file_get_contents($path);
        if (strlen($blob) < 29) {
            return null;
        }
        $plain = openssl_decrypt(substr($blob, 28), self::CIPHER, $this->key, OPENSSL_RAW_DATA, substr($blob, 0, 12), substr($blob, 12, 16), $key);

        return $plain === false ? null : $plain;
    }

    public function delete(string $key): void
    {
        $path = $this->path($key);
        if (is_file($path)) {
            @unlink($path);
        }
    }

    private function path(string $key): string
    {
        if (preg_match('/^[a-z0-9\-]+\/[a-f0-9]{32}\.bin$/', $key) !== 1) {
            throw new RuntimeException('Invalid vault key');
        }

        return rtrim($this->baseDir, '/\\') . '/' . $key;
    }
}
