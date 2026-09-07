<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\Message;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\MessageRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor/appointments/{id}/messages — the doctor's view of the secure
 * thread with the patient. Opening the thread marks the patient's messages read.
 * A doctor can only ever read their own consultation's thread.
 */
final class ListDoctorMessagesAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;

    public function __construct(
        private readonly UserRepository $users,
        private readonly AppointmentRepository $appointments,
        private readonly MessageRepository $messages,
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

        // Reading the thread clears the doctor's unread count for it.
        $this->messages->markReadForRole($id, Message::ROLE_DOCTOR);

        $items = array_map(
            static fn (Message $m): array => $m->toArray(),
            $this->messages->forAppointment($id),
        );

        return $this->success($response, $items)
            ->withHeader('Cache-Control', 'no-store');
    }
}
