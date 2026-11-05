<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Entity\LabRequest;
use App\Domain\Lab\LabRequestRules;
use App\Domain\Settings\ClinicTime;
use App\Infrastructure\Lab\LabRequestPdfRenderer;
use App\Infrastructure\Prescription\PrescriptionPdf;
use DateTimeImmutable;
use DateTimeZone;
use PHPUnit\Framework\TestCase;

/**
 * The request PDF (lab spec §6): renders the worst case (20 items, every
 * long field, no date of birth, no signature, every watermark) within 3 pages
 * and 1 MB, prints the safety warnings, and its footer's "Valid until" is the
 * calendar date whatever the doctor's or the server's zone.
 */
final class LabRequestPdfRendererTest extends TestCase
{
    use LabFixtures;

    private const CODES = ['FBC', 'BMP', 'LIPID', 'MP', 'RBS', 'FBS', 'HIV', 'HBSAG', 'TSH', 'CRP', 'MCS-URINE', 'GRAM-BLOOD', 'AFB-SPUTUM',
        'XR-CHEST', 'CT-HEAD', 'MRI-KNEE', 'US-PELVIS', 'OT-FLUORO', 'ECG12', 'ECHO-TTE'];

    private function worstCase(): LabRequest
    {
        $long = str_repeat('Lorem ipsum dolor sit amet consectetur ', 13);
        $r    = self::labRequest([
            'priority'          => 'stat',
            'clinical_question' => mb_substr($long, 0, 200),
            'history'           => mb_substr($long, 0, 500),
            'medication'        => mb_substr($long, 0, 500),
            'allergies'         => mb_substr($long, 0, 500),
            'items'             => array_map(static fn (string $c): array => ['code' => $c], self::CODES),
            'imaging_safety'    => ['contrast_allergy' => 'yes', 'mobility' => 'bed'],
            'clinical'          => ['fasting' => true, 'fasting_hours' => 10, 'pregnant' => true, 'weeks_pregnant' => 12, 'infection_alerts' => ['hiv', 'tb'], 'transfusion_3m' => true],
        ], true);
        (new \ReflectionProperty(LabRequest::class, 'patientSnapshot'))->setValue($r, ['name' => 'Chika Osuji', 'reference' => 'P-11111111', 'email' => '', 'date_of_birth' => '', 'dob_iso' => '', 'sex' => '']);

        return $r;
    }

    private function renderer(): LabRequestPdfRenderer
    {
        return new LabRequestPdfRenderer(self::catalogue(), clinicContact: '+234 800 000 0000');
    }

    public function testTheWorstCaseRendersWithinThreePagesAndOneMegabyte(): void
    {
        $renderer = $this->renderer();
        foreach ([null, 'NOT YET ACCEPTED', 'CANCELLED', 'EXPIRED', 'DECLINED'] as $watermark) {
            $pdf = $renderer->render($this->worstCase(), null, $watermark, new DateTimeZone('Africa/Lagos'));
            $this->assertStringStartsWith('%PDF-', $pdf);
            $this->assertLessThan(1024 * 1024, strlen($pdf));
            $this->assertLessThanOrEqual(3, $renderer->lastPageCount(), (string) $watermark);
            $text = self::text($pdf);
            if ($watermark !== null) {
                $this->assertStringContainsString('(' . $watermark . ') Tj', $text, $watermark);
            }
        }
        $text = self::text($renderer->render($this->worstCase(), null, null, new DateTimeZone('Africa/Lagos')));
        $this->assertStringContainsString('Pregnant patient: check this study is safe in pregnancy before sending.', $text);
        $this->assertStringContainsString('Contrast allergy reported. Check before any contrast study.', $text);
        $this->assertStringContainsString('MRI safety and kidney function for contrast are checked by the imaging centre.', $text);
        $this->assertStringContainsString('Not on file', $text, 'no date of birth');
        $this->assertStringContainsString('INVESTIGATION REQUEST', $text);
        $this->assertStringContainsString('Questions about this request: +234 800 000 0000', $text);
    }

