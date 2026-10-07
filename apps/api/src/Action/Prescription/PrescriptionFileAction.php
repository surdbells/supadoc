<?php

declare(strict_types=1);

namespace App\Action\Prescription;

use App\Domain\Entity\Patient;
use App\Domain\Entity\Specialist;
use App\Domain\Entity\User;
use App\Domain\Repository\PatientRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Prescription\PrescriptionService;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AuditLogger;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/public/prescriptions/file?token=… — streams the branded prescription
 * PDF. The signed token in the URL is the credential (issued to the prescriber,
 * the patient or authorised staff, valid for minutes), so the link opens in a
 * new tab, downloads and prints without a bearer header. Every view and
 * download is audited; an expired or cancelled prescription is stamped across
 * every page.
 */
final class PrescriptionFileAction
{
    use ApiResponse;

    public function __construct(
        private readonly PrescriptionService $service,
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
            return $this->error($response, 'This link has expired. Go back and open the prescription again.', 410);
        }
        $rx  = $link['rx'];
        $pdf = $this->service->pdf($rx);

        $this->audit->record(
            $this->viewerName($link['viewer_type'], $link['viewer_id']),
            $link['viewer_type'],
            $link['download'] ? 'prescription.downloaded' : 'prescription.viewed',
            $rx->getAppointmentId(),
            'prescription',
            $rx->getId(),
            ['number' => $rx->getNumber(), 'status' => $rx->effectiveStatus()],
        );

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
