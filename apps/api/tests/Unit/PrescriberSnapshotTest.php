<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Entity\Specialist;
use App\Infrastructure\Prescription\PrescriberSnapshot;
use PHPUnit\Framework\TestCase;

/**
 * The prescriber as signed documents freeze them (lab spec §1.1): one shape
 * for prescriptions and lab requests, keys stored as they are (the lab DTO
 * maps `mdcn_number` to `registration_number`).
 */
final class PrescriberSnapshotTest extends TestCase
{
    public function testTheKeysAndValues(): void
    {
        $s = new Specialist('Dr. James Smith', 'Cardiology');
        (new \ReflectionProperty(Specialist::class, 'id'))->setValue($s, 's-1');
        $s->setQualifications('MBBS, FWACP');
        $s->setMdcnNumber('12345');
        $snap = PrescriberSnapshot::of($s);
        $this->assertSame(['id', 'name', 'specialty', 'qualifications', 'mdcn_number', 'registration_label'], array_keys($snap));
        $this->assertSame(['s-1', 'Dr. James Smith', 'Cardiology', 'MBBS, FWACP'], [$snap['id'], $snap['name'], $snap['specialty'], $snap['qualifications']]);
        $this->assertSame((string) ($s->registrationNumberForRoute() ?? ''), $snap['mdcn_number']);
        $this->assertSame($s->registrationLabel(), $snap['registration_label']);

        $bare = new Specialist('Dr. New', 'General Practice');
        (new \ReflectionProperty(Specialist::class, 'id'))->setValue($bare, 's-2');
        $this->assertSame('', PrescriberSnapshot::of($bare)['qualifications']);
    }

    public function testThePrescriptionServiceStillUsesIt(): void
    {
        $source = (string) file_get_contents(dirname(__DIR__, 2) . '/src/Infrastructure/Prescription/PrescriptionService.php');
        $this->assertStringContainsString('return PrescriberSnapshot::of($doctor);', $source, 'prescriberDetails() delegates (Rx output unchanged)');
    }
}
