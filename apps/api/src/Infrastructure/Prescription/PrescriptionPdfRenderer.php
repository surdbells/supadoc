<?php

declare(strict_types=1);

namespace App\Infrastructure\Prescription;

use App\Domain\Entity\Prescription;
use DateTimeImmutable;
use DateTimeZone;

/**
 * Renders a prescription as the branded GVM-F-RX-01 PDF (A4, well under 1 MB):
 * header with the VideoMed mark and the prescription number, patient and
 * prescriber details, the ten health-reading boxes, reason / illness code /
 * current medicines, five numbered medicine rows per page (an extra page,
 * "Page 2 of 2", for medicines 6-10), advice and follow-up, the signature, an
 * empty "For pharmacy use only" box sized for a standard 40x25 mm stamp, and the
 * check-page address. A status watermark (DRAFT / EXPIRED / CANCELLED) can be
 * stamped across every page without touching the stored prescription.
 */
final class PrescriptionPdfRenderer
{
    private const M  = 12.0;     // page margin (mm)
    private const W  = 186.0;    // content width (A4 210 - 2 x 12)

    private const BLUE  = [21, 101, 192];
    private const TEAL  = [0, 137, 123];
    private const INK   = [28, 43, 58];
    private const SLATE = [84, 110, 122];
    private const LINE  = [207, 216, 220];
    private const TINT  = [241, 249, 255];
    private const ALERT = [229, 57, 53];

    private DateTimeZone $tz;

    public function __construct(
        private readonly string $clinicName = 'VideoMed',
        private readonly string $clinicTagline = 'Telehealth Consultations',
        private readonly string $clinicContact = '',
        string $timezone = 'Africa/Lagos',
    ) {
        try {
            $this->tz = new DateTimeZone($timezone !== '' ? $timezone : 'Africa/Lagos');
        } catch (\Throwable) {
            $this->tz = new DateTimeZone('Africa/Lagos');
        }
    }

    /**
     * @param array<string,string> $patient    name, date_of_birth, age, sex, reference
     * @param array<string,string> $prescriber name, specialty, qualifications, mdcn_number
     * @param ?string $signaturePng flat PNG bytes, or null
     * @param ?string $watermark    DRAFT | EXPIRED | CANCELLED | null
     */
    public function render(
        Prescription $rx,
        array $patient,
        array $prescriber,
        ?string $signaturePng,
        string $verifyUrl,
        ?string $watermark = null,
    ): string {
        $pdf = new PrescriptionPdf('P', 'mm', 'A4');
        $pdf->SetAutoPageBreak(false);
        $pdf->SetMargins(self::M, self::M, self::M);
        $pdf->SetTitle(PrescriptionPdf::enc('Prescription ' . $rx->getNumber()));
        $pdf->SetAuthor(PrescriptionPdf::enc($this->clinicName));
        $pdf->SetSubject('Prescription (form GVM-F-RX-01)');
        $pdf->SetCreator(PrescriptionPdf::enc($this->clinicName . ' e-prescribing'));

        $items = $rx->getItems();
        $pages = max(1, (int) ceil(count($items) / Prescription::ROWS_PER_PAGE));
        $sigFile = $this->signatureFile($signaturePng);

        try {
            for ($page = 1; $page <= $pages; ++$page) {
                $pdf->AddPage();
                $y = $this->header($pdf, $rx, $page, $pages);
                $y = $this->metaStrip($pdf, $rx, $y);
                $y = $this->parties($pdf, $rx, $patient, $prescriber, $y);
                if ($page === 1) {
                    $y = $this->readings($pdf, $rx, $y);
                    $y = $this->consultation($pdf, $rx, $y);
                }
                $rows = array_slice($items, ($page - 1) * Prescription::ROWS_PER_PAGE, Prescription::ROWS_PER_PAGE);
                $y    = $this->medicines($pdf, $rows, ($page - 1) * Prescription::ROWS_PER_PAGE, $y, $page > 1);
                if ($page === 1) {
                    $y = $this->advice($pdf, $rx, $y);
                }
                // Anchored above the footer; page 1 content is capped so it never reaches it.
                $this->signatureAndPharmacy($pdf, $rx, $prescriber, $sigFile, max(min($y + 2, 241.0), 232.0));
                $this->footer($pdf, $rx, $verifyUrl, $page, $pages);
                if ($watermark !== null && $watermark !== '') {
                    $this->watermark($pdf, $watermark);
                }
            }

            return $pdf->Output('S');
        } finally {
            if ($sigFile !== null) {
                @unlink($sigFile);
            }
        }
    }

