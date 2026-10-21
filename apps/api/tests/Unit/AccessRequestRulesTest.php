<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Document\AccessRequestRules;
use DateTimeImmutable;
use PHPUnit\Framework\TestCase;

/** When a doctor may ask a patient to share (spec §3.2). */
final class AccessRequestRulesTest extends TestCase
{
    private DateTimeImmutable $now;

    protected function setUp(): void
    {
        $this->now = new DateTimeImmutable('2026-10-21 10:00:00');
    }

    public function testAnOpenConsultationWithNothingInTheWayMayAsk(): void
    {
        $this->assertNull(AccessRequestRules::check($this->facts(), $this->now));
        $this->assertSame('access', AccessRequestRules::kind($this->facts(), $this->now));
    }

    public function testAPendingRequestBlocksASecond(): void
    {
        $this->assertSame('request_pending', AccessRequestRules::check($this->facts(['pending' => true]), $this->now)['code']);
    }

    public function testTheCooldownLastsSeventyTwoHoursAfterADecline(): void
    {
        $declined = $this->now->modify('-71 hours -59 minutes');
        $check    = AccessRequestRules::check($this->facts(['last_declined_at' => $declined]), $this->now);
        $this->assertSame('request_cooldown', $check['code']);
        $this->assertEquals($declined->modify('+72 hours'), $check['available_at']);
        $this->assertNull(AccessRequestRules::check($this->facts(['last_declined_at' => $this->now->modify('-72 hours')]), $this->now));
    }

    public function testThePairAndDailyLimits(): void
    {
        $three = [$this->now->modify('-29 days'), $this->now->modify('-10 days'), $this->now->modify('-1 day')];
        $check = AccessRequestRules::check($this->facts(['pair_requests' => $three]), $this->now);
        $this->assertSame('request_limit', $check['code']);
        $this->assertEquals($three[0]->modify('+30 days'), $check['available_at']);
        $this->assertNull(AccessRequestRules::check($this->facts(['pair_requests' => array_slice($three, 1)]), $this->now));

        $thirty = array_map(fn (int $i): DateTimeImmutable => $this->now->modify('-' . (60 + $i) . ' minutes'), range(0, 29));
        $daily  = AccessRequestRules::check($this->facts(['doctor_requests' => $thirty]), $this->now);
        $this->assertSame('request_limit', $daily['code']);
        $this->assertEquals($this->now->modify('-89 minutes')->modify('+24 hours'), $daily['available_at'], 'when the oldest of the 30 falls out');
        $this->assertNull(AccessRequestRules::check($this->facts(['doctor_requests' => array_slice($thirty, 1)]), $this->now));
    }

    public function testOnlyAnEligibleConsultationCanBeAskedFrom(): void
    {
        foreach (['cancelled', 'proposed'] as $status) {
            $this->assertSame('appointment_not_eligible', AccessRequestRules::check($this->facts(['appointment' => $this->appointment($status)]), $this->now)['code'], $status);
        }
        $deleted = $this->appointment('confirmed') + ['deleted' => true];
        $deleted['deleted'] = true;
        $this->assertSame('appointment_not_eligible', AccessRequestRules::check($this->facts(['appointment' => $deleted]), $this->now)['code']);
        $this->assertSame('appointment_not_eligible', AccessRequestRules::check($this->facts(['appointment' => $this->appointment('completed', '-31 days')]), $this->now)['code']);
        $this->assertNull(AccessRequestRules::check($this->facts(['appointment' => $this->appointment('completed', '-29 days')]), $this->now));
        $this->assertNull(AccessRequestRules::check($this->facts(['appointment' => $this->appointment('missed', '-2 days')]), $this->now));
        $this->assertSame('appointment_not_eligible', AccessRequestRules::check($this->facts(['appointment' => null]), $this->now)['code']);
    }

    public function testAFolderShareEndingWithin48HoursAllowsAnExtension(): void
    {
        $full = $this->facts(['has_folder' => true, 'folder_ends_at' => $this->now->modify('+49 hours')]);
        $this->assertSame('has_full_access', AccessRequestRules::check($full, $this->now)['code']);
        $this->assertSame('has_full_access', AccessRequestRules::check($this->facts(['has_folder' => true, 'folder_ends_at' => null]), $this->now)['code']);

        $soon = $this->facts(['has_folder' => true, 'folder_ends_at' => $this->now->modify('+47 hours')]);
        $this->assertNull(AccessRequestRules::check($soon, $this->now));
        $this->assertSame('extend', AccessRequestRules::kind($soon, $this->now));
    }

    public function testABlockStopsTheDoctorAsking(): void
    {
        $this->assertSame('request_blocked', AccessRequestRules::check($this->facts(['blocked' => true]), $this->now)['code']);
        $this->assertSame('doctor_unavailable', AccessRequestRules::check($this->facts(['practising' => false]), $this->now)['code']);
    }

    /** @return array{status:string, deleted:bool, ends_at:DateTimeImmutable} */
    private function appointment(string $status, string $ended = '+2 days'): array
    {
        return ['status' => $status, 'deleted' => false, 'ends_at' => $this->now->modify($ended)];
    }

    /** @param array<string,mixed> $over @return array<string,mixed> */
    private function facts(array $over = []): array
    {
        return $over + [
            'appointment'      => $this->appointment('confirmed'),
            'practising'       => true,
            'pending'          => false,
            'blocked'          => false,
            'has_folder'       => false,
            'folder_ends_at'   => null,
            'last_declined_at' => null,
            'pair_requests'    => [],
            'doctor_requests'  => [],
        ];
    }
}
