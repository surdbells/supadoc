<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\SessionMetric;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\SessionMetricRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/doctor/appointments/{id}/metrics — the doctor's call client reports a
 * connection-quality sample for their own consultation. Not audited (high volume).
 */
final class ReportMetricAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;

    public function __construct(
        private readonly UserRepository $users,
        private readonly AppointmentRepository $appointments,
        private readonly SessionMetricRepository $metrics,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $id = (string) $args['id'];
        if ($this->doctorAppointment($request, $this->users, $this->appointments, $id) === null) {
            return $this->error($response, 'Consultation not found', 403);
        }

        $body = (array) ($request->getParsedBody() ?? []);
        $this->metrics->save(new SessionMetric(
            $id,
            'doctor',
            (int) ($body['uplink'] ?? 0),
            (int) ($body['downlink'] ?? 0),
            isset($body['rtt']) && is_numeric($body['rtt']) ? (int) $body['rtt'] : null,
        ));

        return $this->success($response, ['recorded' => true])
            ->withHeader('Cache-Control', 'no-store');
    }
}
