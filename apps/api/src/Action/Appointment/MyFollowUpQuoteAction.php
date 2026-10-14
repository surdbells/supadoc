<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Enum\AppointmentStatus;
use App\Domain\Exception\ValidationException;
use App\Domain\Repository\AppointmentRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\FollowUpService;
use DateTimeImmutable;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/appointments/{id}/follow-up/quote?scheduled_at=… — the
 * price the signed-in patient would pay, before paying:
 *   - {id} is one of their completed consultations: booking a follow-up of it
 *     (with that doctor) starting at `scheduled_at` (default now; the price
 *     holds until `window_ends_at`);
 *   - {id} is an open follow-up proposal: accepting it — at the proposed time
 *     the doctor's price stands, another `scheduled_at` is re-priced.
 * 422 otherwise (not completed yet, or not an open proposal).
 */
final class MyFollowUpQuoteAction
{
    use ApiResponse;

    public function __construct(
        private readonly AppointmentRepository $appointments,
        private readonly FollowUpService $followUps,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $customerId  = (string) $request->getAttribute('customer_id');
        $appointment = $this->appointments->findForPatient((string) $args['id'], $customerId);
        if ($appointment === null) {
            return $this->error($response, 'Appointment not found', 404);
        }

        $raw   = trim((string) ($request->getQueryParams()['scheduled_at'] ?? ''));
        $start = $raw !== '' ? FollowUpService::parseStart($raw) : null;
        $now   = new DateTimeImmutable();

        if ($appointment->getStatus() === AppointmentStatus::PROPOSED) {
            if (($problem = FollowUpService::responseProblem($appointment, $now)) !== null) {
                throw new ValidationException(['status' => $problem], $problem);
            }

            return $this->success($response, $this->followUps->proposalQuote($appointment, $start));
        }

        $problem = FollowUpService::patientParentProblem($appointment, $appointment->getSpecialist()->getId());
        if ($problem !== null) {
            throw new ValidationException([$problem[0] => $problem[1]], $problem[1]);
        }

        return $this->success($response, $this->followUps->quote($appointment, $start ?? $now));
    }
}
