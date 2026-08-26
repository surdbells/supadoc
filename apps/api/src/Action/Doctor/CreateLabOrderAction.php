<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\LabOrder;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\LabOrderRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AuditLogger;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/doctor/appointments/{id}/lab-orders — order one or more tests for the
 * consultation. Requires at least one test; the order is visible to the patient
 * immediately and is audited.
 */
final class CreateLabOrderAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;

    public function __construct(
        private readonly UserRepository $users,
        private readonly AppointmentRepository $appointments,
        private readonly LabOrderRepository $orders,
        private readonly AuditLogger $audit,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $id = (string) $args['id'];
        $appointment = $this->doctorAppointment($request, $this->users, $this->appointments, $id);
        if ($appointment === null) {
            return $this->error($response, 'Consultation not found', 403);
        }

        $body  = (array) ($request->getParsedBody() ?? []);
        $tests = is_array($body['tests'] ?? null) ? $body['tests'] : [];

        $order = new LabOrder($id, $appointment->getPatient()->getId());
        $order->setTests($tests);
        if ($order->getTests() === []) {
            return $this->error($response, 'Add at least one test', 422);
        }
        $order->setInstructions(is_string($body['instructions'] ?? null) ? $body['instructions'] : null);
        $order->setPriority((string) ($body['priority'] ?? 'routine'));
        $author = $appointment->getSpecialist()->getName();
        $order->setAuthor($author);
        $this->orders->save($order);

        $this->audit->record(
            $author,
            'doctor',
            'lab_order.created',
            $id,
            'lab_order',
            $order->getId(),
            ['tests' => count($order->getTests())],
        );

        return $this->success($response, $order->toArray(), 'Lab order created', 201)
            ->withHeader('Cache-Control', 'no-store');
    }
}
