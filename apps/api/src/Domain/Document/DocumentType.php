<?php

declare(strict_types=1);

namespace App\Domain\Document;

/**
 * The catalogue of medical document types a patient (or clinician) can file.
 * Single source of truth: the value list validates uploads server-side and the
 * label map drives the client dropdown (served by DocumentTypesAction), so the
 * two never drift. `other` is always valid and pairs with a free-text label.
 */
final class DocumentType
{
    /** value => human label, in display order. */
    public const CATALOGUE = [
        'laboratory_test_report' => 'Laboratory Test Report',
        'blood_test_report'      => 'Blood Test Report',
        'urine_test_report'      => 'Urine Test Report',
        'xray_report'            => 'X-Ray Report',
        'ct_scan_report'         => 'CT Scan Report',
        'mri_report'             => 'MRI Report',
        'ultrasound_report'      => 'Ultrasound Report',
        'ecg_report'             => 'ECG / EKG Report',
        'echocardiogram_report'  => 'Echocardiogram Report',
        'pathology_report'       => 'Pathology Report',
        'histopathology_report'  => 'Histopathology Report',
        'biopsy_report'          => 'Biopsy Report',
        'radiology_report'       => 'Radiology Report',
        'discharge_summary'      => 'Discharge Summary',
        'surgical_report'        => 'Surgical / Operative Report',
        'prescription'           => 'Prescription',
        'medical_certificate'    => 'Medical Certificate',
        'referral_letter'        => 'Referral Letter',
        'vaccination_record'     => 'Vaccination / Immunization Record',
        'allergy_record'         => 'Allergy Record',
        'genetic_test_report'    => 'Genetic Test Report',
        'mental_health_report'   => 'Mental Health Assessment',
        'physical_exam_report'   => 'Physical Examination Report',
        'dental_report'          => 'Dental Report',
        'ophthalmology_report'   => 'Ophthalmology Report',
        'insurance_document'     => 'Insurance Document',
        'consent_form'           => 'Consent Form',
        'other'                  => 'Other',
    ];

    /** @return list<array{value: string, label: string}> */
    public static function all(): array
    {
        $out = [];
        foreach (self::CATALOGUE as $value => $label) {
            $out[] = ['value' => $value, 'label' => $label];
        }

        return $out;
    }

    public static function isValid(string $value): bool
    {
        return isset(self::CATALOGUE[$value]);
    }

    public static function label(string $value): string
    {
        return self::CATALOGUE[$value] ?? 'Document';
    }
}
