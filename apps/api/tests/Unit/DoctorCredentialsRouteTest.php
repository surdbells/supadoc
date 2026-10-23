<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Doctor\DoctorCredentials;
use App\Domain\Entity\Specialist;
use App\Domain\Entity\SpecialistCredential as C;
use App\Domain\Enum\SpecialistStatus;
use App\Infrastructure\Service\DoctorCredentialService;
use App\Infrastructure\Service\DoctorOnboardingService;
use DateTimeImmutable;
use PHPUnit\Framework\TestCase;

/** Spec §4.4 / D2: route-aware credential rules — abroad types and wording; Nigeria unchanged. */
final class DoctorCredentialsRouteTest extends TestCase
{
    private const TODAY = '2026-10-23';

    private function credential(string $type, string $status, ?string $expires = null): C
    {
        $c = new C('00000000-0000-0000-0000-000000000001', $type, 'credentials/' . bin2hex(random_bytes(16)) . '.bin', 'x.pdf', 'application/pdf', 1, str_repeat('a', 64));
        $c->setExpiresAt($expires !== null ? new DateTimeImmutable($expires) : null);
        if ($status === C::STATUS_VERIFIED) {
            $c->verify(null, 'R', ['register_checked' => true, 'register_reference' => 'R', 'note' => null]);
        }

        return $c;
    }

    public function testAbroadRegistrationAndLicenceTypes(): void
    {
        $this->assertSame(C::TYPE_GOOD_STANDING, DoctorCredentials::registrationType('abroad'));
        $this->assertSame(C::TYPE_MDCN, DoctorCredentials::registrationType(null));
        $this->assertSame(C::TYPE_FOREIGN_LICENCE, DoctorCredentials::licenceType('abroad'));
        $this->assertSame(C::TYPE_LICENCE, DoctorCredentials::licenceType('ng'));

        $abroad = [$this->credential(C::TYPE_GOOD_STANDING, C::STATUS_VERIFIED), $this->credential(C::TYPE_FOREIGN_LICENCE, C::STATUS_VERIFIED, '2027-01-01')];
        $this->assertTrue(DoctorCredentials::complete($abroad, self::TODAY, 'abroad'));
        $this->assertFalse(DoctorCredentials::complete($abroad, self::TODAY), 'read as Nigeria they are not MDCN documents');
        $this->assertNotNull(DoctorCredentials::currentLicence($abroad, self::TODAY, 'abroad'));
        $this->assertNull(DoctorCredentials::currentLicence($abroad, self::TODAY));
        $this->assertTrue(DoctorCredentials::mdcnProvided($abroad, 'abroad'));
        $this->assertTrue(DoctorCredentials::licenceProvided($abroad, self::TODAY, 'abroad'));

        $expiredForeign = $this->credential(C::TYPE_FOREIGN_LICENCE, C::STATUS_VERIFIED, '2026-01-01');
        $this->assertNotContains($expiredForeign->getId(), DoctorCredentials::verifiedIds([$expiredForeign], self::TODAY, 'abroad'), 'expired foreign licences are left out too');
    }

    public function testNigeriaIsUnchanged(): void
    {
        $ng = [$this->credential(C::TYPE_MDCN, C::STATUS_VERIFIED), $this->credential(C::TYPE_LICENCE, C::STATUS_VERIFIED, '2027-01-01')];
        $this->assertTrue(DoctorCredentials::hasVerifiedMdcn($ng));
        $this->assertTrue(DoctorCredentials::complete($ng, self::TODAY));
        $this->assertSame([C::TYPE_MDCN, C::TYPE_LICENCE, C::TYPE_SPECIALIST, C::TYPE_INDEMNITY], C::uploadableTypes('ng'));
        $this->assertSame([C::TYPE_GOOD_STANDING, C::TYPE_FOREIGN_LICENCE, C::TYPE_SPECIALIST, C::TYPE_INDEMNITY], C::uploadableTypes('abroad'));
        $this->assertTrue(C::requiresExpiry(C::TYPE_INDEMNITY));
        $this->assertFalse(C::requiresNumber(C::TYPE_INDEMNITY));
        $this->assertTrue(C::requiresNumber(C::TYPE_FOREIGN_LICENCE));
    }

