<?php

declare(strict_types=1);

namespace App\Infrastructure\Storage;

use Psr\Http\Message\UploadedFileInterface;

/**
 * Doctor headshots in the public avatar folder (public/uploads/avatars), shared
 * by the doctor's own upload (POST /api/doctor/avatar) and the back office's
 * (POST /api/specialists/{id}/photo), so both get the same checks:
 *
 *  - the upload arrived (UPLOAD_ERR_OK) and is at most MAX_BYTES;
 *  - the BYTES are an image of an allowed type (getimagesize — the client's
 *    filename and Content-Type are never trusted);
 *  - it is saved under a server-generated name (`dr-{specialist id}-{random}`)
 *    with the extension of the detected type, so nothing executable can land
 *    in the web root.
 *
 * Every rule a caller breaks is a {@see PhotoRejectedException} whose message
 * is the user-facing reason (the actions turn it into a 422 field error).
 */
final class ProfilePhotoStore
{
    public const MAX_BYTES = 2 * 1024 * 1024;

    /** Public URL prefix of the avatar folder. */
    public const URL_PREFIX = '/uploads/avatars/';

    /** What the doctor's own upload has always accepted. @var array<int,string> IMAGETYPE_* => extension */
    public const DOCTOR_TYPES = [
        IMAGETYPE_JPEG => 'jpg',
        IMAGETYPE_PNG  => 'png',
        IMAGETYPE_WEBP => 'webp',
        IMAGETYPE_GIF  => 'gif',
    ];

    /** What the back office may upload for a doctor: JPG, PNG or WebP. @var array<int,string> */
    public const STAFF_TYPES = [
        IMAGETYPE_JPEG => 'jpg',
        IMAGETYPE_PNG  => 'png',
        IMAGETYPE_WEBP => 'webp',
    ];

    private readonly string $publicDir;

    /** `$publicDir`: the web root holding /uploads (tests point it at a temp folder). */
    public function __construct(?string $publicDir = null)
    {
        $this->publicDir = rtrim($publicDir ?? dirname(__DIR__, 3) . '/public', '/\\');
    }

    public function avatarDir(): string
    {
        return $this->publicDir . '/uploads/avatars';
    }

    /**
     * Check an upload against the shared rules; returns the extension to save
     * it with.
     *
     * @param array<int,string> $allowed IMAGETYPE_* => extension
     *
     * @throws PhotoRejectedException with the reason to show the user
     */
    public function validate(mixed $file, array $allowed = self::DOCTOR_TYPES): string
    {
        if (!$file instanceof UploadedFileInterface) {
            throw new PhotoRejectedException('No image was uploaded');
        }
        $error = $file->getError();
        if ($error === UPLOAD_ERR_INI_SIZE || $error === UPLOAD_ERR_FORM_SIZE) {
            throw new PhotoRejectedException('Image must be 2MB or smaller');
        }
        if ($error !== UPLOAD_ERR_OK) {
            throw new PhotoRejectedException('No image was uploaded');
        }
        if (($file->getSize() ?? 0) > self::MAX_BYTES) {
            throw new PhotoRejectedException('Image must be 2MB or smaller');
        }

        // Never trust the client filename/type — verify the bytes are an image.
        $tmpPath = $file->getStream()->getMetadata('uri');
        $info    = is_string($tmpPath) ? @getimagesize($tmpPath) : false;
        $ext     = is_array($info) ? ($allowed[$info[2]] ?? null) : null;
        if ($ext === null) {
            throw new PhotoRejectedException(self::typesMessage($allowed));
        }

        return $ext;
    }

    /**
     * Validate and save a doctor's headshot; returns its public URL
     * (`/uploads/avatars/dr-{id}-{random}.{ext}`). The caller points the
     * profile at it and then drops the previous file ({@see deleteLocal()}).
     *
     * @param array<int,string> $allowed
     *
     * @throws PhotoRejectedException
     */
    public function storeSpecialistPhoto(string $specialistId, mixed $file, array $allowed = self::DOCTOR_TYPES): string
    {
        $ext = $this->validate($file, $allowed);
        \assert($file instanceof UploadedFileInterface);

        $dir = $this->avatarDir();
        if (!is_dir($dir)) {
            @mkdir($dir, 0o775, true);
        }

        $filename = 'dr-' . $specialistId . '-' . bin2hex(random_bytes(4)) . '.' . $ext;
        $file->moveTo($dir . '/' . $filename);

        return self::URL_PREFIX . $filename;
    }

    /**
     * Is `$url` one of this specialist's own stored headshots (uploaded by the
     * doctor or the back office)? The only kind of file a photo replace or
     * removal deletes — `photo_url` may hold another path (an older link, or
     * whatever the doctor's own PATCH set), and that file is never touched.
     */
    public static function isOwnSpecialistUpload(?string $url, string $specialistId): bool
    {
        if ($url === null || $specialistId === '') {
            return false;
        }
        $pattern = '#^' . preg_quote(self::URL_PREFIX . 'dr-' . $specialistId . '-', '#') . '[0-9a-f]{8}\.(?:jpg|png|webp|gif)$#';

        return preg_match($pattern, $url) === 1;
    }

    /**
     * The back office's `photo_url` rule (PATCH /specialists/{id}): photos are
     * uploaded (POST /specialists/{id}/photo), never linked, so the only values
     * accepted are '' (clear it) or the current value unchanged (a form
     * re-sending what it loaded — e.g. an older external link). Not even an
     * earlier upload of this doctor: its file was deleted when it was
     * replaced, so the profile would point at a missing image. The reason to
     * show, or null when `$value` is acceptable.
     */
    public static function staffPhotoUrlError(string $value, ?string $current): ?string
    {
        if ($value === '' || ($current !== null && $value === trim($current))) {
            return null;
        }

        return 'Upload a photo instead — links are not accepted';
    }

    /**
     * Remove a previously-stored local avatar file (ignores external URLs).
     * Hardened against path traversal: rejects any '..' segment and confirms
     * the resolved path is still inside the avatar folder before unlinking.
     */
    public function deleteLocal(?string $url): void
    {
        if ($url === null || !str_starts_with($url, self::URL_PREFIX) || str_contains($url, '..')) {
            return;
        }
        $real = realpath($this->publicDir . $url);
        $base = realpath($this->avatarDir());
        if ($real === false || $base === false || !str_starts_with($real, $base . DIRECTORY_SEPARATOR)) {
            return;
        }
        if (is_file($real)) {
            @unlink($real);
        }
    }

    /** @param array<int,string> $allowed */
    private static function typesMessage(array $allowed): string
    {
        $names = array_map(
            static fn (string $ext): string => match ($ext) {
                'jpg'  => 'JPG',
                'png'  => 'PNG',
                'webp' => 'WEBP',
                'gif'  => 'GIF',
                default => strtoupper($ext),
            },
            array_values($allowed),
        );
        $last = array_pop($names);

        return 'Only ' . ($names !== [] ? implode(', ', $names) . ' or ' : '') . $last . ' images are allowed';
    }
}
