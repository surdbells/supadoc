<?php

declare(strict_types=1);

namespace App\Action\Admin;

use App\Domain\Entity\User;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\SessionService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * PATCH /api/staff/{id} — update a staff account's name, email, roles,
 * permissions, active flag or specialist link (needs `staff.manage`). Only the
 * keys present in the body change. Guardrails: only a super_admin may grant
 * super_admin or edit a super_admin account, and you can't deactivate yourself.
 * Deactivating a login signs it out everywhere at once.
 */
final class UpdateStaffAction
{
    use ApiResponse;
    use ManagesStaff;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly SessionService $sessions,
    ) {
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

        $isSelf = $user->getId() === $actor;

        if (array_key_exists('roles', $body)) {
            $roles = $this->cleanRoles($body['roles']);
            if (!$isSuper && $isSelf) {
                return $this->error($response, 'You cannot change your own roles', 403);
            }
            $violation = $this->grantViolation($request, $roles, [], $user->getRoles());
            if ($violation !== null) {
                return $this->error($response, $violation, 403);
            }
            $user->setRoles($roles);
        }

        if (array_key_exists('permissions', $body)) {
            $permissions = $this->cleanPermissions($body['permissions']);
            if (!$isSuper && $isSelf) {
                return $this->error($response, 'You cannot change your own permissions', 403);
            }
            $violation = $this->grantViolation($request, [], $permissions, [], $user->getPermissions());
            if ($violation !== null) {
                return $this->error($response, $violation, 403);
            }
            $user->setPermissions($permissions);
        }

        $deactivated = false;
        if (array_key_exists('active', $body)) {
            $active = (bool) $body['active'];
            if (!$active && $user->getId() === $actor) {
                $errors['active'] = 'You cannot deactivate your own account';
            } else {
                $deactivated = !$active && $user->isActive();
                $user->setActive($active);
            }
        }

        if (array_key_exists('specialist_id', $body)) {
            // Null / '' unlinks; otherwise the specialist must exist and be free.
            $specialistId = trim((string) $body['specialist_id']);
            $problem      = $specialistId !== ''
                ? $this->specialistLinkProblem($this->specialists, $this->users, $specialistId, $user->getId())
                : null;
            if ($problem !== null) {
                $errors['specialist_id'] = $problem;
            } else {
                $user->setSpecialistId($specialistId);
            }
        }

        if ($errors !== []) {
            return $this->error($response, 'Validation failed', 422, $errors);
        }

        $this->users->save($user);
        // A deactivated login is signed out everywhere now, not when its access
        // token runs out.
        if ($deactivated) {
            $this->sessions->revokeAllStaff($user->getId());
        }

        return $this->success($response, $user->toArray(), 'Staff account updated');
    }
}
