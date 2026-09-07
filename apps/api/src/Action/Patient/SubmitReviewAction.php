<?php

declare(strict_types=1);

namespace App\Action\Patient;

use App\Domain\Entity\Review;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\ReviewRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/appointments/{id}/review — the patient rates a completed
 * consultation (1–5 + optional comment). One review per appointment; the
 * specialist's cached rating + reviews_count are recomputed.
 */
final class SubmitReviewAction
{
    use ApiResponse;

    public function __construct(
        private readonly AppointmentRepository $appointments,
        private readonly ReviewRepository $reviews,
        private readonly SpecialistRepository $specialists,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $customerId  = (string) $request->getAttribute('customer_id');
        $appointment = $this->appointments->findForPatient((string) $args['id'], $customerId);
        if ($appointment === null) {
            return $this->error($response, 'Appointment not found', 404);
        }
        if ($appointment->getStatus() !== AppointmentStatus::COMPLETED) {
            return $this->error($response, 'You can only review a completed consultation', 422, [
                'status' => 'Not completed',
            ]);
        }
        if ($this->reviews->forAppointment($appointment->getId()) !== null) {
            return $this->error($response, 'You have already reviewed this consultation', 422, [
                'rating' => 'Already reviewed',
            ]);
        }

        $body   = (array) $request->getParsedBody();
        $rating = (int) ($body['rating'] ?? 0);
        if ($rating < 1 || $rating > 5) {
            return $this->error($response, 'Validation failed', 422, ['rating' => 'Choose a rating from 1 to 5']);
        }

        $specialist = $appointment->getSpecialist();
        $p          = $appointment->getPatient()->toArray();

        $review = new Review(
            $specialist->getId(),
            $customerId,
            trim(((string) $p['first_name']) . ' ' . ((string) $p['last_name'])),
            $rating,
            isset($body['comment']) ? (string) $body['comment'] : null,
            $appointment->getId(),
        );
        $this->reviews->save($review);

        // Recompute the specialist's cached rating.
        $summary = $this->reviews->summaryForSpecialist($specialist->getId());
        $specialist->setRating($summary['average']);
        $specialist->setReviewsCount($summary['count']);
        $this->specialists->save($specialist);

        return $this->created($response, $review->toArray(), 'Thanks for your review');
    }
}
