<?php

declare(strict_types=1);

namespace App\Action\Auth;

use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/** GET /api/me — the authenticated staff user (from the token's `sub`). */
final class MeAction
{
    use ApiResponse;

    public function __construct(private readonly UserRepository $users)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $userId = (string) $request->getAttribute('user_id');
        $user   = $this->users->findOrFail($userId);

        return $this->success($response, $user->toArray());
    }
}
