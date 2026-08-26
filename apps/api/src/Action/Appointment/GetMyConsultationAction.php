<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Entity\Appointment;
use App\Domain\Exception\EntityNotFoundException;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\ClinicalNoteRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/appointments/{id}/consultation — the patient's own consultation
 * summary. Only a *finalized* SOAP note is returned; a draft the doctor is still
 * writing is never exposed. Scoped by customer_id, so another patient's id 404s.
 */
final class GetMyConsultationAction
{
    use ApiResponse;

    public function __construct(
        private readonly AppointmentRepository $appointments,
        private readonly ClinicalNoteRepository $notes,
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

        $note = $this->notes->findByAppointment($id);
        if ($note === null || !$note->isFinalized()) {
            return $this->success($response, ['available' => false]);
        }

        return $this->success($response, $note->toPatientSummary());
    }
}
