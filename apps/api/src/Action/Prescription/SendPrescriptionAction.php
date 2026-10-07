<?php

declare(strict_types=1);

namespace App\Action\Prescription;

use App\Domain\Repository\PrescriptionRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Prescription\PrescriptionService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/doctor/prescriptions/{rxId}/send — tick the checklist, sign (saved
 * signature or drawn by hand) and send: the prescription becomes Active and
 * locked, and the patient gets an in-app notification and an email naming only
 * the doctor and the prescription number.
 */
final class SendPrescriptionAction
{
    use DoctorPrescriptionSupport;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly PrescriptionRepository $prescriptions,
        private readonly PrescriptionService $service,
    ) {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response, array $args): ResponseInterface
    {
        [$doctor, $denied] = $this->doctor($request, $response, $this->users, $this->specialists);
        if ($doctor === null) {
            return $denied;
        }
        $rx = $this->ownPrescription($this->prescriptions, $doctor, (string) $args['rxId']);
        if ($rx === null) {
            return $this->error($response, 'Prescription not found', 404);
        }
        $rx = $this->service->send($rx, $doctor, (array) ($request->getParsedBody() ?? []));

        return $this->noStore($this->success($response, $rx->toArray(), 'Prescription sent to the patient'));
    }
}
