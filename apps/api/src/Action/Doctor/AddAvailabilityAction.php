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
 * POST /api/doctor/availability — publish open slots for a date. Splits the
 * [start, end) time range into fixed-length slots of `duration` minutes; when
 * `recurring` is set, repeats weekly for `weeks` weeks. Slots that already exist
 * at the same start are skipped, so re-adding a range is idempotent.
 *
 * Body: { date: "YYYY-MM-DD", start: "HH:MM", end: "HH:MM",
 *         duration: 15|30|45|60, recurring?: bool, weeks?: int }
 */
final class AddAvailabilityAction
{
    use ApiResponse;
    use ResolvesDoctorSpecialist;

    private const MAX_WEEKS = 26;

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

        $start    = $this->minutesOfDay((string) ($body['start'] ?? ''));
        $end      = $this->minutesOfDay((string) ($body['end'] ?? ''));
        $duration = (int) ($body['duration'] ?? 30);

        $errors = [];
        if ($start === null) {
            $errors['start'] = 'Enter a start time';
        }
        if ($end === null) {
            $errors['end'] = 'Enter an end time';
        }
        if ($start !== null && $end !== null && $end <= $start) {
            $errors['end'] = 'End time must be after the start time';
        }
        if (!in_array($duration, [15, 30, 45, 60], true)) {
            $errors['duration'] = 'Choose 15, 30, 45 or 60 minutes';
        }
        if ($errors !== []) {
            return $this->error($response, 'Validation failed', 422, $errors);
        }

        $recurring = (bool) ($body['recurring'] ?? false);
        $weeks     = $recurring ? max(1, min(self::MAX_WEEKS, (int) ($body['weeks'] ?? 8))) : 1;

        // One dedupe pass: collect existing open-slot starts across the full span.
        $spanFrom = $date->setTime(0, 0);
        $spanTo   = $date->modify('+' . (($weeks - 1) * 7 + 1) . ' days')->setTime(0, 0);
        $existing = [];
        foreach ($this->slots->forSpecialistBetween($specialist->getId(), $spanFrom, $spanTo) as $s) {
            if ($s->isOpen()) {
                $existing[$s->getStartsAt()->format('Y-m-d H:i')] = true;
            }
        }

        $created = [];
        for ($w = 0; $w < $weeks; $w++) {
            $day = $date->modify('+' . ($w * 7) . ' days');
            for ($m = $start; $m + $duration <= $end; $m += $duration) {
                $slotStart = $day->setTime(intdiv($m, 60), $m % 60);
                $key       = $slotStart->format('Y-m-d H:i');
                if (isset($existing[$key])) {
                    continue;
                }
                $existing[$key] = true;
                $slot = new AvailabilitySlot(
                    $specialist,
                    $slotStart,
                    $slotStart->modify('+' . $duration . ' minutes'),
                    SlotKind::OPEN,
                );
                $this->slots->persist($slot);
                $created[] = $slot->toArray() + ['status' => 'open'];
            }
        }

        if ($created !== []) {
            $this->slots->flush();
        }

        return $this->success(
            $response,
            ['created' => count($created), 'slots' => $created],
            count($created) === 1 ? '1 slot added' : count($created) . ' slots added',
        );
    }

    /** "HH:MM" -> minutes since midnight, or null if malformed. */
    private function minutesOfDay(string $hm): ?int
    {
        if (!preg_match('/^([01]\d|2[0-3]):([0-5]\d)$/', trim($hm), $mm)) {
            return null;
        }

        return ((int) $mm[1]) * 60 + (int) $mm[2];
    }
}
