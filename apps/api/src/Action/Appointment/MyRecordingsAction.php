<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Entity\Appointment;
use App\Domain\Entity\Recording;
use App\Domain\Exception\EntityNotFoundException;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\RecordingRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/appointments/{id}/recordings — the patient's recording state:
 * whether the consultation is currently being recorded, plus finished recordings.
 * Scoped by customer_id.
 */
final class MyRecordingsAction
{
    use ApiResponse;

    public function __construct(
        private readonly AppointmentRepository $appointments,
        private readonly RecordingRepository $recordings,
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

        $all    = $this->recordings->forAppointment($id);
        $active = false;
        foreach ($all as $r) {
            if ($r->isActive()) {
                $active = true;
                break;
            }
        }

        return $this->success($response, [
            'active'     => $active,
            'recordings' => array_map(static fn (Recording $r): array => $r->toArray(), $all),
        ]);
    }
}
