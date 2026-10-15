<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\Appointment;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\EarningsService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor/earnings/transactions — one line per consultation that earned
 * something (completed, or missed with the patient the one who didn't come:
 * `status`, `no_show`), gross (its amount less any refund) / commission / net,
 * paginated, newest first. While the doctor is
 * suspended `patient_name` is just "Patient" (no patient data).
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
        // Completed consultations, and missed ones the patient didn't come to.
        $page   = $this->appointments->paginatedEarnedForSpecialist(
            $params['offset'],
            $params['per_page'],
            $specialist->getId(),
        );

        // A suspended doctor still sees their earnings, but no patient data.
        $anonymous = $specialist->isSuspended();
        $items     = array_map(function (Appointment $a) use ($anonymous): array {
            // What it earned: the amount less any refund (a missed one's guest fees / refund share).
            $gross = bcsub($a->getAmount(), $a->getRefundedAmount(), 2);
            if ($anonymous) {
                $name = 'Patient';
            } else {
                $p    = $a->getPatient()->toArray();
                $name = trim(((string) $p['first_name']) . ' ' . ((string) $p['last_name']));
            }

            return [
                'appointment_id' => $a->getId(),
                'patient_name'   => $name,
                'date'           => $a->getScheduledAt()->format(DATE_ATOM),
                'status'         => $a->getStatus()->value,
                'no_show'        => $a->getNoShow(),
                'gross'          => $gross,
                'commission'     => $this->earnings->commission($gross),
                'net'            => $this->earnings->net($gross),
            ];
        }, $page['items']);

        return $this->paginated($response, $items, $page['total'], $params['page'], $params['per_page']);
    }
}
