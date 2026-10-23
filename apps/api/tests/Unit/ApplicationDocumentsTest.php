<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Application\ApplicationDocuments as Docs;
use App\Domain\Entity\SpecialistCredential as C;
use PHPUnit\Framework\TestCase;

/** Spec §2.12 slots, labels and requirements per route; §4.3 slot → credential type and prefill. */
final class ApplicationDocumentsTest extends TestCase
{
    public function testSlotsAndRequirementsPerRoute(): void
    {
        $this->assertSame(['mdcn_certificate', 'government_id', 'medical_degree', 'practising_licence', 'curriculum_vitae', 'indemnity_certificate'], Docs::slotsFor('ng'));
        $this->assertSame(['good_standing_certificate', 'government_id', 'medical_degree', 'practising_licence', 'curriculum_vitae', 'indemnity_certificate'], Docs::slotsFor('abroad'));
        $this->assertSame(Docs::slotsFor('abroad'), Docs::requiredFor('abroad'));
        $this->assertNotContains('additional', Docs::slotsFor('ng'), 'only on request');
        $this->assertSame(['mdcn_certificate'], Docs::requiredForStep('licence', 'ng'));
        $this->assertSame(['good_standing_certificate'], Docs::requiredForStep('licence', 'abroad'));
        $this->assertSame(Docs::DOCUMENTS_STEP, Docs::requiredForStep('documents', 'ng'));
        $this->assertSame(['indemnity_certificate'], Docs::requiredForStep('indemnity', 'ng'));
        $this->assertSame([], Docs::requiredForStep('personal', 'ng'));
        $this->assertTrue(Docs::requestable('additional', 'ng'));
        $this->assertFalse(Docs::requestable('good_standing_certificate', 'ng'));
    }

    public function testLabelsAndHelpers(): void
    {
        $this->assertSame('Current MDCN practising licence', Docs::label('practising_licence', 'ng'));
        $this->assertSame('Current practising licence', Docs::label('practising_licence', 'abroad'));
        $this->assertSame('Issued by General Medical Council', Docs::helper('practising_licence', 'abroad', 'General Medical Council'));
        $this->assertSame('Valid for the current year', Docs::helper('practising_licence', 'ng'));
        $this->assertSame('MDCN full registration certificate', Docs::label('mdcn_certificate', 'ng'));
    }

    public function testSlotToCredentialType(): void
    {
        $this->assertSame(C::TYPE_MDCN, Docs::typeFor('mdcn_certificate', 'ng'));
        $this->assertSame(C::TYPE_LICENCE, Docs::typeFor('practising_licence', 'ng'));
        $this->assertSame(C::TYPE_FOREIGN_LICENCE, Docs::typeFor('practising_licence', 'abroad'));
        $this->assertSame(C::TYPE_GOOD_STANDING, Docs::typeFor('good_standing_certificate', 'abroad'));
        $this->assertSame(C::TYPE_INDEMNITY, Docs::typeFor('indemnity_certificate', 'ng'));
        $this->assertSame(C::TYPE_GOVERNMENT_ID, Docs::typeFor('government_id', 'ng'));
        $this->assertSame(C::TYPE_MEDICAL_DEGREE, Docs::typeFor('medical_degree', 'abroad'));
        $this->assertSame(C::TYPE_CV, Docs::typeFor('curriculum_vitae', 'ng'));
        $this->assertNull(Docs::typeFor('additional', 'ng'));
        foreach (Docs::slotsFor('abroad') as $slot) {
            $this->assertArrayHasKey((string) Docs::typeFor($slot, 'abroad'), C::TYPES);
        }
    }

    public function testApprovalPrefill(): void
    {
        $promoted = ['reference' => 'GVM-DR-2026-12345', 'registration_number' => '7012345', 'regulator_name' => 'General Medical Council', 'good_standing_issued_on' => '2026-06-01'];
        $abroad   = Docs::prefill('practising_licence', 'abroad', $promoted);
        $this->assertSame('2027-06-01', $abroad['prefill']['expires_on'], '12 months from the good-standing date');
        $this->assertSame('7012345', $abroad['prefill']['number']);
        $this->assertNotNull($abroad['expiry_hint']);
        $gs = Docs::prefill('good_standing_certificate', 'abroad', $promoted);
        $this->assertTrue($gs['needs_issue_date']);
        $this->assertSame('2026-06-01', $gs['prefill']['issued_on']);
        $this->assertSame('General Medical Council register entry or certificate number', $gs['reference_hint']);
        $this->assertSame('Checked with application GVM-DR-2026-12345', Docs::prefill('government_id', 'ng', $promoted)['prefill']['register_reference']);
        $this->assertSame('', Docs::prefill('mdcn_certificate', 'ng', $promoted)['prefill']['register_reference']);
    }
}
