<?php

declare(strict_types=1);

namespace App\Action\Prescription;

use App\Action\Doctor\ResolvesDoctorSpecialist;
use App\Domain\Entity\Prescription;
use App\Domain\Entity\Specialist;
use App\Domain\Repository\PrescriptionRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * Shared plumbing for the doctor's prescription endpoints: resolve the signed-in
 * doctor's specialist profile, and load a prescription only if that doctor wrote
 * it — any other prescription answers 404 (never revealing that it exists).
 */
trait DoctorPrescriptionSupport
{
    use ApiResponse;
    use ResolvesDoctorSpecialist;

    /**
     * @return array{0: ?Specialist, 1: ?ResponseInterface} the doctor, or an error response
     */
    private function doctor(
        ServerRequestInterface $request,
        ResponseInterface $response,
        UserRepository $users,
        SpecialistRepository $specialists,
    ): array {
        $doctor = $this->doctorSpecialist($request, $users, $specialists);

        return $doctor === null
            ? [null, $this->error($response, 'This account is not a doctor profile', 403)]
            : [$doctor, null];
    }

    private function ownPrescription(PrescriptionRepository $prescriptions, Specialist $doctor, string $id): ?Prescription
    {
        $rx = $prescriptions->findById($id);

        return $rx !== null && $rx->getSpecialistId() === $doctor->getId() ? $rx : null;
    }

    private function noStore(ResponseInterface $response): ResponseInterface
    {
        return $response->withHeader('Cache-Control', 'no-store');
    }
}
