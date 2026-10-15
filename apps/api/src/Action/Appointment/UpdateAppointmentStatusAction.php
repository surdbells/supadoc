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
use App\Infrastructure\Service\AppointmentResolver;
use App\Infrastructure\Service\AuditLogger;
use App\Infrastructure\Service\FollowUpService;
use App\Infrastructure\Service\PatientNotifier;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use App\Domain\Settings\WebUrls;

/**
 * PATCH /api/appointments/{id}/status — move an appointment along its lifecycle.
 *
 * The state machine lives on the AppointmentStatus enum (the entity's
 * transitionTo() is the enforcement boundary). This Action normalises and
 * validates the target at the edge (Postgres `=` is case-sensitive —
 * ARCHITECTURE §11) and rejects an illegal move with a 422 that names the
 * legal next states. Every change is audited with the staff member.
 *
 *  - cancelled: refunds by default — in full, guest fees included (`refund`
 *    full); `refund: none` keeps the money and needs a `reason`. Works on a
 *    missed consultation too. Guests are told (their links stop working).
 *  - completed: through {@see \App\Infrastructure\Service\ConsultationCompleter}
 *    (audit, the patient's notice, earnings), only once its time has come —
 *    also for a visit that took place unconfirmed, or a missed one held after all.
 *  - missed: use POST /appointments/{id}/resolve (it needs who didn't come).
 *  - anything else (confirmed, rescheduled, pending): the ordinary transitions.
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
        private readonly AppointmentResolver $resolver,
        private readonly AuditLogger $audit,
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
        $actor   = $this->actor((string) $request->getAttribute('user_id'));
        // Only the patient accepting (and paying for) a follow-up proposal confirms it.
        if ($current === AppointmentStatus::PROPOSED && $target === AppointmentStatus::CONFIRMED) {
            return $this->error(
                $response,
                'A proposed follow-up is confirmed when the patient accepts it (it can only be cancelled here)',
                422,
                ['status' => 'Illegal transition'],
            );
        }
        if ($target === AppointmentStatus::MISSED && $current !== AppointmentStatus::MISSED) {
            $instead = 'Mark a consultation missed with Resolve — say who didn\'t come';

            return $this->error($response, $instead, 422, ['status' => $instead]);
        }
        if ($current !== $target && !$current->canTransitionTo($target, true)) {
            $allowed = array_map(
                static fn (AppointmentStatus $s): string => $s->value,
                array_values(array_filter(
                    [...$current->allowedTransitions(), ...$current->privilegedTransitions()],
                    static fn (AppointmentStatus $s): bool => $s !== AppointmentStatus::MISSED,
                )),
            );

            return $this->error(
                $response,
                sprintf(
                    'Cannot move appointment from %s to %s%s',
                    $current->value,
                    $target->value,
                    $allowed === []
                        ? ' (it is in a terminal state)'
                        : ' (allowed: ' . implode(', ', array_unique($allowed)) . ')',
                ),
                422,
                ['status' => 'Illegal transition'],
            );
        }

        if ($current === AppointmentStatus::PROPOSED && $target === AppointmentStatus::CANCELLED) {
            // A compare-and-set, as when the doctor withdraws it: a patient
            // accepting (and paying) at this moment wins or loses cleanly —
            // 422 when they won. Audited, and the doctor told, there.
            if (!$this->followUps->cancelByStaff($appointment, $actor['name'])) {
                return $this->success($response, $appointment->toAdminArray(), 'Follow-up proposal already closed');
            }
            $this->notifyPatient($appointment);

            return $this->success($response, $appointment->toAdminArray(), 'Status updated');
        }
        if ($current === $target) {
            return $this->success($response, $appointment->toAdminArray(), 'Status unchanged');
        }

        if ($target === AppointmentStatus::CANCELLED) {
            $mode     = AppointmentResolver::refundMode('cancel', $body['refund'] ?? null, $body['amount'] ?? null);
            $reason   = AppointmentResolver::reason($body['reason'] ?? null, $mode === 'none');
            $refunded = $this->resolver->cancel(
                $appointment,
                $actor,
                $mode,
                $mode === 'amount' ? (string) $body['amount'] : null,
                $reason,
                AppointmentResolver::idempotencyKey($body['idempotency_key'] ?? null),
            );

            return $this->success($response, $appointment->toAdminArray() + ['refunded_now' => $refunded], 'Appointment cancelled');
        }
        if ($target === AppointmentStatus::COMPLETED) {
            $reason = AppointmentResolver::reason($body['reason'] ?? null, false) ?? 'Marked completed by the back office';
            $this->resolver->markHeld($appointment, $actor, $reason);

            return $this->success($response, $appointment->toAdminArray(), 'Consultation completed');
        }

        $appointment->transitionTo($target, true);
        $this->repo->save($appointment);
        $this->audit->record($actor['name'], 'admin', 'appointment.status_changed', $appointment->getId(), 'appointment', $appointment->getId(), [
            'from' => $current->value,
            'to'   => $target->value,
        ], $actor['id']);

        $this->notifyPatient($appointment);

        return $this->success($response, $appointment->toAdminArray(), 'Status updated');
    }

    /**
     * The signed-in staff member, for the audit trail.
     *
     * @return array{id:?string, name:string}
     */
    private function actor(string $userId): array
    {
        $user = $userId !== '' ? $this->users->find($userId) : null;
        if ($user === null) {
            return ['id' => null, 'name' => 'Admin'];
        }
        $a = $user->toArray();

        return [
            'id'   => $user->getId(),
            'name' => trim(((string) $a['first_name']) . ' ' . ((string) $a['last_name'])) ?: 'Admin',
        ];
    }

    /** Status-update email + in-app notice to the patient (best-effort). */
    private function notifyPatient(Appointment $appointment): void
    {
        $this->patientNotifier->appointment(
            $appointment,
            'Appointment ' . $appointment->getStatus()->label(),
            'The status of your appointment changed to ' . $appointment->getStatus()->label() . '.',
        );
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
