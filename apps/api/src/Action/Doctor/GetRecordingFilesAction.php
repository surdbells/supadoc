<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\Recording;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\RecordingRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\RecordingStorage;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor/appointments/{id}/recording/files — playback/download URLs for
 * the doctor's own consultation recordings. Each stored file key is resolved to a
 * short-lived URL (null when storage isn't configured). Doctor-owned only.
 */
final class GetRecordingFilesAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;

    public function __construct(
        private readonly UserRepository $users,
        private readonly AppointmentRepository $appointments,
        private readonly RecordingRepository $recordings,
        private readonly RecordingStorage $storage,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $appointment = $this->doctorAppointment($request, $this->users, $this->appointments, (string) $args['id']);
        if ($appointment === null) {
            return $this->error($response, 'You cannot access this consultation', 403);
        }

        $files = [];
        foreach ($this->recordings->forAppointment($appointment->getId()) as $recording) {
            foreach ($recording->getFiles() as $key) {
                $files[] = [
                    'recording_id' => $recording->getId(),
                    'key'          => $key,
                    'name'         => basename($key),
                    'url'          => $this->storage->url($key),
                ];
            }
        }

        return $this->success($response, [
            'configured' => $this->storage->isConfigured(),
            'files'      => $files,
        ])->withHeader('Cache-Control', 'no-store');
    }
}
