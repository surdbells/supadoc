<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\ClinicalNote;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\ClinicalNoteRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
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

        if ($note->isFinalized()) {
            $note->amend($author, ...$content);
        } else {
            $note->applyDraft(...$content);
            $note->finalize($author);
        }

        $this->notes->save($note);

        return $this->success($response, $note->toArray(), 'Consultation finalized')
            ->withHeader('Cache-Control', 'no-store');
    }
}
