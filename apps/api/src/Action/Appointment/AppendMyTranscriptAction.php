<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Entity\Appointment;
use App\Domain\Entity\TranscriptSegment;
use App\Domain\Exception\EntityNotFoundException;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\ConsultationConsentRepository;
use App\Domain\Repository\TranscriptSegmentRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/appointments/{id}/transcript — append a transcribed utterance
 * from the patient's client. Requires the patient's AI-transcription consent.
 */
final class AppendMyTranscriptAction
{
    use ApiResponse;

    public function __construct(
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
        $customerId  = (string) $request->getAttribute('customer_id');
        $id          = (string) $args['id'];
        $appointment = $this->appointments->findForPatient($id, $customerId);
        if ($appointment === null) {
            throw EntityNotFoundException::for(Appointment::class, $id);
        }

        $consent = $this->consents->findOne($id, 'ai_transcription');
        if ($consent === null || !$consent->isGranted()) {
            return $this->error($response, 'AI transcription consent not granted', 403);
        }

        $text = trim((string) (((array) ($request->getParsedBody() ?? []))['text'] ?? ''));
        if ($text === '') {
            return $this->success($response, ['recorded' => false]);
        }

        $this->transcript->save(new TranscriptSegment($id, 'patient', $text));

        return $this->success($response, ['recorded' => true])
            ->withHeader('Cache-Control', 'no-store');
    }
}
