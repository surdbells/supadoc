<?php

declare(strict_types=1);

namespace App\Action\Specialist;

use App\Domain\Entity\Specialist;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AuditLogger;
use App\Infrastructure\Storage\ProfilePhotoStore;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * DELETE /api/specialists/{id}/photo — the back office removes a doctor's
 * headshot: the profile photo is cleared and the stored file deleted when it
 * is one of this doctor's own uploads. Gated on `specialists.manage`.
 * Idempotent (no photo → 200, nothing audited); a removal is audited as
 * `specialist.updated` with the photo_url before/after (`via: photo_remove`).
 * The response is the PATCH /specialists/{id} payload.
 */
final class DeleteSpecialistPhotoAction
{
    use ApiResponse;
    use AuditsSpecialistReview;

    public function __construct(
        private readonly SpecialistRepository $specialists,
        private readonly UserRepository $users,
        private readonly AuditLogger $audit,
        private readonly ProfilePhotoStore $photos,
    ) {
    }

    /** @param array<string,string> $args */
    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        /** @var Specialist $specialist */
        $specialist = $this->specialists->findOrFail((string) $args['id']);
        $before     = $specialist->getPhotoUrl();

        if ($before !== null) {
            $specialist->setPhotoUrl(null);
            $this->specialists->save($specialist);

            if (ProfilePhotoStore::isOwnSpecialistUpload($before, $specialist->getId())) {
                $this->photos->deleteLocal($before);
            }

            $this->auditReview($request, $this->users, $this->audit, 'specialist.updated', $specialist, [
                'before' => ['photo_url' => $before],
                'after'  => ['photo_url' => null],
                'via'    => 'photo_remove',
            ]);
        }

        return $this->success($response, UploadSpecialistPhotoAction::payload($specialist), 'Photo removed');
    }
}