    // ----- sections -----

    private function header(PrescriptionPdf $pdf, Prescription $rx, int $page, int $pages): float
    {
        $x = self::M;
        $y = self::M;
        // The VideoMed mark: a blue rounded square with a white cross.
        $this->fill($pdf, self::BLUE);
        $pdf->roundedRect($x, $y, 13, 13, 3.2, 'F');
        $pdf->SetDrawColor(252, 252, 252);
        $pdf->SetLineWidth(1.4);
        $pdf->Line($x + 6.5, $y + 3.4, $x + 6.5, $y + 9.6);
        $pdf->Line($x + 3.4, $y + 6.5, $x + 9.6, $y + 6.5);

        $name = $this->clinicName;
        $pdf->SetFont('Helvetica', 'B', 17);
        if (strcasecmp($name, 'VideoMed') === 0) {
            $this->text($pdf, self::BLUE);
            $pdf->Text($x + 16, $y + 7.2, 'Video');
            $this->text($pdf, self::TEAL);
            $pdf->Text($x + 16 + $pdf->GetStringWidth('Video'), $y + 7.2, 'Med');
        } else {
            $this->text($pdf, self::BLUE);
            $pdf->Text($x + 16, $y + 7.2, PrescriptionPdf::enc($name));
        }
        $pdf->SetFont('Helvetica', '', 8);
        $this->text($pdf, self::SLATE);
        $pdf->Text($x + 16, $y + 11.4, PrescriptionPdf::enc($this->clinicTagline));
        if ($this->clinicContact !== '') {
            $pdf->Text($x + 16, $y + 15.2, PrescriptionPdf::enc($this->clinicContact));
        }

        // Right block: title, form code, number, page.
        $right = self::M + self::W;
        $pdf->SetFont('Helvetica', 'B', 15);
        $this->text($pdf, self::BLUE);
        $this->rightText($pdf, $right, $y + 5, 'PRESCRIPTION');
        $pdf->SetFont('Helvetica', '', 7.5);
        $this->text($pdf, self::SLATE);
        $this->rightText($pdf, $right, $y + 9.2, 'Form GVM-F-RX-01');
        $pdf->SetFont('Helvetica', 'B', 11);
        $this->text($pdf, self::INK);
        $this->rightText($pdf, $right, $y + 14.6, $rx->getNumber());
        $pdf->SetFont('Helvetica', '', 8);
        $this->text($pdf, self::SLATE);
        $this->rightText($pdf, $right, $y + 18.6, sprintf('Page %d of %d', $page, $pages));

        $this->draw($pdf, self::BLUE);
        $pdf->SetLineWidth(0.8);
        $pdf->Line(self::M, $y + 21.5, $right, $y + 21.5);

        return $y + 24.5;
    }

    private function metaStrip(PrescriptionPdf $pdf, Prescription $rx, float $y): float
    {
        $sent  = $rx->getSentAt();
        $cells = [
            ['Date sent', $sent !== null ? $this->date($sent) : 'Not sent yet'],
            ['Valid until', $rx->getValidUntil() !== null ? $this->day($rx->getValidUntil()) : '-'],
            ['Repeats allowed', $rx->allowsRepeats() ? 'Yes' : 'No'],
            ['Consultation', $rx->getAppointmentId() !== null ? 'Video consultation' : 'Outside a consultation'],
        ];
        $w = self::W / count($cells);
        $this->fill($pdf, self::TINT);
        $pdf->roundedRect(self::M, $y, self::W, 10.5, 2, 'F');
        foreach ($cells as $i => [$label, $value]) {
            $x = self::M + $i * $w + 3;
            $pdf->SetFont('Helvetica', '', 6.8);
            $this->text($pdf, self::SLATE);
            $pdf->Text($x, $y + 3.9, PrescriptionPdf::enc(strtoupper($label)));
            $pdf->SetFont('Helvetica', 'B', 9);
            $this->text($pdf, self::INK);
            $pdf->Text($x, $y + 8.3, PrescriptionPdf::enc($value));
        }

        return $y + 13.5;
    }

