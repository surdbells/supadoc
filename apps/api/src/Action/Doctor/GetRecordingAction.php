<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Infrastructure\Agora\AgoraRecordingService;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\RecordingRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\GuestConsent;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor/appointments/{id}/recording — recording state for the cockpit:
 * whether recording is available on this environment, the active session if
 * any, and the guests in the call now (`guest_consent.connected`) of whom
 * `pending` haven't accepted the recording notice — recording can't start
 * until that is 0. `unknown`: presence couldn't be read, so every invited
 * guest is counted.
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
        private readonly GuestConsent $guestConsent,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $id          = (string) $args['id'];
        $appointment = $this->doctorAppointment($request, $this->users, $this->appointments, $id);
        if ($appointment === null) {
            return $this->error($response, 'Consultation not found', 403);
        }

        $active = $this->recordings->activeForAppointment($id);
        $guests = $this->guestConsent->connectedGuests($appointment);

        return $this->success($response, [
            'configured'    => $this->recorder->isConfigured(),
            'active'        => $active !== null,
            'recording'     => $active?->toArray(),
            'guest_consent' => [
                'connected'   => $guests['connected'],
                'pending'     => $guests['pending'],
                'pending_ids' => $guests['pending_ids'],
                'unknown'     => $guests['unknown'],
            ],
        ]);
    }
}
