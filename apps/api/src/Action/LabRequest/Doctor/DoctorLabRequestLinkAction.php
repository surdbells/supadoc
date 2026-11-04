<?php

declare(strict_types=1);

namespace App\Action\LabRequest\Doctor;

use App\Action\LabRequest\LabActionSupport;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Lab\LabRequestService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/doctor/lab-requests/{labId}/link {download?} — a 15-minute signed
 * URL to the request PDF for the requesting doctor (watermarked NOT YET
 * ACCEPTED while the patient hasn't answered). Rate-limited (`lab-link`).
 */
final class DoctorLabRequestLinkAction
{
    use LabActionSupport;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly LabRequestService $service,
    ) {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response, array $args): ResponseInterface
    {
        [$doctor, $denied] = $this->labDoctor($request, $response, $this->users, $this->specialists);
        if ($doctor === null) {
            return $denied;
        }
        try {
            $r = $this->service->doctorRequest($doctor, (string) $args['labId']);
        } catch (\Throwable $e) {
            return $this->refused($response, $e);
        }
        $download = filter_var($this->body($request)['download'] ?? false, FILTER_VALIDATE_BOOLEAN);

        return $this->noStore($this->success($response, $this->service->issueLink($r, 'doctor', $doctor->getId(), $download)));
    }
}
