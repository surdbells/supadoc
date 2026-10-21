<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Document\DocumentAccessPolicy;
use App\Infrastructure\Document\DocumentSharingViews;
use App\Infrastructure\Document\VisibleDocument;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor/appointments/{id}/patient-documents — the documents this
 * consultation's patient has SHARED with the signed-in doctor, newest first
 * (kept for doctor bundles from before document sharing; new code uses
 * GET …/document-access). Same array shape as before, but filtered by
 * DocumentAccessPolicy and cut down to the doctor allowlist
 * ({@see \App\Domain\Entity\MedicalDocument::toDoctorArray()}). The doctor must
 * own the consultation and it must not be deleted (403).
 *
 * Fails closed: if the policy can't answer, the answer is `[]` — and the
 * failure is reported to Sentry and the error log, so it is never silent.
 */
final class ListPatientDocumentsAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;

    public function __construct(
        private readonly UserRepository $users,
        private readonly AppointmentRepository $appointments,
        private readonly DocumentAccessPolicy $policy,
        private readonly DocumentSharingViews $views,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $appointment = $this->doctorAppointment($request, $this->users, $this->appointments, strtolower(trim((string) $args['id'])));
        if ($appointment === null || $appointment->isDeleted()) {
            return $this->error($response, 'Consultation not found', 403);
        }
        $doctor  = $appointment->getSpecialist();
        $patient = $appointment->getPatient();

        try {
            $visible = $this->policy->visibleDocuments($doctor, $patient, Rules::now());
            $own     = $visible !== [] ? $this->views->ownAppointmentIds($patient->getId(), $doctor->getId()) : [];
            $items   = array_map(
                static fn (VisibleDocument $v): array => $v->document->toDoctorArray($doctor->getId(), $own),
                $visible,
            );
        } catch (\Throwable $e) {
            if (function_exists('\Sentry\captureException')) {
                \Sentry\captureException($e);
            }
            error_log('[doc-access] legacy patient-documents list failed: ' . $e::class . ': ' . $e->getMessage());
            $items = [];
        }

        return $this->success($response, $items)->withHeader('Cache-Control', 'no-store');
    }
}
