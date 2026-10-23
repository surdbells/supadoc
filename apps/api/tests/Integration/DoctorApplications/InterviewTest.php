<?php

declare(strict_types=1);

namespace App\Tests\Integration\DoctorApplications;

use App\Domain\Settings\ClinicTime;

/** Spec §3.3.7, §3.3.8, §3.3.1–2: interviews on the process clock (PRC in production). */
final class InterviewTest extends DoctorApplicationsTestCase
{
    private string $zone = 'UTC';

    protected function setUp(): void
    {
        parent::setUp();
        $this->zone = date_default_timezone_get();
        date_default_timezone_set('Asia/Shanghai'); // production's PRC process clock
    }

    protected function tearDown(): void
    {
        date_default_timezone_set($this->zone);
        parent::tearDown();
    }

    public function testScheduleRoundTripsTheInstantUnderPrc(): void
    {
        $app   = $this->submitted('ng');
        $staff = $this->staff()['token'];
        $this->underReview($staff, $app['id']);

        $start = ClinicTime::now()->modify('+3 days')->setTime(10, 0); // Lagos 10:00
        $iso   = $start->format('Y-m-d\TH:i:sP');
        $this->assertStringEndsWith('+01:00', $iso);
        $body = ['starts_at' => $iso, 'duration_minutes' => 30, 'meeting_url' => 'https://meet.google.com/abc-defg-hij', 'note' => 'Bring your ID'];

        $this->assertCode($this->staffCall($staff, 'POST', '/' . $app['id'] . '/schedule-interview', ['starts_at' => $start->format('Y-m-d\TH:i')] + $body), 422, null, 'no offset');
        $this->assertCode($this->staffCall($staff, 'POST', '/' . $app['id'] . '/schedule-interview', ['meeting_url' => 'http://meet.example.com/x'] + $body), 422);
        $this->assertCode($this->staffCall($staff, 'POST', '/' . $app['id'] . '/schedule-interview', ['meeting_url' => 'https://user:pw@meet.example.com/x'] + $body), 422);
        $this->assertCode($this->staffCall($staff, 'POST', '/' . $app['id'] . '/schedule-interview', ['meeting_url' => 'javascript:alert(1)'] + $body), 422);
        $this->assertCode($this->staffCall($staff, 'POST', '/' . $app['id'] . '/schedule-interview', ['starts_at' => ClinicTime::now()->modify('+5 minutes')->format(DATE_ATOM)] + $body), 422, null, 'too soon');

        $res = $this->staffCall($staff, 'POST', '/' . $app['id'] . '/schedule-interview', $body);
        $this->assertCode($res, 200);
        $this->assertSame('interview_scheduled', $res['body']['data']['status']);
        $this->assertSame($start->getTimestamp(), (int) $this->conn()->fetchOne('SELECT interview_epoch FROM doctor_applications'));
        $stored = (string) $this->conn()->fetchOne('SELECT interview_starts_at FROM doctor_applications');
        $this->assertSame($start->setTimezone(new \DateTimeZone('Asia/Shanghai'))->format('Y-m-d H:i:s'), $stored, 'naive, on the process clock');
        $this->assertSame($start->getTimestamp(), (new \DateTimeImmutable($res['body']['data']['interview']['starts_at']))->getTimestamp());
        $this->assertStringEndsWith('10:00 WAT', $res['body']['data']['interview']['starts_at_label']);
        $this->assertSame('meet.google.com', $res['body']['data']['interview']['meeting_host']);

        $access = $this->trackToken($app['reference'], $app['email']);
        $status = $this->http('GET', '/api/public/doctor-applications/track/status', null, $access)['body']['data'];
        $this->assertSame($start->getTimestamp(), (new \DateTimeImmutable($status['interview']['starts_at']))->getTimestamp());

        $this->assertCode($this->staffCall($staff, 'POST', '/' . $app['id'] . '/resend-interview', []), 429, 'resend_cooldown');
        $moved = $this->staffCall($staff, 'POST', '/' . $app['id'] . '/schedule-interview', ['starts_at' => $start->modify('+1 day')->format(DATE_ATOM)] + $body);
        $this->assertCode($moved, 200);
        $this->assertSame(1, $this->rows("SELECT COUNT(*) FROM doctor_application_events WHERE kind = 'interview_rescheduled'"));
    }

    public function testNeedsActionAnHourAfterTheInterviewAndInterviewsToday(): void
    {
        $app   = $this->submitted('ng');
        $staff = $this->staff()['token'];
        $this->underReview($staff, $app['id']);
        $body = ['starts_at' => ClinicTime::now()->modify('+2 hours')->format(DATE_ATOM), 'duration_minutes' => 30, 'meeting_url' => 'https://zoom.us/j/1'];
        $this->assertCode($this->staffCall($staff, 'POST', '/' . $app['id'] . '/schedule-interview', $body), 200);
        $queue = $this->staffCall($staff, 'GET', '/queue')['body']['data'];
        $this->assertSame(0, $queue['needs_action']);
        $this->assertSame(1, $queue['interview_scheduled']);

        // Move the stored interview 2 hours into the past (both columns, as the writer would).
        $past = ClinicTime::now()->modify('-2 hours');
        $this->conn()->executeStatement('UPDATE doctor_applications SET interview_epoch = ?, interview_starts_at = ?', [
            $past->getTimestamp(), $past->setTimezone(new \DateTimeZone(date_default_timezone_get()))->format('Y-m-d H:i:s'),
        ]);
        $queue = $this->staffCall($staff, 'GET', '/queue')['body']['data'];
        $this->assertSame(1, $queue['needs_action'], 'an hour past its start, still undecided');
        $sameDay = $past->format('Y-m-d') === ClinicTime::todayYmd();
        $this->assertSame($sameDay ? 1 : 0, $queue['interviews_today']);
        $list = $this->staffCall($staff, 'GET', '?filter=needs_action')['body'];
        $this->assertSame(1, $list['meta']['total']);
    }

    public function testRequestingInfoCancelsTheInterview(): void
    {
        $app   = $this->submitted('ng');
        $staff = $this->staff()['token'];
        $this->underReview($staff, $app['id']);
        $this->assertCode($this->staffCall($staff, 'POST', '/' . $app['id'] . '/schedule-interview', [
            'starts_at' => ClinicTime::now()->modify('+2 days')->format(DATE_ATOM), 'duration_minutes' => 45, 'meeting_url' => 'https://teams.microsoft.com/l/x',
        ]), 200);
        $res = $this->staffCall($staff, 'POST', '/' . $app['id'] . '/request-info', ['message' => 'Need your CV', 'items' => [['kind' => 'document', 'key' => 'curriculum_vitae']]]);
        $this->assertCode($res, 200);
        $this->assertNull($res['body']['data']['interview']);
        $this->assertNull($this->conn()->fetchOne('SELECT interview_epoch FROM doctor_applications'));
        $this->assertSame(1, $this->rows("SELECT COUNT(*) FROM doctor_application_events WHERE kind = 'interview_cancelled'"));
        $meta = json_decode((string) $this->conn()->fetchOne("SELECT metadata FROM doctor_application_events WHERE kind = 'interview_cancelled'"), true);
        $this->assertSame(45, $meta['duration_minutes']);
    }
}
