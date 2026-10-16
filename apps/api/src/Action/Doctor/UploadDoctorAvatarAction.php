<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Storage\PhotoRejectedException;
use App\Infrastructure\Storage\ProfilePhotoStore;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/doctor/avatar (multipart, field `avatar`) — a doctor uploads their
 * public headshot. The bytes are validated as a real image (getimagesize + size
 * cap) and saved under a server-generated name with a whitelisted extension, so
 * nothing executable can land in the web root. The checks and storage are
 * shared with the back office's upload ({@see ProfilePhotoStore}).
 */
final class UploadDoctorAvatarAction
{
    use ApiResponse;
    use ResolvesDoctorSpecialist;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly ProfilePhotoStore $photos,
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

        try {
            $url = $this->photos->storeSpecialistPhoto(
                $specialist->getId(),
                $request->getUploadedFiles()['avatar'] ?? null,
                ProfilePhotoStore::DOCTOR_TYPES,
            );
        } catch (PhotoRejectedException $e) {
            return $this->error($response, 'Validation failed', 422, ['avatar' => $e->getMessage()]);
        }

        // Point the profile at the new file, then drop the previous one — only
        // when it is this doctor's own upload: `photo_url` can be any /uploads
        // path (PATCH /doctor/profile), and must never delete someone else's file.
        $old = $specialist->getPhotoUrl();
        $specialist->setPhotoUrl($url);
        $this->specialists->save($specialist);
        if (ProfilePhotoStore::isOwnSpecialistUpload($old, $specialist->getId())) {
            $this->photos->deleteLocal($old);
        }

        return $this->success($response, $specialist->toPrivateArray(), 'Photo updated');
    }
}