    /**
     * @param array<string,string> $patient
     * @param array<string,string> $prescriber
     */
    private function parties(PrescriptionPdf $pdf, Prescription $rx, array $patient, array $prescriber, float $y): float
    {
        $colW = (self::W - 4) / 2;
        $pregnancy = PrescriptionForm::PREGNANCY[$rx->getPregnancyStatus() ?? ''] ?? 'Not answered';
        $dob = trim((string) ($patient['date_of_birth'] ?? ''));
        $age = trim((string) ($patient['age'] ?? ''));
        $this->box($pdf, self::M, $y, $colW, 26, 'Patient', [
            ['Name', (string) ($patient['name'] ?? '-')],
            ['Date of birth', $dob !== '' ? $dob . ($age !== '' ? "  ({$age} yrs)" : '') : '-'],
            ['Sex', (string) (($patient['sex'] ?? '') !== '' ? $patient['sex'] : '-')],
            ['Pregnant / breastfeeding', $pregnancy],
            ['Patient ref.', (string) ($patient['reference'] ?? '-')],
        ]);
        $this->box($pdf, self::M + $colW + 4, $y, $colW, 26, 'Prescriber', [
            ['Name', (string) ($prescriber['name'] ?? '-')],
            ['Specialty', (string) (($prescriber['specialty'] ?? '') !== '' ? $prescriber['specialty'] : '-')],
            ['Qualifications', (string) (($prescriber['qualifications'] ?? '') !== '' ? $prescriber['qualifications'] : '-')],
            ['MDCN number', (string) (($prescriber['mdcn_number'] ?? '') !== '' ? $prescriber['mdcn_number'] : 'Not provided')],
        ]);

        return $y + 29;
    }

    private function readings(PrescriptionPdf $pdf, Prescription $rx, float $y): float
    {
        $y = $this->sectionTitle($pdf, 'Health readings', $y);
        $readings = $rx->getReadings();
        $cols = 5;
        $gap  = 2;
        $bw   = (self::W - ($cols - 1) * $gap) / $cols;
        $bh   = 9.6;
        $i = 0;
        foreach (PrescriptionForm::READINGS as $key => [$label, $unit]) {
            $bx = self::M + ($i % $cols) * ($bw + $gap);
            $by = $y + intdiv($i, $cols) * ($bh + $gap);
            $this->draw($pdf, self::LINE);
            $pdf->SetLineWidth(0.25);
            $pdf->roundedRect($bx, $by, $bw, $bh, 1.6);
            $pdf->SetFont('Helvetica', '', 6.6);
            $this->text($pdf, self::SLATE);
            $pdf->Text($bx + 2, $by + 3.3, PrescriptionPdf::enc($label . ' (' . $unit . ')'));
            $value = (string) ($readings[$key] ?? '');
            if ($value !== '') {
                $pdf->SetFont('Helvetica', 'B', 9.5);
                $this->text($pdf, self::INK);
                $pdf->Text($bx + 2, $by + 7.9, PrescriptionPdf::enc($value));
            }
            ++$i;
        }
        $y += 2 * $bh + $gap + 3.6;
        $source = PrescriptionForm::READING_SOURCES[$readings['source'] ?? ''] ?? '';
        $taken  = '';
        if (($readings['taken_at'] ?? '') !== '') {
            try {
                $taken = $this->dateTime(new DateTimeImmutable($readings['taken_at']));
            } catch (\Throwable) {
                $taken = '';
            }
        }
        $pdf->SetFont('Helvetica', '', 7.6);
        $this->text($pdf, self::SLATE);
        $pdf->Text(self::M, $y, PrescriptionPdf::enc('Where the readings came from: ' . ($source !== '' ? $source : '________________')
            . '      Time taken: ' . ($taken !== '' ? $taken : '________________')));

        return $y + 3.4;
    }

