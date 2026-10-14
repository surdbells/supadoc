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
 * POST /api/portal/me/vitals — add the patient's own readings. Body:
 * {readings: {key: value}, taken_at?, source?: self_reported|patient_device}.
 * Checked with the prescription form's rules (ranges, blood pressure as
 * systolic/diastolic, worked-out BMI); `taken_at` defaults to now and may not be
 * in the future. Always recorded as the patient's — never as a doctor's.
 * Returns the same body as GET.
 */
final class RecordMyVitalsAction
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
        $now     = new DateTimeImmutable();

        $count = $this->vitals->recordByPatient($patient, (array) $request->getParsedBody(), $now);

        return $this->success(
            $response,
            $this->vitals->overview($patient, $now),
            $count === 1 ? 'Reading saved' : 'Readings saved',
        );
    }
}
