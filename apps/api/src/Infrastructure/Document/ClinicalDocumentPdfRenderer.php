<?php

declare(strict_types=1);

namespace App\Infrastructure\Document;

use App\Domain\Settings\ClinicTime;
use App\Domain\Settings\TimeZones;
use App\Infrastructure\Prescription\PrescriptionPdf;
use DateTimeImmutable;
use DateTimeZone;

/**
 * Renders a referral letter or a medical certificate as an A4 PDF (document
 * viewer spec §5): the same letter as {@see ClinicalDocumentRenderer}'s HTML —
 * its colours, wording and order — drawn with FPDF through
 * {@see PrescriptionPdf} (core Helvetica, every value through `enc()`, so
 * cp1252 with the rest transliterated). The viewer shows it in pdf.js with a
 * text layer, so the text stays real text (never an image).
 *
 * Layout: the letterhead band (the clinic name in two colours, tagline and
 * contact; on the right the title, "Ref" and "Issued" in the issuing doctor's
 * zone; a 3 pt rule), the patient and the attending doctor, the body, the
 * signature, the closing note, and "Page n of N · Ref …" on every page. Long
 * text flows onto further pages (the statement box is split with it). Each
 * free-text field is capped at {@see MAX_FIELD} characters, so the file stays
 * far below 1 MB whatever was typed, and wrapped by {@see wrap()}, which
 * breaks an over-long unbroken run (a pasted token or URL) in O(n log n), so
 * the time stays small too.
 *
 * Pure: no I/O and no logging — the context carries PHI.
 */
final class ClinicalDocumentPdfRenderer
{
    private const M      = 14.0;    // page margins (mm)
    private const W      = 182.0;   // content width (A4 210 - 2 x 14)
    private const BOTTOM = 274.0;   // body content stops here; the page footer is below
    private const RULE   = 1.058;   // 3 pt, in mm

    private const CERULEAN  = [21, 101, 192];   // #1565c0
    private const TEAL      = [0, 137, 123];    // #00897b
    private const INK       = [28, 43, 58];     // #1c2b3a
    private const SLATE     = [84, 110, 122];   // #546e7a
    private const CLOUD     = [224, 229, 233];  // #e0e5e9
    private const PANEL     = [247, 249, 251];  // #f7f9fb, the certificate statement box
    private const URGENT_BG = [253, 236, 234];  // #fdecea
    private const URGENT    = [198, 40, 40];    // #c62828

    /** Longest free-text field printed, in characters (about five pages); longer text is shortened. */
    public const MAX_FIELD = 20000;

    /** Total pages of the render in progress (0 during the counting pass). */
    private int $total = 0;

    /** "ABCDEF12": the reference printed in the header and the footer. */
    private string $docNo = '';

    public function __construct(
        private readonly string $clinicName = 'VideoMed',
        private readonly string $clinicTagline = 'Telehealth Consultations',
        private readonly string $clinicContact = '',
    ) {
    }

    /**
     * The document as PDF bytes. `$ctx` is the context the HTML renderer gets
     * (letterhead fields, the record's own fields, `document_no`, `issued_at`,
     * `doctor_timezone`).
     *
     * @param 'referral'|'certificate' $kind
     * @param array<string,mixed> $ctx
     */
    public function render(string $kind, array $ctx): string
    {
        if (!in_array($kind, ['referral', 'certificate'], true)) {
            throw new \InvalidArgumentException("Unknown document kind: {$kind}");
        }
        // Two passes: the first counts the pages for "Page n of N" (the footer
        // sits below the body, so it never moves anything).
        $this->total = 0;
        $this->total = $this->draw($kind, $ctx)->PageNo();

        return $this->draw($kind, $ctx)->Output('S');
    }

    /**
     * "referral-2026-11-04.pdf" / "medical-certificate-2026-11-04.pdf": the
     * issue date in the issuing doctor's zone (ASCII only).
     *
     * @param 'referral'|'certificate' $kind
     * @param array<string,mixed> $ctx
     */
    public function filename(string $kind, array $ctx): string
    {
        $prefix = match ($kind) {
            'referral'    => 'referral',
            'certificate' => 'medical-certificate',
            default       => throw new \InvalidArgumentException("Unknown document kind: {$kind}"),
        };
        $issued = self::str($ctx, 'issued_at');
        try {
            $at = new DateTimeImmutable($issued !== '' ? $issued : 'now');
        } catch (\Throwable) {
            $at = new DateTimeImmutable('now');
        }

        return $prefix . '-' . $at->setTimezone($this->doctorZone($ctx))->format('Y-m-d') . '.pdf';
    }