    private function consultation(PrescriptionPdf $pdf, Prescription $rx, float $y): float
    {
        $y = $this->sectionTitle($pdf, 'Consultation', $y);
        $pdf->SetFont('Helvetica', 'B', 7.6);
        $this->text($pdf, self::SLATE);
        $pdf->Text(self::M, $y + 1.2, 'Reason for the prescription');
        $pdf->SetFont('Helvetica', '', 8.6);
        $this->text($pdf, self::INK);
        $lines = $pdf->wrap((string) $rx->getReason(), self::W - 44, 2);
        foreach ($lines === [] ? ['-'] : $lines as $n => $line) {
            $pdf->Text(self::M + 42, $y + 1.2 + $n * 3.9, $line);
        }
        $y += max(1, count($lines)) * 3.9 + 1.6;

        $pdf->SetFont('Helvetica', 'B', 7.6);
        $this->text($pdf, self::SLATE);
        $pdf->Text(self::M, $y + 1.2, 'Illness code (ICD)');
        $pdf->SetFont('Helvetica', '', 8.6);
        $this->text($pdf, self::INK);
        $pdf->Text(self::M + 42, $y + 1.2, PrescriptionPdf::enc($rx->getIcdCode() ?? '-'));
        $y += 4.6;

        $pdf->SetFont('Helvetica', 'B', 7.6);
        $this->text($pdf, self::SLATE);
        $pdf->Text(self::M, $y + 1.2, 'Medicines already taken');
        $pdf->SetFont('Helvetica', '', 8.6);
        $this->text($pdf, self::INK);
        $current = $pdf->wrap((string) ($rx->getCurrentMedications() ?? 'None recorded'), self::W - 44, 1);
        $pdf->Text(self::M + 42, $y + 1.2, $current[0] ?? '-');

        return $y + 4.8;
    }

    /** @param list<array<string,mixed>> $rows */
    private function medicines(PrescriptionPdf $pdf, array $rows, int $offset, float $y, bool $continued): float
    {
        $y = $this->sectionTitle($pdf, $continued ? 'Medicines (continued)' : 'Medicines', $y);
        $pdf->SetFont('Helvetica', 'I', 7.2);
        $this->text($pdf, self::SLATE);
        $pdf->Text(self::M, $y + 0.6, PrescriptionPdf::enc(
            'Common (generic) medicine names are used. "No substitute" ticked means the pharmacy must give exactly that brand.',
        ));
        $y += 2.4;

        // # | medicine | dose | route | how often | how long | qty | repeats | no sub
        $cols = [['#', 7], ['Medicine name and strength', 63], ['Dose', 20], ['Route', 17], ['How often', 25], ['How long', 18], ['Qty', 14], ['Repeats', 11], ['No sub.', 11]];
        $this->fill($pdf, self::BLUE);
        $pdf->Rect(self::M, $y, self::W, 5.6, 'F');
        $pdf->SetFont('Helvetica', 'B', 7);
        $pdf->SetTextColor(255, 255, 255);
        $x = self::M;
        foreach ($cols as [$label, $w]) {
            $pdf->Text($x + 1.5, $y + 3.8, PrescriptionPdf::enc($label));
            $x += $w;
        }
        $y += 5.6;

        $rowH = 11.4;
        for ($i = 0; $i < Prescription::ROWS_PER_PAGE; ++$i) {
            $row = $rows[$i] ?? null;
            $ry  = $y + $i * $rowH;
            if ($i % 2 === 1) {
                $this->fill($pdf, [248, 251, 253]);
                $pdf->Rect(self::M, $ry, self::W, $rowH, 'F');
            }
            $this->draw($pdf, self::LINE);
            $pdf->SetLineWidth(0.2);
            $pdf->Line(self::M, $ry + $rowH, self::M + self::W, $ry + $rowH);

            $x = self::M;
            $pdf->SetFont('Helvetica', 'B', 8);
            $this->text($pdf, self::SLATE);
            $pdf->Text($x + 1.8, $ry + 4.2, (string) ($offset + $i + 1));
            if ($row === null) {
                continue;
            }
            $x += $cols[0][1];
            $pdf->SetFont('Helvetica', 'B', 7.8);
            $this->text($pdf, self::INK);
            $name = $pdf->wrap((string) ($row['name'] ?? ''), $cols[1][1] - 2.5, 2);
            foreach ($name as $n => $line) {
                $pdf->Text($x + 1.5, $ry + 3.7 + $n * 3.2, $line);
            }
            $pdf->SetFont('Helvetica', '', 7.6);
            $x += $cols[1][1];
            foreach ([['dose', 2], ['route', 3], ['frequency', 4], ['duration', 5], ['quantity', 6]] as [$field, $c]) {
                $text = $pdf->wrap((string) ($row[$field] ?? ''), $cols[$c][1] - 2.5, 2);
                foreach ($text as $n => $line) {
                    $pdf->Text($x + 1.5, $ry + 3.7 + $n * 3.2, $line);
                }
                $x += $cols[$c][1];
            }
            $pdf->Text($x + 3.5, $ry + 3.7, (string) (int) ($row['repeats'] ?? 0));
            $x += $cols[7][1];
            // "No substitute" tick box.
            $this->draw($pdf, self::SLATE);
            $pdf->SetLineWidth(0.3);
            $pdf->Rect($x + 3.2, $ry + 1.4, 3.4, 3.4);
            if (!empty($row['no_substitute'])) {
                $pdf->SetLineWidth(0.5);
                $this->draw($pdf, self::BLUE);
                $pdf->Line($x + 3.8, $ry + 3.2, $x + 4.6, $ry + 4.2);
                $pdf->Line($x + 4.6, $ry + 4.2, $x + 6.2, $ry + 1.9);
            }
            // Instructions line underneath.
            $instr = trim((string) ($row['instructions'] ?? ''));
            $pdf->SetFont('Helvetica', 'I', 7.2);
            $this->text($pdf, self::SLATE);
            $line = $pdf->wrap('Instructions: ' . ($instr !== '' ? $instr : '-'), self::W - $cols[0][1] - 3, 1);
            $pdf->Text(self::M + $cols[0][1] + 1.5, $ry + 10.2, $line[0] ?? '');
        }

        return $y + Prescription::ROWS_PER_PAGE * $rowH + 2.4;
    }

