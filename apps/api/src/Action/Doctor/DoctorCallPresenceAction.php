<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\CallPresence;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor/appointments/presence — who is in the call right now, for the
 * signed-in doctor's consultations that have anyone in them:
 * `{ "<appointment id>": { "doctor": false, "patient": true } }`. Polled by the
 * schedule, dashboard and consultation page while they are open.
 */
final class DoctorCallPresenceAction
{
    use ApiResponse;

    public function __construct(
        private readonly UserRepository $users,
        private readonly CallPresence $presence,
    ) {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $user = $this->users->find((string) $request->getAttribute('user_id'));
        if ($user === null || !in_array('doctor', $user->getRoles(), true) || $user->getSpecialistId() === null) {
            return $this->error($response, 'This account is not a doctor login', 403);
        }

        return $this->success($response, (object) $this->presence->forSpecialist($user->getSpecialistId()))
            ->withHeader('Cache-Control', 'no-store');
    }
}
