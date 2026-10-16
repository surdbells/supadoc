<?php

declare(strict_types=1);

namespace App\Action\Specialist;

use App\Domain\Entity\Specialist;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AuditLogger;
use App\Infrastructure\Storage\PhotoRejectedException;
use App\Infrastructure\Storage\ProfilePhotoStore;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/specialists/{id}/photo (multipart, field `photo`) — the back office
 * uploads (or replaces) a doctor's public headshot: JPG, PNG or WebP, ≤ 2MB,
 * checked and stored exactly like the doctor's own upload
 * ({@see ProfilePhotoStore}). Gated on `specialists.manage`.
 *
 * The new file is saved first, the profile pointed at it, and only then is the
 * previous file deleted — and only when it was one of this doctor's own
 * uploads (an older hand-entered link is just replaced). Audited as
 * `specialist.updated` with the photo_url before/after (`via: photo_upload`),
 * so the doctor's History tab shows it like any other edit. The response is
 * the PATCH /specialists/{id} payload.
 */
final class UploadSpecialistPhotoAction
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
        // findOrFail throws → 404 for an unknown id.
        /** @var Specialist $specialist */
        $specialist = $this->specialists->findOrFail((string) $args['id']);
        $before     = $specialist->getPhotoUrl();

        try {
            $url = $this->photos->storeSpecialistPhoto(
                $specialist->getId(),
                $request->getUploadedFiles()['photo'] ?? null,
                ProfilePhotoStore::STAFF_TYPES,
            );
        } catch (PhotoRejectedException $e) {
            return $this->error($response, 'Validation failed', 422, ['photo' => $e->getMessage()]);
        }

        $specialist->setPhotoUrl($url);
        $this->specialists->save($specialist);

        if (ProfilePhotoStore::isOwnSpecialistUpload($before, $specialist->getId())) {
            $this->photos->deleteLocal($before);
        }

        $this->auditReview($request, $this->users, $this->audit, 'specialist.updated', $specialist, [
            'before' => ['photo_url' => $before],
            'after'  => ['photo_url' => $url],
            'via'    => 'photo_upload',
        ]);

        return $this->success($response, self::payload($specialist), 'Photo updated');
    }

    /**
     * The PATCH /specialists/{id} response shape (public profile + the
     * server-side email + review state).
     *
     * @return array<string,mixed>
     */
    public static function payload(Specialist $specialist): array
    {
        return $specialist->toArray() + ['email' => $specialist->getEmail()] + $specialist->toReviewArray();
    }
}
