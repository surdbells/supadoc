<?php

declare(strict_types=1);

namespace App\Action\Specialist;

use App\Domain\Entity\Appointment;
use App\Domain\Entity\Specialist;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/specialists/{id}/appointments?page=&per_page=&status=&search= — one
 * doctor's consultations for the back office's doctor page, newest first:
 * each appointment with the patient's name only (no contact details, and none
 * of what the doctor and patient wrote each other). `status` takes a comma
 * list; `search` matches the patient's name. Needs `specialists.manage`.
 */
final class ListSpecialistAppointmentsAction
{
    use ApiResponse;

    public function __construct(
        private readonly SpecialistRepository $specialists,
        private readonly AppointmentRepository $appointments,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        /** @var Specialist $specialist */
        $specialist = $this->specialists->findOrFail((string) ($args['id'] ?? ''));
        $query      = $request->getQueryParams();
        $p          = $this->getPaginationParams($query);

        $statuses = null;
        if (is_string($query['status'] ?? null) && $query['status'] !== '') {
            $statuses = array_values(array_filter(array_map(
                static fn (string $s): ?AppointmentStatus => AppointmentStatus::tryFrom(strtolower(trim($s))),
                explode(',', $query['status']),
            ))) ?: null;
        }
        $search = trim((string) ($query['search'] ?? ''));

        $page = $this->appointments->paginatedForSpecialist(
            $p['offset'],
            $p['per_page'],
            $specialist->getId(),
            $statuses,
            $search !== '' ? $search : null,
        );

        $rows = array_map(static function (Appointment $a): array {
            $row = $a->toArray('staff');
            unset($row['follow_up_note'], $row['decline_reason'], $row['notes'], $row['document_url']);
            $p = $a->getPatient()->toArray();

            return $row + ['patient_name' => trim(((string) ($p['first_name'] ?? '')) . ' ' . ((string) ($p['last_name'] ?? ''))) ?: 'Patient'];
        }, $page['items']);

        return $this->paginated($response, $rows, $page['total'], $p['page'], $p['per_page']);
    }
}
