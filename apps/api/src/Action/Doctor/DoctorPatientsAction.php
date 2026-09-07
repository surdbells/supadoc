<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor/patients — the doctor's own patients (one row each with visit
 * count + last visit), paginated, with an optional name/email search.
 */
final class DoctorPatientsAction
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

        $query  = $request->getQueryParams();
        $params = $this->getPaginationParams($query);
        $search = trim((string) ($query['search'] ?? ''));

        $page = $this->appointments->patientsForSpecialist(
            $params['offset'],
            $params['per_page'],
            $specialist->getId(),
            $search !== '' ? $search : null,
        );

        $items = array_map(static function (array $r): array {
            $last = $r['last_visit'] ?? null;
            if ($last instanceof \DateTimeInterface) {
                $last = $last->format(DATE_ATOM);
            } elseif (is_string($last) && $last !== '') {
                $last = str_replace(' ', 'T', $last);
            }

            return [
                'patient_id'  => (string) $r['patient_id'],
                'first_name'  => (string) ($r['first_name'] ?? ''),
                'last_name'   => (string) ($r['last_name'] ?? ''),
                'email'       => (string) ($r['email'] ?? ''),
                'visit_count' => (int) ($r['visit_count'] ?? 0),
                'last_visit'  => $last,
            ];
        }, $page['items']);

        return $this->paginated($response, $items, $page['total'], $params['page'], $params['per_page']);
    }
}
