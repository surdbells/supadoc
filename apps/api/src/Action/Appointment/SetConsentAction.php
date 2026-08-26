<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Entity\Appointment;
use App\Domain\Entity\ConsultationConsent;
use App\Domain\Exception\EntityNotFoundException;
use App\Action\Consent\BuildsConsentState;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\ConsultationConsentRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AuditLogger;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/appointments/{id}/consents — the patient grants or withdraws a
 * consent (recording, AI transcription, data sharing). Every decision is stored
 * with actor + version and written to the audit trail.
 */
final class SetConsentAction
{
    use ApiResponse;
    use BuildsConsentState;

    public function __construct(
        private readonly AppointmentRepository $appointments,
        private readonly ConsultationConsentRepository $consents,
        private readonly AuditLogger $audit,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $customerId  = (string) $request->getAttribute('customer_id');
        $id          = (string) $args['id'];
        $appointment = $this->appointments->findForPatient($id, $customerId);
        if ($appointment === null) {
            throw EntityNotFoundException::for(Appointment::class, $id);
        }

        $body    = (array) ($request->getParsedBody() ?? []);
        $type    = (string) ($body['type'] ?? '');
        $granted = (bool) ($body['granted'] ?? false);
        if (!in_array($type, ConsultationConsent::TYPES, true)) {
            return $this->error($response, 'Unknown consent type', 422);
        }

        $patient = $appointment->getPatient();
        $name    = trim($patient->toArray()['first_name'] . ' ' . $patient->toArray()['last_name']);

        $consent = $this->consents->findOne($id, $type) ?? new ConsultationConsent($id, $type);
        $consent->decide($granted, 'patient', $name);
        $this->consents->save($consent);

        $this->audit->record(
            $name,
            'patient',
            $granted ? 'consent.granted' : 'consent.withdrawn',
            $id,
            'consent',
            $type,
            ['version' => ConsultationConsent::VERSION],
        );

        return $this->success($response, $this->consentState($this->consents, $id), 'Consent updated')
            ->withHeader('Cache-Control', 'no-store');
    }
}
