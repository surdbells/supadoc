<?php

declare(strict_types=1);

namespace App\Action\Admin;

use App\Domain\Entity\Patient;
use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/patients?search=&limit= — staff patient lookup (name / email / phone)
 * for booking on a patient's behalf. Returns a slim projection (never medical or
 * account internals). Gated by the appointment-create permission.
 */
final class SearchPatientsAction
{
    use ApiResponse;

    public function __construct(private readonly PatientRepository $patients)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $query = $request->getQueryParams();
        $term  = trim((string) ($query['search'] ?? $query['q'] ?? ''));
        $limit = (int) ($query['limit'] ?? 10);

        // Require a couple of characters so we never dump the whole table.
        if (mb_strlen($term) < 2) {
            return $this->success($response, []);
        }

        $rows = array_map(
            static function (Patient $p): array {
                $a = $p->toArray();

                return [
                    'id'         => $a['id'],
                    'first_name' => $a['first_name'],
                    'last_name'  => $a['last_name'],
                    'email'      => $a['email'],
                    'phone'      => $a['phone'],
                ];
            },
            $this->patients->search($term, $limit),
        );

        return $this->success($response, $rows);
    }
}
