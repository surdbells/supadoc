<?php

declare(strict_types=1);

namespace App\Action\Admin;

use App\Domain\Entity\User;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/staff/{id}/password — an admin sets a staff account's password
 * (no current-password needed). Min 8 chars. Only a super_admin may reset a
 * super_admin account. Needs `staff.manage`.
 */
final class ResetStaffPasswordAction
{
    use ApiResponse;
    use ManagesStaff;

    public function __construct(private readonly UserRepository $users)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        /** @var User $user */
        $user = $this->users->findOrFail((string) $args['id']);
        $body = (array) $request->getParsedBody();
        $next = (string) ($body['new_password'] ?? '');

        if (in_array('super_admin', $user->getRoles(), true) && !$this->actorIsSuperAdmin($request)) {
            return $this->error($response, 'Only a super admin can reset this account', 403);
        }

        if (strlen($next) < 8) {
            return $this->error($response, 'Validation failed', 422, [
                'new_password' => 'Password must be at least 8 characters',
            ]);
        }

        $user->setPassword($next);
        $this->users->save($user);

        return $this->success($response, ['changed' => true], 'Password reset');
    }
}
