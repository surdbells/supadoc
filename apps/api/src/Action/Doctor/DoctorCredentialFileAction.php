<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Action\Document\StreamsCredential;
use App\Domain\Repository\SpecialistCredentialRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\DoctorCredentialService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor/credentials/{id}/file — the doctor opens one of their own
 * licensing documents (decrypted, inline, never cached). 404 for anyone
 * else's.
 */
final class DoctorCredentialFileAction
{
    use ApiResponse;
    use ResolvesDoctorSpecialist;
    use StreamsCredential;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly SpecialistCredentialRepository $credentials,
        private readonly DoctorCredentialService $service,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $specialist = $this->doctorSpecialist($request, $this->users, $this->specialists);
        if ($specialist === null) {
            return $this->error($response, 'This account is not a doctor profile', 403);
        }
        $credential = $this->credentials->findForSpecialist((string) ($args['id'] ?? ''), $specialist->getId());
        if ($credential === null) {
            return $this->error($response, 'Document not found', 404);
        }

        return $this->streamCredential($response, $credential, $this->service->bytes($credential));
    }
}
