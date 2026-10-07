<?php

declare(strict_types=1);

namespace App\Infrastructure\Prescription;

use App\Domain\Exception\ValidationException;
use DomainException;
use App\Infrastructure\Storage\FileVault;
use Psr\Log\LoggerInterface;

/**
 * Doctors' signature pictures (GVM-RX-02 AC13): a saved PNG/JPG under 500 KB
 * that only the doctor can add or change, plus the copy frozen into each sent
 * prescription. Images are re-encoded to a flat (no alpha) PNG — that strips
 * any metadata or payload smuggled in the upload and gives the PDF renderer a
 * format it can always embed — then stored encrypted in the {@see FileVault}.
 *
 * The vault is built on first use, so a missing/invalid FILE_ENCRYPTION_KEY
 * only affects signature operations (with a clear message and a log entry),
 * never the rest of e-prescribing.
 */
final class SignatureStore
{
    public const MAX_BYTES = 512_000;

    private ?FileVault $vault = null;

    /** @param FileVault|callable():FileVault $vault */
    public function __construct(
        private readonly mixed $vaultFactory,
        private readonly ?LoggerInterface $logger = null,
    ) {
    }

    private function vault(): FileVault
    {
        if ($this->vault === null) {
            $this->vault = $this->vaultFactory instanceof FileVault ? $this->vaultFactory : ($this->vaultFactory)();
        }

        return $this->vault;
    }

    /**
     * Validate + normalise an uploaded/drawn signature; returns PNG bytes.
     *
     * @throws ValidationException
     */
    public function normalize(string $bytes, string $field = 'signature'): string
    {
        if ($bytes === '') {
            throw new ValidationException([$field => 'Add a signature picture']);
        }
        if (strlen($bytes) > self::MAX_BYTES) {
            throw new ValidationException([$field => sprintf(
                'This picture is %s KB. The limit is 500 KB.',
                number_format(strlen($bytes) / 1024),
            )]);
        }
        $info = @getimagesizefromstring($bytes);
        if ($info === false || !in_array($info[2], [IMAGETYPE_PNG, IMAGETYPE_JPEG], true)) {
            throw new ValidationException([$field => 'Upload a PNG or JPG picture of your signature']);
        }
        if ($info[0] < 40 || $info[1] < 15 || $info[0] > 4000 || $info[1] > 4000) {
            throw new ValidationException([$field => 'The signature picture must be between 40×15 and 4000×4000 pixels']);
        }

        if (!function_exists('imagecreatefromstring')) {
            return $bytes; // no GD: keep the validated original
        }
        $src = @imagecreatefromstring($bytes);
        if ($src === false) {
            throw new ValidationException([$field => 'This picture could not be read. Try another PNG or JPG.']);
        }
        [$w, $h] = [imagesx($src), imagesy($src)];
        // Downscale very large pictures — a signature box is ~60 mm wide.
        $scale = min(1.0, 1200 / $w, 480 / $h);
        $nw    = max(1, (int) round($w * $scale));
        $nh    = max(1, (int) round($h * $scale));
        $dst   = imagecreatetruecolor($nw, $nh);
        imagefill($dst, 0, 0, (int) imagecolorallocate($dst, 255, 255, 255));
        imagecopyresampled($dst, $src, 0, 0, 0, 0, $nw, $nh, $w, $h);
        ob_start();
        imagepng($dst, null, 9);
        $png = (string) ob_get_clean();
        imagedestroy($src);
        imagedestroy($dst);

        return $png;
    }

    /** Decode a drawn signature sent as a `data:image/png;base64,…` URL. */
    public function fromDataUrl(string $dataUrl, string $field = 'signature'): string
    {
        if (preg_match('#^data:image/(png|jpe?g);base64,([A-Za-z0-9+/=\s]+)$#', trim($dataUrl), $m) !== 1) {
            throw new ValidationException([$field => 'Sign in the box before sending']);
        }
        $bytes = base64_decode(preg_replace('/\s+/', '', $m[2]) ?? '', true);
        if ($bytes === false) {
            throw new ValidationException([$field => 'Sign in the box before sending']);
        }

        return $this->normalize($bytes, $field);
    }

    /** @throws DomainException when the vault is not configured / writable */
    public function store(string $pngBytes, string $folder = 'signatures'): string
    {
        try {
            return $this->vault()->put($folder, $pngBytes);
        } catch (\Throwable $e) {
            $this->logger?->error('Signature could not be stored', ['error' => $e->getMessage()]);

            throw new DomainException('Signatures can’t be saved right now because secure file storage isn’t set up on the server. Please contact support.');
        }
    }

    public function read(?string $key): ?string
    {
        if ($key === null || $key === '') {
            return null;
        }
        try {
            $bytes = $this->vault()->get($key);
        } catch (\Throwable $e) {
            $this->logger?->error('Signature could not be read from the vault', ['key' => $key, 'error' => $e->getMessage()]);

            return null;
        }
        if ($bytes === null && $this->vault()->exists($key)) {
            // Stored but undecryptable: almost always a changed FILE_ENCRYPTION_KEY.
            $this->logger?->error('Stored signature failed to decrypt (was FILE_ENCRYPTION_KEY changed?)', ['key' => $key]);
        }

        return $bytes;
    }

    public function delete(?string $key): void
    {
        if ($key !== null && $key !== '') {
            try {
                $this->vault()->delete($key);
            } catch (\Throwable) {
                // already gone / invalid key — nothing to remove
            }
        }
    }
}
