<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Entity\Appointment;
use App\Domain\Entity\Prescription;
use App\Domain\Exception\EntityNotFoundException;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\PrescriptionRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/appointments/{id}/prescriptions — prescriptions the patient has
 * been issued for this consultation. Signed only (a draft is never exposed) and
 * scoped by customer_id.
 */
final class MyPrescriptionsAction
{
    use ApiResponse;

    public function __construct(
        private readonly AppointmentRepository $appointments,
        private readonly PrescriptionRepository $prescriptions,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $customerId  = (string) $request->getAttribute('customer_id');
        $id          = (string) $args['id'];
        $appointment = $this->appointments->findForPatient($id, $customerId);
        if ($appointment === null) {
            throw EntityNotFoundException::for(Appointment::class, $id);
        }

        $rows = array_map(
            static fn (Prescription $p): array => $p->toArray(),
            $this->prescriptions->forAppointment($id, signedOnly: true),
        );

        return $this->success($response, $rows);
    }
}
