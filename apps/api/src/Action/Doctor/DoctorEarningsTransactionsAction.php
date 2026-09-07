<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\Appointment;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\EarningsService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor/earnings/transactions — one line per completed consultation
 * (gross / commission / net), paginated, newest first.
 */
final class DoctorEarningsTransactionsAction
{
    use ApiResponse;
    use ResolvesDoctorSpecialist;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly AppointmentRepository $appointments,
        private readonly EarningsService $earnings,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $specialist = $this->doctorSpecialist($request, $this->users, $this->specialists);
        if ($specialist === null) {
            return $this->error($response, 'This account is not a doctor profile', 403);
        }

        $params = $this->getPaginationParams($request->getQueryParams());
        $page   = $this->appointments->paginatedForSpecialist(
            $params['offset'],
            $params['per_page'],
            $specialist->getId(),
            [AppointmentStatus::COMPLETED],
        );

        $items = array_map(function (Appointment $a): array {
            $p     = $a->getPatient()->toArray();
            $gross = $a->getAmount();

            return [
                'appointment_id' => $a->getId(),
                'patient_name'   => trim(((string) $p['first_name']) . ' ' . ((string) $p['last_name'])),
                'date'           => $a->getScheduledAt()->format(DATE_ATOM),
                'gross'          => $gross,
                'commission'     => $this->earnings->commission($gross),
                'net'            => $this->earnings->net($gross),
            ];
        }, $page['items']);

        return $this->paginated($response, $items, $page['total'], $params['page'], $params['per_page']);
    }
}
