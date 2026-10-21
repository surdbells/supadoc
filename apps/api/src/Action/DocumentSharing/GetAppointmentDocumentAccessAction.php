<?php

declare(strict_types=1);

namespace App\Action\DocumentSharing;

use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Document\DomainRefusal;
use App\Domain\Entity\Patient;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Document\DocumentSharingViews;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/appointments/{id}/document-access — for one of the patient's
 * consultations: what that doctor can see now (from the same policy query as
 * the doctor's own view), the files attached when booking that they can't
 * see, the consultation's `after_*` options and the doctor's pending request.
 * 404 when it isn't the patient's. Polled passively (`X-SD-Passive: 1`):
 * never extends the session's idle clock. AppointmentDocumentAccessDto.
 */
final class GetAppointmentDocumentAccessAction
{
    use ApiResponse;
    use SharingActionSupport;

    public function __construct(
        private readonly PatientRepository $patients,
        private readonly AppointmentRepository $appointments,
        private readonly DocumentSharingViews $views,
    ) {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response, array $args): ResponseInterface
    {
        return $this->forPatient($request, $response, $this->patients, function (Patient $p) use ($response, $args): ResponseInterface {
            $id          = Rules::lowerUuid($args['id'] ?? null);
            $appointment = $id !== null ? $this->appointments->findForPatient($id, $p->getId()) : null;
            if ($appointment === null) {
                throw DomainRefusal::notFound('Appointment not found');
            }

            return $this->success($response, $this->views->appointmentAccess($p, $appointment, Rules::now()));
        });
    }
}
