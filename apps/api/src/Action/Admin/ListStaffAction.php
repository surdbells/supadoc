<?php

declare(strict_types=1);

namespace App\Action\Admin;

use App\Domain\Entity\User;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/** GET /api/staff — the staff directory (needs `staff.manage`). */
final class ListStaffAction
{
    use ApiResponse;

    public function __construct(private readonly UserRepository $users)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $rows = array_map(
            static fn (User $u): array => $u->toArray(),
            $this->users->all(),
        );

        return $this->success($response, $rows);
    }
}
