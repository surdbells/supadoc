<?php

declare(strict_types=1);

namespace App\Action\Admin;

use App\Domain\Entity\User;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * PATCH /api/staff/{id} — update a staff account's name, email, roles,
 * permissions, active flag or specialist link (needs `staff.manage`). Only the
 * keys present in the body change. Guardrails: only a super_admin may grant
 * super_admin or edit a super_admin account, and you can't deactivate yourself.
 */
final class UpdateStaffAction
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
        $user   = $this->users->findOrFail((string) $args['id']);
        $body   = (array) $request->getParsedBody();
        $actor  = (string) $request->getAttribute('user_id');
        $isSuper = $this->actorIsSuperAdmin($request);

        // A super_admin account can only be edited by a super_admin.
        if (in_array('super_admin', $user->getRoles(), true) && !$isSuper) {
            return $this->error($response, 'Only a super admin can edit this account', 403);
        }

        $errors = [];

        if (array_key_exists('email', $body)) {
            $email = strtolower(trim((string) $body['email']));
            if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
                $errors['email'] = 'A valid email is required';
            } else {
                $existing = $this->users->findByEmail($email);
                if ($existing !== null && $existing->getId() !== $user->getId()) {
                    $errors['email'] = 'An account with this email already exists';
                } else {
                    $user->setEmail($email);
                }
            }
        }

        if (array_key_exists('first_name', $body)) {
            $first = trim((string) $body['first_name']);
            if ($first === '') {
                $errors['first_name'] = 'First name is required';
            } else {
                $user->setFirstName($first);
            }
        }

        if (array_key_exists('last_name', $body)) {
            $last = trim((string) $body['last_name']);
            if ($last === '') {
                $errors['last_name'] = 'Last name is required';
            } else {
                $user->setLastName($last);
            }
        }

        if (array_key_exists('roles', $body)) {
            $roles = $this->cleanRoles($body['roles']);
            if (in_array('super_admin', $roles, true) && !$isSuper) {
                return $this->error($response, 'Only a super admin can grant the super_admin role', 403);
            }
            $user->setRoles($roles);
        }

        if (array_key_exists('permissions', $body)) {
            $user->setPermissions($this->cleanPermissions($body['permissions']));
        }

        if (array_key_exists('active', $body)) {
            $active = (bool) $body['active'];
            if (!$active && $user->getId() === $actor) {
                $errors['active'] = 'You cannot deactivate your own account';
            } else {
                $user->setActive($active);
            }
        }

        if (array_key_exists('specialist_id', $body)) {
            $user->setSpecialistId((string) $body['specialist_id']);
        }

        if ($errors !== []) {
            return $this->error($response, 'Validation failed', 422, $errors);
        }

        $this->users->save($user);

        return $this->success($response, $user->toArray(), 'Staff account updated');
    }
}
