<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Exception\ValidationException;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\FollowUpService;
use DateTimeImmutable;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor/appointments/{id}/follow-up/quote?scheduled_at=…&waive=0|1 —
 * what a follow-up of consultation {id} would cost the patient, before the
 * doctor proposes it. Without `scheduled_at` it prices one starting now (the
 * answer then holds until `window_ends_at`). 422 when {id} can't have a
 * follow-up proposed yet. Doctor-owned only.
 */
final class FollowUpQuoteAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;

    public function __construct(
        private readonly UserRepository $users,
        private readonly AppointmentRepository $appointments,
        private readonly FollowUpService $followUps,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $parent = $this->doctorAppointment($request, $this->users, $this->appointments, (string) $args['id']);
        if ($parent === null) {
            return $this->error($response, 'You cannot manage this appointment', 403);
        }

        $now = new DateTimeImmutable();
        if (($problem = FollowUpService::doctorParentProblem($parent, $now)) !== null) {
            throw new ValidationException(['status' => $problem], $problem);
        }

        $query = $request->getQueryParams();
        $raw   = trim((string) ($query['scheduled_at'] ?? ''));
        $start = $raw !== '' ? FollowUpService::parseStart($raw) : $now;

        return $this->success(
            $response,
            $this->followUps->quote($parent, $start, filter_var($query['waive'] ?? false, FILTER_VALIDATE_BOOLEAN)),
        );
    }
}
