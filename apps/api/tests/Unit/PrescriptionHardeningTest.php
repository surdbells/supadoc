<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Entity\Prescription;
use App\Domain\Settings\ClinicTime;
use App\Domain\Settings\HealthProfile;
use App\Infrastructure\Prescription\PrescriptionCheckService;
use App\Infrastructure\Prescription\SignatureStore;
use App\Infrastructure\Storage\FileVault;
use DateTimeImmutable;
use DateTimeZone;
use DomainException;
use PHPUnit\Framework\TestCase;
use RuntimeException;

/** Review-driven hardening: allergy severities, check-page bucketing, vault keys, clinic calendar. */
final class PrescriptionHardeningTest extends TestCase
{
    protected function tearDown(): void
    {
        ClinicTime::configure('Africa/Lagos');
    }

    public function testLegacySeveritiesMapToTheCanonicalScale(): void
    {
        $this->assertSame('severe', HealthProfile::canonicalSeverity('High'));
        $this->assertSame('moderate', HealthProfile::canonicalSeverity(' medium '));
        $this->assertSame('mild', HealthProfile::canonicalSeverity('Low'));
        $this->assertSame('life-threatening', HealthProfile::canonicalSeverity('Life threatening'));
        $this->assertSame('unknown', HealthProfile::canonicalSeverity('Not sure'));
        $this->assertSame('', HealthProfile::canonicalSeverity(''));
        // Unrecognised free text is kept exactly as the patient typed it.
        $this->assertSame('Itchy only', HealthProfile::canonicalSeverity('Itchy only'));
    }

    public function testSavingTheMedicalProfileStoresCanonicalSeverities(): void
    {
        $medical = HealthProfile::normalizeMedical(['allergies' => [
            ['allergen' => 'Penicillin', 'severity' => 'High', 'reaction' => 'Rash'],
            ['allergen' => 'Latex', 'severity' => 'Low', 'reaction' => ''],
        ]]);
        $this->assertSame(['severe', 'mild'], array_column($medical['allergies'], 'severity'));
        // Idempotent: normalising again changes nothing.
        $this->assertSame($medical, HealthProfile::normalizeMedical($medical));
    }

    public function testIpv6IsThrottledPerSlash64(): void
    {
        $this->assertSame(
            PrescriptionCheckService::network('2001:db8:abcd:12:1:2:3:4'),
            PrescriptionCheckService::network('2001:db8:abcd:12:ffff::1'),
        );
        $this->assertNotSame(
            PrescriptionCheckService::network('2001:db8:abcd:12::1'),
            PrescriptionCheckService::network('2001:db8:abcd:13::1'),
        );
        $this->assertSame('41.58.1.2', PrescriptionCheckService::network('41.58.1.2'));
    }

    public function testVaultKeyMustBeValidAndIsRequiredInProduction(): void
    {
        $good = base64_encode(random_bytes(32));
        $this->assertSame(32, strlen(FileVault::keyFrom($good, 'jwt', production: true)));
        $this->assertSame(32, strlen(FileVault::keyFrom('', 'jwt', production: false)), 'dev fallback');

        try {
            FileVault::keyFrom(bin2hex(random_bytes(32)), 'jwt'); // hex, not 32-byte base64
            $this->fail('A malformed key must be refused');
        } catch (RuntimeException) {
            $this->addToAssertionCount(1);
        }
        $this->expectException(RuntimeException::class);
        FileVault::keyFrom('', 'jwt', production: true);
    }

    public function testMisconfiguredVaultOnlyBlocksSignatureOperations(): void
    {
        $store = new SignatureStore(static fn (): FileVault => throw new RuntimeException('no key'));
        $this->assertNull($store->read('signatures/' . str_repeat('a', 32) . '.bin'), 'reads degrade to no signature');

        $this->expectException(DomainException::class);
        $store->store('png-bytes');
    }

    public function testValidityFollowsTheClinicCalendar(): void
    {
        // The clinic's "today" is its own calendar date, whatever php.ini says.
        ClinicTime::configure('Pacific/Kiritimati'); // UTC+14
        $this->assertSame((new DateTimeImmutable('now', new DateTimeZone('Pacific/Kiritimati')))->format('Y-m-d'), ClinicTime::todayYmd());

        $yesterday = (new DateTimeImmutable(ClinicTime::todayYmd()))->modify('-1 day');
        $rx = new Prescription('p', 's', null, 'GVM-RX-20261007-00001', $yesterday);
        $rx->send(['name' => 'Dr. A'], ['name' => 'B'], 'saved', null, new DateTimeImmutable());
        $this->assertSame('expired', $rx->effectiveStatus(), 'expired the day after valid-until on the clinic calendar');

        $rx2 = new Prescription('p', 's', null, 'GVM-RX-20261007-00002', ClinicTime::today());
        $rx2->send(['name' => 'Dr. A'], ['name' => 'B'], 'saved', null, new DateTimeImmutable());
        $this->assertSame('active', $rx2->effectiveStatus(), 'still valid on its valid-until day');
    }
}
