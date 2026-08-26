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
 * PUT /api/doctor/appointments/{id}/note — upsert the SOAP note (auto-save). While
 * the note is a draft this simply overwrites the content; once finalized, a save is
 * treated as an amendment (the prior version is preserved for audit), so a signed
 * note is never silently changed.
 */
final class SaveClinicalNoteAction
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

        $body = (array) ($request->getParsedBody() ?? []);
        $subjective = $this->str($body['subjective'] ?? null);
        $objective  = $this->str($body['objective'] ?? null);
        $assessment = $this->str($body['assessment'] ?? null);
        $plan       = $this->str($body['plan'] ?? null);

        $note = $this->notes->findByAppointment($id) ?? new ClinicalNote($id);

        if ($note->isFinalized()) {
            $note->amend(
                $appointment->getSpecialist()->getName(),
                $subjective,
                $objective,
                $assessment,
                $plan,
            );
        } else {
            $note->applyDraft($subjective, $objective, $assessment, $plan);
        }

        $this->notes->save($note);

        return $this->success($response, $note->toArray(), 'Note saved')
            ->withHeader('Cache-Control', 'no-store');
    }

    private function str(mixed $v): ?string
    {
        return is_string($v) ? $v : null;
    }
}
