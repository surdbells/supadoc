<?php

declare(strict_types=1);

namespace App\Infrastructure\Availability;

use App\Domain\Entity\Specialist;
use App\Domain\Exception\ValidationException;
use App\Domain\Repository\SpecialistRepository;
use App\Infrastructure\Service\AvailabilityService;
use DateTimeImmutable;

/**
 * The doctor directory behind both listings (GET /portal/specialists and GET
 * /public/specialists): the profile filters in SQL, the "when" filters on real
 * availability, and an `availability` summary on every doctor so cards never
 * fetch their own slots.
 *
 *   - No date filter: SQL paging as before, plus each page doctor's next
 *     opening (a few batched queries for the page).
 *   - A date filter (`available_on`, `available_within`, or `part_of_day` on
 *     its own, which means "within the booking window"), or `sort_by=soonest`:
 *     up to {@see MAX_CANDIDATES} matching doctors are checked in one batch,
 *     those without an opening are dropped, the rest sorted (first opening,
 *     weighted rating, name — unless another sort was asked for) and then
 *     paged, so `meta.total` counts what is really listed.
 *
 * Dates are calendar days in `tz` (default: the clinic's zone) and must lie in
 * today … today + horizon_days. Only `Specialist::toArray()` is ever returned.
 */
final class DirectorySearch
{
    /** The most doctors a date-filtered search checks (beyond: cut by the SQL order). */
    public const MAX_CANDIDATES = 500;

    public const WITHIN = ['today', 'tomorrow', 'week'];

    public function __construct(
        private readonly SpecialistRepository $repo,
        private readonly AvailabilityService $availability,
    ) {
    }

    /**
     * One page of the directory.
     *
     * @param array<string,mixed> $query the request's query string
     * @return array{items: list<array<string,mixed>>, total: int}
     * @throws ValidationException
     */
    public function search(array $query, int $offset, int $perPage, string $sortBy, string $sortDir, ?DateTimeImmutable $now = null): array
    {
        $frame = $this->availability->frame(BookingFrame::zone($query['tz'] ?? null), $now);
        $f     = self::filters($query, $frame);
        $qb    = $this->repo->searchQuery(
            $f['search'],
            $f['specialty'],
            $f['location'],
            $f['language'],
            $f['gender'],
            $f['in_person'] ? true : null,
            $f['fee_max'],
            $f['min_rating'],
            $f['min_years'],
        );
        $window  = $f['window'];
        $soonest = $f['sort'] === 'soonest' || ($window !== null && $f['sort'] === null);

        if ($window === null && !$soonest) {
            $page = $this->repo->pageOf($qb, $offset, $perPage, $sortBy, $sortDir);
            $next = $this->availability->firstOpenings($page['items'], $frame, $frame->today, $frame->bookableUntilDate);

            return [
                'items' => array_map(static fn (Specialist $s): array => $s->toArray() + [
                    'availability' => AvailabilityService::summary($next[$s->getId()] ?? null, $next[$s->getId()] ?? null),
                ], $page['items']),
                'total' => $page['total'],
            ];
        }

        $candidates = $this->repo->candidatesOf($qb, $sortBy, $sortDir, self::MAX_CANDIDATES);
        $matches    = $window !== null
            ? $this->availability->firstOpenings($candidates, $frame, $window[0], $window[1], $f['part_of_day'])
            : $this->availability->firstOpenings($candidates, $frame, $frame->today, $frame->bookableUntilDate);
        if ($window !== null) {
            $candidates = array_values(array_filter($candidates, static fn (Specialist $s): bool => ($matches[$s->getId()] ?? null) !== null));
        }
        if ($soonest) {
            $candidates = self::soonestFirst($candidates, $matches);
        }

        $total = count($candidates);
        $page  = array_slice($candidates, max(0, $offset), max(1, $perPage));
        // The window's first opening is the next opening when it starts today
        // and keeps every part of the day; otherwise look it up for the page.
        $next = $window === null || ($window[0] === $frame->today && $f['part_of_day'] === null)
            ? $matches
            : $this->availability->firstOpenings($page, $frame, $frame->today, $frame->bookableUntilDate);

        return [
            'items' => array_map(static fn (Specialist $s): array => $s->toArray() + [
                'availability' => AvailabilityService::summary($matches[$s->getId()] ?? null, $next[$s->getId()] ?? null),
            ], $page),
            'total' => $total,
        ];
    }

