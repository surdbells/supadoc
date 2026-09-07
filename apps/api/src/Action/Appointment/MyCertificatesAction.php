<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Entity\Appointment;
use App\Domain\Entity\MedicalCertificate;
use App\Domain\Exception\EntityNotFoundException;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\MedicalCertificateRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/appointments/{id}/certificates — the patient's own medical
 * certificates for this consultation. Scoped by customer_id.
 */
final class MyCertificatesAction
{
    use ApiResponse;

    public function __construct(
        private readonly AppointmentRepository $appointments,
        private readonly MedicalCertificateRepository $certificates,
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

        $items = array_map(
            static fn (MedicalCertificate $c): array => $c->toArray(),
            $this->certificates->forAppointment($id),
        );

        return $this->success($response, $items);
    }
}