    private function advice(PrescriptionPdf $pdf, Prescription $rx, float $y): float
    {
        $y = $this->sectionTitle($pdf, 'Advice and follow-up', $y);
        $pdf->SetFont('Helvetica', 'B', 7.6);
        $this->text($pdf, self::SLATE);
        $pdf->Text(self::M, $y + 1.2, 'Advice to the patient');
        $pdf->SetFont('Helvetica', '', 8.4);
        $this->text($pdf, self::INK);
        $lines = $pdf->wrap((string) ($rx->getAdvice() ?? ''), self::W - 44, 2);
        foreach ($lines === [] ? ['-'] : $lines as $n => $line) {
            $pdf->Text(self::M + 42, $y + 1.2 + $n * 3.8, $line);
        }
        $y += max(1, count($lines)) * 3.8 + 1.4;

        $pdf->SetFont('Helvetica', 'B', 7.6);
        $this->text($pdf, self::SLATE);
        $pdf->Text(self::M, $y + 1.2, 'Follow-up date');
        $pdf->SetFont('Helvetica', '', 8.4);
        $this->text($pdf, self::INK);
        $follow = $rx->getFollowUpDate();
        $pdf->Text(self::M + 42, $y + 1.2, PrescriptionPdf::enc($follow !== null ? $this->day($follow) : '____________'));
        $bx = self::M + 80;
        foreach (['video' => 'Video', 'in_person' => 'In person'] as $mode => $label) {
            $this->draw($pdf, self::SLATE);
            $pdf->SetLineWidth(0.3);
            $pdf->Rect($bx, $y - 1.6, 3.2, 3.2);
            if ($rx->getFollowUpMode() === $mode) {
                $this->draw($pdf, self::BLUE);
                $pdf->SetLineWidth(0.5);
                $pdf->Line($bx + 0.6, $y + 0.1, $bx + 1.4, $y + 1.0);
                $pdf->Line($bx + 1.4, $y + 1.0, $bx + 2.8, $y - 1.1);
            }
            $pdf->Text($bx + 4.6, $y + 1.2, $label);
            $bx += 26;
        }
        $y += 4.8;

        $pdf->SetFont('Helvetica', 'B', 7.6);
        $this->text($pdf, self::SLATE);
        $pdf->Text(self::M, $y + 1.2, 'Tests or referrals');
        $pdf->SetFont('Helvetica', '', 8.4);
        $this->text($pdf, self::INK);
        $tests = $pdf->wrap((string) ($rx->getTestsReferrals() ?? ''), self::W - 44, 1);
        foreach ($tests === [] ? ['-'] : $tests as $n => $line) {
            $pdf->Text(self::M + 42, $y + 1.2 + $n * 3.8, $line);
        }

        return $y + max(1, count($tests)) * 3.8 + 1.2;
    }