    /** @param array<string,mixed> $ctx */
    private function draw(string $kind, array $ctx): PrescriptionPdf
    {
        $title       = $kind === 'referral' ? 'Referral letter' : (self::str($ctx, 'type_label') !== '' ? self::str($ctx, 'type_label') : 'Medical certificate');
        $this->docNo = strtoupper(substr(self::str($ctx, 'document_no'), 0, 8));

        $pdf = new PrescriptionPdf('P', 'mm', 'A4');
        $pdf->SetAutoPageBreak(false);
        $pdf->SetMargins(self::M, self::M, self::M);
        // Metadata: no patient details (viewers and file managers show it).
        $pdf->SetTitle(trim($title . ' ' . $this->docNo), true);
        $pdf->SetAuthor($this->clinicName, true);
        $pdf->SetSubject($title, true);
        $pdf->SetCreator($this->clinicName . ' clinical documents', true);

        $pdf->AddPage();
        $y = $this->header($pdf, $title, $ctx);
        $y = $this->parties($pdf, $ctx, $y);
        $y = $kind === 'referral' ? $this->referral($pdf, $ctx, $y) : $this->certificate($pdf, $title, $ctx, $y);
        $y = $this->signature($pdf, $ctx, $y);
        $this->closingNote($pdf, $y);
        $this->footer($pdf);

        return $pdf;
    }

    // ----- sections -----

    /** @param array<string,mixed> $ctx */
    private function header(PrescriptionPdf $pdf, string $title, array $ctx): float
    {
        $x     = self::M;
        $y     = self::M;
        $right = self::M + self::W;

        // Right: the title in upper case, "Ref" and "Issued" (the doctor's zone).
        $titleText = PrescriptionPdf::enc(mb_strtoupper($title, 'UTF-8'));
        $titleSize = $this->fit($pdf, 'B', 13, 9, $titleText, 96);
        $this->font($pdf, 'B', $titleSize, self::INK);
        $titleText = $this->clip($pdf, $titleText, 96);
        $pdf->Text($right - $pdf->GetStringWidth($titleText), $y + 5.6, $titleText);
        $rightW = $pdf->GetStringWidth($titleText);

        $issued = $this->humanDateTime(self::str($ctx, 'issued_at'), $this->doctorZone($ctx));
        $this->font($pdf, '', 9, self::SLATE);
        $ly = $y + 11.2;
        foreach ([$this->docNo !== '' ? 'Ref: ' . $this->docNo : '', $issued !== '' ? 'Issued: ' . $issued : ''] as $line) {
            if ($line === '') {
                continue;
            }
            $enc = PrescriptionPdf::enc($line);
            $pdf->Text($right - $pdf->GetStringWidth($enc), $ly, $enc);
            $rightW = max($rightW, $pdf->GetStringWidth($enc));
            $ly += 4.4;
        }

        // Left: the clinic name in two colours ("Video" + "Med"), tagline, contact.
        $one   = PrescriptionPdf::enc(self::wordOne($this->clinicName));
        $rest  = PrescriptionPdf::enc(self::wordRest($this->clinicName));
        $room  = self::W - $rightW - 8;
        $size  = $this->fit($pdf, 'B', 20, 12, $one . $rest, $room);
        $this->font($pdf, 'B', $size, self::CERULEAN);
        $one = $this->clip($pdf, $one, $room);
        $pdf->Text($x, $y + 7, $one);
        if ($rest !== '' && $pdf->GetStringWidth($one . $rest) <= $room) {
            $this->font($pdf, 'B', $size, self::TEAL);
            $pdf->Text($x + $pdf->GetStringWidth($one), $y + 7, $rest);
        }
        $this->font($pdf, '', 9, self::SLATE);
        $sub = $y + 12;
        foreach ([$this->clinicTagline, $this->clinicContact] as $line) {
            if (trim($line) === '') {
                continue;
            }
            $pdf->Text($x, $sub, $this->clip($pdf, PrescriptionPdf::enc($line), $room));
            $sub += 4.4;
        }

        $ruleY = max($y + 20.5, $ly - 1.6, $sub - 1.6);
        $this->stroke($pdf, self::CERULEAN, self::RULE);
        $pdf->Line(self::M, $ruleY, $right, $ruleY);

        return $ruleY + 7.5;
    }

