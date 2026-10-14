<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Entity\Appointment;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Email\MailService;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\FollowUpService;
use App\Infrastructure\Service\PatientNotifier;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use App\Domain\Settings\WebUrls;

/**
 * PATCH /api/appointments/{id}/status — move an appointment along its lifecycle.
 *
 * The state machine lives on the AppointmentStatus enum (the entity's
 * transitionTo() is the enforcement boundary). This Action only does HTTP work:
 * normalise + validate the target against the enum at the edge (Postgres `=` is
 * case-sensitive — ARCHITECTURE §11), then reject an illegal move with a 422
 * that names the legal next states rather than letting the entity throw a plain
 * DomainException (which the error handler would surface as a 500).
 */
final class UpdateAppointmentStatusAction
{
    use ApiResponse;

    public function __construct(
        private readonly AppointmentRepository $repo,
        private readonly MailService $mail,
        private readonly PatientNotifier $patientNotifier,
        private readonly FollowUpService $followUps,
        private readonly UserRepository $users,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $appointment = $this->repo->findOrFail((string) $args['id']);

        $body = (array) $request->getParsedBody();
        $raw  = strtolower(trim((string) ($body['status'] ?? '')));

        if ($raw === '') {
            return $this->error($response, 'Validation failed', 422, [
                'status' => 'Status is required',
            ]);
        }

        $target = AppointmentStatus::tryFrom($raw);
        if ($target === null) {
            return $this->error($response, 'Validation failed', 422, [
                'status' => sprintf('Unknown status "%s"', $raw),
            ]);
        }

        $current = $appointment->getStatus();
        // Only the patient accepting (and paying for) a follow-up proposal confirms it.
        if ($current === AppointmentStatus::PROPOSED && $target === AppointmentStatus::CONFIRMED) {
            return $this->error(
                $response,
                'A proposed follow-up is confirmed when the patient accepts it (it can only be cancelled here)',
                422,
                ['status' => 'Illegal transition'],
            );
        }
        if ($current !== $target && !$current->canTransitionTo($target)) {
            $allowed = array_map(
                static fn (AppointmentStatus $s): string => $s->value,
                $current->allowedTransitions(),
            );

            return $this->error(
                $response,
                sprintf(
                    'Cannot move appointment from %s to %s%s',
                    $current->value,
                    $target->value,
                    $allowed === []
                        ? ' (it is in a terminal state)'
                        : ' (allowed: ' . implode(', ', $allowed) . ')',
                ),
                422,
                ['status' => 'Illegal transition'],
            );
        }

        if ($current === AppointmentStatus::PROPOSED && $target === AppointmentStatus::CANCELLED) {
            // A compare-and-set, as when the doctor withdraws it: a patient
            // accepting (and paying) at this moment wins or loses cleanly —
            // 422 when they won. Audited, and the doctor told, there.
            if (!$this->followUps->cancelByStaff($appointment, $this->actorName((string) $request->getAttribute('user_id')))) {
                return $this->success($response, $appointment->toAdminArray(), 'Follow-up proposal already closed');
            }
        } else {
            $appointment->transitionTo($target);
            $this->repo->save($appointment);
        }

        $this->notifyPatient($appointment);
        $this->patientNotifier->appointment(
            $appointment,
            'Appointment ' . $appointment->getStatus()->label(),
            'The status of your appointment changed to ' . $appointment->getStatus()->label() . '.',
        );

        return $this->success($response, $appointment->toAdminArray(), 'Status updated');
    }

    /** The signed-in staff member's name, for the audit trail. */
    private function actorName(string $userId): string
    {
        $user = $userId !== '' ? $this->users->find($userId) : null;
        if ($user === null) {
            return 'Admin';
        }
        $a = $user->toArray();

        return trim(((string) $a['first_name']) . ' ' . ((string) $a['last_name'])) ?: 'Admin';
    }

    /** Fire-and-forget status-update email to the patient. */
    private function notifyPatient(Appointment $appointment): void
    {
        try {
            $p    = $appointment->getPatient()->toArray();
            $mail = EmailTemplates::appointmentStatusUpdate(
                $appointment->toArray(),
                (string) $p['first_name'],
                WebUrls::forPatient($appointment->getPatient()),
            );
            $this->mail->send(
                (string) $p['email'],
                trim((string) $p['first_name'] . ' ' . (string) $p['last_name']),
                $mail['subject'],
                $mail['html'],
            );
        } catch (\Throwable) {
            // logged inside MailService; the transition already succeeded.
        }
    }
}
