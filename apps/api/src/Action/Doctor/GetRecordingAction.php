<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Infrastructure\Agora\AgoraRecordingService;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\RecordingRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor/appointments/{id}/recording — recording state for the cockpit:
 * whether recording is available on this environment and the active session if any.
 */
final class GetRecordingAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;

    public function __construct(
        private readonly UserRepository $users,
        private readonly AppointmentRepository $appointments,
        private readonly RecordingRepository $recordings,
        private readonly AgoraRecordingService $recorder,
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

        $active = $this->recordings->activeForAppointment($id);

        return $this->success($response, [
            'configured' => $this->recorder->isConfigured(),
            'active'     => $active !== null,
            'recording'  => $active?->toArray(),
        ]);
    }
}
