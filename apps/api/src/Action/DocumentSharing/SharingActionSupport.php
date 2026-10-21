<?php

declare(strict_types=1);

namespace App\Action\DocumentSharing;

use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Document\DomainRefusal;
use App\Domain\Entity\Patient;
use App\Domain\Repository\PatientRepository;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * Shared plumbing of the patient's document-sharing actions (spec §3.3): the
 * signed-in patient (from `customer_id`, never the body), the kill switch
 * (503 `sharing_unavailable` on every one of these routes while sharing is
 * off), and a {@see DomainRefusal} answered in the API envelope.
 */
trait SharingActionSupport
{
    /** The signed-in patient, or null (their account is gone). */
    private function currentPatient(ServerRequestInterface $request, PatientRepository $patients): ?Patient
    {
        $patient = $patients->find((string) $request->getAttribute('customer_id'));

        return $patient instanceof Patient ? $patient : null;
    }

    /**
     * Run `$handle(Patient)` for the signed-in patient, answering a refusal
     * (or the kill switch) with its status and errors.
     *
     * @param callable(Patient): ResponseInterface $handle
     */
    private function forPatient(ServerRequestInterface $request, ResponseInterface $response, PatientRepository $patients, callable $handle): ResponseInterface
    {
        try {
            if (!Rules::enabled()) {
                throw DomainRefusal::unavailable();
            }
            $patient = $this->currentPatient($request, $patients);
            if ($patient === null) {
                return $this->error($response, 'Account not found', 404);
            }

            return $handle($patient)->withHeader('Cache-Control', 'no-store');
        } catch (DomainRefusal $refusal) {
            return $this->refused($response, $refusal);
        }
    }

    private function refused(ResponseInterface $response, DomainRefusal $refusal): ResponseInterface
    {
        return $this->error($response, $refusal->getMessage(), $refusal->status, $refusal->errors);
    }

    /** The JSON body (an empty array when there is none). @return array<string,mixed> */
    private function body(ServerRequestInterface $request): array
    {
        $body = $request->getParsedBody();

        return is_array($body) ? $body : [];
    }
}
