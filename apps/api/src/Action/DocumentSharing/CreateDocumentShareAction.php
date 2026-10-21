<?php

declare(strict_types=1);

namespace App\Action\DocumentSharing;

use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Entity\Patient;
use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Document\DocumentSharingService;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/document-access/grants (CreateDocumentShareInput) — share
 * the whole folder or selected documents with 1–5 doctors the patient has
 * booked, for a period or with no end date. One transaction under every
 * pair's lock: any refusal shares nothing. 201 DocumentShareResultDto; 200
 * with `replayed: true` for a repeat of the same `client_key` and choices
 * within 24 hours (409 `idempotency_conflict` with other choices).
 */
final class CreateDocumentShareAction
{
    use ApiResponse;
    use SharingActionSupport;

    public function __construct(
        private readonly PatientRepository $patients,
        private readonly DocumentSharingService $sharing,
    ) {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        return $this->forPatient($request, $response, $this->patients, function (Patient $p) use ($request, $response): ResponseInterface {
            $result = $this->sharing->share($p, $this->body($request), Rules::now());

            return $result['replayed']
                ? $this->success($response, $result, 'Already shared')
                : $this->created($response, $result, 'Shared');
        });
    }
}
