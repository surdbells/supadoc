<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Application\GoLiveRules;
use App\Domain\Entity\DoctorApplication;
use App\Domain\Entity\Specialist;
use App\Domain\Entity\SpecialistCredential;
use App\Domain\Enum\DoctorApplicationStatus;
use App\Infrastructure\Service\DoctorOnboardingService;
use DateTimeImmutable;
use PHPUnit\Framework\TestCase;

/** Spec §4.6: every gate of "Go live" for a doctor who came from an application. */
final class GoLiveRulesTest extends TestCase
{
    private const TODAY = '2026-10-23';
    private const TERMS = '1.0';

    /** @return array{0: Specialist, 1: DoctorApplication, 2: list<SpecialistCredential>, 3: array<string,bool>} */
    private function ready(string $route = 'ng'): array
    {
        $s = new Specialist('Dr. Ada Obi', 'Cardiology');
        $s->setLicenceRoute($route);
        $route === 'abroad' ? $s->setRegistration('General Medical Council', 'GB', '7012345') : $s->setMdcnNumber('MDCN/1');
        $s->setConsultationFee('15000.00');
        $s->setBio('Bio');
        $s->setQualificationEntries([['title' => 'MBBS', 'institution' => 'Unilag', 'year' => '2010']]);
        $s->acceptTerms(self::TERMS, null);
        $app = new DoctorApplication($route, 'ada@example.com');
        $app->setStatus(DoctorApplicationStatus::APPROVED);
        $app->setApprovalSnapshot(['locked' => $s->lockedValues()]);
        $s->setApplicationId($app->getId());

        $credentials = [
            $this->credential($s, $route === 'abroad' ? SpecialistCredential::TYPE_GOOD_STANDING : SpecialistCredential::TYPE_MDCN, null),
            $this->credential($s, $route === 'abroad' ? SpecialistCredential::TYPE_FOREIGN_LICENCE : SpecialistCredential::TYPE_LICENCE, '2027-06-30'),
        ];
        $checklist = array_fill_keys(DoctorOnboardingService::ITEMS, true);

        return [$s, $app, $credentials, $checklist];
    }

    private function credential(Specialist $s, string $type, ?string $expires): SpecialistCredential
    {
        $c = new SpecialistCredential($s->getId(), $type, 'credentials/' . bin2hex(random_bytes(16)) . '.bin', 'x.pdf', 'application/pdf', 1, str_repeat('a', 64));
        $c->setExpiresAt($expires !== null ? new DateTimeImmutable($expires) : null);
        $c->verify(null, 'Reviewer', ['register_checked' => true, 'register_reference' => 'R', 'note' => null]);

        return $c;
    }

    public function testEverythingInPlaceGoesLive(): void
    {
        foreach (['ng', 'abroad'] as $route) {
            [$s, $app, $creds, $checklist] = $this->ready($route);
            $this->assertSame([], GoLiveRules::problems($s, $app, $checklist, $creds, self::TERMS, self::TODAY), $route);
        }
    }

    public function testEveryGate(): void
    {
        [$s, $app, $creds, $checklist] = $this->ready();
        $s->setConsultationFee('0.00');
        $this->assertArrayHasKey('fee', GoLiveRules::problems($s, $app, $checklist, $creds, self::TERMS, self::TODAY));

        [$s, $app, $creds, $checklist] = $this->ready();
        $s->stageChanges(['name' => 'Dr. Ada Obi-Okafor']);
        $this->assertArrayHasKey('pending_changes', GoLiveRules::problems($s, $app, $checklist, $creds, self::TERMS, self::TODAY));

        [$s, $app, $creds, $checklist] = $this->ready();
        $s->setName('Dr. Somebody Else');
        $this->assertArrayHasKey('locked_values', GoLiveRules::problems($s, $app, $checklist, $creds, self::TERMS, self::TODAY));

        [$s, $app, $creds, $checklist] = $this->ready();
        $expired = [$creds[0], $this->credential($s, SpecialistCredential::TYPE_LICENCE, '2026-10-01')];
        $this->assertArrayHasKey('practising_licence', GoLiveRules::problems($s, $app, $checklist, $expired, self::TERMS, self::TODAY));

        [$s, $app, $creds, $checklist] = $this->ready();
        $this->assertArrayHasKey('terms', GoLiveRules::problems($s, $app, $checklist, $creds, '2.0', self::TODAY));

        [$s, $app, $creds, $checklist] = $this->ready();
        $app->setStatus(DoctorApplicationStatus::WITHDRAWN);
        $this->assertArrayHasKey('application', GoLiveRules::problems($s, $app, $checklist, $creds, self::TERMS, self::TODAY));
        $this->assertArrayHasKey('application', GoLiveRules::problems($s, null, $checklist, $creds, self::TERMS, self::TODAY));

        [$s, $app, $creds, $checklist] = $this->ready();
        $checklist['signature'] = false;
        $this->assertArrayHasKey('checklist', GoLiveRules::problems($s, $app, $checklist, $creds, self::TERMS, self::TODAY));
    }

    public function testLockedValuesCompareWithTheApprovedChangeRequestOnceThereIsOne(): void
    {
        [$s, $app, $creds, $checklist] = $this->ready();
        // A reviewer approved a change request: the specialist's own snapshot is the reference now.
        $s->setName('Dr. Ada Obi-Okafor');
        $s->snapshotApproval([], null, 'Reviewer');
        $this->assertSame([], GoLiveRules::problems($s, $app, $checklist, $creds, self::TERMS, self::TODAY));
        $this->assertSame('Dr. Ada Obi-Okafor', GoLiveRules::lastApprovedLocked($s, $app)['name']);

        [$s2, $app2] = $this->ready();
        $this->assertSame($app2->getApprovalSnapshot()['locked'], GoLiveRules::lastApprovedLocked($s2, $app2), 'otherwise the application snapshot');
    }

    public function testSameLockedValuesIgnoresSpacingAndKeyOrder(): void
    {
        $a = ['name' => 'Dr. Ada', 'qualification_entries' => [['title' => 'MBBS', 'institution' => 'U', 'year' => '2010']]];
        $b = ['qualification_entries' => [['year' => '2010', 'institution' => ' U ', 'title' => 'MBBS']], 'name' => ' Dr. Ada '];
        $this->assertTrue(Specialist::sameLockedValues($a, $b));
        $this->assertFalse(Specialist::sameLockedValues($a, ['name' => 'Dr. Bola'] + $b));
    }
}
