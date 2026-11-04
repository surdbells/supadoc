<?php

declare(strict_types=1);

namespace App\Action\LabRequest;

use App\Action\Doctor\ResolvesDoctorSpecialist;
use App\Domain\Document\DomainRefusal;
use App\Domain\Entity\Patient;
use App\Domain\Entity\Specialist;
use App\Domain\Exception\ValidationException;
use App\Domain\Repository\PatientRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * Shared plumbing of the lab request actions: resolve the signed-in doctor
 * (403 "This account is not a doctor profile") or patient, answer the
 * service's refusals with their status, message and `errors`, and mark every
 * answer `Cache-Control: no-store` (lab requests are PHI).
 */
trait LabActionSupport
{
    use ApiResponse;
    use ResolvesDoctorSpecialist;

    /** @return array{0: ?Specialist, 1: ?ResponseInterface} */
    private function labDoctor(ServerRequestInterface $request, ResponseInterface $response, UserRepository $users, SpecialistRepository $specialists): array
    {
        $doctor = $this->doctorSpecialist($request, $users, $specialists);

        return $doctor === null
            ? [null, $this->noStore($this->error($response, 'This account is not a doctor profile', 403))]
            : [$doctor, null];
    }

    /** @return array{0: ?Patient, 1: ?ResponseInterface} */
    private function labPatient(ServerRequestInterface $request, ResponseInterface $response, PatientRepository $patients): array
    {
        $patient = $patients->find((string) $request->getAttribute('customer_id'));

        return $patient instanceof Patient && !$patient->isDeleted()
            ? [$patient, null]
            : [null, $this->noStore($this->error($response, 'Account not found', 404))];
    }

    /** A refusal / validation error as the envelope; anything else is rethrown (a 500, logged by the handler). */
    private function refused(ResponseInterface $response, \Throwable $e): ResponseInterface
    {
        if ($e instanceof DomainRefusal) {
            return $this->noStore($this->error($response, $e->getMessage(), $e->status, $e->errors));
        }
        if ($e instanceof ValidationException) {
            return $this->noStore($this->error($response, $e->getMessage(), 422, $e->getErrors()));
        }

        throw $e;
    }

    private function noStore(ResponseInterface $response): ResponseInterface
    {
        return $response->withHeader('Cache-Control', 'no-store');
    }

    /** @return array<string,mixed> */
    private function body(ServerRequestInterface $request): array
    {
        $body = $request->getParsedBody();

        return is_array($body) ? $body : [];
    }

    /**
     * `{status, message, data, meta: {total, page, per_page, total_pages, counts}}`.
     *
     * @param list<array<string,mixed>> $rows
     * @param array<string,int>         $counts
     */
    private function pageWithCounts(ResponseInterface $response, array $rows, int $total, int $page, int $perPage, array $counts): ResponseInterface
    {
        return $this->noStore($this->json($response, [
            'status'  => 'success',
            'message' => 'OK',
            'data'    => $rows,
            'meta'    => [
                'total'       => $total,
                'page'        => $page,
                'per_page'    => $perPage,
                'total_pages' => $perPage > 0 ? (int) ceil($total / $perPage) : 0,
                'counts'      => $counts,
            ],
        ]));
    }
}
