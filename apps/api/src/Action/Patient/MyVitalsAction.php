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
 * GET /api/portal/me/vitals — the signed-in patient's latest health readings
 * (who recorded each, and whether it is out of date), the reading catalogue for
 * the "Update vitals" form, and whether to remind them to add readings.
 */
final class MyVitalsAction
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

        return $this->success($response, $this->vitals->overview($patient, new DateTimeImmutable()));
    }
}