    /** @param array<string,mixed> $ctx */
    private function parties(PrescriptionPdf $pdf, array $ctx, float $y): float
    {
        $col   = (self::W - 10) / 2;
        $right = self::M + self::W;

        // Patient (left).
        $this->font($pdf, 'B', 7.5, self::SLATE);
        $pdf->Text(self::M, $y + 3, 'PATIENT');
        $this->font($pdf, 'B', 12, self::INK);
        $ly = $y + 9;
        foreach ($this->wrap($pdf, self::str($ctx, 'patient_name'), $col, 2) as $line) {
            $pdf->Text(self::M, $ly, $line);
            $ly += 5.2;
        }
        $meta = array_values(array_filter([
            self::str($ctx, 'patient_gender') !== '' ? 'Gender: ' . ucfirst(self::str($ctx, 'patient_gender')) : '',
            self::str($ctx, 'patient_dob') !== '' ? 'DOB: ' . $this->humanDate(self::str($ctx, 'patient_dob')) : '',
        ], static fn (string $s): bool => $s !== ''));
        $this->font($pdf, '', 9, self::SLATE);
        foreach ($meta !== [] ? $this->wrap($pdf, implode(' · ', $meta), $col, 2) : [] as $line) {
            $pdf->Text(self::M, $ly - 0.6, $line);
            $ly += 4.4;
        }

        // Attending doctor (right, aligned right as in the HTML).
        $this->font($pdf, 'B', 7.5, self::SLATE);
        $this->rightText($pdf, $right, $y + 3, 'ATTENDING DOCTOR');
        $this->font($pdf, 'B', 12, self::INK);
        $ry = $y + 9;
        foreach ($this->wrap($pdf, self::str($ctx, 'doctor_name'), $col, 2) as $line) {
            $pdf->Text($right - $pdf->GetStringWidth($line), $ry, $line);
            $ry += 5.2;
        }
        $this->font($pdf, '', 9, self::SLATE);
        $consult = self::str($ctx, 'consult_date') !== '' ? $this->humanDate(self::str($ctx, 'consult_date')) : '';
        foreach ([self::str($ctx, 'doctor_specialty'), $consult !== '' ? 'Consultation: ' . $consult : ''] as $value) {
            if ($value === '') {
                continue;
            }
            foreach ($this->wrap($pdf, $value, $col, 2) as $line) {
                $pdf->Text($right - $pdf->GetStringWidth($line), $ry - 0.6, $line);
                $ry += 4.4;
            }
        }

        return max($ly, $ry) + 6;
    }

    /** @param array<string,mixed> $ctx */
    private function referral(PrescriptionPdf $pdf, array $ctx, float $y): float
    {
        $y = $this->ensure($pdf, $y, 30);
        $this->font($pdf, 'B', 8.5, self::TEAL);
        $pdf->Text(self::M, $y + 3, 'REFERRAL');
        if (strtolower(self::str($ctx, 'priority')) === 'urgent') {
            $px = self::M + $pdf->GetStringWidth('REFERRAL') + 3;
            $this->font($pdf, 'B', 7, self::URGENT);
            $pw = $pdf->GetStringWidth('URGENT') + 5;
            $this->paint($pdf, self::URGENT_BG);
            $pdf->roundedRect($px, $y - 0.4, $pw, 4.6, 2.3, 'F');
            $this->font($pdf, 'B', 7, self::URGENT);
            $pdf->Text($px + 2.5, $y + 2.9, 'URGENT');
        }
        $y += 8;

        $y = $this->paragraph($pdf, "Dear Colleague,\nI would be grateful if you could kindly see the above-named patient regarding the following.", $y, 10.5, 5.4);
        $y += 3.5;
        $y = $this->rows($pdf, [
            'Refer to' => self::str($ctx, 'target'),
            'Service'  => ucfirst(self::str($ctx, 'referral_type')),
            'Reason'   => self::str($ctx, 'reason'),
        ], $y);

        $summary = trim(self::str($ctx, 'clinical_summary'));
        if ($summary !== '') {
            $y = $this->ensure($pdf, $y + 4, 16);
            $this->font($pdf, 'B', 7.5, self::SLATE);
            $pdf->Text(self::M, $y + 3, 'CLINICAL SUMMARY');
            $y += 5.5;
            $this->font($pdf, '', 10, self::INK);
            $y = $this->flow($pdf, $this->lines($pdf, $summary, self::W), self::M, $y, 5.0, '', 10, self::INK);
        }

        return $this->paragraph($pdf, 'With thanks for your assistance.', $y + 5, 10.5, 5.4);
    }

