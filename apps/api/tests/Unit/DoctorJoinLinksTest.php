<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Action\Call\CallLobbyAction;
use App\Action\Call\JoinCallAction;
use App\Domain\Appointment\RecipientZones;
use App\Domain\Entity\Appointment;
use App\Domain\Entity\Patient;
use App\Domain\Entity\Specialist;
use App\Domain\Enum\ConsultationType;
use App\Domain\Settings\WebUrls;
use App\Infrastructure\Service\AppointmentInvites;
use App\Infrastructure\Service\ReminderService;
use DateTimeImmutable;
use PHPUnit\Framework\TestCase;

/**
 * A doctor's emailed join link (booking invite and reminder) opens the doctor
 * portal's own call page — with the patient's records and in-call documents —
 * while the patient's and guests' stay on the patient app's join page. Each
 * mail is written on its recipient's clock.
 */
final class DoctorJoinLinksTest extends TestCase
{
    protected function setUp(): void
    {
        WebUrls::configureFromEnv([
            'PATIENT_WEB_URLS' => 'https://patient.dosthq.com,https://patient.betacrest.com',
            'STAFF_WEB_URLS'   => 'https://doctor.dosthq.com,https://doctor.betacrest.com',
        ]);
        WebUrls::setRequestOrigin('');
    }

    private function appointment(): Appointment
    {
        $patient = new Patient('ada@example.test', 'Ada', 'Obi');
        $patient->initTimestamps();
        $patient->setWebOrigin('https://patient.betacrest.com');
        $doctor = new Specialist('Dr. Grace Bell', 'General Practice');
        $doctor->setWebOrigin('https://doctor.betacrest.com');

        return new Appointment($patient, $doctor, new DateTimeImmutable('2026-11-04T15:00:00Z'), ConsultationType::VIDEO);
    }

    public function testTheDoctorsLinkOpensTheDoctorPortalsCallPage(): void
    {
        $a = $this->appointment();
        $this->assertSame(WebUrls::forSpecialist($a->getSpecialist()) . '/call/tok123', AppointmentInvites::joinLink($a, 'doctor', 'tok123'));
        $this->assertSame('https://doctor.betacrest.com/call/tok123', AppointmentInvites::joinLink($a, 'doctor', 'tok123'));
    }

    public function testPatientAndGuestLinksStayOnThePatientApp(): void
    {
        $a = $this->appointment();
        $this->assertSame('https://patient.betacrest.com/call/join/tok123', AppointmentInvites::joinLink($a, 'patient', 'tok123'));
        $this->assertSame('https://patient.betacrest.com/call/join/tok123', AppointmentInvites::joinLink($a, 'guest', 'tok123'));
    }

    public function testRemindersBuildLinksTheSameWay(): void
    {
        $source = (string) file_get_contents((string) (new \ReflectionClass(ReminderService::class))->getFileName());
        $this->assertStringContainsString('AppointmentInvites::joinLink($appointment, $role,', $source, 'one rule for invites and reminders');
        $this->assertStringNotContainsString("'/call/join/'", $source, 'no hand-built patient-app link for the doctor');
        $this->assertStringNotContainsString('patientAppForSpecialist', $source);
    }

    public function testADoctorTokenOpenedOnThePatientAppIsSentToThePortal(): void
    {
        $a = $this->appointment();
        $this->assertSame('https://doctor.betacrest.com/call/tok123', JoinCallAction::doctorPortalUrl($a, 'tok123'));
        $this->assertSame(AppointmentInvites::joinLink($a, 'doctor', 'tok123'), JoinCallAction::doctorPortalUrl($a, 'tok123'), 'the same page the emailed link opens');
        // The join and the lobby both hand it out (a doctor token only) by the one rule.
        foreach ([JoinCallAction::class, CallLobbyAction::class] as $action) {
            $source = (string) file_get_contents((string) (new \ReflectionClass($action))->getFileName());
            $this->assertMatchesRegularExpression("/'doctor_portal_url'\\] = (self|JoinCallAction)::doctorPortalUrl\\(\\\$appointment,/", $source, $action);
        }
        $meeting = JoinCallAction::meeting($a, ['role' => 'patient', 'name' => 'Ada', 'uid' => 1], null);
        $this->assertSame('Africa/Lagos', $meeting['specialist']['timezone'], "the doctor's effective zone");
        $this->assertArrayNotHasKey('doctor_portal_url', $meeting, 'only on a doctor token');
    }

    public function testEachRecipientsClock(): void
    {
        $a = $this->appointment();
        $a->getSpecialist()->setTimezone('America/Chicago', 'manual');

        [$zone, $other, $whose] = RecipientZones::doctor($a);
        $this->assertSame('America/Chicago', $zone->getName());
        $this->assertNull($other, 'a patient never detected is not labelled WAT');
        $this->assertSame("your patient's time", $whose);

        $a->getPatient()->setTimezone('Africa/Lagos', 'auto');
        $this->assertSame('Africa/Lagos', RecipientZones::doctor($a)[1]?->getName());

        [$zone, $other, $whose] = RecipientZones::patient($a);
        $this->assertSame('Africa/Lagos', $zone->getName());
        $this->assertSame('America/Chicago', $other?->getName());
        $this->assertSame("Dr. Grace Bell's time", $whose);
        $this->assertSame("Dr. Ada Okonkwo-Adams' time", RecipientZones::doctorsTime('Dr. Ada Okonkwo-Adams'));

        [$zone, $other] = RecipientZones::guest($a);
        $this->assertSame('Africa/Lagos', $zone->getName(), "a guest gets the inviting patient's zone");
        $this->assertNull($other);
    }
}
