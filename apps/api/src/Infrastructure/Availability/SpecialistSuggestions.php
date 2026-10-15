<?php

declare(strict_types=1);

namespace App\Infrastructure\Availability;

use App\Domain\Entity\Specialist;
use App\Domain\Exception\EntityNotFoundException;
use App\Domain\Exception\ValidationException;
use App\Domain\Repository\SpecialistRepository;
use App\Infrastructure\Service\AvailabilityService;
use DateTimeImmutable;
use Ramsey\Uuid\Uuid;

/**
 * "Similar doctors free that day" — alternatives when the doctor (or the
 * filters) a patient chose have no opening on a date. Always the same
 * specialty (and in-person when asked); tiered so the closest matches lead:
 *
 *   0  every filter holds, free that day (in the part of the day asked for)
 *   1  one filter relaxed at a time, in the order part_of_day → location →
 *      gender → language → fee (never specialty or in-person)
 *   2  free within the next 3 days instead (filters held, any time of day)
 *
 * Within a tier: soonest opening, then weighted rating, then the fee closest to
 * the reference doctor's, then name. `like={id}` excludes that doctor and
 * inherits their specialty and fee (as the fee ceiling); explicit parameters
 * win. Each suggestion says why it is there. Only `Specialist::toArray()`.
 */
final class SpecialistSuggestions
{
    public const DEFAULT_LIMIT = 4;
    public const MAX_LIMIT     = 8;

    /** The order tier 1 relaxes filters in. */
    public const RELAX_ORDER = ['part_of_day', 'location', 'gender', 'language', 'fee'];

    /** How many days after the date tier 2 looks. */
    public const LATER_DAYS = 3;

    /** The most same-specialty doctors considered. */
    private const CANDIDATE_CAP = 200;

    private const RELAXED_REASON = [
        'part_of_day' => 'Different time of day',
        'location'    => 'Different location',
        'gender'      => 'Different gender',
        'language'    => 'Different language',
        'fee'         => 'Higher fee',
    ];

    public function __construct(
        private readonly SpecialistRepository $repo,
        private readonly AvailabilityService $availability,
    ) {
    }

