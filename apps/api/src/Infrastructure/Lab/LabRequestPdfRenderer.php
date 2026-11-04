<?php

declare(strict_types=1);

namespace App\Infrastructure\Lab;

use App\Domain\Entity\LabRequest;
use App\Domain\Lab\LabCatalogue;
use App\Domain\Lab\LabRequestRules;
use App\Infrastructure\Prescription\PrescriptionPdf;
use App\Domain\Settings\TimeZones;
use DateTimeImmutable;
use DateTimeZone;

/**
 * Renders a lab request as the branded "INVESTIGATION REQUEST" PDF (spec §6;
 * A4, at most 3 pages, well under 1 MB) with the prescription look:
 * header (mark, clinic, number, date sent, priority), the patient and the
 * requesting doctor, the clinical information, the investigations table
 * (header repeated on a new page), the imaging safety screen and its
 * warnings, the patient's preparation, the frozen signature, an empty "For
 * laboratory use only" box and a footer on every page. A status watermark
 * (NOT YET ACCEPTED / CANCELLED / EXPIRED / DECLINED) is drawn across every
 * page without touching the request.
 *
 * Instants (sent, signed) are stamped in the requesting doctor's zone;
 * `valid_until` is a calendar date and printed as it is, in every zone.
 * The PDF carries PHI by design — it is never emailed or attached.
 */
final class LabRequestPdfRenderer
{
    private const M      = 12.0;   // page margin (mm)
    private const W      = 186.0;  // content width
    private const BOTTOM = 270.0;  // content stops here (the footer is below)

    private const BLUE  = [21, 101, 192];
    private const TEAL  = [0, 137, 123];
    private const INK   = [28, 43, 58];
    private const SLATE = [84, 110, 122];
    private const LINE  = [207, 216, 220];
    private const TINT  = [241, 249, 255];
    private const ALERT = [229, 57, 53];

    /** Investigations table: [label, width]. */
    private const COLS = [['#', 8.0], ['Investigation', 76.0], ['Type', 26.0], ['Specimen / preparation', 54.0], ['Contrast possible', 22.0]];

    private DateTimeZone $tz;

    private ?string $watermark = null;

    private int $pages = 0;

    public function __construct(
        private readonly LabCatalogue $catalogue,
        private readonly string $clinicName = 'VideoMed',
        private readonly string $clinicTagline = 'Telehealth Consultations',
        private readonly string $clinicContact = '',
    ) {
        $this->tz = new DateTimeZone('UTC');
    }

    /** Pages of the last render (a test seam). */
    public function lastPageCount(): int
    {
        return $this->pages;
    }

    /**
     * @param ?string $signaturePng flat PNG bytes (the frozen copy), or null
     * @param ?string $watermark    NOT YET ACCEPTED | CANCELLED | EXPIRED | DECLINED | null
     * @param DateTimeZone $tz      the requesting doctor's zone (instants only)
     */
    public function render(LabRequest $r, ?string $signaturePng, ?string $watermark, DateTimeZone $tz): string
    {
        $this->tz        = $tz;
        $this->watermark = $watermark !== null && trim($watermark) !== '' ? strtoupper(trim($watermark)) : null;
        $pdf = new PrescriptionPdf('P', 'mm', 'A4');
        $pdf->SetAutoPageBreak(false);
        $pdf->SetMargins(self::M, self::M, self::M);
        $pdf->AliasNbPages('{nb}');
        $pdf->SetTitle(PrescriptionPdf::enc('Investigation request ' . $r->getNumber()));
        $pdf->SetAuthor(PrescriptionPdf::enc($this->clinicName));
        $pdf->SetSubject('Investigation request');
        $pdf->SetCreator(PrescriptionPdf::enc($this->clinicName . ' lab requests'));

        $sigFile = $this->signatureFile($signaturePng);
        try {
            $pdf->AddPage();
            $y = $this->header($pdf, $r, true);
            $y = $this->parties($pdf, $r, $y);
            $y = $this->clinical($pdf, $r, $y);
            $y = $this->investigations($pdf, $r, $y);
            $y = $this->safety($pdf, $r, $y);
            $y = $this->preparation($pdf, $r, $y);
            $this->signature($pdf, $r, $sigFile, $y);
            $this->finishPage($pdf, $r);
            $this->pages = $pdf->PageNo();

            return $pdf->Output('S');
        } finally {
            if ($sigFile !== null) {
                @unlink($sigFile);
            }
        }
    }

