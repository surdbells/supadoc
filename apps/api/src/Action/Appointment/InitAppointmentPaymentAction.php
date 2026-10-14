<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Entity\Patient;
use App\Domain\Entity\Specialist;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Exception\ValidationException;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\PatientRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AppointmentCheckout;
use App\Infrastructure\Service\FollowUpService;
use App\Infrastructure\Service\PricingService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Ramsey\Uuid\Uuid;

/**
 * POST /api/portal/appointments/pay-init — start a direct card payment for a
 * consultation (Paystack), so a patient can pay by card instead of funding the
 * wallet. Returns the checkout access code + reference; the booking is created
 * (or the follow-up accepted) only after the reference verifies.
 *
 * Three ways to price it:
 *   - `{specialist_id, guest_count}` — a new booking (the doctor's fee + guests);
 *   - plus `{parent_appointment_id, scheduled_at}` — booking a follow-up of
 *     one of the patient's completed consultations, at the follow-up price;
 *   - `{appointment_id, scheduled_at?}` — accepting the doctor's follow-up
 *     proposal (at its price, or re-priced for another slot).
 *
 * A free consultation has nothing to charge: it gets a 422 (`payment: free`)
 * and is booked (or accepted) straight away instead.
 */
final class InitAppointmentPaymentAction
{
    use ApiResponse;

    private const MAX_GUESTS = 3;

    public function __construct(
        private readonly PatientRepository $patients,
        private readonly SpecialistRepository $specialists,
        private readonly AppointmentRepository $appointments,
        private readonly PricingService $pricing,
        private readonly AppointmentCheckout $checkout,
        private readonly FollowUpService $followUps,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $customerId = (string) $request->getAttribute('customer_id');
        $body       = (array) ($request->getParsedBody() ?? []);

        /** @var Patient $patient */
        $patient = $this->patients->findOrFail($customerId);

        $appointmentId = trim((string) ($body['appointment_id'] ?? ''));
        if ($appointmentId !== '') {
            [$amount, $metadata, $returnPath] = $this->forProposal($appointmentId, $customerId, $body);
        } else {
            $specialistId = trim((string) ($body['specialist_id'] ?? ''));
            if ($specialistId === '') {
                return $this->error($response, 'Please choose a specialist', 422, ['specialist_id' => 'Required']);
            }
            /** @var Specialist $specialist */
            $specialist = $this->specialists->findOrFail($specialistId);
            // Never take a card payment for a doctor who can't be booked.
            if (!$specialist->isBookable()) {
                return $this->error($response, 'Validation failed', 422, [
                    'specialist_id' => 'This specialist is not currently available',
                ]);
            }
            $guestCount = max(0, min(self::MAX_GUESTS, (int) ($body['guest_count'] ?? 0)));
            $fee        = $this->bookingFee($specialist, $customerId, $body);
            $amount     = bcadd($fee, bcmul(number_format($this->pricing->guestFee(), 2, '.', ''), (string) $guestCount, 2), 2);
            $metadata   = ['specialist_id' => $specialistId, 'purpose' => 'appointment_booking'];
            $returnPath = '/dashboard/appointments';
        }

        // Priced before anything else: a free consultation never needs a
        // checkout — even where card payment isn't set up yet.
        if (($problem = $this->checkout->startProblem($patient, $amount)) !== null) {
            [$status, $message, $errors] = $problem;

            return $this->error($response, $message, $status, $errors);
        }

        try {
            $init = $this->checkout->initialize($patient, $amount, $returnPath, $metadata);
        } catch (\Throwable $e) {
            error_log('[appointments.pay-init] paystack initialize failed: ' . $e->getMessage());

            return $this->error($response, 'Could not start the payment. Please try again.', 502);
        }

        return $this->created($response, $init, 'Payment started')->withHeader('Cache-Control', 'no-store');
    }

    /**
     * The consultation fee of a new booking: the doctor's fee, or the follow-up
     * price when it follows up one of the patient's completed consultations.
     *
     * @param array<string,mixed> $body
     * @throws ValidationException
     */
    private function bookingFee(Specialist $specialist, string $customerId, array $body): string
    {
        $parentId = trim((string) ($body['parent_appointment_id'] ?? ''));
        if ($parentId === '') {
            return $specialist->getConsultationFee();
        }

        $parent  = Uuid::isValid($parentId) ? $this->appointments->findForPatient($parentId, $customerId) : null;
        $problem = FollowUpService::patientParentProblem($parent, $specialist->getId());
        if ($problem !== null) {
            throw new ValidationException([$problem[0] => $problem[1]]);
        }
        // The follow-up price depends on the date, so the slot comes first.
        $start = FollowUpService::parseStart((string) ($body['scheduled_at'] ?? ''));

        return $this->followUps->price($parent, $start)['amount'];
    }

    /**
     * Accepting the doctor's proposal `$appointmentId` by card: its price, at
     * the proposed time or the `scheduled_at` the patient picked instead —
     * only while accepting could still succeed (open for long enough to pay,
     * the doctor bookable, the other slot open; {@see FollowUpService::checkoutAmount()}).
     *
     * @param array<string,mixed> $body
     * @return array{0:string, 1:array<string,mixed>, 2:string}
     * @throws ValidationException
     */
    private function forProposal(string $appointmentId, string $customerId, array $body): array
    {
        $proposal = Uuid::isValid($appointmentId) ? $this->appointments->findForPatient($appointmentId, $customerId) : null;
        if ($proposal === null || $proposal->getStatus() !== AppointmentStatus::PROPOSED) {
            throw new ValidationException(['appointment_id' => 'This is not a follow-up proposal you can accept']);
        }
        $raw   = trim((string) ($body['scheduled_at'] ?? ''));
        $start = $raw !== '' ? FollowUpService::parseStart($raw) : null;

        return [
            $this->followUps->checkoutAmount($proposal, $start),
            ['specialist_id' => $proposal->getSpecialist()->getId(), 'appointment_id' => $proposal->getId(), 'purpose' => 'follow_up_acceptance'],
            '/dashboard/appointments/' . $proposal->getId(),
        ];
    }
}
