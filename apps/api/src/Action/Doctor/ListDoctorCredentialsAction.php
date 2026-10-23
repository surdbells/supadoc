<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\SpecialistCredential;
use App\Domain\Repository\SpecialistCredentialRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Storage\CredentialStore;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor/credentials — the signed-in doctor's licensing documents
 * (newest first; replaced ones left out), each with its status and, when
 * turned down, the reviewer's reason; plus the document types and upload
 * limits for the upload form.
 */
final class ListDoctorCredentialsAction
{
    use ApiResponse;
    use ResolvesDoctorSpecialist;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly SpecialistCredentialRepository $credentials,
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

        $shown = array_values(array_filter(
            $this->credentials->forSpecialist($specialist->getId()),
            static fn (SpecialistCredential $c): bool => $c->getStatus() !== SpecialistCredential::STATUS_SUPERSEDED,
        ));

        return $this->success($response, [
            'credentials' => array_map(static fn (SpecialistCredential $c): array => $c->toArray(), $shown),
            // What this doctor may upload — by where they are licensed (spec §4.4).
            'types'       => array_map(
                static fn (string $type): array => [
                    'type'             => $type,
                    'label'            => SpecialistCredential::TYPES[$type] ?? $type,
                    'requires_expiry'  => SpecialistCredential::requiresExpiry($type),
                    'requires_number'  => SpecialistCredential::requiresNumber($type),
                ],
                SpecialistCredential::uploadableTypes($specialist->getLicenceRoute()),
            ),
            'max_bytes'   => CredentialStore::MAX_BYTES,
            'accepted'    => ['application/pdf', 'image/jpeg', 'image/png'],
        ]);
    }
}