    public function testASignatureIsEmbedded(): void
    {
        $img = imagecreatetruecolor(200, 60);
        imagefill($img, 0, 0, (int) imagecolorallocate($img, 255, 255, 255));
        ob_start();
        imagepng($img);
        $png = (string) ob_get_clean();
        $pdf = $this->renderer()->render(self::labRequest(), $png, null, new DateTimeZone('UTC'));
        $this->assertStringContainsString('/Subtype /Image', $pdf);
        $this->assertStringNotContainsString('/Subtype /Image', $this->renderer()->render(self::labRequest(), null, null, new DateTimeZone('UTC')), 'none without a signature');
    }

    public function testTheFooterPrintsTheCalendarDateInEveryZone(): void
    {
        $zone = date_default_timezone_get();
        date_default_timezone_set('PRC');
        try {
            $sent = new DateTimeImmutable('2026-11-04 23:30', ClinicTime::zone());
            $r    = self::labRequest([], false, $sent);
            $this->assertSame('2026-12-04', $r->getValidUntil()->format('Y-m-d'));
            foreach (['America/Chicago', 'Pacific/Auckland', 'PRC'] as $tz) {
                $text = self::text($this->renderer()->render($r, null, null, new DateTimeZone($tz)));
                $this->assertStringContainsString('Valid until 4 Dec 2026', $text, $tz);
            }
            $chicago = self::text($this->renderer()->render($r, null, null, new DateTimeZone('America/Chicago')));
            $this->assertStringContainsString('Date sent: 4 Nov 2026, 16:30 CST', $chicago, 'instants in the doctor\'s zone');
            $this->assertSame('4 Dec 2026', LabRequestRules::dateLabel($r->getValidUntil()));
        } finally {
            date_default_timezone_set($zone);
        }
    }

    /**
     * Labels never run into the next column: each investigations header fits
     * its column, and each summary-row label and its longest value fit their
     * cell ("TRANSFUSION IN LAST 3 MONTHS" once ran into "PURPOSE").
     */
    public function testHeadersAndSummaryLabelsFitTheirColumns(): void
    {
        $const = static fn (string $name): array => (array) (new \ReflectionClassConstant(LabRequestPdfRenderer::class, $name))->getValue();
        $pdf   = new PrescriptionPdf('P', 'mm', 'A4');
        $pdf->AddPage();

        $cols = $const('COLS');
        $this->assertEqualsWithDelta(186.0, array_sum(array_column($cols, 1)), 0.001);
        $pdf->SetFont('Helvetica', 'B', 7);
        foreach ($cols as [$label, $w]) {
            // Drawn 1.5 mm in; keep at least 1.5 mm clear of the column's right edge.
            $this->assertLessThanOrEqual($w - 3.0, $pdf->GetStringWidth($label), $label);
        }
        $pdf->SetFont('Helvetica', '', 7.6);
        $this->assertLessThanOrEqual($cols[2][1] - 3.0, $pdf->GetStringWidth('Physiological'), 'the longest Type value');

        $meta = $const('META_COLS');
        $this->assertEqualsWithDelta(186.0, array_sum(array_column($meta, 1)), 0.001);
        $longest = [
            ['Yes, 99 hours', 'Not stated'],
            ['Yes, 99 weeks', 'Not stated', 'Not asked'],
            [implode(', ', LabRequestRules::INFECTION_ALERTS)],
            ['Not stated'],
            [...array_values(LabRequestRules::PURPOSES), 'Not stated'],
        ];
        foreach ($meta as $i => [$label, $w]) {
            // Label and value start 2.5 mm in; the next cell's text starts 2.5 mm into it.
            $pdf->SetFont('Helvetica', '', 6.2);
            $this->assertLessThanOrEqual($w - 2.5, $pdf->GetStringWidth(strtoupper($label)) + 2.5, $label);
            $pdf->SetFont('Helvetica', 'B', 8);
            foreach ($longest[$i] as $value) {
                $this->assertLessThanOrEqual($w - 4.0, $pdf->GetStringWidth($value), "{$label}: {$value} is not cut");
            }
        }
    }

    /** The inflated page streams. */
    private static function text(string $pdf): string
    {
        $out = '';
        if (preg_match_all('/stream\r?\n(.*?)\r?\nendstream/s', $pdf, $m) > 0) {
            foreach ($m[1] as $stream) {
                $plain = @gzuncompress($stream);
                $out  .= ($plain !== false ? $plain : $stream) . "\n";
            }
        }

        return $out;
    }
}