    // ----- sections -----

    private function header(PrescriptionPdf $pdf, LabRequest $r, bool $first): float
    {
        $x = self::M;
        $y = self::M;
        $this->fill($pdf, self::BLUE);
        $pdf->roundedRect($x, $y, 13, 13, 3.2, 'F');
        $pdf->SetDrawColor(252, 252, 252);
        $pdf->SetLineWidth(1.4);
        $pdf->Line($x + 6.5, $y + 3.4, $x + 6.5, $y + 9.6);
        $pdf->Line($x + 3.4, $y + 6.5, $x + 9.6, $y + 6.5);

        $pdf->SetFont('Helvetica', 'B', 17);
        if (strcasecmp($this->clinicName, 'VideoMed') === 0) {
            $this->text($pdf, self::BLUE);
            $pdf->Text($x + 16, $y + 7.2, 'Video');
            $this->text($pdf, self::TEAL);
            $pdf->Text($x + 16 + $pdf->GetStringWidth('Video'), $y + 7.2, 'Med');
        } else {
            $this->text($pdf, self::BLUE);
            $pdf->Text($x + 16, $y + 7.2, PrescriptionPdf::enc($this->clinicName));
        }
        $pdf->SetFont('Helvetica', '', 8);
        $this->text($pdf, self::SLATE);
        $pdf->Text($x + 16, $y + 11.4, PrescriptionPdf::enc($this->clinicTagline));
        if ($this->clinicContact !== '') {
            $pdf->Text($x + 16, $y + 15.2, PrescriptionPdf::enc($this->clinicContact));
        }

        $right = self::M + self::W;
        $pdf->SetFont('Helvetica', 'B', 14);
        $this->text($pdf, self::BLUE);
        $this->rightText($pdf, $right, $y + 5, $first ? 'INVESTIGATION REQUEST' : 'INVESTIGATION REQUEST (continued)');
        $pdf->SetFont('Helvetica', 'B', 11);
        $this->text($pdf, self::INK);
        $this->rightText($pdf, $right, $y + 10.4, $r->getNumber());
        $pdf->SetFont('Helvetica', '', 8);
        $this->text($pdf, self::SLATE);
        $this->rightText($pdf, $right, $y + 14.6, 'Date sent: ' . TimeZones::stamp($r->getSentAt(), $this->tz));

        // Priority pill (STAT in the alert colour).
        $label = strtoupper(LabRequestRules::priorityLabel($r->getPriority()));
        $pdf->SetFont('Helvetica', 'B', 8);
        $pw = $pdf->GetStringWidth($label) + 6;
        $this->fill($pdf, $r->getPriority() === 'stat' ? self::ALERT : ($r->getPriority() === 'urgent' ? [239, 108, 0] : self::BLUE));
        $pdf->roundedRect($right - $pw, $y + 16.4, $pw, 5, 2.2, 'F');
        $pdf->SetTextColor(255, 255, 255);
        $pdf->Text($right - $pw + 3, $y + 19.9, PrescriptionPdf::enc($label));

        $this->draw($pdf, self::BLUE);
        $pdf->SetLineWidth(0.8);
        $pdf->Line(self::M, $y + 23.5, $right, $y + 23.5);

        return $y + 26.5;
    }

