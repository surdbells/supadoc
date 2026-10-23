<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Application\ApplicationReference;
use App\Domain\Settings\ClinicTime;
use PHPUnit\Framework\TestCase;

/** Spec §2.9 / D7: GVM-DR-{clinic year}-{random 10000–99999}. */
final class ApplicationReferenceTest extends TestCase
{
    public function testPatternNormaliseAndFormat(): void
    {
        $this->assertSame('GVM-DR-2026-01234', ApplicationReference::format(2026, 1234));
        $this->assertTrue(ApplicationReference::isValid('GVM-DR-2026-12345'));
        $this->assertFalse(ApplicationReference::isValid('GVM-DR-26-12345'));
        $this->assertFalse(ApplicationReference::isValid('gvm-dr-2026-12345'), 'normalise first');
        $this->assertSame('GVM-DR-2026-12345', ApplicationReference::normalise('  gvm dr 2026 12345 '));
        $this->assertSame('GVM-DR-2026-12345', ApplicationReference::normalise('gvm-dr-2026-12345'));
    }

    public function testCandidatesAreRandomInTheClinicYear(): void
    {
        $year = (int) ClinicTime::now()->format('Y');
        $seen = [];
        for ($i = 0; $i < 50; $i++) {
            $c = ApplicationReference::candidate($year);
            $this->assertMatchesRegularExpression('/^GVM-DR-' . $year . '-[1-9]\d{4}$/', $c);
            $seen[$c] = true;
        }
        $this->assertGreaterThan(40, count($seen), 'random, not sequential');
    }
}
