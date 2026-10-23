<?php

declare(strict_types=1);

namespace App\Tests\Integration\DoctorApplications;

/** Spec §3.2.17–3.2.21, §3.5: the status check never reveals a match. */
final class TrackTest extends DoctorApplicationsTestCase
{
    public function testStartLooksTheSameForAMatchAndAMismatch(): void
    {
        $app = $this->submitted('ng');
        $match    = $this->http('POST', '/api/public/doctor-applications/track/start', ['reference' => strtolower($app['reference']), 'contact' => 'Ada.Obi@Example.com']);
        $mismatch = $this->http('POST', '/api/public/doctor-applications/track/start', ['reference' => 'GVM-DR-2026-99999', 'contact' => 'ada.obi@example.com']);
        $this->assertCode($match, 200);
        $this->assertCode($mismatch, 200);
        $strip = static fn (array $d): array => ['expires_in' => $d['expires_in'], 'channels' => $d['channels']];
        $this->assertSame($strip($match['body']['data']), $strip($mismatch['body']['data']), 'identical apart from the track id');
        $this->assertSame([['channel' => 'email', 'destination' => 'ada***@example.com', 'generic' => false, 'default' => true]], $match['body']['data']['channels'], 'SMS hidden while Termii is unconfigured');

        $byPhone = $this->http('POST', '/api/public/doctor-applications/track/start', ['reference' => $app['reference'], 'contact' => '0803 123 4567']);
        $this->assertSame([['channel' => 'email', 'destination' => 'The email address on your application', 'generic' => true, 'default' => true]], $byPhone['body']['data']['channels']);

        $this->assertCode($this->http('POST', '/api/public/doctor-applications/track/start', ['reference' => 'nope', 'contact' => 'x']), 422);
    }

    public function testRequestCodeAlways202AndACodeOnlyForAMatch(): void
    {
        $app      = $this->submitted('ng');
        $mismatch = $this->http('POST', '/api/public/doctor-applications/track/start', ['reference' => $app['reference'], 'contact' => 'someone.else@example.com'])['body']['data']['track_id'];
        $res      = $this->http('POST', '/api/public/doctor-applications/track/request-code', ['track_id' => $mismatch, 'channel' => 'email']);
        $this->assertCode($res, 202);
        $this->assertNull($res['body']['data']['dev_code'], 'nothing sent for a mismatch');
        $this->assertSame('som***@example.com', $res['body']['data']['sent_to']);
        $verify = $this->http('POST', '/api/public/doctor-applications/track/verify', ['track_id' => $mismatch, 'code' => '123456']);
        $this->assertCode($verify, 422, 'code_invalid', 'a dummy code record exists');
        $this->assertCode($this->http('POST', '/api/public/doctor-applications/track/request-code', ['track_id' => 'expired-or-unknown-0000', 'channel' => 'email']), 410, 'track_expired');
    }

    public function testVerifyAttemptsLockoutAndTheAccessTokenScope(): void
    {
        $app  = $this->submitted('ng');
        $tid  = $this->http('POST', '/api/public/doctor-applications/track/start', ['reference' => $app['reference'], 'contact' => $app['email']])['body']['data']['track_id'];
        $code = (string) $this->http('POST', '/api/public/doctor-applications/track/request-code', ['track_id' => $tid, 'channel' => 'email'])['body']['data']['dev_code'];
        $wrong = $code === '000000' ? '111111' : '000000';
        for ($i = 0; $i < 4; $i++) {
            $this->assertCode($this->http('POST', '/api/public/doctor-applications/track/verify', ['track_id' => $tid, 'code' => $wrong]), 422, 'code_invalid');
        }
        $this->assertCode($this->http('POST', '/api/public/doctor-applications/track/verify', ['track_id' => $tid, 'code' => $wrong]), 422, 'code_locked');
        $this->assertCode($this->http('POST', '/api/public/doctor-applications/track/verify', ['track_id' => $tid, 'code' => $code]), 422, 'code_expired', 'burned');

        // Within 60 s the same application + channel gets no new code (same 202, nothing sent) —
        // and the code on file for that check is a placeholder that verifies nothing, whatever is guessed.
        $tid2 = $this->http('POST', '/api/public/doctor-applications/track/start', ['reference' => $app['reference'], 'contact' => $app['email']])['body']['data']['track_id'];
        $this->assertNull($this->http('POST', '/api/public/doctor-applications/track/request-code', ['track_id' => $tid2, 'channel' => 'email'])['body']['data']['dev_code']);
        /** @var \Predis\Client $redis */
        $redis  = $this->container()->get(\Predis\Client::class);
        $record = json_decode((string) $redis->get('onb:trk:code:' . $tid2), true);
        $this->assertSame(1, $record['n'] ?? null, 'an unsent code never matches');
        $record['h'] = $this->container()->get(\App\Infrastructure\Application\ApplicationCodeService::class)->hash($tid2, '123456');
        $redis->setex('onb:trk:code:' . $tid2, 600, (string) json_encode($record));
        $this->assertCode($this->http('POST', '/api/public/doctor-applications/track/verify', ['track_id' => $tid2, 'code' => '123456']), 422, 'code_invalid');

        $this->freshCounters();
        $access = $this->trackToken($app['reference'], $app['email']);
        $status = $this->http('GET', '/api/public/doctor-applications/track/status', null, $access);
        $this->assertCode($status, 200);
        $this->assertSame('submitted', $status['body']['data']['status']);
        $this->assertSame('Submitted', $status['body']['data']['status_label']);
        $this->assertSame('Ada Obi', $status['body']['data']['full_name']);
        $this->assertTrue($status['body']['data']['can_withdraw']);
        $this->assertSame(['submitted:current', 'under_review:pending', 'approved:pending'], array_map(static fn (array $r): string => $r['key'] . ':' . $r['state'], $status['body']['data']['timeline']));
        $this->assertCode($this->http('GET', '/api/public/doctor-applications/drafts/current', null, $access), 401, 'applicant_token_invalid', 'an access token opens no draft route');
        $this->assertCode($this->http('GET', '/api/public/doctor-applications/track/status', null, $app['token']), 401, 'applicant_token_invalid', 'a draft token opens no status route');
        $this->assertCode($this->http('GET', '/api/public/doctor-applications/track/application', null, $access), 200);
    }
}
