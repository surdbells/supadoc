<?php

declare(strict_types=1);

namespace App\Tests\Integration\DoctorApplications;

use App\Domain\Entity\Specialist;
use App\Domain\Entity\SpecialistCredential;

/** Spec D2, §4.3: an application licensed abroad → approval → go live, on the abroad credential types. */
final class AbroadApprovalTest extends DoctorApplicationsTestCase
{
    public function testAbroadApplicationToLive(): void
    {
        [$sid, $token] = $this->readyDoctor('abroad');
        $s = $this->em()->find(Specialist::class, $sid);
        $this->assertSame('abroad', $s->getLicenceRoute());
        $this->assertSame('General Medical Council', $s->getRegulatorName());
        $this->assertSame('GB', $s->getRegulatorCountry());
        $this->assertSame('7012345', $s->registrationNumberForRoute());
        $types = $this->conn()->fetchFirstColumn('SELECT type FROM specialist_credentials ORDER BY type');
        $this->assertContains(SpecialistCredential::TYPE_GOOD_STANDING, $types);
        $this->assertContains(SpecialistCredential::TYPE_FOREIGN_LICENCE, $types);
        $this->assertNotContains(SpecialistCredential::TYPE_MDCN, $types);
        $this->assertNotNull($s->getLicenceExpiresAt(), 'the foreign licence counts');

        $summary = $this->http('GET', '/api/doctor/onboarding', null, $token)['body']['data'];
        $this->assertSame('abroad', $summary['licence_route']);
        $this->assertSame('General Medical Council', $summary['registration']['regulator_name']);
        $this->assertTrue($summary['checklist']['mdcn'], 'the registration number counts for "mdcn"');
        $types = $this->http('GET', '/api/doctor/credentials', null, $token)['body']['data']['types'];
        $this->assertSame(['good_standing_certificate', 'foreign_practising_licence', 'specialist_certificate', 'indemnity_certificate'], array_column($types, 'type'));

        $res = $this->http('POST', '/api/doctor/onboarding/submit', [], $token);
        $this->assertCode($res, 200);
        $this->assertSame('approved', $res['body']['data']['status']);
        $options = $this->http('GET', '/api/doctor/prescriptions/options', null, $token)['body']['data'];
        $this->assertSame('General Medical Council number', $options['registration_label']);
        $this->assertSame('7012345', $options['mdcn_number']);
    }
}
