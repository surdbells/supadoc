<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Entity\Appointment;
use App\Domain\Exception\EntityNotFoundException;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\CarePlanRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/appointments/{id}/care-plan — the patient's care plan. Returned
 * only once the doctor has published it; scoped by customer_id.
 */
final class MyCarePlanAction
{
    use ApiResponse;

    public function __construct(
        private readonly AppointmentRepository $appointments,
        private readonly CarePlanRepository $plans,
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

        $plan = $this->plans->findByAppointment($id);
        if ($plan === null || !$plan->isPublished()) {
            return $this->success($response, ['available' => false, 'items' => []]);
        }

        return $this->success($response, [
            'available' => true,
            'items'     => $plan->getItems(),
            'author'    => $plan->toArray()['author'],
        ]);
    }
}
