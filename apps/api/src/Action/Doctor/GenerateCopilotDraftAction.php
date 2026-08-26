<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\CopilotDraft;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\ConsultationConsentRepository;
use App\Domain\Repository\CopilotDraftRepository;
use App\Domain\Repository\TranscriptSegmentRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AuditLogger;
use App\Infrastructure\Service\CopilotService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/doctor/appointments/{id}/copilot/draft — generate an AI clinical draft
 * (summary + SOAP + extractions) from the transcript. Requires AI-transcription
 * consent and a configured copilot. The result is ALWAYS a draft: it is stored
 * separately and only enters the record if the clinician carries it into the SOAP
 * note and finalizes it.
 */
final class GenerateCopilotDraftAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;

    public function __construct(
        private readonly UserRepository $users,
        private readonly AppointmentRepository $appointments,
        private readonly ConsultationConsentRepository $consents,
        private readonly TranscriptSegmentRepository $transcript,
        private readonly CopilotDraftRepository $drafts,
        private readonly CopilotService $copilot,
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
        if (!$this->copilot->isConfigured()) {
            return $this->error($response, 'The AI copilot is not configured', 503);
        }

        $consent = $this->consents->findOne($id, 'ai_transcription');
        if ($consent === null || !$consent->isGranted()) {
            return $this->error($response, 'AI transcription consent not granted', 403);
        }

        $text = $this->transcript->transcriptText($id);

        try {
            $structured = $this->copilot->draft($text);
        } catch (\RuntimeException $e) {
            return $this->error($response, $e->getMessage(), 502);
        }

        $draft = $this->drafts->findByAppointment($id) ?? new CopilotDraft($id);
        $author = $appointment->getSpecialist()->getName();
        $draft->apply($structured, $author);
        $this->drafts->save($draft);

        $this->audit->record(
            $author,
            'doctor',
            'copilot.draft_generated',
            $id,
            'copilot_draft',
            null,
            ['transcript_chars' => strlen($text)],
        );

        return $this->success($response, $draft->toArray(), 'Draft generated')
            ->withHeader('Cache-Control', 'no-store');
    }
}
