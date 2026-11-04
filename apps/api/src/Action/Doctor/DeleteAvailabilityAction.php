<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\AvailabilitySlot;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\AvailabilitySlotRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\SlotLock;
use Doctrine\ORM\EntityManagerInterface;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * DELETE /api/doctor/availability/{id}?scope=one|following&tz=IANA — remove one
 * of the doctor's own slots (an open window or a block). `scope=one` (the
 * default): an open slot that already has an appointment on it is refused
 * (409) — the booking must be declined first. `scope=following` on an OPEN row
 * of a repeating series removes it and the series' later open times, keeping
 * every one a live appointment starts on (`kept_booked`); on any other row it
 * behaves like `one`. Runs under the doctor's slot lock, taken before any
 * appointment is read, so it can't race a booking that is committing. `tz`,
 * when sent, must be the doctor's profile zone (409 `timezone_changed`).
 */
final class DeleteAvailabilityAction
{
    use ApiResponse;
    use ResolvesDoctorSpecialist;
    use ReadsAvailabilityZone;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly AvailabilitySlotRepository $slots,
        private readonly AppointmentRepository $appointments,
        private readonly EntityManagerInterface $em,
        private readonly SlotLock $slotLock,
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
        $params = $request->getQueryParams();
        $zoned  = $this->availabilityZone($response, $specialist, $params['tz'] ?? null);
        if ($zoned instanceof ResponseInterface) {
            return $zoned;
        }
        $scope = (string) ($params['scope'] ?? 'one');
        if (!in_array($scope, ['one', 'following'], true)) {
            return $this->error($response, 'Validation failed', 422, ['scope' => 'Choose one or following']);
        }

        $id     = (string) ($args['id'] ?? '');
        $result = $this->em->wrapInTransaction(function () use ($specialist, $id, $scope): array {
            // The slot lock every booking takes, before any row or appointment is read.
            $this->slotLock->lockDoctor($specialist->getId());

            $slot = $this->slots->findForSpecialist($id, $specialist->getId());
            if ($slot === null) {
                return ['error' => 404];
            }
            if ($scope === 'following' && $slot->isOpen() && $slot->getSeriesId() !== null) {
                $rows    = $this->slots->openInSeriesFrom($specialist->getId(), $slot->getSeriesId(), $slot->getStartsAt());
                $booked  = $rows === [] ? [] : $this->bookedMinutes($specialist->getId(), $rows[0], $rows[count($rows) - 1]);
                $deleted = 0;
                $kept    = 0;
                foreach ($rows as $row) {
                    if (isset($booked[intdiv($row->getStartsAt()->getTimestamp(), 60)])) {
                        $kept++;
                        continue;
                    }
                    $this->slots->remove($row);
                    $deleted++;
                }
                $this->em->flush();

                return ['deleted' => $deleted, 'kept_booked' => $kept, 'scope' => 'following'];
            }

            if ($slot->isOpen() && $this->isBooked($specialist->getId(), $slot)) {
                return ['error' => 409];
            }
            $this->slots->remove($slot);
            $this->em->flush();

            return ['deleted' => 1, 'kept_booked' => 0, 'scope' => 'one'];
        });

        if (($result['error'] ?? null) === 404) {
            return $this->error($response, 'Slot not found', 404);
        }
        if (($result['error'] ?? null) === 409) {
            return $this->error($response, 'This slot is booked — decline the appointment first', 409);
        }
        $n = $result['deleted'];

        return $this->success(
            $response,
            ['deleted' => $n, 'kept_booked' => $result['kept_booked']],
            $result['scope'] === 'one' ? 'Slot removed' : ($n === 1 ? '1 time removed' : $n . ' times removed'),
        );
    }

    /**
     * The minutes (unix seconds / 60) live appointments start on, from the
     * first row's start to the last's — one query for a whole series.
     *
     * @return array<int,true>
     */
    private function bookedMinutes(string $specialistId, AvailabilitySlot $first, AvailabilitySlot $last): array
    {
        $out = [];
        foreach ($this->appointments->forSpecialistBetween($specialistId, $first->getStartsAt(), $last->getStartsAt()->modify('+1 minute')) as $a) {
            $out[intdiv($a->getScheduledAt()->getTimestamp(), 60)] = true;
        }

        return $out;
    }

    /** Does a live appointment start on this row's start (to the minute)? */
    private function isBooked(string $specialistId, AvailabilitySlot $row): bool
    {
        $start = $row->getStartsAt();

        return $this->appointments->forSpecialistBetween($specialistId, $start, $start->modify('+1 minute')) !== [];
    }
}
