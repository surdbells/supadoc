<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\ClinicalNote;
use App\Domain\Enum\NotificationType;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\ClinicalNoteRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AuditLogger;
use App\Infrastructure\Service\PatientNotifier;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/doctor/appointments/{id}/note/finalize — sign and lock the SOAP note.
 * Any content in the request body is saved first, then the note is finalized and
 * becomes patient-visible. Finalizing an already-finalized note is a no-op success.
 */
final class FinalizeClinicalNoteAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;

    public function __construct(
        private readonly UserRepository $users,
        private readonly AppointmentRepository $appointments,
        private readonly ClinicalNoteRepository $notes,
        private readonly AuditLogger $audit,
        private readonly PatientNotifier $patientNotifier,
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

        $author = $appointment->getSpecialist()->getName();
        $body   = (array) ($request->getParsedBody() ?? []);
        $note   = $this->notes->findByAppointment($id) ?? new ClinicalNote($id);

        $content = [
            is_string($body['subjective'] ?? null) ? $body['subjective'] : null,
            is_string($body['objective'] ?? null) ? $body['objective'] : null,
            is_string($body['assessment'] ?? null) ? $body['assessment'] : null,
            is_string($body['plan'] ?? null) ? $body['plan'] : null,
        ];

        $wasFinalized = $note->isFinalized();
        if ($wasFinalized) {
            $note->amend($author, ...$content);
        } else {
            $note->applyDraft(...$content);
            $note->finalize($author);
        }

        $this->notes->save($note);

        $this->audit->record(
            $author,
            'doctor',
            $wasFinalized ? 'note.amended' : 'note.finalized',
            $id,
            'clinical_note',
            $note->getId(),
        );

        // Tell the patient their summary is ready on first finalize only (not on amends).
        if (!$wasFinalized) {
            $this->patientNotifier->notify(
                $appointment->getPatient(),
                NotificationType::APPOINTMENT,
                'Consultation summary ready',
                'Your consultation summary from ' . $author . ' is now available.',
            );
        }

        return $this->success($response, $note->toArray(), 'Consultation finalized')
            ->withHeader('Cache-Control', 'no-store');
    }
}
