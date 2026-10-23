<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Infrastructure\Application\ApplicationSms;
use PHPUnit\Framework\TestCase;

/** Spec §5.3: the applicant texts — ≤160, GSM-7, no names, only our own host. */
final class ApplicationSmsTest extends TestCase
{
    public function testEveryTextIsShortGsm7NamelessAndOnlyLinksHome(): void
    {
        $vars = ['ref' => 'GVM-DR-2026-12345', 'host' => 'join.dosthq.com', 'when' => 'Wed 14 Oct, 10:00', 'code' => '123456'];
        foreach (array_keys(ApplicationSms::TEXTS) as $key) {
            $text = ApplicationSms::text($key, $vars);
            $this->assertLessThanOrEqual(160, mb_strlen($text), $key);
            $this->assertMatchesRegularExpression('/^[A-Za-z0-9 .,:\/\'\-]+$/', $text, "{$key} is plain GSM-7");
            $this->assertStringStartsWith('VideoMed:', $text);
            if (preg_match_all('#(\w+\.)+\w{2,}#', $text, $m) > 0) {
                foreach ($m[0] as $host) {
                    $this->assertSame('join.dosthq.com', $host, $key);
                }
            }
        }
        $this->assertSame('VideoMed: interview for GVM-DR-2026-12345 on Wed 14 Oct, 10:00 WAT. Joining details are in your email.', ApplicationSms::text('interview', $vars));
        $this->assertSame('Wed 14 Oct, 10:00', ApplicationSms::when(new \DateTimeImmutable('2026-10-14T09:00:00Z'), new \DateTimeZone('Africa/Lagos')));
        $this->assertStringNotContainsString('<', ApplicationSms::text('submitted', ['ref' => '<Ada “Obi”>']), 'a stray value is filtered to GSM-7');
    }
}
