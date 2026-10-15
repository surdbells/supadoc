<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AppointmentResolver;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/appointments/{id}/resolve — the back office settles a missed or
 * stale consultation (past and still open: "needs attention"), audited with
 * the staff member and their `reason` (required, 3–500 characters).
 * `appointments.update`.
 *
 * Body: `action` and its options —
 *  - held:    mark it held → completed (through ConsultationCompleter: the
 *             patient's notice, earnings); `refund` none (default) | full | amount.
 *  - no_show: mark a past open booking missed, or change who didn't come to a
 *             missed one — `no_show` doctor | patient | both; `refund` policy
 *             (default: the no-show rules for that party, topping up what
 *             already went back — never taking any back) | full | none | amount.
 *  - cancel:  cancel it (an open booking or a missed one); `refund` full
 *             (default, guest fees included) | none | amount.
 *  - refund:  give back more of a closed one; `refund` full (default: all
 *             that is left) | amount.
 * `amount` (money string) with `refund: amount`; never more than is left to
 * refund (422 `amount`) — send an `idempotency_key` (8–64 of A–Z a–z 0–9 _ -)
 * so a retry or double submit refunds once. Answers the appointment (admin
 * shape) plus `refunded_now` (what this call refunded).
 */
final class ResolveAppointmentAction
{
    use ApiResponse;

    public function __construct(
        private readonly AppointmentRepository $repo,
        private readonly UserRepository $users,
        private readonly AppointmentResolver $resolver,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $appointment = $this->repo->findOrFail((string) $args['id']);
        $body        = (array) ($request->getParsedBody() ?? []);
        $action      = strtolower(trim((string) ($body['action'] ?? '')));
        if (!in_array($action, AppointmentResolver::ACTIONS, true)) {
            return $this->error($response, 'Validation failed', 422, [
                'action' => 'Choose one of: ' . implode(', ', AppointmentResolver::ACTIONS),
            ]);
        }

        $mode   = AppointmentResolver::refundMode($action, $body['refund'] ?? null, $body['amount'] ?? null);
        $amount = $mode === 'amount' ? (string) $body['amount'] : null;
        $reason = (string) AppointmentResolver::reason($body['reason'] ?? null);
        $key    = AppointmentResolver::idempotencyKey($body['idempotency_key'] ?? null);
        $actor  = $this->actor((string) $request->getAttribute('user_id'));

        $refunded = match ($action) {
            'held'    => $this->resolver->markHeld($appointment, $actor, $reason, $mode, $amount, $key),
            'no_show' => $this->resolver->markNoShow($appointment, $actor, strtolower(trim((string) ($body['no_show'] ?? ''))), $reason, $mode, $amount, $key),
            'cancel'  => $this->resolver->cancel($appointment, $actor, $mode, $amount, $reason, $key),
            default   => $this->resolver->refund($appointment, $actor, $reason, $mode, $amount, $key),
        };

        return $this->success($response, $appointment->toAdminArray() + ['refunded_now' => $refunded], match ($action) {
            'held'    => 'Consultation marked held',
            'no_show' => 'Consultation marked missed',
            'cancel'  => 'Appointment cancelled',
            default   => 'Refund issued',
        });
    }

    /** @return array{id:?string, name:string} */
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
}