    /** @param array<string,string> $prescriber */
    private function signatureAndPharmacy(PrescriptionPdf $pdf, Prescription $rx, array $prescriber, ?string $sigFile, float $y): void
    {
        $h = 31.0;
        // Prescriber signature.
        $w = 90.0;
        $this->draw($pdf, self::LINE);
        $pdf->SetLineWidth(0.3);
        $pdf->roundedRect(self::M, $y, $w, $h, 2);
        $pdf->SetFont('Helvetica', 'B', 7.4);
        $this->text($pdf, self::SLATE);
        $pdf->Text(self::M + 3, $y + 4.4, "PRESCRIBER'S SIGNATURE");
        if ($sigFile !== null) {
            try {
                [$iw, $ih] = (array) getimagesize($sigFile);
                $maxW = 58.0;
                $maxH = 14.0;
                $scale = min($maxW / max(1, (int) $iw), $maxH / max(1, (int) $ih));
                $pdf->Image($sigFile, self::M + 4, $y + 6.2 + ($maxH - $ih * $scale) / 2, $iw * $scale, $ih * $scale, 'PNG');
            } catch (\Throwable) {
                // An unreadable image never blocks the document; the e-sign line below still prints.
            }
        }
        $this->draw($pdf, self::SLATE);
        $pdf->SetLineWidth(0.25);
        $pdf->Line(self::M + 4, $y + 20.6, self::M + $w - 4, $y + 20.6);
        $pdf->SetFont('Helvetica', 'B', 8.2);
        $this->text($pdf, self::INK);
        $mdcn = trim((string) ($prescriber['mdcn_number'] ?? ''));
        $pdf->Text(self::M + 4, $y + 24.4, PrescriptionPdf::enc(($prescriber['name'] ?? 'Prescriber') . ($mdcn !== '' ? '  -  MDCN ' . $mdcn : '')));
        $pdf->SetFont('Helvetica', '', 7);
        $this->text($pdf, self::SLATE);
        $signed = $rx->getSignedAt();
        $pdf->Text(self::M + 4, $y + 28.2, PrescriptionPdf::enc($signed !== null
            ? 'Signed electronically on ' . $this->dateTime($signed)
            : 'Not yet signed - draft for review only'));

        // For pharmacy use only (left empty; stamp area ~40 x 25 mm).
        $px = self::M + $w + 4;
        $pw = self::W - $w - 4;
        $this->draw($pdf, self::SLATE);
        $pdf->SetLineWidth(0.3);
        $pdf->setDash(1.2, 0.9);
        $pdf->roundedRect($px, $y, $pw, $h, 2);
        $pdf->setDash();
        $pdf->SetFont('Helvetica', 'B', 7.4);
        $this->text($pdf, self::SLATE);
        $pdf->Text($px + 3, $y + 4.4, 'FOR PHARMACY USE ONLY');
        $pdf->SetFont('Helvetica', '', 7);
        $lineW = $pw - 46;
        foreach (["Pharmacist's name", 'Pharmacy council no.', 'Date'] as $n => $label) {
            $ly = $y + 10.6 + $n * 7.2;
            $pdf->Text($px + 3, $ly - 1.2, PrescriptionPdf::enc($label));
            $this->draw($pdf, self::LINE);
            $pdf->Line($px + 3, $ly + 2.6, $px + 3 + $lineW, $ly + 2.6);
        }
        $sx = $px + $pw - 43;
        $this->draw($pdf, self::LINE);
        $pdf->setDash(0.8, 0.8);
        $pdf->Rect($sx, $y + 4.0, 40, 25);
        $pdf->setDash();
        $pdf->SetFont('Helvetica', '', 6.6);
        $this->text($pdf, self::LINE);
        $pdf->Text($sx + 15.5, $y + 17.2, 'Stamp');
    }

