<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\AvailabilitySlot;
use App\Domain\Enum\SlotKind;
use App\Domain\Repository\AvailabilitySlotRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Domain\Settings\ScheduleRules;
use App\Domain\Settings\TimeZones;
use App\Infrastructure\Availability\BookingFrame;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AvailabilityService;
use App\Infrastructure\Service\SlotLock;
use DateTimeImmutable;
use Doctrine\ORM\EntityManagerInterface;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/doctor/availability/block — mark a date (or a span within it)
 * unavailable. A block overlays the schedule: patient slot generation subtracts
 * any time that falls inside a block, and the doctor's calendar shows overlapping
 * open slots as blocked. A past date, a date more than 12 months ahead, or a
 * span starting before now is rejected (422); today as a whole day can still be
 * blocked.
 *
 * Dates and times are wall clock in `tz` (the doctor's profile zone; any other
 * zone is a 409 `timezone_changed`): an entire day runs from local midnight to
 * the next (23 or 25 hours on a DST day) and a span may end at "24:00".
 * Without `tz`, the legacy UTC contract. Written under the doctor's slot lock.
 *
 * Body: { date: "YYYY-MM-DD", entire_day?: bool, start?: "HH:MM",
 *         end?: "HH:MM"|"24:00", reason?: string, tz?: IANA }
 */
final class BlockAvailabilityAction
{
    use ApiResponse;
    use ResolvesDoctorSpecialist;
    use ReadsAvailabilityZone;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly AvailabilitySlotRepository $slots,
        private readonly EntityManagerInterface $em,
        private readonly SlotLock $slotLock,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $specialist = $this->doctorSpecialist($request, $this->users, $this->specialists);
        if ($specialist === null) {
            return $this->error($response, 'This account is not a doctor profile', 403);
        }

        $body  = (array) $request->getParsedBody();
        $zoned = $this->availabilityZone($response, $specialist, $body['tz'] ?? null);
        if ($zoned instanceof ResponseInterface) {
            return $zoned;
        }
        ['zone' => $tz, 'legacy' => $legacy] = $zoned;
        $now = new DateTimeImmutable();

        $date = trim((string) ($body['date'] ?? ''));
        if (!BookingFrame::isYmd($date)) {
            return $this->error($response, 'Validation failed', 422, ['date' => 'Enter a valid date']);
        }
        if (ScheduleRules::isPastLocalDay($date, $tz, $now)) {
            return $this->error($response, 'Validation failed', 422, ['date' => 'Choose today or a later date']);
        }
        $limit = BookingFrame::addDays($now->setTimezone($tz)->format('Y-m-d'), AvailabilityService::STAFF_HORIZON_DAYS);
        if (BookingFrame::daysBetween($date, $limit) < 0) {
            return $this->error($response, 'Validation failed', 422, ['date' => 'Choose a date within the next 12 months']);
        }

        $entireDay = (bool) ($body['entire_day'] ?? false);
        if ($entireDay) {
            [$startAt, $endAt] = TimeZones::localDayBounds($date, $tz);
        } else {
            $s = self::startMinutes($body['start'] ?? null);
            $e = self::endMinutes($body['end'] ?? null, !$legacy);
            $errors = [];
            if ($s === null) {
                $errors['start'] = 'Enter a start time';
            }
            if ($e === null) {
                $errors['end'] = 'Enter an end time';
            }
            if ($s !== null && $e !== null && $e <= $s) {
                $errors['end'] = 'End time must be after the start time';
            }
            if ($errors !== []) {
                return $this->error($response, 'Validation failed', 422, $errors);
            }
            $startAt = TimeZones::wallToInstant($date, (int) $s, $tz);
            $endAt   = TimeZones::wallToInstant($date, (int) $e, $tz);
            // A start inside a spring-forward gap rolls forward (02:30 → 03:30),
            // which can put it at or past the end (02:30–03:00): no span at all.
            if ($endAt <= $startAt) {
                return $this->error($response, 'Validation failed', 422, ['end' => 'End time must be after the start time']);
            }
            // Today's whole day may be blocked; a specific span must start from now on.
            if (ScheduleRules::hasPassed(new DateTimeImmutable('@' . $startAt), $now)) {
                return $this->error($response, 'Validation failed', 422, [
                    'start' => 'That start time has already passed — choose a later time',
                ]);
            }
        }
        $reason = trim((string) ($body['reason'] ?? '')) ?: null;

        $block = $this->em->wrapInTransaction(function () use ($specialist, $startAt, $endAt, $reason, $tz, $legacy): ?AvailabilitySlot {
            // The slot lock every booking takes, before anything is written.
            $this->slotLock->lockDoctor($specialist->getId());
            // The span was worked out in `tz`: a zone change that committed
            // while this waited for the lock makes it wrong — write nothing.
            if (!$legacy && !$this->zoneStillCurrent($this->em, $specialist, $tz)) {
                return null;
            }
            $block = new AvailabilitySlot(
                $specialist,
                new DateTimeImmutable('@' . $startAt),
                new DateTimeImmutable('@' . $endAt),
                SlotKind::BLOCK,
                $reason,
            );
            $this->slots->persist($block);
            $this->em->flush();

            return $block;
        });
        if ($block === null) {
            return $this->zoneChanged($response, $specialist);
        }

        [$dayStart, $dayEnd] = TimeZones::localDayBounds($date, $tz);

        return $this->success(
            $response,
            $block->toArray() + [
                'status'     => 'blocked',
                'entire_day' => $startAt === $dayStart && $endAt === $dayEnd,
            ],
            'Day blocked',
        );
    }
}
