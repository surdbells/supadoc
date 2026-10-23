<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Contact\PhoneNumber;
use PHPUnit\Framework\TestCase;

/** Spec §3.1: phone numbers as E.164 (what applications store; Termii's `to` without the +). */
final class PhoneNumberTest extends TestCase
{
    public function testPhoneNumbers(): void
    {
        $cases = [
            '0803 123 4567'      => '+2348031234567',
            '8031234567'         => '+2348031234567',
            '+234 0803 123 4567' => '+2348031234567',
            '002348031234567'    => '+2348031234567',
            '+44 7700 900123'    => '+447700900123',
            '(0803) 123-45.67'   => '+2348031234567',
            '0803123456'         => null,
            '+234803123456'      => null,
            '6031234567'         => null,
            '+1234567'           => null,
            'call me'            => null,
            ''                   => null,
        ];
        foreach ($cases as $raw => $expected) {
            $this->assertSame($expected, PhoneNumber::toE164((string) $raw), (string) $raw);
        }
        $this->assertSame('2348031234567', PhoneNumber::termiiTo('+2348031234567'));
        $this->assertSame(['44', '7700900123'], PhoneNumber::split('+447700900123'));
        $this->assertSame(['1', '2025550143'], PhoneNumber::split('+12025550143'));
        $this->assertSame(['234', '8031234567'], PhoneNumber::split('+2348031234567'), 'the longest code wins ("234" before "2")');
        $this->assertSame(['880', '1712345678'], PhoneNumber::split('+8801712345678'));
    }
}
