<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Document\DocumentAccessCalculator;
use DateTimeImmutable;
use PHPUnit\Framework\TestCase;

/** Folding covering-grant rows into one entry per (doctor, document) — spec §2.2. */
final class DocumentAccessCalculatorTest extends TestCase
{
    public function testAFolderAndASelectedShareUniteAndNullWins(): void
    {
        $out = DocumentAccessCalculator::reduce([
            $this->row('s1', 'd1', 'g-folder', 'all', '7d', '2026-10-28 10:00:00', '2026-10-21 10:00:00'),
            $this->row('s1', 'd1', 'g-doc', 'selected', 'indefinite', null, '2026-10-20 09:00:00'),
            $this->row('s1', 'd2', 'g-folder', 'all', '7d', '2026-10-28 10:00:00', '2026-10-21 10:00:00'),
            $this->row('S2', 'D1', 'g-other', 'selected', '24h', '2026-10-22 10:00:00', '2026-10-21 10:00:00'),
        ]);

        $this->assertSame(['s1', 's2'], array_keys($out));
        $d1 = $out['s1']['d1'];
        $this->assertNull($d1['until']);
        $this->assertTrue($d1['indefinite']);
        $this->assertSame('folder', $d1['via'], 'any folder share wins `via`');
        $this->assertSame('g-doc', $d1['grant_id'], 'the latest-ending grant');
        $this->assertSame(['g-folder', 'g-doc'], $d1['grant_ids']);
        $this->assertEquals(new DateTimeImmutable('2026-10-20 09:00:00'), $d1['shared_at'], 'the earliest creation');
        $this->assertEquals(new DateTimeImmutable('2026-10-28 10:00:00'), $out['s1']['d2']['until']);
        $this->assertSame('document', $out['s2']['d1']['via']);
    }

    public function testTheLaterEndWinsAndItsDurationLabelsIt(): void
    {
        $out = DocumentAccessCalculator::reduce([
            $this->row('s1', 'd1', 'g1', 'selected', 'until', '2026-11-01 00:00:00', '2026-10-21 10:00:00'),
            $this->row('s1', 'd1', 'g2', 'selected', '7d', '2026-10-28 10:00:00', '2026-10-21 10:00:00'),
        ]);
        $d1 = $out['s1']['d1'];
        $this->assertSame('g1', $d1['grant_id']);
        $this->assertEquals(new DateTimeImmutable('2026-11-01 00:00:00'), $d1['until']);
        $this->assertEquals(new DateTimeImmutable('2026-10-31 23:59:59'), $d1['until_label_at'], 'until − 1 s');

        $preset = DocumentAccessCalculator::reduce([$this->row('s1', 'd1', 'g2', 'selected', '7d', '2026-10-28 10:00:00', '2026-10-21 10:00:00')]);
        $this->assertEquals(new DateTimeImmutable('2026-10-28 10:00:00'), $preset['s1']['d1']['until_label_at'], 'a preset is labelled at its end');
    }

    public function testNoRowsNoAccess(): void
    {
        $this->assertSame([], DocumentAccessCalculator::reduce([]));
    }

    /** @return array<string,mixed> */
    private function row(string $s, string $d, string $g, string $scope, string $duration, ?string $expires, string $created): array
    {
        return ['specialist_id' => $s, 'document_id' => $d, 'grant_id' => $g, 'scope' => $scope, 'duration' => $duration, 'expires_at' => $expires, 'created_at' => $created];
    }
}
