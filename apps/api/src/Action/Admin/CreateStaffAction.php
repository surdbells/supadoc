<?php

declare(strict_types=1);

namespace App\Action\Admin;

use App\Domain\Entity\User;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/** POST /api/staff — create a staff account (needs `staff.manage`). */
final class CreateStaffAction
{
    use ApiResponse;
    use ManagesStaff;

    public function __construct(private readonly UserRepository $users)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $body      = (array) $request->getParsedBody();
        $email     = strtolower(trim((string) ($body['email'] ?? '')));
        $firstName = trim((string) ($body['first_name'] ?? ''));
        $lastName  = trim((string) ($body['last_name'] ?? ''));
        $password  = (string) ($body['password'] ?? '');

        $errors = [];
        if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
            $errors['email'] = 'A valid email is required';
        } elseif ($this->users->findByEmail($email) !== null) {
            $errors['email'] = 'An account with this email already exists';
        }
        if ($firstName === '') {
            $errors['first_name'] = 'First name is required';
        }
        if ($lastName === '') {
            $errors['last_name'] = 'Last name is required';
        }
        if (strlen($password) < 8) {
            $errors['password'] = 'Password must be at least 8 characters';
        }
        if ($errors !== []) {
            return $this->error($response, 'Validation failed', 422, $errors);
        }

        $roles       = $this->cleanRoles($body['roles'] ?? []);
        $permissions = $this->cleanPermissions($body['permissions'] ?? []);

        if (in_array('super_admin', $roles, true) && !$this->actorIsSuperAdmin($request)) {
            return $this->error($response, 'Only a super admin can grant the super_admin role', 403);
        }

        $user = new User($email, $firstName, $lastName);
        $user->setPassword($password);
        $user->setRoles($roles);
        $user->setPermissions($permissions);
        $user->setSpecialistId(isset($body['specialist_id']) ? (string) $body['specialist_id'] : null);
        $this->users->save($user);

        return $this->created($response, $user->toArray(), 'Staff account created');
    }
}
