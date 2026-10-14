<?php

declare(strict_types=1);

namespace App\Action\Patient;

use App\Domain\Entity\Patient;
use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Vitals\UpcomingConsultations;
use App\Infrastructure\Vitals\VitalsService;
use DateTimeImmutable;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/me/vitals — the signed-in patient's latest health readings
 * (who recorded each, whether it is out of date, and its Normal / High… flag),
 * the reading catalogue for the "Update vitals" form, and whether to remind
 * them to add readings (none yet, a consultation coming up, or out of date).
 */
final class MyVitalsAction
{
    use ApiResponse;

    public function __construct(
        private readonly PatientRepository $patients,
        private readonly VitalsService $vitals,
        private readonly UpcomingConsultations $upcoming,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        /** @var Patient $patient */
        $patient = $this->patients->findOrFail((string) $request->getAttribute('customer_id'));
        $now     = new DateTimeImmutable();

        return $this->success(
            $response,
            $this->vitals->overview($patient, $now, $this->upcoming->startingWithin($patient->getId(), $now)),
        );
    }
}
