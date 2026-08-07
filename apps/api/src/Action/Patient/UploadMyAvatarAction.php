<?php

declare(strict_types=1);

namespace App\Action\Patient;

use App\Domain\Entity\Patient;
use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Message\UploadedFileInterface;

/**
 * POST /api/portal/me/avatar (multipart, field `avatar`) — upload a profile
 * photo. The image is validated for real (getimagesize, size cap) and saved
 * under a server-generated name with a whitelisted extension, so an attacker
 * can never place an executable file in the public web root.
 */
final class UploadMyAvatarAction
{
    use ApiResponse;

    private const MAX_BYTES = 2 * 1024 * 1024;

    /** @var array<int,string> IMAGETYPE_* => file extension */
    private const ALLOWED = [
        IMAGETYPE_JPEG => 'jpg',
        IMAGETYPE_PNG  => 'png',
        IMAGETYPE_WEBP => 'webp',
        IMAGETYPE_GIF  => 'gif',
    ];

    public function __construct(private readonly PatientRepository $patients)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $customerId = (string) $request->getAttribute('customer_id');
        $file       = $request->getUploadedFiles()['avatar'] ?? null;

        if (!$file instanceof UploadedFileInterface || $file->getError() !== UPLOAD_ERR_OK) {
            return $this->error($response, 'Validation failed', 422, ['avatar' => 'No image was uploaded']);
        }
        if (($file->getSize() ?? 0) > self::MAX_BYTES) {
            return $this->error($response, 'Validation failed', 422, ['avatar' => 'Image must be 2MB or smaller']);
        }

        // Never trust the client filename/type — verify the bytes are an image.
        $tmpPath = $file->getStream()->getMetadata('uri');
        $info    = is_string($tmpPath) ? @getimagesize($tmpPath) : false;
        $ext     = is_array($info) ? (self::ALLOWED[$info[2]] ?? null) : null;
        if ($ext === null) {
            return $this->error($response, 'Validation failed', 422, ['avatar' => 'Only JPG, PNG, WEBP or GIF images are allowed']);
        }

        /** @var Patient $patient */
        $patient = $this->patients->findOrFail($customerId);

        $dir = self::avatarDir();
        if (!is_dir($dir)) {
            @mkdir($dir, 0o775, true);
        }

        $filename = $customerId . '-' . bin2hex(random_bytes(4)) . '.' . $ext;
        $file->moveTo($dir . '/' . $filename);

        // Drop the previous upload, then point the profile at the new file.
        self::deleteLocalAvatar($patient->getAvatarUrl());
        $patient->setAvatarUrl('/uploads/avatars/' . $filename);
        $this->patients->save($patient);

        return $this->success($response, $patient->toArray(), 'Photo updated');
    }

    public static function avatarDir(): string
    {
        return dirname(__DIR__, 3) . '/public/uploads/avatars';
    }

    /** Remove a previously-stored local avatar file (ignores external URLs). */
    public static function deleteLocalAvatar(?string $url): void
    {
        if ($url === null || !str_starts_with($url, '/uploads/avatars/')) {
            return;
        }
        $path = dirname(__DIR__, 3) . '/public' . $url;
        if (is_file($path)) {
            @unlink($path);
        }
    }
}
