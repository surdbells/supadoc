<?php

declare(strict_types=1);

namespace App\Tests\Integration\DoctorApplications;

use App\Domain\Entity\Specialist;
use App\Domain\Entity\SpecialistCredential;
use App\Domain\Enum\SpecialistStatus;
use App\Domain\Repository\SpecialistCredentialRepository;
use App\Domain\Settings\ClinicTime;
use App\Infrastructure\Service\DoctorCredentialService;
use App\Infrastructure\Service\SpecialistSuspensionService;
use Doctrine\ORM\EntityManagerInterface;

/** Spec §4.4: an abroad doctor's foreign licences — renewal, expiry query, reinstatement. */
final class AbroadLicenceLifecycleTest extends DoctorApplicationsTestCase
{
    private function abroadDoctor(): Specialist
    {
        $em = $this->em();
        $s  = new Specialist('Dr. Abroad', 'Cardiology');
        $s->setLicenceRoute('abroad');
        $s->setRegistration('General Medical Council', 'GB', '7012345');
        $s->setStatus(SpecialistStatus::APPROVED);
        $em->persist($s);
        $em->flush();

        return $s;
    }

    private function credential(EntityManagerInterface $em, Specialist $s, string $type, ?string $expires, bool $verified): SpecialistCredential
    {
        $c = new SpecialistCredential($s->getId(), $type, 'credentials/' . bin2hex(random_bytes(16)) . '.bin', 'x.pdf', 'application/pdf', 10, str_repeat('a', 64));
        $c->setNumber('GMC-1');
        $c->setExpiresAt($expires !== null ? new \DateTimeImmutable($expires) : null);
        if ($verified) {
            $c->verify(null, 'Reviewer', ['register_checked' => true, 'register_reference' => 'GMC register', 'note' => null]);
        }
        $em->persist($c);
        $em->flush();

        return $c;
    }

    public function testVerifyingAForeignLicenceSetsTheExpiryAndTheCronSeesIt(): void
    {
        $s       = $this->abroadDoctor();
        $c       = $this->container();
        $em      = $c->get(EntityManagerInterface::class);
        $s       = $em->find(Specialist::class, $s->getId());
        $pending = $this->credential($em, $s, SpecialistCredential::TYPE_FOREIGN_LICENCE, self::plusDays(200), false);
        $c->get(DoctorCredentialService::class)->verify($s, $pending, ['register_checked' => true, 'register_reference' => 'GMC register'], null, 'Reviewer');
        $this->assertSame(self::plusDays(200), $em->find(Specialist::class, $s->getId())->getLicenceExpiresAt()?->format('Y-m-d'));

        $soon = $c->get(SpecialistCredentialRepository::class)->verifiedLicencesExpiringBy(ClinicTime::today()->modify('+365 days'));
        $this->assertContains($pending->getId(), array_map(static fn (SpecialistCredential $x): string => $x->getId(), $soon), 'the licence cron reads foreign licences too');
    }

    public function testARenewedForeignLicenceKeepsThemCurrentAndReinstatementWorks(): void
    {
        $s  = $this->abroadDoctor();
        $c  = $this->container();
        $em = $c->get(EntityManagerInterface::class);
        $s  = $em->find(Specialist::class, $s->getId());
        $this->credential($em, $s, SpecialistCredential::TYPE_FOREIGN_LICENCE, self::plusDays(-3), true);
        $this->credential($em, $s, SpecialistCredential::TYPE_FOREIGN_LICENCE, self::plusDays(300), true);
        $creds = $c->get(SpecialistCredentialRepository::class)->forSpecialist($s->getId());

        $this->assertNotNull(\App\Domain\Doctor\DoctorCredentials::currentLicence($creds, ClinicTime::todayYmd(), 'abroad'), 'renewed: still current');

        // The licence cron: the lapsed foreign licence is marked expired, the doctor stays approved.
        $result = $this->container()->get(\App\Infrastructure\Service\CredentialExpiryService::class)->run();
        $this->assertSame(1, $result['licences_expired'], json_encode($result));
        $this->assertSame(0, $result['suspended']);
        $this->assertSame('approved', $this->conn()->fetchOne('SELECT status FROM specialists WHERE id = ?', [$s->getId()]));
        $this->assertSame(1, $this->rows("SELECT COUNT(*) FROM specialist_credentials WHERE status = 'expired'"));

        $s->suspend('licence_expired', 'Expired', null);
        $em->flush();
        $this->assertSame([], SpecialistSuspensionService::reinstateProblems($s, 'Renewed licence verified', $creds, ClinicTime::todayYmd()));
        $p = SpecialistSuspensionService::reinstateProblems($s, 'x', [], ClinicTime::todayYmd());
        $this->assertStringContainsString('General Medical Council', $p['practising_licence']);
    }
}
