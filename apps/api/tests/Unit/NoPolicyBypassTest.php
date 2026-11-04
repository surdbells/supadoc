<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Action\Doctor\DownloadPatientDocumentAction;
use App\Action\Doctor\ListPatientDocumentsAction;
use App\Domain\Entity\Appointment;
use App\Domain\Entity\Patient;
use App\Domain\Entity\Specialist;
use App\Domain\Enum\ConsultationType;
use App\Domain\Repository\MedicalDocumentRepository;
use App\Infrastructure\Document\DocumentAccessPolicy;
use DateTimeImmutable;
use PHPUnit\Framework\TestCase;

/**
 * DocumentAccessPolicy is the ONLY code that decides what a doctor may see
 * (spec §2.1): there is no "every document of a patient" reader to reach for,
 * no doctor action touches the document repository, the two legacy doctor
 * document routes go through the policy, no call payload carries documents,
 * and the legacy attachment URL never reaches a doctor or the back office.
 */
final class NoPolicyBypassTest extends TestCase
{
    public function testThereIsNoUnfilteredReader(): void
    {
        $this->assertFalse(method_exists(MedicalDocumentRepository::class, 'allForPatient'));
    }

    public function testNoDoctorActionReadsTheDocumentRepository(): void
    {
        foreach ([
            ...(glob(dirname(__DIR__, 2) . '/src/Action/Doctor/*.php') ?: []),
            // Lab requests: the doctor and back-office actions see results only through the policy.
            ...(glob(dirname(__DIR__, 2) . '/src/Action/LabRequest/Doctor/*.php') ?: []),
            ...(glob(dirname(__DIR__, 2) . '/src/Action/LabRequest/Admin/*.php') ?: []),
        ] as $file) {
            $this->assertStringNotContainsString('MedicalDocumentRepository', (string) file_get_contents($file), basename($file));
        }
    }

    public function testTheDoctorDocumentRoutesGoThroughThePolicy(): void
    {
        foreach ([ListPatientDocumentsAction::class, DownloadPatientDocumentAction::class, \App\Action\LabRequest\Doctor\ViewLabResultAction::class, \App\Action\LabRequest\Doctor\RecordLabResultPrintAction::class] as $action) {
            $types = array_map(
                static fn (\ReflectionParameter $p): string => (string) $p->getType(),
                (new \ReflectionMethod($action, '__construct'))->getParameters(),
            );
            $this->assertContains(DocumentAccessPolicy::class, $types, $action);
        }
    }

    public function testNoCallPayloadCarriesDocuments(): void
    {
        foreach (glob(dirname(__DIR__, 2) . '/src/Action/Call/*.php') ?: [] as $file) {
            $source = (string) file_get_contents($file);
            $this->assertStringNotContainsString("'documents'", $source, basename($file));
            $this->assertStringNotContainsString('MedicalDocument', $source, basename($file));
        }
    }

    public function testTheLegacyAttachmentUrlIsThePatientsAlone(): void
    {
        $p = new Patient('p@example.test', 'Pat', 'Patient');
        (new \ReflectionProperty(Patient::class, 'id'))->setValue($p, 'p-1');
        $s = new Specialist('Dr. Test', 'General Practice');
        (new \ReflectionProperty(Specialist::class, 'id'))->setValue($s, 's-1');
        $a = new Appointment($p, $s, new DateTimeImmutable('+1 day'), ConsultationType::VIDEO);
        (new \ReflectionProperty(Appointment::class, 'documentUrl'))->setValue($a, '/uploads/appointment-docs/p-1-abc.pdf');
        $p->initTimestamps();
        $a->initTimestamps();

        $this->assertArrayHasKey('document_url', $a->toArray('patient'));
        $this->assertArrayNotHasKey('document_url', $a->toArray('doctor'));
        $this->assertArrayNotHasKey('document_url', $a->toArray('staff'));
        $this->assertArrayNotHasKey('document_url', $a->toAdminArray());
    }
}
