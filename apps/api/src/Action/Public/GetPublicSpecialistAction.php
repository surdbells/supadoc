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
 * wizard's header + summary. 404 if unknown.
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
        if ($specialist === null) {
            throw EntityNotFoundException::for(Specialist::class, $id);
        }

        return $this->success($response, $specialist->toArray());
    }
}