    private function parties(PrescriptionPdf $pdf, LabRequest $r, float $y): float
    {
        $p    = $r->getPatientSnapshot();
        $d    = $r->getPrescriber();
        $colW = (self::W - 4) / 2;
        $dob  = trim((string) ($p['date_of_birth'] ?? ''));
        $this->box($pdf, self::M, $y, $colW, 26, 'Patient', [
            ['Name', (string) (($p['name'] ?? '') !== '' ? $p['name'] : '-')],
            ['Reference', (string) (($p['reference'] ?? '') !== '' ? $p['reference'] : '-')],
            ['Date of birth', $dob !== '' ? $dob : 'Not on file'],
            ['Age', ($p['age'] ?? '') !== '' ? $p['age'] . ' years' : 'Not on file'],
            ['Sex', (string) (($p['sex'] ?? '') !== '' ? $p['sex'] : 'Not recorded')],
        ]);
        $label = trim((string) ($d['registration_label'] ?? ''));
        $this->box($pdf, self::M + $colW + 4, $y, $colW, 26, 'Requesting doctor', [
            ['Name', (string) (($d['name'] ?? '') !== '' ? $d['name'] : '-')],
            ['Specialty', (string) (($d['specialty'] ?? '') !== '' ? $d['specialty'] : '-')],
            ['Qualifications', (string) (($d['qualifications'] ?? '') !== '' ? $d['qualifications'] : '-')],
            [$label !== '' ? $label : 'MDCN number', (string) (($d['mdcn_number'] ?? '') !== '' ? $d['mdcn_number'] : 'Not provided')],
        ]);

        return $y + 29;
    }

    private function clinical(PrescriptionPdf $pdf, LabRequest $r, float $y): float
    {
        $y = $this->sectionTitle($pdf, 'Clinical information', $y);
        foreach ([
            ['Provisional diagnosis / clinical question', $r->getClinicalQuestion()],
            ['Relevant history / symptoms', $r->getHistory()],
            ['Current medication', $r->getMedication()],
            ['Allergies', $r->getAllergies()],
        ] as [$label, $value]) {
            $pdf->SetFont('Helvetica', '', 8.4);
            $lines = $pdf->wrap((string) ($value ?? ''), self::W - 50, 7);
            $lines = $lines === [] ? ['-'] : $lines;
            $y     = $this->ensure($pdf, $r, $y, count($lines) * 3.7 + 1.6);
            $pdf->SetFont('Helvetica', 'B', 7.4);
            $this->text($pdf, self::SLATE);
            $labelLines = $pdf->wrap($label, 46, 2);
            foreach ($labelLines as $n => $line) {
                $pdf->Text(self::M, $y + 1.2 + $n * 3.2, $line);
            }
            $pdf->SetFont('Helvetica', '', 8.4);
            $this->text($pdf, self::INK);
            foreach ($lines as $n => $line) {
                $pdf->Text(self::M + 48, $y + 1.2 + $n * 3.7, $line);
            }
            $y += max(count($lines) * 3.7, count($labelLines) * 3.2) + 1.6;
        }

        // Meta row.
        $f        = $r->getClinicalFlags();
        $fasting  = match ($f['fasting'] ?? null) {
            true    => 'Yes' . (is_int($f['fasting_hours'] ?? null) ? ', ' . $f['fasting_hours'] . ' hours' : ''),
            false   => 'No',
            default => 'Not stated',
        };
        $pregnant = !($f['pregnancy_asked'] ?? false) ? 'Not asked' : match ($f['pregnant'] ?? null) {
            true    => 'Yes' . (is_int($f['weeks_pregnant'] ?? null) ? ', ' . $f['weeks_pregnant'] . ' weeks' : ''),
            false   => 'No',
            default => 'Not stated',
        };
        $alerts = array_map(static fn (string $a): string => LabRequestRules::INFECTION_ALERTS[$a] ?? $a, (array) ($f['infection_alerts'] ?? []));
        $transfusion = match ($f['transfusion_3m'] ?? null) {
            true    => 'Yes',
            false   => 'No',
            default => 'Not stated',
        };
        $cells = [
            ['Fasting', $fasting],
            ['Pregnant', $pregnant],
            ['Infection alert', $alerts !== [] ? implode(', ', $alerts) : 'None'],
            ['Transfusion in last 3 months', $transfusion],
            ['Purpose', $r->getPurpose() !== null ? (LabRequestRules::PURPOSES[$r->getPurpose()] ?? $r->getPurpose()) : 'Not stated'],
        ];
        $y = $this->ensure($pdf, $r, $y, 12);
        $this->fill($pdf, self::TINT);
        $pdf->roundedRect(self::M, $y, self::W, 10.5, 2, 'F');
        $w = self::W / count($cells);
        foreach ($cells as $i => [$label, $value]) {
            $x = self::M + $i * $w + 2.5;
            $pdf->SetFont('Helvetica', '', 6.2);
            $this->text($pdf, self::SLATE);
            $pdf->Text($x, $y + 3.9, PrescriptionPdf::enc(strtoupper($label)));
            $pdf->SetFont('Helvetica', 'B', 8);
            $this->text($pdf, self::INK);
            $line = $pdf->wrap($value, $w - 4, 1);
            $pdf->Text($x, $y + 8.3, $line[0] ?? '-');
        }

        return $y + 13.5;
    }