    /** @param array<string,mixed> $ctx */
    private function certificate(PrescriptionPdf $pdf, string $title, array $ctx, float $y): float
    {
        $y = $this->ensure($pdf, $y, 30);
        $this->font($pdf, 'B', 8.5, self::TEAL);
        $pdf->Text(self::M, $y + 3, $this->clip($pdf, PrescriptionPdf::enc(mb_strtoupper($title, 'UTF-8')), self::W));
        $y += 8;

        $y = $this->paragraph($pdf, 'This is to certify that I have examined the above-named patient and provide the following on medical grounds:', $y, 10.5, 5.4);
        $y = $this->statement($pdf, self::str($ctx, 'statement'), $y + 3.5);

        $rows = [];
        $from = self::str($ctx, 'from_date');
        $to   = self::str($ctx, 'to_date');
        if ($from !== '' && $to !== '') {
            $days         = (int) ($ctx['days'] ?? 0);
            $rows['Period'] = $this->humanDate($from) . ' to ' . $this->humanDate($to)
                . ($days > 0 ? ' (' . $days . ' day' . ($days === 1 ? '' : 's') . ')' : '');
        }
        $diagnosis = trim(self::str($ctx, 'diagnosis'));
        if ($diagnosis !== '') {
            $rows['Diagnosis'] = $diagnosis;
        }

        return $rows !== [] ? $this->rows($pdf, $rows, $y) : $y;
    }

    /** The certificate statement in a bordered box, split across pages when long. */
    private function statement(PrescriptionPdf $pdf, string $text, float $y): float
    {
        $pad = 4.5;
        $lh  = 5.6;
        $this->font($pdf, '', 11, self::INK);
        $lines = $this->lines($pdf, $text, self::W - 2 * $pad);
        if ($lines === []) {
            $lines = [''];
        }
        $n = count($lines);
        $i = 0;
        while ($i < $n) {
            // Lines that fit between $y and the bottom: 2*pad + 4.6 + (k-1)*lh <= room.
            $fit = (int) floor((self::BOTTOM - $y - 2 * $pad - 4.6) / $lh) + 1;
            if ($fit < min(2, $n - $i) && $y > self::M + 0.01) {
                $y = $this->newPage($pdf);
                continue;
            }
            $take = max(1, min($fit, $n - $i));
            $h    = 2 * $pad + 4.6 + ($take - 1) * $lh;
            $this->paint($pdf, self::PANEL);
            $this->stroke($pdf, self::CLOUD, 0.3);
            $pdf->roundedRect(self::M, $y, self::W, $h, 2.5, 'DF');
            $this->font($pdf, '', 11, self::INK);
            for ($k = 0; $k < $take; ++$k) {
                $line = $lines[$i + $k];
                if ($line !== '') {
                    $pdf->Text(self::M + $pad, $y + $pad + 3.4 + $k * $lh, $line);
                }
            }
            $i += $take;
            $y += $h;
            if ($i < $n) {
                $y = $this->newPage($pdf);
            }
        }

        return $y + 5;
    }

    /** @param array<string,mixed> $ctx */
    private function signature(PrescriptionPdf $pdf, array $ctx, float $y): float
    {
        $y    = $this->ensure($pdf, $y + 9, 27);
        $name = PrescriptionPdf::enc(self::str($ctx, 'doctor_name'));

        // The e-signature: the name in Helvetica Italic 16 pt over a rule.
        $size = $this->fit($pdf, 'I', 16, 10, $name, 110);
        $this->font($pdf, 'I', $size, self::CERULEAN);
        $name = $this->clip($pdf, $name, 110);
        $pdf->Text(self::M, $y + 6.5, $name);
        $this->stroke($pdf, self::CLOUD, 0.3);
        $pdf->Line(self::M, $y + 9, self::M + max(70.0, min(116.0, $pdf->GetStringWidth($name) + 6)), $y + 9);

        $this->font($pdf, 'B', 10, self::INK);
        $pdf->Text(self::M, $y + 14.5, $this->clip($pdf, PrescriptionPdf::enc(self::str($ctx, 'doctor_name')), self::W));
        $specialty = self::str($ctx, 'doctor_specialty');
        $this->font($pdf, '', 9, self::SLATE);
        $pdf->Text(self::M, $y + 19, $this->clip($pdf, PrescriptionPdf::enc($specialty !== '' ? $specialty : 'Attending doctor'), self::W));
        $this->font($pdf, '', 8, self::SLATE);
        $pdf->Text(self::M, $y + 24, 'Electronically signed and verified - no wet signature required.');

        return $y + 26;
    }

