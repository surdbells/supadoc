<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Appointment\AppointmentLifecycle;
use App\Domain\Document\DocumentSharingRules;
use App\Domain\Settings\BookingSettings;
use App\Infrastructure\Document\DocumentSharingService;
use DateTimeImmutable;
use App\Domain\Entity\Appointment;
use App\Domain\Exception\EntityNotFoundException;
use App\Domain\Repository\AppointmentRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\CallPresence;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/appointments/{id} — one of the signed-in customer's own
 * appointments. Scoped by `customer_id`, so another patient's id resolves to a
 * 404 rather than leaking the record.
 *
 * Adds `cancel_policy` while it can still be cancelled (`can_cancel`), else
 * null: `refund_percent` (100, or the late-cancellation share) and
 * `refund_amount` (what cancelling now would put back in the wallet: '0.00'
 * when nothing was paid), `late_cancel_hours` (0 = no late window).
 *
 * The lifecycle fields (phase / display_status …) count a call running over
 * its time as live, like the list; `can_reschedule` is false inside the
 * late-cancellation window (the reschedule would be refused).
 *
 * Adds `pending_document_request`: this doctor's pending request to see the
 * patient's documents (DocumentAccessRequestDto), or null.
 */
final class GetMyAppointmentAction
{
    use ApiResponse;

    public function __construct(
        private readonly AppointmentRepository $repo,
        private readonly BookingSettings $settings,
        private readonly CallPresence $presence,
        private readonly DocumentSharingService $sharing,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $customerId  = (string) $request->getAttribute('customer_id');
        $id          = (string) $args['id'];
        $appointment = $this->repo->findForPatient($id, $customerId);

        if ($appointment === null) {
            throw EntityNotFoundException::for(Appointment::class, $id);
        }

        $now  = new DateTimeImmutable();
        $data = $appointment->toArray('patient', $now);
        // Someone in the call: it is live, whatever the clock says (as the list shows it).
        $p = $this->presence->forAppointment($appointment);
        if ($p['doctor'] || $p['patient'] || $p['guests'] !== []) {
            $data = array_merge($data, $appointment->lifecycleFields($now, 'patient', true));
        }
        // Moving it inside the late-cancellation window is refused (422).
        if ($data['can_reschedule'] && AppointmentLifecycle::inLateWindow($appointment, $now, $this->settings->get('late_cancel_hours'))) {
            $data['can_reschedule'] = false;
        }

        return $this->success($response, $data + [
            'cancel_policy'            => $data['can_cancel'] ? $this->cancelPolicy($appointment, $now) : null,
            'pending_document_request' => $this->pendingDocumentRequest($appointment),
        ]);
    }

    /**
     * This doctor's pending request to see the patient's documents (patient
     * audience only) — the in-call screen's one new signal, riding this
     * already-polled read. Null when there is none, sharing is off, or it
     * can't be read (the consultation itself must still load).
     *
     * @return array<string,mixed>|null
     */
    private function pendingDocumentRequest(Appointment $appointment): ?array
    {
        try {
            return $this->sharing->pendingRequestFor($appointment->getPatient(), $appointment->getSpecialist()->getId(), DocumentSharingRules::now());
        } catch (\Throwable $e) {
            error_log('[doc-access] pending_document_request failed: ' . $e::class . ': ' . $e->getMessage());

            return null;
        }
    }

    /** @return array{refund_percent:int, refund_amount:string, late_cancel_hours:int} */
    private function cancelPolicy(Appointment $appointment, DateTimeImmutable $now): array
    {
        $hours   = $this->settings->get('late_cancel_hours');
        $percent = AppointmentLifecycle::cancelRefundPercent($appointment, $now, $hours, $this->settings->get('late_cancel_refund_pct'));
        $left    = $appointment->getPaymentStatus() === 'paid' ? $appointment->refundableAmount() : '0.00';
        $amount  = $percent >= 100 ? $left : AppointmentLifecycle::partialRefund($appointment, $percent);

        return [
            'refund_percent'    => $percent,
            'refund_amount'     => bccomp($amount, $left, 2) > 0 ? $left : $amount,
            'late_cancel_hours' => $hours,
        ];
    }
}