    private function investigations(PrescriptionPdf $pdf, LabRequest $r, float $y): float
    {
        $y = $this->ensure($pdf, $r, $y, 20);
        $y = $this->sectionTitle($pdf, 'Investigations', $y);
        $y = $this->tableHeader($pdf, $y);
        foreach ($r->getItems() as $n => $item) {
            $pdf->SetFont('Helvetica', 'B', 7.8);
            $name = $pdf->wrap($item->getLabel(), self::COLS[1][1] - 2.5, 2);
            $detail = match ($item->getKind()) {
                'lab'     => (string) ($item->getSpecimenLabel() ?? '-'),
                'imaging' => 'Preparation: ' . (string) ($item->getPreparationLabel() ?? 'None'),
                default   => '-',
            };
            $pdf->SetFont('Helvetica', '', 7.6);
            $detailLines = $pdf->wrap($detail, self::COLS[3][1] - 2.5, 2);
            $rowH        = max(count($name), count($detailLines), 1) * 3.4 + 3.2;
            if ($y + $rowH > self::BOTTOM) {
                $this->finishPage($pdf, $r);
                $pdf->AddPage();
                $y = $this->header($pdf, $r, false);
                $y = $this->sectionTitle($pdf, 'Investigations (continued)', $y);
                $y = $this->tableHeader($pdf, $y);
            }
            if ($n % 2 === 1) {
                $this->fill($pdf, [248, 251, 253]);
                $pdf->Rect(self::M, $y, self::W, $rowH, 'F');
            }
            $this->draw($pdf, self::LINE);
            $pdf->SetLineWidth(0.2);
            $pdf->Line(self::M, $y + $rowH, self::M + self::W, $y + $rowH);

            $x = self::M;
            $pdf->SetFont('Helvetica', 'B', 8);
            $this->text($pdf, self::SLATE);
            $pdf->Text($x + 1.8, $y + 4.2, (string) ($n + 1));
            $x += self::COLS[0][1];
            $pdf->SetFont('Helvetica', 'B', 7.8);
            $this->text($pdf, self::INK);
            foreach ($name as $i => $line) {
                $pdf->Text($x + 1.5, $y + 4.2 + $i * 3.4, $line);
            }
            $x += self::COLS[1][1];
            $pdf->SetFont('Helvetica', '', 7.6);
            $pdf->Text($x + 1.5, $y + 4.2, PrescriptionPdf::enc(match ($item->getKind()) {
                'lab'     => 'Laboratory',
                'imaging' => 'Imaging',
                default   => 'Physiological',
            }));
            $x += self::COLS[2][1];
            foreach ($detailLines as $i => $line) {
                $pdf->Text($x + 1.5, $y + 4.2 + $i * 3.4, $line);
            }
            $x += self::COLS[3][1];
            $pdf->Text($x + 1.5, $y + 4.2, $item->getKind() === 'imaging' ? ($item->isContrastPossible() ? 'Yes' : 'No') : '-');
            $y += $rowH;
        }

        return $y + 3;
    }

    private function tableHeader(PrescriptionPdf $pdf, float $y): float
    {
        $this->fill($pdf, self::BLUE);
        $pdf->Rect(self::M, $y, self::W, 5.6, 'F');
        $pdf->SetFont('Helvetica', 'B', 7);
        $pdf->SetTextColor(255, 255, 255);
        $x = self::M;
        foreach (self::COLS as [$label, $w]) {
            $pdf->Text($x + 1.5, $y + 3.8, PrescriptionPdf::enc($label));
            $x += $w;
        }

        return $y + 5.6;
    }