    private function footer(PrescriptionPdf $pdf, Prescription $rx, string $verifyUrl, int $page, int $pages): void
    {
        $y = 297 - self::M - 10.6;
        $this->draw($pdf, self::LINE);
        $pdf->SetLineWidth(0.3);
        $pdf->Line(self::M, $y, self::M + self::W, $y);
        $pdf->SetFont('Helvetica', 'B', 7.4);
        $this->text($pdf, self::BLUE);
        $pdf->Text(self::M, $y + 3.6, PrescriptionPdf::enc('Check this prescription is real at ' . $verifyUrl));
        $this->text($pdf, self::INK);
        $this->rightText($pdf, self::M + self::W, $y + 3.6, sprintf('%s  -  Page %d of %d', $rx->getNumber(), $page, $pages));
        $pdf->SetFont('Helvetica', '', 6.8);
        $this->text($pdf, self::SLATE);
        $pdf->Text(self::M, $y + 7, PrescriptionPdf::enc("Enter the prescription number and the patient's date of birth. No sign-in is needed."));
        $this->rightText($pdf, self::M + self::W, $y + 7, 'Issued electronically by ' . $this->clinicName);
        $pdf->SetFont('Helvetica', '', 6);
        $pdf->Text(self::M, $y + 10.2, PrescriptionPdf::enc(
            'Medicine names from RxNorm, courtesy of the U.S. National Library of Medicine.'
            . ($this->clinicContact !== '' ? '   Questions about this prescription: ' . $this->clinicContact : ''),
        ));
    }

    private function watermark(PrescriptionPdf $pdf, string $label): void
    {
        $label = strtoupper($label);
        $pdf->SetFont('Helvetica', 'B', 86);
        $color = $label === 'DRAFT' ? [176, 190, 197] : self::ALERT;
        $this->draw($pdf, $color);
        $pdf->SetLineWidth(1.1);
        $w = $pdf->GetStringWidth($label);
        // Centre the rotated word on the page.
        $angle = 35.0;
        $cx = 105 - cos(deg2rad($angle)) * $w / 2;
        $cy = 160 + sin(deg2rad($angle)) * $w / 2;
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
            $ly = $y + 8.8 + $n * 4.1;
            $pdf->SetFont('Helvetica', '', 7.2);
            $this->text($pdf, self::SLATE);
            $pdf->Text($x + 3, $ly, PrescriptionPdf::enc($label));
            $pdf->SetFont('Helvetica', 'B', 7.8);
            $this->text($pdf, self::INK);
            $line = $pdf->wrap($value, $w - 38, 1);
            $pdf->Text($x + 35, $ly, $line[0] ?? '-');
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

    /** A calendar date (valid-until, follow-up): printed as stored, never timezone-shifted. */
    private function day(DateTimeImmutable $d): string
    {
        return $d->format('j M Y');
    }

    /** The date part of an instant (sent / signed), in the clinic's timezone. */
    private function date(DateTimeImmutable $d): string
    {
        return $d->setTimezone($this->tz)->format('j M Y');
    }

    private function dateTime(DateTimeImmutable $d): string
    {
        return $d->setTimezone($this->tz)->format('j M Y, H:i');
    }

    /** FPDF embeds images from files; write the signature to a private temp file. */
    private function signatureFile(?string $png): ?string
    {
        if ($png === null || $png === '') {
            return null;
        }
        $path = tempnam(sys_get_temp_dir(), 'rxsig');
        if ($path === false) {
            return null;
        }
        file_put_contents($path, $png);

        return $path;
    }
}
