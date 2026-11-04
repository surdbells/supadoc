<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Infrastructure\Application\ApplicationSms;
use DateTimeImmutable;
use DateTimeZone;
use PHPUnit\Framework\TestCase;

/** Spec §5.3: the applicant texts — ≤160, GSM-7, no names, only our own host. */
final class ApplicationSmsTest extends TestCase
{
    public function testEveryTextIsShortGsm7NamelessAndOnlyLinksHome(): void
    {
        $vars = ['ref' => 'GVM-DR-2026-12345', 'host' => 'join.dosthq.com', 'when' => 'Wed 14 Oct, 04:00 CDT (10:00 WAT)', 'code' => '123456'];
        foreach (array_keys(ApplicationSms::TEXTS) as $key) {
            $text = ApplicationSms::text($key, $vars);
            $this->assertLessThanOrEqual(160, mb_strlen($text), $key);
            $this->assertMatchesRegularExpression('/^[A-Za-z0-9 .,:\/\'()+\-]+$/', $text, "{$key} is plain GSM-7");
            $this->assertStringStartsWith('VideoMed:', $text);
            if (preg_match_all('#(\w+\.)+\w{2,}#', $text, $m) > 0) {
                foreach ($m[0] as $host) {
                    $this->assertSame('join.dosthq.com', $host, $key);
                }
            }
        }
        $this->assertStringNotContainsString('<', ApplicationSms::text('submitted', ['ref' => '<Ada “Obi”>']), 'a stray value is filtered to GSM-7');
    }

    public function testTheInterviewTextIsOnTheApplicantsClockWithTheClinicsBesideIt(): void
    {
        $at     = new DateTimeImmutable('2026-10-14T09:00:00Z');
        $lagos  = new DateTimeZone('Africa/Lagos');
        $abroad = ApplicationSms::when($at, new DateTimeZone('America/Chicago'), $lagos);
        $this->assertSame('Wed 14 Oct, 04:00 CDT (10:00 WAT)', $abroad);
        $this->assertSame('Wed 14 Oct, 10:00 WAT', ApplicationSms::when($at, $lagos, $lagos), 'same offset: no bracket');
        $this->assertSame('Wed 14 Oct, 10:00 WAT', ApplicationSms::when($at, $lagos), 'no clinic zone given');
        // The clinic's weekday when its date differs.
        $this->assertSame('Tue 13 Oct, 20:00 PDT (Wed 04:00 WAT)', ApplicationSms::when(new DateTimeImmutable('2026-10-14T03:00:00Z'), new DateTimeZone('America/Los_Angeles'), $lagos));

        $text = ApplicationSms::text('interview', ['ref' => 'GVM-DR-2026-12345', 'when' => $abroad]);
        $this->assertSame('VideoMed: interview for GVM-DR-2026-12345 on Wed 14 Oct, 04:00 CDT (10:00 WAT). Joining details are in your email.', $text);
        $this->assertLessThanOrEqual(160, mb_strlen($text));
        $this->assertStringContainsString('(10:00 WAT)', $text, '( ) kept by the GSM-7 filter');
        $this->assertSame('VideoMed: interview for X on Wed 14 Oct, 10:00 GMT+5:45. Joining details are in your email.', ApplicationSms::text('interview', ['ref' => 'X', 'when' => ApplicationSms::when(new DateTimeImmutable('2026-10-14T04:15:00Z'), new DateTimeZone('Asia/Kathmandu'))]), '+ kept');
    }
}
