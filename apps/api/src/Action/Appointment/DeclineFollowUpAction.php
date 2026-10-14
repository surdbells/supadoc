<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Repository\AppointmentRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\FollowUpService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/appointments/{id}/follow-up/decline — the signed-in patient
 * declines their doctor's follow-up proposal {id}: `{reason?}` (up to 500
 * characters, shown to the doctor on the follow-up, never in a notice).
 * PROPOSED → CANCELLED (nothing was charged), the slot reopens and the doctor
 * is told. A repeat answers 200; 422 once accepted (cancel it instead).
 */
final class DeclineFollowUpAction
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
        $customerId = (string) $request->getAttribute('customer_id');
        $proposal   = $this->appointments->findForPatient((string) $args['id'], $customerId);
        if ($proposal === null) {
            return $this->error($response, 'Appointment not found', 404);
        }

        $body     = (array) ($request->getParsedBody() ?? []);
        $declined = $this->followUps->decline($proposal, isset($body['reason']) ? (string) $body['reason'] : null);

        return $this->success(
            $response,
            $proposal->toArray(),
            $declined ? 'Follow-up declined' : 'Follow-up proposal already closed',
        );
    }
}
