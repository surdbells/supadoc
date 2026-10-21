<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Action\Doctor\DoctorPatientsAction;
use App\Domain\Settings\ClinicTime;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Persistence\ClockRepair;
use App\Infrastructure\Service\PatientNotifier;
use DateTimeImmutable;
use PHPUnit\Framework\TestCase;

/**
 * What people read names a time on the clinic's clock (APP_TIMEZONE, Lagos)
 * with its zone — whatever the PHP process zone (PRC in production) and
 * whatever offset the instant carries. Calendar days (Y-m-d) never shift.
 */
final class HumanTimesTest extends TestCase
{
    private string $zone = 'UTC';

    protected function setUp(): void
    {
        $this->zone = date_default_timezone_get();
        date_default_timezone_set('Asia/Shanghai');
        ClinicTime::configure('Africa/Lagos');
    }

    protected function tearDown(): void
    {
        date_default_timezone_set($this->zone);
        ClockRepair::resetCache();
    }

    /** @return array<string,mixed> the fields the appointment emails read */
    private function appt(string $scheduledAt): array
    {
        return [
            'id'           => 'a1',
            'scheduled_at' => $scheduledAt,
            'specialist'   => ['name' => 'Dr. Test', 'specialty' => 'General Practice'],
            'type_label'   => 'Video consultation',
            'amount'       => '10000.00',
            'status'       => 'confirmed',
            'status_label' => 'Confirmed',
        ];
    }

    public function testAppointmentEmailsUseTheClinicClock(): void
    {
        $process = EmailTemplates::appointmentConfirmation($this->appt('2026-10-21T17:00:00+08:00'), 'Ada', 'https://app.example');
        $this->assertStringContainsString('Wed, 21 Oct 2026', $process['html']);
        $this->assertStringContainsString('10:00 AM WAT', $process['html']);
        $utc = EmailTemplates::appointmentConfirmation($this->appt('2026-10-21T09:00:00+00:00'), 'Ada', 'https://app.example');
        $this->assertSame($process['html'], $utc['html'], 'the same instant renders identically');

        $reminder = EmailTemplates::joinReminder($this->appt('2026-10-21T17:00:00+08:00'), 'Ada', 'in 1 hour', 'https://app.example/join');
        $this->assertStringContainsString('Wed, 21 Oct 2026', $reminder['html']);
        $this->assertStringContainsString('10:00 AM WAT', $reminder['html']);
        $this->assertSame(
            $reminder['html'],
            EmailTemplates::joinReminder($this->appt('2026-10-21T09:00:00Z'), 'Ada', 'in 1 hour', 'https://app.example/join')['html'],
        );
    }

    public function testAWalletReceiptUsesTheClinicClock(): void
    {
        $receipt = EmailTemplates::walletReceipt(
            ['type' => 'topup', 'direction' => 'credit', 'amount' => '5000.00', 'reference' => 'ref_1', 'created_at' => '2026-10-21T17:00:00+08:00'],
            'Ada',
            '₦',
            'https://app.example',
        );
        $this->assertStringContainsString('Wed, 21 Oct 2026 at 10:00 AM WAT', $receipt['html']);
    }

    public function testInAppNoticesUseTheClinicClock(): void
    {
        $this->assertSame('Wed, 21 Oct 2026 · 10:00 AM WAT', PatientNotifier::timeLabel(new DateTimeImmutable('2026-10-21T17:00:00+08:00')));
        $this->assertSame('Wed, 21 Oct 2026 · 10:00 AM WAT', PatientNotifier::timeLabel(new DateTimeImmutable('2026-10-21T09:00:00Z')));
    }

    public function testADoctorsLastVisitCarriesItsOffset(): void
    {
        $this->assertSame('2026-10-21T17:00:00+08:00', DoctorPatientsAction::lastVisitIso('2026-10-21 17:00:00'));
        $this->assertNull(DoctorPatientsAction::lastVisitIso(null));
        $this->assertNull(DoctorPatientsAction::lastVisitIso(''));
        $this->assertSame('2026-10-21T09:00:00+00:00', DoctorPatientsAction::lastVisitIso(new DateTimeImmutable('2026-10-21T09:00:00+00:00')));
    }
}