    private function closingNote(PrescriptionPdf $pdf, float $y): void
    {
        $this->font($pdf, '', 8, self::SLATE);
        $lines = $this->wrap(
            $pdf,
            'This document was issued electronically via ' . $this->clinicName . '. '
            . 'Its authenticity can be verified using the reference above. '
            . 'This is a confidential medical document intended only for the named patient.',
            self::W,
            8,
        );
        $y = $this->ensure($pdf, $y + 7, 3 + count($lines) * 4);
        $this->stroke($pdf, self::CLOUD, 0.3);
        $pdf->Line(self::M, $y, self::M + self::W, $y);
        $this->flow($pdf, $lines, self::M, $y + 2, 4.0, '', 8, self::SLATE);
    }

    /** "Page n of N · Ref ABCDEF12", centred below the body on every page. */
    private function footer(PrescriptionPdf $pdf): void
    {
        $this->stroke($pdf, self::CLOUD, 0.2);
        $pdf->Line(self::M, self::BOTTOM + 4.5, self::M + self::W, self::BOTTOM + 4.5);
        $text = PrescriptionPdf::enc(sprintf('Page %d of %d', $pdf->PageNo(), max($this->total, $pdf->PageNo()))
            . ($this->docNo !== '' ? ' · Ref ' . $this->docNo : ''));
        $this->font($pdf, '', 7.5, self::SLATE);
        $pdf->Text(self::M + (self::W - $pdf->GetStringWidth($text)) / 2, 297 - self::M + 0.5, $text);
    }

    // ----- flow -----

    /** Start a new page when `$h` mm don't fit below `$y`; returns where to draw. */
    private function ensure(PrescriptionPdf $pdf, float $y, float $h): float
    {
        return $y + $h <= self::BOTTOM ? $y : $this->newPage($pdf);
    }

    private function newPage(PrescriptionPdf $pdf): float
    {
        $this->footer($pdf);
        $pdf->AddPage();

        return self::M;
    }

    /**
     * Draw cp1252 `$lines` from `$y`, one every `$lh` mm, breaking pages as
     * needed; returns the y below the last line.
     *
     * @param list<string> $lines
     * @param array{0:int,1:int,2:int} $rgb
     */
    private function flow(PrescriptionPdf $pdf, array $lines, float $x, float $y, float $lh, string $style, float $size, array $rgb): float
    {
        foreach ($lines as $line) {
            if ($y + $lh > self::BOTTOM) {
                $y = $this->newPage($pdf);
            }
            if ($line !== '') {
                $this->font($pdf, $style, $size, $rgb);
                $pdf->Text($x, $y + $lh * 0.72, $line);
            }
            $y += $lh;
        }

        return $y;
    }

    /** A body paragraph (INK, regular) across the full width. */
    private function paragraph(PrescriptionPdf $pdf, string $text, float $y, float $size, float $lh): float
    {
        $this->font($pdf, '', $size, self::INK);

        return $this->flow($pdf, $this->lines($pdf, $text, self::W), self::M, $y, $lh, '', $size, self::INK);
    }

    /**
     * Label / value rows (empty values skipped, as in the HTML); long values
     * wrap and flow onto the next page.
     *
     * @param array<string,string> $pairs
     */
    private function rows(PrescriptionPdf $pdf, array $pairs, float $y): float
    {
        $labelW = 34.0;
        $lh     = 5.0;
        foreach ($pairs as $label => $value) {
            if (trim($value) === '') {
                continue;
            }
            $this->font($pdf, '', 10, self::INK);
            $lines = $this->lines($pdf, $value, self::W - $labelW);
            $y     = $this->ensure($pdf, $y, min(count($lines), 2) * $lh + 1);
            $this->font($pdf, 'B', 9, self::SLATE);
            $pdf->Text(self::M, $y + $lh * 0.72, PrescriptionPdf::enc($label));
            $y = $this->flow($pdf, $lines, self::M + $labelW, $y, $lh, '', 10, self::INK) + 2.2;
        }

        return $y;
    }