    /**
     * @param array<string,mixed> $query the request's query string
     * @return array{requested: array{id:string, available_on_date:bool, next_available_at:?string}|null, suggestions: list<array<string,mixed>>}
     * @throws ValidationException|EntityNotFoundException
     */
    public function suggest(array $query, ?DateTimeImmutable $now = null): array
    {
        $frame = $this->availability->frame(BookingFrame::zone($query['tz'] ?? null), $now);
        $text  = static function (string $key) use ($query): ?string {
            $v = trim((string) (is_scalar($query[$key] ?? null) ? $query[$key] : ''));

            return $v === '' ? null : $v;
        };

        $like   = null;
        $likeId = $text('like');
        if ($likeId !== null) {
            /** @var Specialist|null $like */
            $like = Uuid::isValid($likeId) ? $this->repo->find($likeId) : null;
            // Unlisted (onboarding, rejected, suspended, removed) is as good as unknown,
            // like the profile, calendar and slots; one only switched off for bookings is fine.
            if ($like === null || $like->isDeleted() || !$like->isApproved()) {
                throw EntityNotFoundException::for(Specialist::class, $likeId);
            }
        }

        $errors    = [];
        $specialty = $text('specialty') ?? $like?->getSpecialty();
        if ($specialty === null) {
            $errors['specialty'] = 'Choose a specialty or a doctor to compare with';
        }
        $date = $text('date') ?? $frame->today;
        $problem = DirectorySearch::dateProblem($date, $frame);
        if ($problem !== null) {
            $errors['date'] = $problem;
        }
        $part = $text('part_of_day');
        $part = $part !== null ? strtolower($part) : null;
        if ($part !== null && $part !== 'any' && !BookingFrame::isPartOfDay($part)) {
            $errors['part_of_day'] = 'Choose morning, afternoon, evening or any';
        }
        $feeMax = $text('fee_max');
        if ($feeMax !== null && (!is_numeric($feeMax) || (float) $feeMax < 0)) {
            $errors['fee_max'] = 'Enter a maximum fee of 0 or more';
        }
        if ($errors !== []) {
            throw new ValidationException($errors);
        }

        $refFee  = $like?->getConsultationFee();
        $filters = [
            'part_of_day' => $part === 'any' ? null : $part,
            'location'    => $text('location'),
            'gender'      => $text('gender'),
            'language'    => $text('language'),
            'fee'         => $feeMax !== null ? number_format((float) $feeMax, 2, '.', '') : $refFee,
        ];
        $inPerson = strtolower((string) $text('mode')) === 'in_person';
        $limit    = $text('limit');
        $limit    = max(1, min(self::MAX_LIMIT, is_numeric($limit) ? (int) $limit : self::DEFAULT_LIMIT));

        $candidates = $this->repo->suggestionCandidates((string) $specialty, $inPerson, $like?->getId(), self::CANDIDATE_CAP);
        $last       = BookingFrame::addDays($date, self::LATER_DAYS);
        $openings   = $this->availability->openingsByDate($like !== null ? [...$candidates, $like] : $candidates, $frame, $date, $last);

        $requested = null;
        if ($like !== null) {
            $mine = $openings[$like->getId()] ?? [];
            $next = null;
            foreach ($mine as $times) {
                $next = $times[0]['at'];
                break;
            }
            if ($next === null && $last < $frame->bookableUntilDate) {
                $found = $this->availability->firstOpenings([$like], $frame, BookingFrame::addDays($last, 1), $frame->bookableUntilDate)[$like->getId()] ?? null;
                $next  = $found['first_at'] ?? null;
            }
            $onDate = array_filter(
                $mine[$date] ?? [],
                static fn (array $t): bool => $filters['part_of_day'] === null || $t['period'] === $filters['part_of_day'],
            );
            $requested = [
                'id'                => $like->getId(),
                'available_on_date' => $onDate !== [],
                'next_available_at' => $next !== null ? BookingFrame::iso($next) : null,
            ];
        }

        $byId    = [];
        $doctors = [];
        foreach ($candidates as $s) {
            $byId[$s->getId()] = $s;
            $doctors[] = ['id' => $s->getId(), 'profile' => $s->toArray(), 'days' => $openings[$s->getId()] ?? []];
        }

        $suggestions = [];
        foreach (self::rank($doctors, $filters, $refFee, $date, $limit, $frame) as $pick) {
            $suggestions[] = [
                'specialist'   => $byId[$pick['id']]->toArray() + ['availability' => $pick['availability']],
                'availability' => $pick['availability'],
                'match'        => ['tier' => $pick['tier'], 'relaxed' => $pick['relaxed'], 'reason' => $pick['reason']],
            ];
        }

        return ['requested' => $requested, 'suggestions' => $suggestions];
    }

    /**
     * The tiering, pure (unit-tested).
     *
     * @param list<array{id:string, profile:array<string,mixed>, days:array<string, list<array{at:int, period:string}>>}> $doctors
     * @param array{part_of_day:?string, location:?string, gender:?string, language:?string, fee:?string} $filters
     * @return list<array{id:string, tier:int, relaxed:list<string>, reason:string, availability:array<string,mixed>}>
     */
    public static function rank(array $doctors, array $filters, ?string $refFee, string $date, int $limit, BookingFrame $frame): array
    {
        $picked = [];
        $out    = [];
        $add    = static function (array $tier, int $level, array $relaxed, callable $reason) use (&$picked, &$out, $limit, $refFee): void {
            usort($tier, static fn (array $a, array $b): int => self::order($a, $refFee) <=> self::order($b, $refFee));
            foreach ($tier as $t) {
                if (count($out) >= $limit) {
                    return;
                }
                $picked[$t['doctor']['id']] = true;
                $out[] = [
                    'id'           => $t['doctor']['id'],
                    'tier'         => $level,
                    'relaxed'      => $relaxed,
                    'reason'       => $reason($t),
                    'availability' => self::summaryOf($t),
                ];
            }
        };

        // Tier 0: everything holds, free that day.
        $tier = [];
        foreach ($doctors as $d) {
            $times = self::timesOn($d, $date, $filters['part_of_day']);
            if ($times !== [] && self::matches($d['profile'], $filters, null)) {
                $tier[] = ['doctor' => $d, 'date' => $date, 'times' => $times];
            }
        }
        $add($tier, 0, [], static fn (array $t): string => 'Same specialty · free ' . $frame->timeLabel($t['times'][0]));

        // Tier 1: one filter relaxed at a time.
        foreach (self::RELAX_ORDER as $relax) {
            if (count($out) >= $limit) {
                break;
            }
            if ($filters[$relax] === null) {
                continue;
            }
            $tier = [];
            foreach ($doctors as $d) {
                if (isset($picked[$d['id']])) {
                    continue;
                }
                $times = self::timesOn($d, $date, $relax === 'part_of_day' ? null : $filters['part_of_day']);
                if ($times !== [] && self::matches($d['profile'], $filters, $relax)) {
                    $tier[] = ['doctor' => $d, 'date' => $date, 'times' => $times];
                }
            }
            $label = self::RELAXED_REASON[$relax];
            $add($tier, 1, [$relax], static fn (array $t): string => $label . ' · free ' . $frame->timeLabel($t['times'][0]));
        }

        // Tier 2: free in the next few days instead.
        if (count($out) < $limit) {
            $tier = [];
            foreach ($doctors as $d) {
                if (isset($picked[$d['id']]) || !self::matches($d['profile'], $filters, 'part_of_day')) {
                    continue;
                }
                foreach ($d['days'] as $day => $times) {
                    if ($day > $date && $day <= BookingFrame::addDays($date, self::LATER_DAYS) && $times !== []) {
                        $tier[] = ['doctor' => $d, 'date' => (string) $day, 'times' => array_column($times, 'at')];
                        break;
                    }
                }
            }
            $add($tier, 2, [], static fn (array $t): string => 'Same specialty · free ' . $frame->dateLabel($t['times'][0]) . ', ' . $frame->timeLabel($t['times'][0]));
        }

        return $out;
    }

