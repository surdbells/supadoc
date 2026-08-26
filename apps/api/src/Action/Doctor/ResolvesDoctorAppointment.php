<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\Appointment;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\UserRepository;
use Psr\Http\Message\ServerRequestInterface;

/**
 * Shared authorisation for the doctor's in-consultation actions: the signed-in
 * staff user must be a `doctor` linked to a specialist, and that specialist must
 * own the appointment. Returns null when any check fails so the action can answer
 * with a 403 — a doctor can only ever touch their own consultations.
 */
trait ResolvesDoctorAppointment
{
    private function doctorAppointment(
        ServerRequestInterface $request,
        UserRepository $users,
        AppointmentRepository $appointments,
        string $appointmentId,
    ): ?Appointment {
        $user = $users->find((string) $request->getAttribute('user_id'));
        if (
            $user === null
            || !in_array('doctor', $user->getRoles(), true)
            || $user->getSpecialistId() === null
        ) {
            return null;
        }

        $appointment = $appointments->find($appointmentId);
        if ($appointment === null || $appointment->getSpecialist()->getId() !== $user->getSpecialistId()) {
            return null;
        }

        return $appointment;
    }
}