    public function testTheChecklistReadsTheRegistrationNumberForTheRoute(): void
    {
        $s = new Specialist('Dr. Ada', 'Cardiology');
        $s->setLicenceRoute('abroad');
        $this->assertFalse(DoctorOnboardingService::checklistFrom($s, false, false, [], '1.0', self::TODAY)['mdcn']);
        $s->setRegistration('General Medical Council', 'gb', '7012345');
        $this->assertTrue(DoctorOnboardingService::checklistFrom($s, false, false, [], '1.0', self::TODAY)['mdcn']);
        $this->assertSame('GB', $s->getRegulatorCountry());
        $this->assertSame('7012345', $s->registrationNumberForRoute());
        $this->assertSame('General Medical Council number', $s->registrationLabel());
        $this->assertSame('MDCN number', (new Specialist('Dr. B', 'X'))->registrationLabel());
    }

    public function testRouteAwareApprovalWording(): void
    {
        $s = new Specialist('Dr. Ada', 'Cardiology');
        $s->setLicenceRoute('abroad');
        $s->setRegistration('General Medical Council', 'GB', '7012345');
        $s->setStatus(SpecialistStatus::PENDING_REVIEW);
        $p = DoctorOnboardingService::approvalProblems($s, array_fill_keys(DoctorOnboardingService::ITEMS, true), [], '1.0', self::TODAY, false);
        $this->assertSame('Verify their Certificate of Good Standing first.', $p['mdcn_certificate']);
        $this->assertSame('Verify a current practising licence first.', $p['practising_licence']);
        $this->assertSame('Confirm that you checked their documents against the General Medical Council register.', $p['attest']);

        $ng = new Specialist('Dr. Bola', 'Cardiology');
        $ng->setStatus(SpecialistStatus::PENDING_REVIEW);
        $p = DoctorOnboardingService::approvalProblems($ng, array_fill_keys(DoctorOnboardingService::ITEMS, true), [], '1.0', self::TODAY, false);
        $this->assertSame('Verify their MDCN full-registration certificate first.', $p['mdcn_certificate']);
        $this->assertSame('Confirm that you checked their documents against the MDCN register.', $p['attest']);
        $this->assertSame('your Certificate of Good Standing', DoctorOnboardingService::missingLabel('mdcn_certificate', 'abroad'));
        $this->assertSame('your MDCN full-registration certificate', DoctorOnboardingService::missingLabel('mdcn_certificate', 'ng'));
    }

    public function testUploadsAreRouteAware(): void
    {
        $fields = DoctorCredentialService::uploadFields(['type' => C::TYPE_FOREIGN_LICENCE, 'number' => 'gmc-1', 'expires_at' => '2027-01-01'], self::TODAY, 'abroad');
        $this->assertSame(C::TYPE_FOREIGN_LICENCE, $fields['type']);
        try {
            DoctorCredentialService::uploadFields(['type' => C::TYPE_FOREIGN_LICENCE, 'number' => 'gmc-1', 'expires_at' => '2027-01-01'], self::TODAY);
            $this->fail('a Nigerian doctor cannot upload a foreign licence');
        } catch (\App\Domain\Exception\ValidationException $e) {
            $this->assertArrayHasKey('type', $e->getErrors());
        }
        try {
            DoctorCredentialService::uploadFields(['type' => C::TYPE_INDEMNITY], self::TODAY);
            $this->fail('indemnity needs an expiry');
        } catch (\App\Domain\Exception\ValidationException $e) {
            $this->assertSame(['expires_at'], array_keys($e->getErrors()));
        }
        try {
            DoctorCredentialService::verifyFields($this->credential(C::TYPE_GOOD_STANDING, C::STATUS_PENDING), [], self::TODAY, 'abroad');
            $this->fail('attestation required');
        } catch (\App\Domain\Exception\ValidationException $e) {
            $this->assertSame("Confirm that you checked the regulator's register", $e->getErrors()['register_checked']);
        }
    }
}
