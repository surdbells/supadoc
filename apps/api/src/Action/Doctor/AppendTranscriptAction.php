<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\TranscriptSegment;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\ConsultationConsentRepository;
use App\Domain\Repository\TranscriptSegmentRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/doctor/appointments/{id}/transcript — append a transcribed utterance
 * from the doctor's client. Requires the patient's AI-transcription consent; a
 * withdrawn consent stops new segments (403).
 */
final class AppendTranscriptAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;

    public function __construct(
        private readonly UserRepository $users,
        private readonly AppointmentRepository $appointments,
        private readonly TranscriptSegmentRepository $transcript,
        private readonly ConsultationConsentRepository $consents,
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

        $consent = $this->consents->findOne($id, 'ai_transcription');
        if ($consent === null || !$consent->isGranted()) {
            return $this->error($response, 'AI transcription consent not granted', 403);
        }

        $text = trim((string) (((array) ($request->getParsedBody() ?? []))['text'] ?? ''));
        if ($text === '') {
            return $this->success($response, ['recorded' => false]);
        }

        $this->transcript->save(new TranscriptSegment($id, 'doctor', $text));

        return $this->success($response, ['recorded' => true])
            ->withHeader('Cache-Control', 'no-store');
    }
}
