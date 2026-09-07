<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Entity\Appointment;
use App\Domain\Entity\Message;
use App\Domain\Exception\EntityNotFoundException;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\MessageRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/appointments/{id}/messages — the patient's view of the secure
 * thread with their doctor. Opening it marks the doctor's messages read. Scoped
 * by customer_id, so another patient's appointment id 404s.
 */
final class MyMessagesAction
{
    use ApiResponse;

    public function __construct(
        private readonly AppointmentRepository $appointments,
        private readonly MessageRepository $messages,
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

        // Reading the thread clears the patient's unread count for it.
        $this->messages->markReadForRole($id, Message::ROLE_PATIENT);

        $items = array_map(
            static fn (Message $m): array => $m->toArray(),
            $this->messages->forAppointment($id),
        );

        return $this->success($response, $items)
            ->withHeader('Cache-Control', 'no-store');
    }
}
