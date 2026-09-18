<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\AvailabilitySlot;
use App\Domain\Enum\SlotKind;
use App\Domain\Repository\AvailabilitySlotRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use DateTimeImmutable;
use DateTimeZone;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/doctor/availability/block — mark a date (or a span within it)
 * unavailable. A block overlays the schedule: patient slot generation subtracts
 * any time that falls inside a block, and the doctor's calendar shows overlapping
 * open slots as blocked.
 *
 * Body: { date: "YYYY-MM-DD", entire_day?: bool, start?: "HH:MM",
 *         end?: "HH:MM", reason?: string }
 */
final class BlockAvailabilityAction
{
    use ApiResponse;
    use ResolvesDoctorSpecialist;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly AvailabilitySlotRepository $slots,
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

        $body = (array) $request->getParsedBody();
        $tz   = new DateTimeZone('UTC');

        $date = DateTimeImmutable::createFromFormat('!Y-m-d', trim((string) ($body['date'] ?? '')), $tz);
        if ($date === false) {
            return $this->error($response, 'Validation failed', 422, ['date' => 'Enter a valid date']);
        }

        $entireDay = (bool) ($body['entire_day'] ?? false);
        if ($entireDay) {
            $start = $date->setTime(0, 0);
            $end   = $date->modify('+1 day')->setTime(0, 0);
        } else {
            $s = $this->minutesOfDay((string) ($body['start'] ?? ''));
            $e = $this->minutesOfDay((string) ($body['end'] ?? ''));
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
            $start = $date->setTime(intdiv((int) $s, 60), ((int) $s) % 60);
            $end   = $date->setTime(intdiv((int) $e, 60), ((int) $e) % 60);
        }

        $block = new AvailabilitySlot(
            $specialist,
            $start,
            $end,
            SlotKind::BLOCK,
            trim((string) ($body['reason'] ?? '')) ?: null,
        );
        $this->slots->save($block);

        return $this->success(
            $response,
            $block->toArray() + ['status' => 'blocked'],
            'Day blocked',
        );
    }

    private function minutesOfDay(string $hm): ?int
    {
        if (!preg_match('/^([01]\d|2[0-3]):([0-5]\d)$/', trim($hm), $mm)) {
            return null;
        }

        return ((int) $mm[1]) * 60 + (int) $mm[2];
    }
}
