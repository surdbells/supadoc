<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Action\Patient\UploadMyAvatarAction;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Storage\ProfilePhotoStore;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * DELETE /api/doctor/avatar — remove the doctor's headshot (deletes the stored
 * file when it is one of this doctor's own uploads) and clear the profile photo.
 */
final class DeleteDoctorAvatarAction
{
    use ApiResponse;
    use ResolvesDoctorSpecialist;

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

        // Delete the stored file only when it is this doctor's own upload:
        // `photo_url` can be any /uploads path (PATCH /doctor/profile), and
        // must never delete someone else's file.
        $old = $specialist->getPhotoUrl();
        $specialist->setPhotoUrl(null);
        $this->specialists->save($specialist);
        if (ProfilePhotoStore::isOwnSpecialistUpload($old, $specialist->getId())) {
            UploadMyAvatarAction::deleteLocalAvatar($old);
        }

        return $this->success($response, $specialist->toPrivateArray(), 'Photo removed');
    }
}