    private function safety(PrescriptionPdf $pdf, LabRequest $r, float $y): float
    {
        $safety = $r->getImagingSafety();
        if ($safety === null) {
            return $y;
        }
        $y = $this->ensure($pdf, $r, $y, 26);
        $y = $this->sectionTitle($pdf, 'Imaging safety', $y);
        $pregnant = ['yes' => 'Yes', 'no' => 'No', 'na' => 'Not asked'][$safety['pregnant'] ?? 'na'] ?? 'Not asked';
        $pdf->SetFont('Helvetica', '', 8.4);
        $this->text($pdf, self::INK);
        $pdf->Text(self::M, $y + 1.2, PrescriptionPdf::enc(sprintf(
            'Contrast allergy: %s  ·  Mobility: %s  ·  Pregnant: %s',
            LabRequestRules::CONTRAST_ALLERGY[$safety['contrast_allergy'] ?? ''] ?? '-',
            LabRequestRules::MOBILITY[$safety['mobility'] ?? ''] ?? '-',
            $pregnant,
        )));
        $y += 5;

        $items    = $r->getItems();
        $warnings = [];
        if (LabRequestRules::pregnancyWarning(($r->getClinicalFlags()['pregnant'] ?? null) === true, $items)) {
            $warnings[] = 'Pregnant patient: check this study is safe in pregnancy before sending.';
        }
        $contrastStudy = array_filter($items, static fn ($i): bool => $i->getKind() === 'imaging' && $i->isContrastPossible()) !== [];
        if (($safety['contrast_allergy'] ?? null) === 'yes' && $contrastStudy) {
            $warnings[] = 'Contrast allergy reported. Check before any contrast study.';
        }
        $pdf->SetFont('Helvetica', 'B', 8.2);
        $this->text($pdf, self::ALERT);
        foreach ($warnings as $w) {
            $pdf->Text(self::M, $y + 1.2, PrescriptionPdf::enc($w));
            $y += 4.2;
        }
        $pdf->SetFont('Helvetica', 'I', 7.6);
        $this->text($pdf, self::SLATE);
        $pdf->Text(self::M, $y + 1.2, 'MRI safety and kidney function for contrast are checked by the imaging centre.');

        return $y + 6;
    }

    private function preparation(PrescriptionPdf $pdf, LabRequest $r, float $y): float
    {
        $rows = array_values(array_filter(
            LabRequestRules::patientInstructions($r, $this->catalogue),
            static fn (array $i): bool => $i['key'] !== 'bring',
        ));
        if ($rows === []) {
            return $y;
        }
        $y = $this->ensure($pdf, $r, $y, 14);
        $y = $this->sectionTitle($pdf, 'Patient preparation', $y);
        foreach ($rows as $row) {
            $pdf->SetFont('Helvetica', '', 8.2);
            $lines = $pdf->wrap($row['text'], self::W - 42, 3);
            $y     = $this->ensure($pdf, $r, $y, count($lines) * 3.6 + 1.4);
            $pdf->SetFont('Helvetica', 'B', 7.6);
            $this->text($pdf, self::SLATE);
            $pdf->Text(self::M, $y + 1.2, PrescriptionPdf::enc($row['title']));
            $pdf->SetFont('Helvetica', '', 8.2);
            $this->text($pdf, self::INK);
            foreach ($lines as $n => $line) {
                $pdf->Text(self::M + 40, $y + 1.2 + $n * 3.6, $line);
            }
            $y += max(1, count($lines)) * 3.6 + 1.4;
        }

        return $y + 2;
    }

