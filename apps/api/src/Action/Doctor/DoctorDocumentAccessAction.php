<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Entity\Appointment;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Document\DocumentSharingService;
use App\Infrastructure\Document\DocumentSharingViews;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AuditLogger;
use DateTimeImmutable;
use Predis\Client as RedisClient;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor/appointments/{id}/document-access — what the consultation's
 * patient shares with this doctor now (DoctorDocumentAccessDto: the access, the
 * documents — an explicit allowlist, never `shared_with` — and whether the
 * doctor may ask for access), straight from DocumentAccessPolicy. The doctor
 * must own the consultation (403) and it must not be deleted.
 *
 * Opening the list is audited (`document.list_viewed`, at most once per 15
 * minutes per pair, Redis `SET NX`, fail open) — never for a background poll
 * (`X-SD-Passive: 1`, which also leaves the session's idle clock alone). When
 * the policy can't answer: 503 `sharing_unavailable` (reported to Sentry), so
 * the app shows an error with Try again — never a false "No documents".
 * `Cache-Control: no-store`.
 */
final class DoctorDocumentAccessAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;

    /** Seconds one list-view audit row stands for. */
    private const LIST_AUDIT_COALESCE = 900;

    public function __construct(
        private readonly UserRepository $users,
        private readonly AppointmentRepository $appointments,
        private readonly DocumentSharingService $sharing,
        private readonly DocumentSharingViews $views,
        private readonly AuditLogger $audit,
        private readonly RedisClient $redis,
    ) {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response, array $args): ResponseInterface
    {
        $appointment = $this->doctorAppointment($request, $this->users, $this->appointments, strtolower(trim((string) $args['id'])));
        if ($appointment === null || $appointment->isDeleted()) {
            return $this->error($response, 'Consultation not found', 403);
        }
        $doctor = $appointment->getSpecialist();
        $now    = Rules::now();
        try {
            $dto = $this->views->doctorAccess($doctor, $appointment, $this->sharing->doctorRequestBlock($doctor, $appointment, $now), $now);
        } catch (\Throwable $e) {
            self::report('document-access', $e);

            return $this->error($response, "Could not load the patient's shared documents right now.", 503, ['code' => 'sharing_unavailable'])
                ->withHeader('Cache-Control', 'no-store');
        }

        if ($request->getHeaderLine('X-SD-Passive') !== '1' && Rules::enabled()) {
            $this->auditListView($request, $appointment, count($dto['documents']), $now);
        }

        return $this->success($response, $dto)->withHeader('Cache-Control', 'no-store');
    }

    /** `document.list_viewed`, coalesced per pair for 15 minutes (fail open: Redis down → recorded). Never fails the read. */
    private function auditListView(ServerRequestInterface $request, Appointment $appointment, int $count, DateTimeImmutable $now): void
    {
        $sid = strtolower($appointment->getSpecialist()->getId());
        $pid = strtolower($appointment->getPatient()->getId());
        try {
            if ($this->redis->set('docaudit:list:' . $sid . ':' . $pid, '1', 'EX', self::LIST_AUDIT_COALESCE, 'NX') === null) {
                return;
            }
        } catch (\Throwable) {
            // fail open: record it
        }
        try {
            $this->audit->record(
                $appointment->getSpecialist()->getName(),
                'doctor',
                'document.list_viewed',
                $appointment->getId(),
                'patient',
                $pid,
                [
                    'patient_id'    => $pid,
                    'patient_name'  => $appointment->getPatient()->getFullName(),
                    'specialist_id' => $sid,
                    'doctor'        => $appointment->getSpecialist()->getName(),
                    'count'         => $count,
                ],
                (string) $request->getAttribute('user_id'),
            );
        } catch (\Throwable $e) {
            error_log('[doc-access] list view audit failed: ' . $e::class . ': ' . $e->getMessage());
        }
    }

    private static function report(string $where, \Throwable $e): void
    {
        if (function_exists('\Sentry\captureException')) {
            \Sentry\captureException($e);
        }
        error_log('[doc-access] ' . $where . ' failed: ' . $e::class . ': ' . $e->getMessage());
    }
}
