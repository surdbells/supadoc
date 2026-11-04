<?php

declare(strict_types=1);

namespace App\Action\LabRequest\Patient;

use App\Action\LabRequest\LabActionSupport;
use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Lab\LabRequestService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Message\UploadedFileInterface;

/**
 * POST /api/portal/lab-requests/{labId}/results (multipart) — the patient adds
 * a result file: `file` (PDF, JPG, PNG, WEBP, DCM, DOCX ≤ 10 MB),
 * `document_type`, `item_ids[]` (empty = all), `share` (1 / 0; absent = the
 * dialog's default) and `exclude_specialist_ids[]` (whole-folder holders who
 * must not see it). One transaction (spec §1.9): every refusal stores
 * nothing. 201 LabResultUploadedDto "Result added". Rate-limited (`lab-result`).
 */
final class UploadLabResultAction
{
    use LabActionSupport;

    public function __construct(
        private readonly PatientRepository $patients,
        private readonly LabRequestService $service,
    ) {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response, array $args): ResponseInterface
    {
        [$patient, $denied] = $this->labPatient($request, $response, $this->patients);
        if ($patient === null) {
            return $denied;
        }
        // Multipart text fields: the parsed body is populated from $_POST by the
        // request factory; fall back to $_POST directly in case it wasn't.
        $body = $this->body($request);
        if ($body === []) {
            $body = $_POST;
        }
        $file = $request->getUploadedFiles()['file'] ?? null;
        try {
            $out = $this->service->addResult($patient, (string) $args['labId'], $file instanceof UploadedFileInterface ? $file : null, $body);
        } catch (\Throwable $e) {
            if (!$e instanceof \App\Domain\Document\DomainRefusal && !$e instanceof \App\Domain\Exception\ValidationException) {
                error_log('[lab] result upload failed for request ' . preg_replace('/[^0-9a-f-]/i', '', (string) $args['labId']) . ': ' . $e::class);

                return $this->noStore($this->error($response, 'Could not save the result. Please try again.', 500));
            }

            return $this->refused($response, $e);
        }

        return $this->noStore($this->created($response, $out, 'Result added'));
    }
}
