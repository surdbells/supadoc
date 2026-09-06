<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\Specialist;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use Psr\Http\Message\ServerRequestInterface;

/**
 * Resolves the Specialist profile owned by the signed-in doctor: the staff user
 * must have the `doctor` role and a linked specialist. Returns null when the
 * account isn't a doctor (so the action can answer 403), keeping doctors to
 * managing only their own profile.
 */
trait ResolvesDoctorSpecialist
{
    private function doctorSpecialist(
        ServerRequestInterface $request,
        UserRepository $users,
        SpecialistRepository $specialists,
    ): ?Specialist {
        $user = $users->find((string) $request->getAttribute('user_id'));
        if (
            $user === null
            || !in_array('doctor', $user->getRoles(), true)
            || $user->getSpecialistId() === null
        ) {
            return null;
        }

        $specialist = $specialists->find($user->getSpecialistId());

        return $specialist instanceof Specialist ? $specialist : null;
    }
}
