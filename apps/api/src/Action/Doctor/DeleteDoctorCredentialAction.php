<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Repository\SpecialistCredentialRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\DoctorCredentialService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * DELETE /api/doctor/credentials/{id} — the doctor deletes one of their
 * documents while it is still waiting for review (the file is destroyed). A
 * verified or turned-down document stays on record: 422. Audited.
 */
final class DeleteDoctorCredentialAction
{
    use ApiResponse;
    use ResolvesDoctorSpecialist;

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

        $this->service->deleteByDoctor($specialist, $credential, (string) $request->getAttribute('user_id'));

        return $this->success($response, null, 'Document deleted');
    }
}
