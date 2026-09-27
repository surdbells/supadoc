<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\CarePlan;
use App\Domain\Enum\NotificationType;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\CarePlanRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AuditLogger;
use App\Infrastructure\Service\PatientNotifier;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * PUT /api/doctor/appointments/{id}/care-plan — upsert the care plan. Saving
 * publishes it to the patient (the doctor builds it for them); an empty list is
 * allowed (clears the plan). Audited.
 */
final class SaveCarePlanAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;

    public function __construct(
        private readonly UserRepository $users,
        private readonly AppointmentRepository $appointments,
        private readonly CarePlanRepository $plans,
        private readonly AuditLogger $audit,
        private readonly PatientNotifier $patientNotifier,
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
        $items = is_array($body['items'] ?? null) ? $body['items'] : [];

        $plan = $this->plans->findByAppointment($id) ?? new CarePlan($id);
        $plan->setItems($items);
        $author = $appointment->getSpecialist()->getName();
        $plan->publish($author);
        $this->plans->save($plan);

        $this->audit->record(
            $author,
            'doctor',
            'care_plan.updated',
            $id,
            'care_plan',
            null,
            ['items' => count($plan->getItems())],
        );

        // Only signal the patient when a real plan was published (not when cleared).
        if (count($plan->getItems()) > 0) {
            $this->patientNotifier->notify(
                $appointment->getPatient(),
                NotificationType::SYSTEM,
                'Care plan updated',
                $author . ' published a care plan with ' . count($plan->getItems()) . ' item(s) for you.',
            );
        }

        return $this->success($response, $plan->toArray(), 'Care plan saved')
            ->withHeader('Cache-Control', 'no-store');
    }
}
