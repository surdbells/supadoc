<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\Appointment;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor/appointments/history — paginated, filterable history of the
 * signed-in doctor's consultations (newest first). Query: page, per_page,
 * status (CSV), search (patient name/email).
 */
final class DoctorAppointmentHistoryAction
{
    use ApiResponse;
    use ResolvesDoctorSpecialist;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly AppointmentRepository $appointments,
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

        $query   = $request->getQueryParams();
        $params  = $this->getPaginationParams($query);
        $search  = trim((string) ($query['search'] ?? ''));
        $statuses = $this->parseStatuses((string) ($query['status'] ?? ''));

        $page = $this->appointments->paginatedForSpecialist(
            $params['offset'],
            $params['per_page'],
            $specialist->getId(),
            $statuses,
            $search !== '' ? $search : null,
        );

        $items = array_map(
            static function (Appointment $a): array {
                $patient = $a->getPatient()->toArray();

                return $a->toArray() + [
                    'patient_name' => trim(((string) $patient['first_name']) . ' ' . ((string) $patient['last_name'])),
                ];
            },
            $page['items'],
        );

        return $this->paginated($response, $items, $page['total'], $params['page'], $params['per_page']);
    }

    /** @return list<AppointmentStatus>|null */
    private function parseStatuses(string $csv): ?array
    {
        $csv = trim($csv);
        if ($csv === '') {
            return null;
        }
        $out = [];
        foreach (explode(',', $csv) as $raw) {
            $status = AppointmentStatus::tryFrom(strtolower(trim($raw)));
            if ($status !== null) {
                $out[] = $status;
            }
        }

        return $out !== [] ? $out : null;
    }
}