    /**
     * The directory query string, checked. `window` is the date range the
     * "when" filters ask about ([from, to], the zone's dates) or null.
     *
     * @param array<string,mixed> $query
     * @return array{search:?string, specialty:?string, location:?string, language:?string, gender:?string, in_person:bool, fee_max:?string, min_rating:?string, min_years:?int, part_of_day:?string, window:?array{0:string,1:string}, sort:?string}
     * @throws ValidationException
     */
    public static function filters(array $query, BookingFrame $frame): array
    {
        $text = static function (string $key) use ($query): ?string {
            $v = trim((string) (is_scalar($query[$key] ?? null) ? $query[$key] : ''));

            return $v === '' ? null : $v;
        };
        $errors = [];

        $feeMax = $text('fee_max');
        if ($feeMax !== null && (!is_numeric($feeMax) || (float) $feeMax < 0)) {
            $errors['fee_max'] = 'Enter a maximum fee of 0 or more';
        }
        $minRating = $text('min_rating');
        if ($minRating !== null && (!is_numeric($minRating) || (float) $minRating < 0 || (float) $minRating > 5)) {
            $errors['min_rating'] = 'Enter a rating from 0 to 5';
        }
        $minYears = $text('min_years');
        if ($minYears !== null && (!ctype_digit($minYears) || (int) $minYears > 80)) {
            $errors['min_years'] = 'Enter a whole number of years from 0 to 80';
        }

        $part = $text('part_of_day');
        $part = $part !== null ? strtolower($part) : null;
        if ($part !== null && $part !== 'any' && !BookingFrame::isPartOfDay($part)) {
            $errors['part_of_day'] = 'Choose morning, afternoon, evening or any';
        }
        $part = $part === 'any' ? null : $part;

        $window = null;
        $on     = $text('available_on');
        $within = $text('available_within');
        $within = $within !== null ? strtolower($within) : null;
        if ($on !== null && $within !== null) {
            $errors['available_within'] = 'Choose either a date or today / tomorrow / this week, not both';
        } elseif ($on !== null) {
            $problem = self::dateProblem($on, $frame);
            if ($problem !== null) {
                $errors['available_on'] = $problem;
            } else {
                $window = [$on, $on];
            }
        } elseif ($within !== null) {
            $window = match ($within) {
                'today'    => [$frame->today, $frame->today],
                'tomorrow' => [BookingFrame::addDays($frame->today, 1), BookingFrame::addDays($frame->today, 1)],
                'week'     => [$frame->today, min(BookingFrame::addDays($frame->today, 6), $frame->bookableUntilDate)],
                default    => null,
            };
            if ($window === null) {
                $errors['available_within'] = 'Choose today, tomorrow or week';
            }
        }
        if ($window === null && $part !== null && !isset($errors['part_of_day'])) {
            $window = [$frame->today, $frame->bookableUntilDate];
        }

        if ($errors !== []) {
            throw new ValidationException($errors);
        }

        $sort = $text('sort_by');

        return [
            'search'      => $text('search'),
            'specialty'   => $text('specialty'),
            'location'    => $text('location'),
            'language'    => $text('language'),
            'gender'      => $text('gender'),
            'in_person'   => strtolower((string) $text('mode')) === 'in_person',
            'fee_max'     => $feeMax !== null ? number_format((float) $feeMax, 2, '.', '') : null,
            'min_rating'  => $minRating !== null ? number_format((float) $minRating, 2, '.', '') : null,
            'min_years'   => $minYears !== null ? (int) $minYears : null,
            'part_of_day' => $part,
            'window'      => $window,
            'sort'        => $sort !== null ? strtolower($sort) : null,
        ];
    }

    /** Why $date can't be searched (malformed, or outside today … bookable_until), or null. */
    public static function dateProblem(string $date, BookingFrame $frame): ?string
    {
        if (!BookingFrame::isYmd($date)) {
            return 'Enter a date as YYYY-MM-DD';
        }
        if (!$frame->isBookableDate($date)) {
            return sprintf('Choose a date from %s to %s', $frame->today, $frame->bookableUntilDate);
        }

        return null;
    }

    /**
     * Ratings with few reviews pulled towards 4 (as if 5 more 4-star reviews):
     * a 5.0 from one review shouldn't outrank a 4.8 from two hundred.
     */
    public static function weightedRating(float $rating, int $reviews): float
    {
        $reviews = max(0, $reviews);

        return ($rating * $reviews + 4 * 5) / ($reviews + 5);
    }

    /**
     * Soonest first opening, then weighted rating, then name; doctors with no
     * opening last.
     *
     * @param list<Specialist> $specialists
     * @param array<string, array{first_at:int}|null> $openings
     * @return list<Specialist>
     */
    public static function soonestFirst(array $specialists, array $openings): array
    {
        $key = static function (Specialist $s) use ($openings): array {
            $a = $s->toArray();

            return [
                $openings[$s->getId()]['first_at'] ?? PHP_INT_MAX,
                -self::weightedRating((float) $a['rating'], (int) $a['reviews_count']),
                mb_strtolower((string) $a['name']),
            ];
        };
        $keys = [];
        foreach ($specialists as $s) {
            $keys[$s->getId()] = $key($s);
        }
        usort($specialists, static fn (Specialist $a, Specialist $b): int => $keys[$a->getId()] <=> $keys[$b->getId()]);

        return $specialists;
    }
}
