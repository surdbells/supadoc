<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\DocumentAccessGrantRepository;
use App\Domain\Repository\DocumentAccessLogRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Document\DocumentAccessPolicy;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AuditLogger;
use App\Infrastructure\Service\MedicalDocumentStorage;
use Doctrine\ORM\EntityManagerInterface;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor/appointments/{id}/patient-documents/{docId}/file — view one
 * document the consultation's patient shares with this doctor, in the doctor
 * app's view-only viewer (it can show and print, never download):
 *
 *  0. only the viewer may ask (`X-SD-Viewer: 1`); an old doctor tab that would
 *     open the file in the browser's own viewer (which has a download button)
 *     gets 409 `update_required` and nothing is recorded;
 *  1. the doctor must own the consultation and it must not be deleted (403);
 *  2. DocumentAccessPolicy decides, bound to THIS consultation's patient — a
 *     document of anyone else, or no longer shared, is 404 `not_shared` and
 *     writes nothing; a shared document whose file is missing is 404 "File not
 *     found" and also writes nothing;
 *  2b. a type the viewer can't show (Word, DICOM, .mov…) is 415 `not_viewable`:
 *     nothing is streamed or recorded;
 *  3. the view is recorded BEFORE a byte is streamed, in one transaction: the
 *     audit row (`document.viewed`), the patient's ledger row (`viewed` — every
 *     view) and the grant's access counter. Both carry the view reference
 *     "VM-" + the first 8 hex digits of the ledger row's id, which the viewer
 *     watermarks and a print cites;
 *  4. if that record can't be written, nothing is streamed: 503
 *     `view_unavailable` (reported to Sentry);
 *  5. the file is served inline only, with its extension's fixed type, no
 *     caching and a sandboxing CSP, plus `X-SD-View-Ref` / `X-SD-Viewed-At`.
 *
 * Steps 2–5 are {@see ViewsSharedDocument::viewForDoctor()}, shared with the
 * lab result view.
 */
final class DownloadPatientDocumentAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;
    use ViewsSharedDocument;

    /** The header only the doctor app's view-only viewer sends. */
    public const VIEWER_HEADER = 'X-SD-Viewer';

    public function __construct(
        private readonly UserRepository $users,
        private readonly AppointmentRepository $appointments,
        private readonly DocumentAccessPolicy $policy,
        private readonly DocumentAccessGrantRepository $grants,
        private readonly DocumentAccessLogRepository $log,
        private readonly AuditLogger $audit,
        private readonly MedicalDocumentStorage $storage,
        private readonly EntityManagerInterface $em,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        if (($refused = $this->viewerHeaderProblem($request, $response)) !== null) {
            return $refused;
        }
        $appointment = $this->doctorAppointment($request, $this->users, $this->appointments, strtolower(trim((string) $args['id'])));
        if ($appointment === null || $appointment->isDeleted()) {
            return $this->error($response, 'Consultation not found', 403);
        }

        return $this->viewForDoctor(
            $response,
            $appointment->getSpecialist(),
            $appointment->getPatient(),
            (string) $args['docId'],
            $appointment->getId(),
            (string) $request->getAttribute('user_id'),
        );
    }

    /** "VM-" + the first 8 hex digits of a ledger row id, upper-case. */
    public static function viewRef(string $logId): string
    {
        return 'VM-' . strtoupper(substr(str_replace('-', '', $logId), 0, 8));
    }
}
