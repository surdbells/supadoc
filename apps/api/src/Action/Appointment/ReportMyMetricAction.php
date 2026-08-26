<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Entity\Appointment;
use App\Domain\Entity\SessionMetric;
use App\Domain\Exception\EntityNotFoundException;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\SessionMetricRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/appointments/{id}/metrics — the patient's call client reports
 * a connection-quality sample. High-frequency + low-value individually, so it's
 * not audited. Scoped by customer_id.
 */
final class ReportMyMetricAction
{
    use ApiResponse;

    public function __construct(
        private readonly AppointmentRepository $appointments,
        private readonly SessionMetricRepository $metrics,
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

        $body = (array) ($request->getParsedBody() ?? []);
        $this->metrics->save(new SessionMetric(
            $id,
            'patient',
            (int) ($body['uplink'] ?? 0),
            (int) ($body['downlink'] ?? 0),
            isset($body['rtt']) && is_numeric($body['rtt']) ? (int) $body['rtt'] : null,
        ));

        return $this->success($response, ['recorded' => true])
            ->withHeader('Cache-Control', 'no-store');
    }
}
