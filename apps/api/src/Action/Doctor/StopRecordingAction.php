<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Infrastructure\Agora\AgoraRecordingService;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\RecordingRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AuditLogger;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/doctor/appointments/{id}/recording/stop — stop the active cloud
 * recording and store the resulting file list. No-op success if nothing is active.
 */
final class StopRecordingAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;

    public function __construct(
        private readonly UserRepository $users,
        private readonly AppointmentRepository $appointments,
        private readonly RecordingRepository $recordings,
        private readonly AgoraRecordingService $recorder,
        private readonly AuditLogger $audit,
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

        $recording = $this->recordings->activeForAppointment($id);
        if ($recording === null) {
            return $this->success($response, ['active' => false], 'No active recording');
        }

        $files = [];
        try {
            $server = $this->recorder->stop(
                $recording->getChannel(),
                AgoraRecordingService::RECORDER_UID,
                $recording->getResourceId(),
                $recording->getSid(),
            );
            foreach ((array) ($server['fileList'] ?? []) as $file) {
                if (is_array($file) && isset($file['fileName']) && is_string($file['fileName'])) {
                    $files[] = $file['fileName'];
                } elseif (is_string($file)) {
                    $files[] = $file;
                }
            }
            $recording->markStopped($files);
        } catch (\RuntimeException $e) {
            // Agora auto-stops after maxIdleTime; mark it stopped locally regardless.
            $recording->markStopped($files);
        }
        $this->recordings->save($recording);

        $this->audit->record(
            $appointment->getSpecialist()->getName(),
            'doctor',
            'recording.stopped',
            $id,
            'recording',
            $recording->getId(),
            ['files' => count($files)],
        );

        return $this->success($response, $recording->toArray(), 'Recording stopped')
            ->withHeader('Cache-Control', 'no-store');
    }
}
