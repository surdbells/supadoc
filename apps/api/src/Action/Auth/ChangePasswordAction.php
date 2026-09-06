<?php

declare(strict_types=1);

namespace App\Action\Auth;

use App\Domain\Entity\User;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/me/password — change the signed-in staff user's password. Requires
 * the current password; the new one must be at least 8 characters. Works for any
 * staff account (admin, doctor, viewer) since the user comes from the token.
 */
final class ChangePasswordAction
{
    use ApiResponse;

    public function __construct(private readonly UserRepository $users)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $userId  = (string) $request->getAttribute('user_id');
        $body    = (array) $request->getParsedBody();
        $current = (string) ($body['current_password'] ?? '');
        $next    = (string) ($body['new_password'] ?? '');

        if (strlen($next) < 8) {
            return $this->error($response, 'Validation failed', 422, [
                'new_password' => 'Password must be at least 8 characters',
            ]);
        }

        $user = $this->users->find($userId);
        if (!$user instanceof User) {
            return $this->error($response, 'Not authenticated', 401);
        }

        if (!$user->verifyPassword($current)) {
            return $this->error($response, 'Current password is incorrect', 422, [
                'current_password' => 'Current password is incorrect',
            ]);
        }

        $user->setPassword($next);
        $this->users->save($user);

        return $this->success($response, ['changed' => true], 'Password updated');
    }
}
