<?php

declare(strict_types=1);

namespace App\Action\DocumentSharing;

use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Entity\Patient;
use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Document\DocumentSharingService;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/document-access/doctors/{specialistId}/allow-requests —
 * lift "Don't let Dr X ask again" (idempotent). SharingDoctorDto.
 */
final class AllowAccessRequestsAction
{
    use ApiResponse;
    use SharingActionSupport;

    public function __construct(
        private readonly PatientRepository $patients,
        private readonly DocumentSharingService $sharing,
    ) {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response, array $args): ResponseInterface
    {
        return $this->forPatient($request, $response, $this->patients, fn (Patient $p): ResponseInterface =>
            $this->success($response, $this->sharing->allowRequests($p, (string) $args['specialistId'], Rules::now()), 'Requests allowed'));
    }
}
