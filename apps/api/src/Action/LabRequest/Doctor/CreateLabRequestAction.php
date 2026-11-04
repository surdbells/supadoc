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
 * POST /api/doctor/lab-requests — sign and send a lab request (there are no
 * drafts): 201 LabRequestDto "Request sent". The body's `client_key` (uuid v4)
 * makes it safe to retry: the same form again answers 200 "Request already
 * sent" with that request; the key with other details is 409
 * `idempotency_conflict`. 409 `catalogue_changed` when the test list was
 * updated; 422 every form error ("Complete the request before sending"),
 * `not_consulted`, `appointment_id` or `duplicated_from`. Rate-limited
 * (`lab-send`).
 */
final class CreateLabRequestAction
{
    use LabActionSupport;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly LabRequestService $service,
    ) {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        [$doctor, $denied] = $this->labDoctor($request, $response, $this->users, $this->specialists);
        if ($doctor === null) {
            return $denied;
        }
        try {
            $out = $this->service->send($doctor, (string) $request->getAttribute('user_id'), $this->body($request));
        } catch (\Throwable $e) {
            return $this->refused($response, $e);
        }

        return $this->noStore($out['created']
            ? $this->created($response, $out['dto'], 'Request sent')
            : $this->success($response, $out['dto'], 'Request already sent'));
    }
}
