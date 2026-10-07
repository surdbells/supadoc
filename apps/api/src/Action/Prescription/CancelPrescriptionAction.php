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
 * POST /api/doctor/prescriptions/{rxId}/cancel — {reason, replace?} cancel an
 * active prescription (final); with `replace`, a new draft pre-filled from it is
 * returned for the doctor to correct and send.
 */
final class CancelPrescriptionAction
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
        $body = (array) ($request->getParsedBody() ?? []);
        [$cancelled, $replacement] = $this->service->cancel(
            $rx,
            $doctor,
            (string) ($body['reason'] ?? ''),
            filter_var($body['replace'] ?? false, FILTER_VALIDATE_BOOLEAN),
        );

        return $this->noStore($this->success($response, [
            'cancelled'   => $cancelled->toArray(),
            'replacement' => $replacement?->toArray(),
        ], $replacement !== null ? 'Cancelled — a replacement draft is ready' : 'Prescription cancelled'));
    }
}
