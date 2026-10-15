<?php

declare(strict_types=1);

namespace App\Action\Specialist;

use App\Action\Document\StreamsCredential;
use App\Domain\Entity\Specialist;
use App\Domain\Repository\SpecialistCredentialRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AuditLogger;
use App\Infrastructure\Service\DoctorCredentialService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/specialists/{id}/credentials/{cid}/file — a reviewer opens one of the
 * doctor's licensing documents (decrypted from the vault, inline, never
 * cached). Every view is audited (`specialist.credential_viewed`, by whom).
 * Needs `specialists.manage`; 404 for a document that isn't this doctor's.
 */
final class SpecialistCredentialFileAction
{
    use ApiResponse;
    use AuditsSpecialistReview;
    use StreamsCredential;

    public function __construct(
        private readonly SpecialistRepository $specialists,
        private readonly SpecialistCredentialRepository $credentials,
        private readonly DoctorCredentialService $service,
        private readonly UserRepository $users,
        private readonly AuditLogger $audit,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        /** @var Specialist $specialist */
        $specialist = $this->specialists->findOrFail((string) ($args['id'] ?? ''));
        $credential = $this->credentials->findForSpecialist((string) ($args['cid'] ?? ''), $specialist->getId());
        if ($credential === null) {
            return $this->error($response, 'Document not found', 404);
        }

        $bytes = $this->service->bytes($credential);
        $this->auditReview($request, $this->users, $this->audit, 'specialist.credential_viewed', $specialist, [
            'credential_id' => $credential->getId(),
            'type'          => $credential->getType(),
            'readable'      => $bytes !== null,
        ]);

        return $this->streamCredential($response, $credential, $bytes);
    }
}