    /**
     * `$text` wrapped to `$width` mm in the current font, as cp1252 lines,
     * keeping the author's line breaks (a run of blank lines becomes one).
     *
     * @return list<string>
     */
    private function lines(PrescriptionPdf $pdf, string $text, float $width): array
    {
        if (mb_strlen($text, 'UTF-8') > self::MAX_FIELD) {
            $text = rtrim(mb_substr($text, 0, self::MAX_FIELD, 'UTF-8')) . ' [...] (shortened for print)';
        }
        $out = [];
        foreach (preg_split('/\r\n|\r|\n/', $text) ?: [$text] as $para) {
            if (trim($para) === '') {
                if ($out !== [] && end($out) !== '') {
                    $out[] = '';
                }
                continue;
            }
            foreach ($this->wrap($pdf, $para, $width, PHP_INT_MAX) as $line) {
                $out[] = $line;
            }
        }
        while ($out !== [] && end($out) === '') {
            array_pop($out);
        }

        return $out;
    }

    /**
     * {@see PrescriptionPdf::wrap()}'s line breaking, line for line the same:
     * UTF-8 `$text` wrapped to `$width` mm in the current font, as at most
     * `$maxLines` cp1252 lines (the last ending in "..." when cut). Only the
     * hard break of a word wider than the line differs in cost: wrap() drops
     * one byte at a time and re-measures the whole prefix each time (O(n^3)
     * for one unbroken run: minutes for a pasted 20 000-character token),
     * here {@see fitPrefix()} finds the same cut in O(line log line), so the
     * whole text costs O(n log n). Every free-text field goes through this.
     *
     * @return list<string>
     */
    private function wrap(PrescriptionPdf $pdf, string $text, float $width, int $maxLines): array
    {
        $text = PrescriptionPdf::enc(trim(preg_replace('/\s+/', ' ', $text) ?? ''));
        if ($text === '') {
            return [];
        }
        $lines = [];
        $line  = '';
        foreach (explode(' ', $text) as $word) {
            $try = $line === '' ? $word : $line . ' ' . $word;
            if ($pdf->GetStringWidth($try) <= $width) {
                $line = $try;
                continue;
            }
            if ($line !== '') {
                $lines[] = $line;
            }
            // A single word longer than the line: hard-break it into the
            // longest prefixes that fit (one byte at least), as wrap() does.
            $at = 0;
            $n  = strlen($word);
            while ($n - $at > 1) {
                $cut = $this->fitPrefix($pdf, $word, $at, $width);
                if ($cut >= $n - $at) {
                    break; // the rest fits
                }
                $lines[] = substr($word, $at, $cut);
                $at     += $cut;
            }
            $line = substr($word, $at);
        }
        if ($line !== '') {
            $lines[] = $line;
        }
        if (count($lines) > $maxLines) {
            $lines = array_slice($lines, 0, $maxLines);
            $last  = $lines[$maxLines - 1];
            while ($last !== '' && $pdf->GetStringWidth($last . '...') > $width) {
                $last = substr($last, 0, -1);
            }
            $lines[$maxLines - 1] = rtrim($last) . '...';
        }

        return $lines;
    }

    /**
     * How many bytes of cp1252 `$word`, from byte `$at`, fit `$width` in the
     * current font: the longest such prefix, at least 1 (a single glyph wider
     * than the line still takes a line of its own), or all the rest when it
     * fits. Doubling from 64 bytes, then bisecting: every probe measures at
     * most twice a line, never the whole remaining word.
     */
    private function fitPrefix(PrescriptionPdf $pdf, string $word, int $at, float $width): int
    {
        $rest = strlen($word) - $at;
        $lo   = 0;                  // the longest prefix known to fit (0: none yet)
        $hi   = min($rest, 64);
        while ($pdf->GetStringWidth(substr($word, $at, $hi)) <= $width) {
            if ($hi >= $rest) {
                return $rest;
            }
            $lo = $hi;
            $hi = min($rest, 2 * $hi);
        }
        // A prefix of $lo bytes fits (or $lo is 0) and one of $hi bytes doesn't.
        while ($hi - $lo > 1) {
            $mid = intdiv($lo + $hi, 2);
            if ($pdf->GetStringWidth(substr($word, $at, $mid)) <= $width) {
                $lo = $mid;
            } else {
                $hi = $mid;
            }
        }

        return max(1, $lo);
    }

