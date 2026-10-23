<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Application\ApplicantContact;
use PHPUnit\Framework\TestCase;

/** Spec §3.1 / D25: the masks the applicant sees — only ever of what they typed — and the generic phrases. */
final class ApplicantContactTest extends TestCase
{
    public function testMasks(): void
    {
        $this->assertSame('cle***@gmail.com', ApplicantContact::maskEmail('Clement.Obi@gmail.com'));
        $this->assertSame('ab***@x.io', ApplicantContact::maskEmail('ab@x.io'), 'a short local part shows what there is');
        $this->assertSame('0802*****56', ApplicantContact::maskPhone('+2348021234556'));
        $this->assertSame('+44 77*****23', ApplicantContact::maskPhone('+447700900123'));
        $this->assertSame('+1 20*****43', ApplicantContact::maskPhone('+12025550143'));
    }

    public function testGenericDestinations(): void
    {
        $this->assertSame('The phone number on your application', ApplicantContact::GENERIC_PHONE);
        $this->assertSame('The email address on your application', ApplicantContact::GENERIC_EMAIL);
        $this->assertTrue(ApplicantContact::looksLikeEmail('a@b.co'));
        $this->assertFalse(ApplicantContact::looksLikeEmail('0803 123 4567'));
    }
}
