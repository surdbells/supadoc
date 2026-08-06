<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Enum\AppointmentStatus;
use App\Domain\Repository\AppointmentRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/** GET /api/appointments — staff list, paginated, optional `?status=` filter. */
final class ListAppointmentsAction
{
    use ApiResponse;

    public function __construct(private readonly AppointmentRepository $repo)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $query = $request->getQueryParams();
        $p     = $this->getPaginationParams($query);

        $result = $this->repo->paginated(
            $p['offset'],
            $p['per_page'],
            $p['sort_by'],
            $p['sort_dir'],
            null,
            $this->parseStatuses($query['status'] ?? null),
        );

        return $this->paginated(
            $response,
            array_map(static fn ($a) => $a->toArray(), $result['items']),
            $result['total'],
            $p['page'],
            $p['per_page'],
        );
    }

    /**
     * Normalise case and validate against the enum so junk never reaches SQL
     * (Postgres `=` is case-sensitive — see ARCHITECTURE §11).
     *
     * @return list<AppointmentStatus>|null
     */
    private function parseStatuses(mixed $raw): ?array
    {
        if (!is_string($raw) || $raw === '') {
            return null;
        }

        $valid = array_values(array_filter(array_map(
            static fn (string $s): ?AppointmentStatus =>
                AppointmentStatus::tryFrom(strtolower(trim($s))),
            explode(',', $raw),
        )));

        return $valid === [] ? null : $valid;
    }
}
