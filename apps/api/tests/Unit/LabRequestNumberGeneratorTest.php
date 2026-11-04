<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Infrastructure\Lab\LabRequestNumberGenerator;
use App\Infrastructure\Prescription\PrescriptionNumberGenerator;
use PHPUnit\Framework\TestCase;

/** Lab request numbers: GVM-REQ-YYYYMMDD-NNNNN (lab spec §1.5). */
final class LabRequestNumberGeneratorTest extends TestCase
{
    public function testTheFormat(): void
    {
        $this->assertSame('GVM-REQ-20261104-00001', LabRequestNumberGenerator::format('2026-11-04', 1));
        $this->assertSame('GVM-REQ-20261231-12345', LabRequestNumberGenerator::format('2026-12-31', 12345));
        $this->assertTrue(LabRequestNumberGenerator::isValid('GVM-REQ-20261104-00012'));
        foreach (['GVM-RX-20261104-00012', 'REQ-0012', 'GVM-REQ-2026114-00012', 'GVM-REQ-20261104-0012', ' GVM-REQ-20261104-00012'] as $bad) {
            $this->assertFalse(LabRequestNumberGenerator::isValid($bad), $bad);
        }
        $this->assertFalse(PrescriptionNumberGenerator::isValid(LabRequestNumberGenerator::format('2026-11-04', 1)), 'never mistaken for a prescription');
    }
}
