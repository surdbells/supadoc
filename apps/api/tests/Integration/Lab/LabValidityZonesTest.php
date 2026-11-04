<?php

declare(strict_types=1);

namespace App\Tests\Integration\Lab;

use App\Action\LabRequest\Doctor\GetDoctorLabRequestAction;
use App\Action\LabRequest\Patient\GetMyLabRequestAction;
use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Entity\LabRequest;
use App\Domain\Lab\LabRequestRules;
use App\Domain\Settings\ClinicTime;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Lab\LabRequestService;
use DateTimeImmutable;
use Doctrine\ORM\EntityManagerInterface;

/**
 * `valid_until` is a clinic calendar date (lab spec §1.1, review finding 12):
 * a doctor in Chicago, a patient in Auckland and a server on PRC all see the
 * same date — in the doctor's and patient's payloads, the email and the PDF
 * footer — for a request sent at 23:30 clinic time.
 */
final class LabValidityZonesTest extends LabTestCase
{
    public function testEverySurfacePrintsTheSameValidUntil(): void
    {
        $zone = date_default_timezone_get();
        date_default_timezone_set('PRC');
        try {
            $this->conn()->executeStatement("UPDATE specialists SET timezone = 'America/Chicago', timezone_source = 'manual' WHERE id = ?", [$this->A]);
            $this->conn()->executeStatement("UPDATE patients SET timezone = 'Pacific/Auckland', timezone_source = 'manual' WHERE id = ?", [$this->P]);
            $id = $this->sent();

            // Sent at 23:30 clinic time (Lagos): already the next day in PRC and Auckland.
            $sentAt   = new DateTimeImmutable(ClinicTime::todayYmd() . ' 23:30', ClinicTime::zone());
            $validity = LabRequestRules::validity($sentAt);
            $this->conn()->executeStatement('UPDATE lab_requests SET sent_at = ?, valid_until = ?, expires_at = ? WHERE id = ?', [
                Rules::sql($sentAt), $validity['valid_until']->format('Y-m-d'), Rules::sql($validity['expires_at']), $id,
            ]);
            $expected = (new DateTimeImmutable(ClinicTime::todayYmd()))->modify('+' . LabRequestRules::EXPIRY_DAYS . ' days')->format('Y-m-d');
            $this->assertSame($expected, $validity['valid_until']->format('Y-m-d'));
            $label = LabRequestRules::dateLabel($validity['valid_until']);

            $doctor  = $this->doctorAction(GetDoctorLabRequestAction::class, $this->userA, ['labId' => $id], [], [], 'GET')['body']['data'];
            $patient = $this->patientAction(GetMyLabRequestAction::class, $this->P, [], ['labId' => $id], [], 'GET')['body']['data'];
            $this->assertSame($expected, $doctor['valid_until']);
            $this->assertSame($expected, $patient['valid_until']);

            $c = $this->container();
            $r = $c->get(EntityManagerInterface::class)->find(LabRequest::class, $id);
            \assert($r instanceof LabRequest);
            $email = EmailTemplates::labRequestSent('Pat', 'Dr. Ada Alpha', $r->getNumber(), 'Routine', false, LabRequestRules::dateLabel($r->getValidUntil()), 'https://example.test');
            $this->assertStringContainsString('>' . $label . '<', $email['html']);

            $pdf = $c->get(LabRequestService::class)->pdf($r);
            $this->assertStringContainsString('Valid until ' . $label, self::pdfText($pdf['bytes']));
            // The doctor's instants are in Chicago, so "Date sent" is the clinic day (16:30 CST/CDT).
            $this->assertStringContainsString(' 16:30 C', self::pdfText($pdf['bytes']));
        } finally {
            date_default_timezone_set($zone);
        }
    }
}
