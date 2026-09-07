<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\Appointment;
use App\Domain\Entity\Message;
use App\Domain\Entity\Notification;
use App\Domain\Enum\NotificationType;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\MessageRepository;
use App\Domain\Repository\NotificationRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/doctor/appointments/{id}/messages — the doctor posts a reply to the
 * patient. Drops an in-app notification for the patient (best-effort). A doctor
 * can only ever post into their own consultation's thread.
 */
final class PostDoctorMessageAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;

    public function __construct(
        private readonly UserRepository $users,
        private readonly AppointmentRepository $appointments,
        private readonly MessageRepository $messages,
        private readonly NotificationRepository $notifications,
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

        $body = trim((string) (((array) ($request->getParsedBody() ?? []))['body'] ?? ''));
        if ($body === '') {
            return $this->error($response, 'Message cannot be empty', 422, ['body' => 'A message is required']);
        }
        if (mb_strlen($body) > 5000) {
            return $this->error($response, 'Message is too long', 422, ['body' => 'Keep it under 5000 characters']);
        }

        $message = new Message(
            $id,
            Message::ROLE_DOCTOR,
            $appointment->getSpecialist()->getName(),
            $body,
        );
        $this->messages->save($message);

        $this->notifyPatient($appointment, $body);

        return $this->created($response, $message->toArray(), 'Message sent');
    }

    /** Fire-and-forget in-app notification so the patient sees a new message. */
    private function notifyPatient(Appointment $appointment, string $body): void
    {
        try {
            $preview = mb_strlen($body) > 120 ? mb_substr($body, 0, 117) . '…' : $body;
            $this->notifications->save(new Notification(
                $appointment->getPatient(),
                NotificationType::MESSAGE,
                'New message from ' . $appointment->getSpecialist()->getName(),
                $preview,
            ));
        } catch (\Throwable) {
            // non-fatal — the message was already saved.
        }
    }
}
