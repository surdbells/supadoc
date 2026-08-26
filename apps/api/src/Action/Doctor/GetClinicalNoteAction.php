<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\ClinicalNoteRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor/appointments/{id}/note — the SOAP note for one of the doctor's
 * own consultations. Returns an empty draft shell when none exists yet, so the
 * cockpit can render a fresh editor.
 */
final class GetClinicalNoteAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;

    public function __construct(
        private readonly UserRepository $users,
        private readonly AppointmentRepository $appointments,
        private readonly ClinicalNoteRepository $notes,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $id = (string) $args['id'];
        $appointment = $this->doctorAppointment($request, $this->users, $this->appointments, $id);
        if ($appointment === null) {
            return $this->error($response, 'Consultation not found', 403);
        }

        $note = $this->notes->findByAppointment($id);
        if ($note === null) {
            return $this->success($response, [
                'appointment_id' => $id,
                'subjective'     => null,
                'objective'      => null,
                'assessment'     => null,
                'plan'           => null,
                'status'         => 'draft',
                'finalized_at'   => null,
                'author'         => null,
                'amendments'     => [],
                'updated_at'     => null,
            ]);
        }

        return $this->success($response, $note->toArray());
    }
}
