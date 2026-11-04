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

    public function testMailsAreWrittenOnTheRecipientsClockWithTheOtherPartysBeside(): void
    {
        $chicago = new \DateTimeZone('America/Chicago');
        $lagos   = new \DateTimeZone('Africa/Lagos');
        // 9:00 AM CST is 4:00 PM WAT (Wed 4 Nov 2026).
        $patient = EmailTemplates::appointmentConfirmation($this->appt('2026-11-04T15:00:00Z'), 'Ada', 'https://app.example', '₦', $lagos, $chicago, "Dr. Test's time");
        $this->assertStringContainsString('Wed, 4 Nov 2026', $patient['html']);
        $this->assertStringContainsString('4:00 PM WAT (9:00 AM CST, Dr. Test&#039;s time)', $patient['html']);

        $doctor = EmailTemplates::sessionInvite($this->appt('2026-11-04T15:00:00Z'), 'Dr. Test', 'doctor', 'https://doctor.example/call/tok', [], '₦', $chicago, $lagos, "your patient's time");
        $this->assertStringContainsString('9:00 AM CST (4:00 PM WAT, your patient&#039;s time)', $doctor['html']);

        // The other side's weekday when its date differs: 10:00 PM CST Wed is Thu 5:00 AM WAT.
        $late = EmailTemplates::joinReminder($this->appt('2026-11-05T04:00:00Z'), 'Dr. Test', 'in 1 hour', 'https://doctor.example/call/tok', $chicago, $lagos, "your patient's time");
        $this->assertStringContainsString('Wed, 4 Nov 2026', $late['html']);
        $this->assertStringContainsString('10:00 PM CST (Thu 5:00 AM WAT, your patient&#039;s time)', $late['html']);

        // Same offset (or no other zone): no bracket.
        $same = EmailTemplates::appointmentStatusUpdate($this->appt('2026-11-04T15:00:00Z'), 'Ada', 'https://app.example', null, $lagos, new \DateTimeZone('Africa/Kinshasa'), 'Dr. Test');
        $this->assertStringContainsString('4:00 PM WAT</td>', $same['html']);
        $this->assertStringNotContainsString('(4:00 PM', $same['html']);

        $receipt = EmailTemplates::walletReceipt(['type' => 'topup', 'direction' => 'credit', 'amount' => '5000.00', 'reference' => 'r', 'created_at' => '2026-11-04T15:00:00Z'], 'Ada', '₦', 'https://app.example', $chicago);
        $this->assertStringContainsString('Wed, 4 Nov 2026 at 9:00 AM CST', $receipt['html']);
        $this->assertSame('Wed, 4 Nov 2026 · 9:00 AM CST', PatientNotifier::timeLabel(new DateTimeImmutable('2026-11-04T15:00:00Z'), $chicago));
    }

    public function testAnApplicantsInterviewMailLeadsWithTheirOwnTime(): void
    {
        $abroad = EmailTemplates::applicationInterview('Ada', 'GVM-DR-2026-12345', '2026-10-14T09:00:00Z', 30, 'https://meet.example/x', null, false, 'support@videomed.app', new \DateTimeZone('America/Chicago'));
        $this->assertStringContainsString('Wed, 14 Oct 2026 at 4:00 AM CDT (10:00 AM WAT, VideoMed time)', $abroad['html']);
        $this->assertStringContainsString('Times are in your time zone (CDT).', $abroad['html']);
        $home = EmailTemplates::applicationInterview('Ada', 'GVM-DR-2026-12345', '2026-10-14T09:00:00Z', 30, 'https://meet.example/x', null, false);
        $this->assertStringContainsString('Wed, 14 Oct 2026 at 10:00 AM WAT', $home['html']);
        $this->assertStringNotContainsString('VideoMed time', $home['html']);
        $this->assertStringContainsString('Times are West Africa Time (Lagos).', $home['html']);
    }

    public function testADoctorsLastVisitCarriesItsOffset(): void
    {
        $this->assertSame('2026-10-21T17:00:00+08:00', DoctorPatientsAction::lastVisitIso('2026-10-21 17:00:00'));
        $this->assertNull(DoctorPatientsAction::lastVisitIso(null));
        $this->assertNull(DoctorPatientsAction::lastVisitIso(''));
        $this->assertSame('2026-10-21T09:00:00+00:00', DoctorPatientsAction::lastVisitIso(new DateTimeImmutable('2026-10-21T09:00:00+00:00')));
    }
}
