<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\AvailabilitySlotRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use DateTimeZone;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * DELETE /api/doctor/availability/{id} — remove one of the doctor's own slots
 * (an open window or a block). An open slot that already has an appointment on
 * it is refused (409) — the booking must be declined first.
 */
final class DeleteAvailabilityAction
{
    use ApiResponse;
    use ResolvesDoctorSpecialist;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly AvailabilitySlotRepository $slots,
        private readonly AppointmentRepository $appointments,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $specialist = $this->doctorSpecialist($request, $this->users, $this->specialists);
        if ($specialist === null) {
            return $this->error($response, 'This account is not a doctor profile', 403);
        }

        $slot = $this->slots->findForSpecialist((string) ($args['id'] ?? ''), $specialist->getId());
        if ($slot === null) {
            return $this->error($response, 'Slot not found', 404);
        }

        if ($slot->isOpen()) {
            $start = $slot->getStartsAt()->setTimezone(new DateTimeZone('UTC'));
            $taken = $this->appointments->forSpecialistBetween(
                $specialist->getId(),
                $start,
                $start->modify('+1 minute'),
            );
            if ($taken !== []) {
                return $this->error($response, 'This slot is booked — decline the appointment first', 409);
            }
        }

        $this->slots->remove($slot);
        $this->slots->flush();

        return $this->success($response, ['deleted' => true], 'Slot removed');
    }
}
