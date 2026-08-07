<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Entity\Appointment;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Repository\AppointmentRepository;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Email\MailService;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

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

        $appointment->transitionTo($target);
        $this->repo->save($appointment);

        $this->notifyPatient($appointment);

        return $this->success($response, $appointment->toArray(), 'Status updated');
    }

    /** Fire-and-forget status-update email to the patient. */
    private function notifyPatient(Appointment $appointment): void
    {
        try {
            $p    = $appointment->getPatient()->toArray();
            $mail = EmailTemplates::appointmentStatusUpdate(
                $appointment->toArray(),
                (string) $p['first_name'],
                $_ENV['APP_WEB_URL'] ?? 'http://localhost:4201',
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
