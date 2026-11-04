<?php

declare(strict_types=1);

namespace App\Infrastructure\Availability;

/**
 * Half-open [start, end) spans (unix seconds), sorted once, answering "does
 * [s, e) overlap any of them?" by binary search — so checking thousands of new
 * times against thousands of existing rows stays fast. Spans may overlap each
 * other and have any length.
 */
final class SpanIndex
{
    /** @param list<array{0:int,1:int}> $spans sorted by start */
    private function __construct(private readonly array $spans, private readonly int $longest)
    {
    }

    /** @param list<array{0:int,1:int}> $spans */
    public static function of(array $spans): self
    {
        usort($spans, static fn (array $a, array $b): int => $a[0] <=> $b[0]);
        $longest = 0;
        foreach ($spans as [$s, $e]) {
            $longest = max($longest, $e - $s);
        }

        return new self(array_values($spans), $longest);
    }

    public function overlaps(int $start, int $end): bool
    {
        // The last span starting before $end; walk back while a span could
        // still reach past $start (none is longer than the longest).
        $lo = 0;
        $hi = count($this->spans) - 1;
        $i  = -1;
        while ($lo <= $hi) {
            $mid = intdiv($lo + $hi, 2);
            if ($this->spans[$mid][0] < $end) {
                $i  = $mid;
                $lo = $mid + 1;
            } else {
                $hi = $mid - 1;
            }
        }
        for (; $i >= 0 && $this->spans[$i][0] + $this->longest > $start; $i--) {
            if ($this->spans[$i][1] > $start) {
                return true;
            }
        }

        return false;
    }
}
