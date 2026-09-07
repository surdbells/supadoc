<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Entity\Appointment;
use App\Domain\Entity\Message;
use App\Domain\Exception\EntityNotFoundException;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\MessageRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\StaffNotifier;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/appointments/{id}/messages — the patient posts a message to
 * their doctor. Notifies the doctor login (best-effort). Scoped by customer_id.
 */
final class PostMyMessageAction
{
    use ApiResponse;

    public function __construct(
        private readonly AppointmentRepository $appointments,
        private readonly MessageRepository $messages,
        private readonly StaffNotifier $notifier,
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

        $body = trim((string) (((array) ($request->getParsedBody() ?? []))['body'] ?? ''));
        if ($body === '') {
            return $this->error($response, 'Message cannot be empty', 422, ['body' => 'A message is required']);
        }
        if (mb_strlen($body) > 5000) {
            return $this->error($response, 'Message is too long', 422, ['body' => 'Keep it under 5000 characters']);
        }

        $patient = $appointment->getPatient()->toArray();
        $name    = trim((string) ($patient['first_name'] ?? '') . ' ' . (string) ($patient['last_name'] ?? '')) ?: 'Patient';

        $message = new Message($id, Message::ROLE_PATIENT, $name, $body);
        $this->messages->save($message);

        $preview = mb_strlen($body) > 120 ? mb_substr($body, 0, 117) . '…' : $body;
        $this->notifier->notifyDoctor(
            $appointment->getSpecialist()->getId(),
            'message',
            'New message from ' . $name,
            $preview,
            '/appointments/' . $id,
        );

        return $this->created($response, $message->toArray(), 'Message sent');
    }
}
