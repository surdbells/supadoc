<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\ConsultationConsent;
use App\Domain\Entity\Recording;
use App\Infrastructure\Agora\AgoraRecordingService;
use App\Infrastructure\Agora\AgoraTokenService;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\ConsultationConsentRepository;
use App\Domain\Repository\RecordingRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AuditLogger;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/doctor/appointments/{id}/recording/start — begin cloud recording.
 * Refuses unless the PATIENT has granted recording consent — the app never
 * records silently. Idempotent while a recording is already active.
 */
final class StartRecordingAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;

    public function __construct(
        private readonly UserRepository $users,
        private readonly AppointmentRepository $appointments,
        private readonly ConsultationConsentRepository $consents,
        private readonly RecordingRepository $recordings,
        private readonly AgoraRecordingService $recorder,
        private readonly AgoraTokenService $agora,
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
        if (!$this->recorder->isConfigured()) {
            return $this->error($response, 'Cloud recording is not configured', 503);
        }

        // Consent gate — the patient must have granted recording consent.
        $consent = $this->consents->findOne($id, 'recording');
        if ($consent === null || !$consent->isGranted()) {
            return $this->error($response, 'The patient has not granted recording consent', 403);
        }

        // Already recording? Return the active session (idempotent).
        $active = $this->recordings->activeForAppointment($id);
        if ($active !== null) {
            return $this->success($response, $active->toArray(), 'Recording already in progress');
        }

        // Record the channel the participants are actually in, with a matching token.
        if ($this->agora->hasStaticToken()) {
            $channel = $this->agora->staticChannel();
            $token   = $this->agora->staticToken();
        } else {
            $channel = $appointment->getId();
            $token   = $this->agora->isConfigured()
                ? $this->agora->rtcToken($channel, (int) AgoraRecordingService::RECORDER_UID, 3600)
                : null;
        }

        try {
            $resourceId = $this->recorder->acquire($channel, AgoraRecordingService::RECORDER_UID);
            $started    = $this->recorder->start(
                $channel,
                AgoraRecordingService::RECORDER_UID,
                $resourceId,
                $token,
                str_replace('-', '', $id),
            );
        } catch (\RuntimeException $e) {
            return $this->error($response, $e->getMessage(), 502);
        }

        $author    = $appointment->getSpecialist()->getName();
        $recording = new Recording($id, $channel, $started['resourceId'], $started['sid'], $author);
        $this->recordings->save($recording);

        $this->audit->record(
            $author,
            'doctor',
            'recording.started',
            $id,
            'recording',
            $recording->getId(),
            ['consent_version' => ConsultationConsent::VERSION],
        );

        return $this->success($response, $recording->toArray(), 'Recording started', 201)
            ->withHeader('Cache-Control', 'no-store');
    }
}
