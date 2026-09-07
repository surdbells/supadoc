<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\Review;
use App\Domain\Repository\ReviewRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/** POST /api/doctor/reviews/{id}/respond — the doctor posts a public reply. */
final class RespondToReviewAction
{
    use ApiResponse;
    use ResolvesDoctorSpecialist;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly ReviewRepository $reviews,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $specialist = $this->doctorSpecialist($request, $this->users, $this->specialists);
        if ($specialist === null) {
            return $this->error($response, 'This account is not a doctor profile', 403);
        }

        $review = $this->reviews->find((string) $args['id']);
        if (!$review instanceof Review || $review->getSpecialistId() !== $specialist->getId()) {
            return $this->error($response, 'Review not found', 404);
        }

        $body     = (array) $request->getParsedBody();
        $reply    = trim((string) ($body['response'] ?? ''));
        if ($reply === '') {
            return $this->error($response, 'Validation failed', 422, ['response' => 'Write a response']);
        }

        $review->respond($reply);
        $this->reviews->save($review);

        return $this->success($response, $review->toArray(), 'Response posted');
    }
}
