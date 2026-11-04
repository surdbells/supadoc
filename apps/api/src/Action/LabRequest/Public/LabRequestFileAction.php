<?php

declare(strict_types=1);

namespace App\Action\LabRequest\Public;

use App\Domain\Entity\Patient;
use App\Domain\Entity\Specialist;
use App\Domain\Entity\User;
use App\Domain\Lab\LabRequestRules;
use App\Domain\Repository\PatientRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Lab\LabRequestService;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AuditLogger;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/public/lab-requests/file?token=… — streams the request PDF. The
 * signed 15-minute token is the credential (issued to the patient after
 * accepting, the requesting doctor, or `labs.manage` staff — each re-checked
 * now; a prescription link never opens it, nor this one a prescription).
 * Watermarked by the effective status at render time (NOT YET ACCEPTED while
 * the patient hasn't answered). Every view and download is audited.
 */
final class LabRequestFileAction
{
    use ApiResponse;

    public function __construct(
        private readonly LabRequestService $service,
        private readonly PatientRepository $patients,
        private readonly SpecialistRepository $specialists,
        private readonly UserRepository $users,
        private readonly AuditLogger $audit,
    ) {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $token = (string) ($request->getQueryParams()['token'] ?? '');
        $link  = $token !== '' ? $this->service->resolveLink($token) : null;
        if ($link === null) {
            return $this->error($response, 'This link has expired. Go back and open the request again.', 410)
                ->withHeader('Cache-Control', 'no-store');
        }
        $r   = $link['request'];
        $pdf = $this->service->pdf($r);

        try {
            $this->service->auditLab(
                $this->viewerName($link['viewer_type'], $link['viewer_id']),
                $link['viewer_type'],
                $link['download'] ? 'lab_request.downloaded' : 'lab_request.viewed',
                $r,
                ['status' => $r->effectiveStatus(LabRequestRules::now())],
                $link['viewer_id'],
            );
        } catch (\Throwable $e) {
            error_log('[lab] pdf audit failed for request ' . $r->getId() . ': ' . $e::class);
        }

        $response->getBody()->write($pdf['bytes']);
        $disposition = ($link['download'] ? 'attachment' : 'inline') . '; filename="' . $pdf['filename'] . '"';

        return $response
            ->withHeader('Content-Type', 'application/pdf')
            ->withHeader('Content-Disposition', $disposition)
            ->withHeader('Content-Length', (string) strlen($pdf['bytes']))
            ->withHeader('Cache-Control', 'private, no-store')
            ->withHeader('X-Content-Type-Options', 'nosniff')
            ->withHeader('Referrer-Policy', 'no-referrer');
    }

    private function viewerName(string $type, string $id): string
    {
        $who = match ($type) {
            'patient' => $this->patients->find($id),
            'doctor'  => $this->specialists->find($id),
            'staff'   => $this->users->find($id),
            default   => null,
        };

        return match (true) {
            $who instanceof Patient    => $who->getFullName(),
            $who instanceof Specialist => $who->getName(),
            $who instanceof User       => 'Staff: ' . $who->getEmail(),
            default                    => ucfirst($type),
        };
    }
}
