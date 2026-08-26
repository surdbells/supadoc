<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\TranscriptSegment;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\TranscriptSegmentRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/** GET /api/doctor/appointments/{id}/transcript — the consultation transcript. */
final class GetTranscriptAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;

    public function __construct(
        private readonly UserRepository $users,
        private readonly AppointmentRepository $appointments,
        private readonly TranscriptSegmentRepository $transcript,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $id = (string) $args['id'];
        if ($this->doctorAppointment($request, $this->users, $this->appointments, $id) === null) {
            return $this->error($response, 'Consultation not found', 403);
        }

        $rows = array_map(
            static fn (TranscriptSegment $s): array => $s->toArray(),
            $this->transcript->forAppointment($id),
        );

        return $this->success($response, $rows);
    }
}