    // ----- drawing helpers -----

    /** @param array{0:int,1:int,2:int} $rgb */
    private function font(PrescriptionPdf $pdf, string $style, float $size, array $rgb): void
    {
        $pdf->SetFont('Helvetica', $style, $size);
        $pdf->SetTextColor($rgb[0], $rgb[1], $rgb[2]);
    }

    /** @param array{0:int,1:int,2:int} $rgb */
    private function stroke(PrescriptionPdf $pdf, array $rgb, float $width): void
    {
        $pdf->SetDrawColor($rgb[0], $rgb[1], $rgb[2]);
        $pdf->SetLineWidth($width);
    }

    /** @param array{0:int,1:int,2:int} $rgb */
    private function paint(PrescriptionPdf $pdf, array $rgb): void
    {
        $pdf->SetFillColor($rgb[0], $rgb[1], $rgb[2]);
    }

    private function rightText(PrescriptionPdf $pdf, float $right, float $y, string $text): void
    {
        $text = PrescriptionPdf::enc($text);
        $pdf->Text($right - $pdf->GetStringWidth($text), $y, $text);
    }

    /** The largest size from `$size` down to `$min` (0.5 pt steps) at which cp1252 `$text` fits `$width`. */
    private function fit(PrescriptionPdf $pdf, string $style, float $size, float $min, string $text, float $width): float
    {
        $pdf->SetFont('Helvetica', $style, $size);
        while ($size > $min && $pdf->GetStringWidth($text) > $width) {
            $size -= 0.5;
            $pdf->SetFont('Helvetica', $style, $size);
        }

        return $size;
    }

    /** cp1252 `$text` cut (with "...") to `$width` in the current font. */
    private function clip(PrescriptionPdf $pdf, string $text, float $width): string
    {
        if ($pdf->GetStringWidth($text) <= $width) {
            return $text;
        }
        while ($text !== '' && $pdf->GetStringWidth($text . '...') > $width) {
            $text = substr($text, 0, -1);
        }

        return rtrim($text) . '...';
    }

    // ----- values -----

    /** @param array<string,mixed> $ctx */
    private static function str(array $ctx, string $key): string
    {
        $v = $ctx[$key] ?? '';

        return is_scalar($v) ? trim((string) $v) : '';
    }

    /** @param array<string,mixed> $ctx */
    private function doctorZone(array $ctx): DateTimeZone
    {
        return TimeZones::zoneOr(is_string($ctx['doctor_timezone'] ?? null) ? $ctx['doctor_timezone'] : null);
    }

    /** A bare Y-m-d (period, DOB) is a calendar day, never shifted; an instant shows on the clinic calendar (as the HTML). */
    private function humanDate(string $iso): string
    {
        if ($iso === '') {
            return '';
        }
        try {
            $at = new DateTimeImmutable($iso);

            return preg_match('/^\d{4}-\d{2}-\d{2}$/', $iso) === 1
                ? $at->format('j M Y')
                : $at->setTimezone(ClinicTime::zone())->format('j M Y');
        } catch (\Throwable) {
            return $iso;
        }
    }

    /** "4 Nov 2026, 09:12 CST" in the issuing doctor's zone. */
    private function humanDateTime(string $iso, DateTimeZone $tz): string
    {
        if ($iso === '') {
            return '';
        }
        try {
            return TimeZones::stamp(new DateTimeImmutable($iso), $tz);
        } catch (\Throwable) {
            return $iso;
        }
    }

    /** "VideoMed" -> "Video"; a spaced name -> its first word (as the HTML letterhead). */
    private static function wordOne(string $s): string
    {
        if (str_contains($s, ' ')) {
            return explode(' ', $s, 2)[0];
        }
        if (preg_match('/^([A-Z][a-z0-9]+)([A-Z].*)$/', $s, $m) === 1) {
            return $m[1];
        }

        return $s;
    }

    private static function wordRest(string $s): string
    {
        if (str_contains($s, ' ')) {
            return ' ' . explode(' ', $s, 2)[1];
        }
        if (preg_match('/^([A-Z][a-z0-9]+)([A-Z].*)$/', $s, $m) === 1) {
            return $m[2];
        }

        return '';
    }
}
