<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Settings\ClinicTime;
use App\Infrastructure\Document\ClinicalDocumentRenderer;
use PHPUnit\Framework\TestCase;

/**
 * The document renderer is pure string-building, so its output — valid HTML,
 * the right content per kind, and (critically) HTML-escaping of every dynamic
 * value — is fully checkable offline.
 */
final class ClinicalDocumentRendererTest extends TestCase
{
    private function renderer(): ClinicalDocumentRenderer
    {
        return new ClinicalDocumentRenderer('VideoMed', 'Telehealth Consultations', 'care@videomed.test');
    }

    /** @return array<string,mixed> */
    private function baseCtx(): array
    {
        return [
            'patient_name'     => 'Ada Lovelace',
            'patient_gender'   => 'female',
            'doctor_name'      => 'Dr Alan Turing',
            'doctor_specialty' => 'Cardiology',
            'consult_date'     => '2026-01-10T09:00:00+00:00',
            'issued_at'        => '2026-01-10T09:30:00+00:00',
            'document_no'      => 'abcdef1234567890',
        ];
    }

    public function testPrescriptionRendersItemsAndDocumentChrome(): void
    {
        $html = $this->renderer()->render('prescription', $this->baseCtx() + [
            'items' => [
                ['medication' => 'Amoxicillin', 'strength' => '500mg', 'dosage' => '1 capsule', 'frequency' => 'three times daily', 'duration' => '7 days'],
            ],
            'notes' => 'Take after meals.',
        ]);

        self::assertStringStartsWith('<!doctype html>', strtolower($html));
        self::assertStringContainsString('Prescription', $html);
        self::assertStringContainsString('Amoxicillin 500mg', $html);
        self::assertStringContainsString('Take after meals.', $html);
        self::assertStringContainsString('Ada Lovelace', $html);
        self::assertStringContainsString('Dr Alan Turing', $html);
        // Reference is the uppercased document number prefix.
        self::assertStringContainsString('ABCDEF12', $html);
    }

    public function testCertificateRendersPeriodAndStatement(): void
    {
        $html = $this->renderer()->render('certificate', $this->baseCtx() + [
            'type_label' => 'Sick leave certificate',
            'statement'  => 'Requires rest and is unfit for work.',
            'from_date'  => '2026-01-10',
            'to_date'    => '2026-01-12',
            'days'       => 3,
        ]);

        self::assertStringContainsString('Sick leave certificate', $html);
        self::assertStringContainsString('Requires rest and is unfit for work.', $html);
        self::assertStringContainsString('(3 days)', $html);
    }

    public function testReferralMarksUrgentAndEscapesInput(): void
    {
        $html = $this->renderer()->render('referral', $this->baseCtx() + [
            'referral_type'    => 'specialist',
            'target'           => 'Neurology <script>alert(1)</script>',
            'reason'           => 'Persistent headaches',
            'priority'         => 'urgent',
        ]);

        self::assertStringContainsString('Urgent', $html);
        self::assertStringContainsString('Persistent headaches', $html);
        // The injected script must be escaped, never emitted as a live tag.
        self::assertStringNotContainsString('<script>alert(1)</script>', $html);
        self::assertStringContainsString('&lt;script&gt;', $html);
    }

    public function testUnknownKindThrows(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->renderer()->render('bogus', $this->baseCtx());
    }

    public function testDatesAreOnTheClinicCalendarWhateverTheProcessZone(): void
    {
        $zone = date_default_timezone_get();
        date_default_timezone_set('Asia/Shanghai');
        ClinicTime::configure('Africa/Lagos');
        try {
            $html = $this->renderer()->render('certificate', [
                'consult_date' => '2026-10-22T06:30:00+08:00', // 21 Oct, 23:30 WAT
                'issued_at'    => '2026-10-21T17:00:00+08:00', // 21 Oct, 10:00 WAT
                'type_label'   => 'Sick leave certificate',
                'statement'    => 'Requires rest.',
                'from_date'    => '2026-10-21',
                'to_date'      => '2026-10-22',
                'days'         => 2,
            ] + $this->baseCtx());

            self::assertStringContainsString('Issued: 21 Oct 2026, 10:00', $html, 'issued on the clinic clock');
            // 23:30 WAT on the 21st — already the 22nd in the process zone.
            self::assertStringContainsString('Consultation: 21 Oct 2026', $html);
            self::assertStringContainsString('21 Oct 2026 to 22 Oct 2026', $html, 'calendar days are never shifted');
        } finally {
            date_default_timezone_set($zone);
        }
    }
}
