<?php

declare(strict_types=1);

namespace App\Action\DocumentSharing;

use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Document\DomainRefusal;
use App\Domain\Entity\Patient;
use App\Domain\Repository\DocumentAccessGrantRepository;
use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Document\DocumentSharingViews;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/document-access/grants?status=active|ended&specialist_id= —
 * the patient's shares (DocumentGrantDto[]): `active` = in their window now
 * (a doctor who isn't practising shows as `paused`); `ended` = ended in the
 * last 90 days, plus any past its end the sweeper hasn't recorded yet
 * (`expired`), newest first, at most 100.
 */
final class ListDocumentGrantsAction
{
    use ApiResponse;
    use SharingActionSupport;

    public function __construct(
        private readonly PatientRepository $patients,
        private readonly DocumentAccessGrantRepository $grants,
        private readonly DocumentSharingViews $views,
    ) {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        return $this->forPatient($request, $response, $this->patients, function (Patient $p) use ($request, $response): ResponseInterface {
            $query  = $request->getQueryParams();
            $status = (string) ($query['status'] ?? 'active');
            if (!in_array($status, ['active', 'ended'], true)) {
                throw DomainRefusal::field('status', 'Use status active or ended');
            }
            $specialist = null;
            if (($query['specialist_id'] ?? '') !== '') {
                $specialist = Rules::lowerUuid($query['specialist_id']) ?? throw DomainRefusal::field('specialist_id', 'Invalid doctor id');
            }
            $now = Rules::now();

            return $this->success($response, $this->views->grantDtos($p, $this->grants->listForPatient($p->getId(), $status, $specialist, $now), $now));
        });
    }
}
