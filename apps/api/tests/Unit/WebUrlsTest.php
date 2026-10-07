<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Entity\Patient;
use App\Domain\Entity\Specialist;
use App\Domain\Entity\User;
use App\Domain\Settings\WebUrls;
use PHPUnit\Framework\TestCase;

/** Links follow each user to the site they use (several deployments, one API). */
final class WebUrlsTest extends TestCase
{
    protected function setUp(): void
    {
        WebUrls::configureFromEnv([
            'PATIENT_WEB_URLS' => 'https://patient.dosthq.com, https://patient.betacrest.com/',
            'STAFF_WEB_URLS'   => 'https://doctor.dosthq.com,https://doctor.betacrest.com',
        ]);
        WebUrls::setRequestOrigin('');
    }

    public function testDefaultsAreTheFirstSites(): void
    {
        $this->assertSame('https://patient.dosthq.com', WebUrls::patientDefault());
        $this->assertSame('https://doctor.dosthq.com', WebUrls::staffDefault());
        $this->assertSame('https://patient.dosthq.com', WebUrls::forPatient(null));
    }

    public function testPatientLinksFollowTheirSite(): void
    {
        $p = new Patient('a@example.test', 'Ada', 'Obi');
        $this->assertSame('https://patient.dosthq.com', WebUrls::forPatient($p));
        $p->setWebOrigin('https://patient.betacrest.com');
        $this->assertSame('https://patient.betacrest.com', WebUrls::forPatient($p));
        // A stored site that is no longer configured falls back to the default.
        $p->setWebOrigin('https://evil.example');
        $this->assertSame('https://patient.dosthq.com', WebUrls::forPatient($p));
    }

    public function testOnlyConfiguredOriginsAreRecognised(): void
    {
        WebUrls::setRequestOrigin('https://PATIENT.betacrest.com/');
        $this->assertSame('https://patient.betacrest.com', WebUrls::requestPatientOrigin());
        $this->assertNull(WebUrls::requestStaffOrigin());
        WebUrls::setRequestOrigin('https://attacker.example');
        $this->assertNull(WebUrls::requestPatientOrigin());
    }

    public function testDoctorsGetTheirPortalAndThePairedPatientApp(): void
    {
        $user = new User('dr@example.test', 'Grace', 'Bell');
        $user->setWebOrigin('https://doctor.betacrest.com');
        $this->assertSame('https://doctor.betacrest.com', WebUrls::forStaff($user));
        $this->assertSame('https://patient.betacrest.com', WebUrls::patientAppForStaff($user));

        $doctor = new Specialist('Dr. Grace Bell', 'General Practice');
        $this->assertSame('https://doctor.dosthq.com', WebUrls::forSpecialist($doctor));
        $doctor->setWebOrigin('https://doctor.betacrest.com');
        $this->assertSame('https://doctor.betacrest.com', WebUrls::forSpecialist($doctor));
        $this->assertSame('https://patient.betacrest.com', WebUrls::patientAppForSpecialist($doctor));
    }

    public function testSingleUrlConfigurationStillWorks(): void
    {
        WebUrls::configureFromEnv(['APP_WEB_URL' => 'https://patient.dosthq.com', 'STAFF_WEB_URL' => 'https://doctor.dosthq.com']);
        $this->assertSame('https://patient.dosthq.com', WebUrls::patientDefault());
        $this->assertSame('https://doctor.dosthq.com', WebUrls::staffDefault());
    }
}
