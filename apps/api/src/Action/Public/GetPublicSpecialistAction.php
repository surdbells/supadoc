<?php

declare(strict_types=1);

namespace App\Action\Public;

use App\Domain\Entity\Specialist;
use App\Domain\Exception\EntityNotFoundException;
use App\Domain\Repository\SpecialistRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/public/specialists/{id} — one specialist (public), for the booking
 * wizard's header + summary. 404 if unknown, removed or not approved yet (a
 * doctor still onboarding is indistinguishable from one that doesn't exist),
 * and 404 with its own message when switched off for bookings.
 */
final class GetPublicSpecialistAction
{
    use ApiResponse;

    public function __construct(private readonly SpecialistRepository $repo)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $id = (string) ($args['id'] ?? '');
        /** @var Specialist|null $specialist */
        $specialist = $this->repo->find($id);
        if ($specialist === null || $specialist->isDeleted() || !$specialist->isApproved()) {
            throw EntityNotFoundException::for(Specialist::class, $id);
        }
        if (!$specialist->isAvailable()) {
            return $this->error($response, 'This specialist is not taking bookings at the moment', 404);
        }

        return $this->success($response, $specialist->toArray());
    }
}