    private function signature(PrescriptionPdf $pdf, LabRequest $r, ?string $sigFile, float $y): void
    {
        $h = 31.0;
        $y = $this->ensure($pdf, $r, $y + 2, $h);
        $w = self::W - 64;
        $this->draw($pdf, self::LINE);
        $pdf->SetLineWidth(0.3);
        $pdf->roundedRect(self::M, $y, $w, $h, 2);
        $pdf->SetFont('Helvetica', 'B', 7.4);
        $this->text($pdf, self::SLATE);
        $pdf->Text(self::M + 3, $y + 4.4, "REQUESTING DOCTOR'S SIGNATURE");
        if ($sigFile !== null) {
            try {
                [$iw, $ih] = (array) getimagesize($sigFile);
                $scale = min(40.0 / max(1, (int) $iw), 13.0 / max(1, (int) $ih));
                $pdf->Image($sigFile, self::M + 4, $y + 6.0 + (13.0 - $ih * $scale) / 2, $iw * $scale, $ih * $scale, 'PNG');
            } catch (\Throwable) {
                // An unreadable image never blocks the document; the e-sign line below still prints.
            }
        }
        $this->draw($pdf, self::SLATE);
        $pdf->SetLineWidth(0.25);
        $pdf->Line(self::M + 4, $y + 19.8, self::M + $w - 4, $y + 19.8);
        $name = trim((string) ($r->getPrescriber()['name'] ?? ''));
        $pdf->SetFont('Helvetica', 'B', 8.2);
        $this->text($pdf, self::INK);
        $pdf->Text(self::M + 4, $y + 23.4, PrescriptionPdf::enc(str_starts_with($name, 'Dr') ? $name : 'Dr. ' . $name));
        $pdf->SetFont('Helvetica', '', 7.2);
        $this->text($pdf, self::SLATE);
        $pdf->Text(self::M + 4, $y + 26.6, 'I confirm these tests are clinically indicated.');
        $pdf->Text(self::M + 4, $y + 29.6, PrescriptionPdf::enc('Signed electronically on ' . TimeZones::stamp($r->getSignedAt(), $this->tz)));

        // For laboratory use only (left empty).
        $px = self::M + $w + 4;
        $pw = 60.0;
        $this->draw($pdf, self::SLATE);
        $pdf->SetLineWidth(0.3);
        $pdf->setDash(1.2, 0.9);
        $pdf->roundedRect($px, $y, $pw, 28, 2);
        $pdf->setDash();
        $pdf->SetFont('Helvetica', 'B', 7.4);
        $this->text($pdf, self::SLATE);
        $pdf->Text($px + 3, $y + 4.4, 'FOR LABORATORY USE ONLY');
        $pdf->SetFont('Helvetica', '', 7);
        foreach (['Received by', 'Date', 'Sample ID'] as $n => $label) {
            $ly = $y + 10.4 + $n * 6.4;
            $pdf->Text($px + 3, $ly, $label);
            $this->draw($pdf, self::LINE);
            $pdf->Line($px + 22, $ly + 0.6, $px + $pw - 3, $ly + 0.6);
        }
    }

    private function finishPage(PrescriptionPdf $pdf, LabRequest $r): void
    {
        $y = 297 - self::M - 8.0;
        $this->draw($pdf, self::LINE);
        $pdf->SetLineWidth(0.3);
        $pdf->Line(self::M, $y, self::M + self::W, $y);
        $pdf->SetFont('Helvetica', 'B', 7.2);
        $this->text($pdf, self::INK);
        // The calendar date as stored — identical in the app, the emails and the doctor portal.
        $pdf->Text(self::M, $y + 3.6, PrescriptionPdf::enc(sprintf(
            'Page %d of {nb} · %s · Valid until %s · Issued through VideoMed',
            $pdf->PageNo(),
            $r->getNumber(),
            LabRequestRules::dateLabel($r->getValidUntil()),
        )));
        if ($this->clinicContact !== '') {
            $pdf->SetFont('Helvetica', '', 6.8);
            $this->text($pdf, self::SLATE);
            $pdf->Text(self::M, $y + 7, PrescriptionPdf::enc('Questions about this request: ' . $this->clinicContact));
        }
        if ($this->watermark !== null) {
            $this->drawWatermark($pdf, $this->watermark);
        }
    }

