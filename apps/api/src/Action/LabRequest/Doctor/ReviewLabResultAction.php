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
 * POST /api/doctor/lab-requests/{labId}/results/{resultId}/review
 * {outcome: normal|abnormal, comment} — the requesting doctor reviews a result
 * they can open now (409 `not_shared` / `not_viewable`); a note (3–1000) is
 * required for Abnormal. Reviews can be changed (latest wins); the patient is
 * told each time — never the outcome. 200 LabRequestDto "Review saved".
 */
final class ReviewLabResultAction
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
            $dto = $this->service->review($doctor, (string) $request->getAttribute('user_id'), (string) $args['labId'], (string) $args['resultId'], $this->body($request));
        } catch (\Throwable $e) {
            return $this->refused($response, $e);
        }

        return $this->noStore($this->success($response, $dto, 'Review saved'));
    }
}
