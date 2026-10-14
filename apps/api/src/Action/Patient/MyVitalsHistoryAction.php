<?php

declare(strict_types=1);

namespace App\Action\Patient;

use App\Domain\Entity\Patient;
use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Vitals\VitalsService;
use DateTimeImmutable;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/me/vitals/history?key=&limit= — the patient's readings,
 * newest first: every type, or one (`key`, e.g. blood_pressure). `limit`
 * defaults to 50, at most 200.
 */
final class MyVitalsHistoryAction
{
    use ApiResponse;

    public function __construct(
        private readonly PatientRepository $patients,
        private readonly VitalsService $vitals,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        /** @var Patient $patient */
        $patient = $this->patients->findOrFail((string) $request->getAttribute('customer_id'));
        $query   = $request->getQueryParams();

        return $this->success(
            $response,
            $this->vitals->history($patient, $query['key'] ?? null, $query['limit'] ?? null, new DateTimeImmutable()),
        );
    }
}
