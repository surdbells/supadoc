<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Entity\Specialist;
use App\Domain\Entity\SpecialistCredential;
use App\Domain\Enum\SpecialistStatus;
use App\Infrastructure\Service\DoctorCredentialService;
use PHPUnit\Framework\TestCase;

/** Spec D5: identityLocked() for application doctors; hasLockedFields() and the legacy rules unchanged. */
final class SpecialistIdentityLockTest extends TestCase
{
    public function testApplicationDoctorsAreLockedFromTheStart(): void
    {
        $s = new Specialist('Dr. Ada Obi', 'Cardiology'); // invited
        $this->assertFalse($s->hasLockedFields());
        $this->assertFalse($s->identityLocked());
        $this->assertSame([], $s->toPrivateArray()['locked_fields']);

        $s->setApplicationId('00000000-0000-0000-0000-0000000000aa');
        $this->assertFalse($s->hasLockedFields(), 'unchanged: it drives the legacy rules');
        $this->assertTrue($s->identityLocked());
        $this->assertSame(Specialist::LOCKED_FIELDS, $s->toPrivateArray()['locked_fields']);
        $this->assertSame('00000000-0000-0000-0000-0000000000aa', $s->toReviewArray()['application_id']);
        $this->assertSame('ng', $s->toReviewArray()['licence_route']);
    }

    public function testApprovedDoctorsStayLocked(): void
    {
        $s = new Specialist('Dr. Bola', 'Cardiology');
        $s->setStatus(SpecialistStatus::APPROVED);
        $this->assertTrue($s->hasLockedFields());
        $this->assertTrue($s->identityLocked());
    }

    public function testCompletesLegacyIsUnaffectedByTheApplication(): void
    {
        $s = new Specialist('Dr. Ada Obi', 'Cardiology');
        $s->setApplicationId('00000000-0000-0000-0000-0000000000aa');
        $docs = [];
        foreach ([SpecialistCredential::TYPE_MDCN, SpecialistCredential::TYPE_LICENCE] as $type) {
            $c = new SpecialistCredential($s->getId(), $type, 'credentials/' . bin2hex(random_bytes(16)) . '.bin', 'x.pdf', 'application/pdf', 1, str_repeat('a', 64));
            $c->setExpiresAt(new \DateTimeImmutable('2027-01-01'));
            $c->verify(null, 'R', ['register_checked' => true, 'register_reference' => 'R', 'note' => null]);
            $docs[] = $c;
        }
        $this->assertFalse(DoctorCredentialService::completesLegacy($s, $docs, '2026-10-23'), 'an invited application doctor is not a legacy doctor');
    }
}
