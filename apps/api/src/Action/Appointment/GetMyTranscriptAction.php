<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Entity\Appointment;
use App\Domain\Entity\TranscriptSegment;
use App\Domain\Exception\EntityNotFoundException;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\TranscriptSegmentRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/appointments/{id}/transcript — a short tail of the transcript
 * for the patient's live captions. Scoped by customer_id.
 */
final class GetMyTranscriptAction
{
    use ApiResponse;

    public function __construct(
        private readonly AppointmentRepository $appointments,
        private readonly TranscriptSegmentRepository $transcript,
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
            static fn (TranscriptSegment $s): array => $s->toArray(),
            $this->transcript->forAppointment($id, 40),
        );

        return $this->success($response, $rows);
    }
}
