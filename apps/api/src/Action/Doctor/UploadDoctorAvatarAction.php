<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Action\Patient\UploadMyAvatarAction;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Message\UploadedFileInterface;

/**
 * POST /api/doctor/avatar (multipart, field `avatar`) — a doctor uploads their
 * public headshot. The bytes are validated as a real image (getimagesize + size
 * cap) and saved under a server-generated name with a whitelisted extension, so
 * nothing executable can land in the web root. Shares the patient avatar folder
 * and validation rules ({@see UploadMyAvatarAction}).
 */
final class UploadDoctorAvatarAction
{
    use ApiResponse;
    use ResolvesDoctorSpecialist;

    private const MAX_BYTES = 2 * 1024 * 1024;

    /** @var array<int,string> IMAGETYPE_* => file extension */
    private const ALLOWED = [
        IMAGETYPE_JPEG => 'jpg',
        IMAGETYPE_PNG  => 'png',
        IMAGETYPE_WEBP => 'webp',
        IMAGETYPE_GIF  => 'gif',
    ];

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $specialist = $this->doctorSpecialist($request, $this->users, $this->specialists);
        if ($specialist === null) {
            return $this->error($response, 'This account is not a doctor profile', 403);
        }

        $file = $request->getUploadedFiles()['avatar'] ?? null;
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

        $dir = UploadMyAvatarAction::avatarDir();
        if (!is_dir($dir)) {
            @mkdir($dir, 0o775, true);
        }

        $filename = 'dr-' . $specialist->getId() . '-' . bin2hex(random_bytes(4)) . '.' . $ext;
        $file->moveTo($dir . '/' . $filename);

        // Drop the previous local upload, then point the profile at the new file.
        UploadMyAvatarAction::deleteLocalAvatar($specialist->getPhotoUrl());
        $specialist->setPhotoUrl('/uploads/avatars/' . $filename);
        $this->specialists->save($specialist);

        return $this->success($response, $specialist->toPrivateArray(), 'Photo updated');
    }
}
