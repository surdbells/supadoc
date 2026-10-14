<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Repository\AppointmentRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\FollowUpService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/appointments/{id}/follow-up/accept — the signed-in patient
 * accepts their doctor's follow-up proposal {id}:
 * `{payment_method: wallet|card, payment_reference?, scheduled_at?}`.
 *
 * `scheduled_at` takes another open slot of the same doctor instead (re-checked
 * and re-priced for that date). A free follow-up is confirmed at once; otherwise
 * the wallet is debited (too low → 422 `errors.wallet = insufficient_funds`), or
 * a card payment started with POST /portal/appointments/pay-init
 * `{appointment_id}` is verified. Then it is CONFIRMED, the doctor is told and
 * everyone gets their join link. A repeat answers 200 without charging again.
 * A card payment for an acceptance that is refused (it closed, or the slot or
 * the doctor went, meanwhile) is credited to the wallet, and the 422 says so
 * (`errors.card_payment = credited_to_wallet`). So is a second card payment a
 * repeat brings: the 200 then says so too, with `meta.card_payment`.
 */
final class AcceptFollowUpAction
{
    use ApiResponse;

    public function __construct(
        private readonly AppointmentRepository $appointments,
        private readonly FollowUpService $followUps,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $customerId = (string) $request->getAttribute('customer_id');
        $proposal   = $this->appointments->findForPatient((string) $args['id'], $customerId);
        if ($proposal === null) {
            return $this->error($response, 'Appointment not found', 404);
        }

        $body  = (array) ($request->getParsedBody() ?? []);
        $raw   = trim((string) ($body['scheduled_at'] ?? ''));
        $start = $raw !== '' ? FollowUpService::parseStart($raw) : null;

        $credited = null;
        $accepted = $this->followUps->accept(
            $proposal,
            (string) ($body['payment_method'] ?? ''),
            (string) ($body['payment_reference'] ?? ''),
            $start,
            $credited,
        );
        $message = $accepted ? 'Follow-up confirmed' : 'Follow-up already accepted';
        if ($credited === null) {
            return $this->success($response, $proposal->toArray(), $message);
        }

        // It was accepted already, so the card payment this request brought wasn't needed.
        return $this->json($response, [
            'status'  => 'success',
            'message' => $message . '. ' . $this->followUps->walletCreditNote($credited),
            'data'    => $proposal->toArray(),
            'meta'    => ['card_payment' => 'credited_to_wallet', 'credited_amount' => $credited],
        ], 200);
    }
}