    /**
     * The doctor's open times on $date (in $part when given), soonest first.
     *
     * @param array{days:array<string, list<array{at:int, period:string}>>} $doctor
     * @return list<int>
     */
    private static function timesOn(array $doctor, string $date, ?string $part): array
    {
        $out = [];
        foreach ($doctor['days'][$date] ?? [] as $t) {
            if ($part === null || $t['period'] === $part) {
                $out[] = $t['at'];
            }
        }

        return $out;
    }

    /**
     * Do the profile filters hold (all but $except; part of the day is checked
     * against the times, not here)? Mirrors the directory's SQL filters.
     *
     * @param array<string,mixed> $p Specialist::toArray()
     * @param array{location:?string, gender:?string, language:?string, fee:?string} $filters
     */
    private static function matches(array $p, array $filters, ?string $except): bool
    {
        $lower = static fn (mixed $v): string => mb_strtolower(trim((string) $v));
        if ($except !== 'location' && $filters['location'] !== null && $lower($p['location'] ?? '') !== $lower($filters['location'])) {
            return false;
        }
        if ($except !== 'gender' && $filters['gender'] !== null && $lower($p['gender'] ?? '') !== $lower($filters['gender'])) {
            return false;
        }
        if ($except !== 'language' && $filters['language'] !== null
            && !str_contains($lower($p['languages'] ?? ''), $lower($filters['language']))
        ) {
            return false;
        }
        if ($except !== 'fee' && $filters['fee'] !== null && bccomp((string) ($p['consultation_fee'] ?? '0'), $filters['fee'], 2) > 0) {
            return false;
        }

        return true;
    }

    /**
     * Sort key within a tier: soonest, weighted rating, fee closest to the
     * reference doctor's, name.
     *
     * @param array{doctor:array{profile:array<string,mixed>}, times:list<int>} $t
     * @return array{0:int, 1:float, 2:string, 3:string}
     */
    private static function order(array $t, ?string $refFee): array
    {
        $p   = $t['doctor']['profile'];
        $fee = (string) ($p['consultation_fee'] ?? '0');
        $gap = $refFee !== null ? ltrim(bcsub($fee, $refFee, 2), '-') : '0';

        return [
            $t['times'][0],
            -DirectorySearch::weightedRating((float) ($p['rating'] ?? 0), (int) ($p['reviews_count'] ?? 0)),
            str_pad($gap, 16, '0', STR_PAD_LEFT),
            mb_strtolower((string) ($p['name'] ?? '')),
        ];
    }

    /**
     * @param array{date:string, times:list<int>} $t
     * @return array{date:?string, open_slots:int, first_slot_at:?string, slots_preview:list<string>, next_available_at:?string}
     */
    private static function summaryOf(array $t): array
    {
        $day = ['date' => $t['date'], 'open_slots' => count($t['times']), 'first_at' => $t['times'][0], 'slots' => $t['times']];

        return AvailabilityService::summary($day, $day);
    }
}