    /** Start a new page when `$h` mm don't fit below `$y`; returns where to draw. */
    private function ensure(PrescriptionPdf $pdf, LabRequest $r, float $y, float $h): float
    {
        if ($y + $h <= self::BOTTOM) {
            return $y;
        }
        $this->finishPage($pdf, $r);
        $pdf->AddPage();

        return $this->header($pdf, $r, false);
    }

    private function drawWatermark(PrescriptionPdf $pdf, string $label): void
    {
        $size = strlen($label) > 10 ? 54 : 86;
        $pdf->SetFont('Helvetica', 'B', $size);
        $this->draw($pdf, self::ALERT);
        $pdf->SetLineWidth(1.0);
        $w     = $pdf->GetStringWidth($label);
        $angle = 35.0;
        $cx    = 105 - cos(deg2rad($angle)) * $w / 2;
        $cy    = 160 + sin(deg2rad($angle)) * $w / 2;
        $pdf->rotatedOutlineText($cx, $cy, $label, $angle);
    }

    // ----- helpers -----

    /** @param list<array{0:string,1:string}> $rows */
    private function box(PrescriptionPdf $pdf, float $x, float $y, float $w, float $h, string $title, array $rows): void
    {
        $this->draw($pdf, self::LINE);
        $pdf->SetLineWidth(0.3);
        $pdf->roundedRect($x, $y, $w, $h, 2);
        $pdf->SetFont('Helvetica', 'B', 7.4);
        $this->text($pdf, self::BLUE);
        $pdf->Text($x + 3, $y + 4.4, PrescriptionPdf::enc(strtoupper($title)));
        foreach ($rows as $n => [$label, $value]) {
            $ly = $y + 8.8 + $n * 3.9;
            $pdf->SetFont('Helvetica', '', 7.2);
            $this->text($pdf, self::SLATE);
            $pdf->Text($x + 3, $ly, PrescriptionPdf::enc($label));
            $pdf->SetFont('Helvetica', 'B', 7.8);
            $this->text($pdf, self::INK);
            $line = $pdf->wrap($value, $w - 34, 1);
            $pdf->Text($x + 31, $ly, $line[0] ?? '-');
        }
    }

    private function sectionTitle(PrescriptionPdf $pdf, string $title, float $y): float
    {
        $pdf->SetFont('Helvetica', 'B', 9);
        $this->text($pdf, self::BLUE);
        $pdf->Text(self::M, $y + 3.2, PrescriptionPdf::enc($title));
        $this->draw($pdf, self::LINE);
        $pdf->SetLineWidth(0.25);
        $tw = $pdf->GetStringWidth(PrescriptionPdf::enc($title));
        $pdf->Line(self::M + $tw + 3, $y + 2.2, self::M + self::W, $y + 2.2);

        return $y + 6.4;
    }

    private function rightText(PrescriptionPdf $pdf, float $right, float $y, string $text): void
    {
        $text = PrescriptionPdf::enc($text);
        $pdf->Text($right - $pdf->GetStringWidth($text), $y, $text);
    }

    /** @param array{0:int,1:int,2:int} $rgb */
    private function text(PrescriptionPdf $pdf, array $rgb): void
    {
        $pdf->SetTextColor($rgb[0], $rgb[1], $rgb[2]);
    }

    /** @param array{0:int,1:int,2:int} $rgb */
    private function draw(PrescriptionPdf $pdf, array $rgb): void
    {
        $pdf->SetDrawColor($rgb[0], $rgb[1], $rgb[2]);
    }

    /** @param array{0:int,1:int,2:int} $rgb */
    private function fill(PrescriptionPdf $pdf, array $rgb): void
    {
        $pdf->SetFillColor($rgb[0], $rgb[1], $rgb[2]);
    }

    /** FPDF embeds images from files; write the signature to a private temp file. */
    private function signatureFile(?string $png): ?string
    {
        if ($png === null || $png === '') {
            return null;
        }
        $path = tempnam(sys_get_temp_dir(), 'labsig');
        if ($path === false) {
            return null;
        }
        file_put_contents($path, $png);

        return $path;
    }

    /** Kept for symmetry with the prescription renderer: a calendar date, never shifted. */
    public static function day(DateTimeImmutable $d): string
    {
        return LabRequestRules::dateLabel($d);
    }
}
