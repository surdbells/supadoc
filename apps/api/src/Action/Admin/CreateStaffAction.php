<?php

declare(strict_types=1);

namespace App\Action\Admin;

use App\Domain\Entity\Specialist;
use App\Domain\Entity\User;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Domain\Settings\WebUrls;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\StaffPasswordService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/staff — create a staff account (needs `staff.manage`). Either set a
 * temporary password, or — for a doctor login linked to a specialist — pass
 * `send_invite: true` to email them a one-time link to choose their own (no
 * password changes hands). A linked specialist must exist and not already
 * belong to another login.
 */
final class CreateStaffAction
{
    use ApiResponse;
    use ManagesStaff;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly StaffPasswordService $passwords,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $body         = (array) $request->getParsedBody();
        $email        = strtolower(trim((string) ($body['email'] ?? '')));
        $firstName    = trim((string) ($body['first_name'] ?? ''));
        $lastName     = trim((string) ($body['last_name'] ?? ''));
        $password     = (string) ($body['password'] ?? '');
        $sendInvite   = filter_var($body['send_invite'] ?? false, FILTER_VALIDATE_BOOLEAN);
        $specialistId = trim((string) ($body['specialist_id'] ?? ''));
        $roles        = $this->cleanRoles($body['roles'] ?? []);
        $permissions  = $this->cleanPermissions($body['permissions'] ?? []);

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
        if ($sendInvite) {
            if (!in_array('doctor', $roles, true)) {
                $errors['send_invite'] = 'Email invites are for doctor logins — set a temporary password instead';
            } elseif ($specialistId === '') {
                $errors['specialist_id'] = 'Choose the specialist this doctor login is for';
            }
        } elseif (strlen($password) < StaffPasswordService::MIN_PASSWORD) {
            $errors['password'] = 'Password must be at least ' . StaffPasswordService::MIN_PASSWORD . ' characters';
        }
        if ($specialistId !== '') {
            $problem = $this->specialistLinkProblem($this->specialists, $this->users, $specialistId);
            if ($problem !== null) {
                $errors['specialist_id'] = $problem;
            }
        }
        if ($errors !== []) {
            return $this->error($response, 'Validation failed', 422, $errors);
        }

        $violation = $this->grantViolation($request, $roles, $permissions);
        if ($violation !== null) {
            return $this->error($response, $violation, 403);
        }

        $user = new User($email, $firstName, $lastName);
        if (!$sendInvite) {
            $user->setPassword($password);
        }
        $user->setRoles($roles);
        $user->setPermissions($permissions);
        $user->setSpecialistId($specialistId !== '' ? $specialistId : null);
        $this->users->save($user);

        if (!$sendInvite) {
            return $this->created($response, $user->toArray(), 'Staff account created');
        }

        // No usable password until they choose one from the emailed link.
        $specialist = $this->specialists->find($specialistId);
        $invite     = $this->passwords->sendInvite(
            $user,
            trim($firstName . ' ' . $lastName),
            WebUrls::forSpecialist($specialist instanceof Specialist ? $specialist : null),
        );

        return $this->created(
            $response,
            $user->toArray() + ['invite' => $invite],
            $invite['email_sent'] ? 'Doctor login created and invite sent' : 'Doctor login created, but the invite email could not be sent',
        );
    }
}
