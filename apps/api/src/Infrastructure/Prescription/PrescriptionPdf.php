<?php

declare(strict_types=1);

namespace App\Infrastructure\Prescription;

use FPDF;

/**
 * FPDF with the few drawing primitives the prescription form needs: rounded
 * boxes, dashed lines, rotated outline text (watermarks) and UTF-8 → cp1252
 * text conversion for the core fonts.
 */
final class PrescriptionPdf extends FPDF
{
    /** Convert UTF-8 to the core fonts' Windows-1252 encoding (transliterating the rest). */
    public static function enc(string $text): string
    {
        $text = strtr($text, ['₦' => 'NGN ', '–' => '-', '—' => '-', '‘' => "'", '’' => "'", '“' => '"', '”' => '"', '…' => '...', '•' => '-']);
        $out  = @iconv('UTF-8', 'windows-1252//TRANSLIT//IGNORE', $text);

        return $out !== false ? $out : preg_replace('/[^\x20-\x7E]/', '?', $text) ?? '';
    }

    public function roundedRect(float $x, float $y, float $w, float $h, float $r, string $style = 'D'): void
    {
        $k  = $this->k;
        $hp = $this->h;
        $op = match ($style) {
            'F'        => 'f',
            'FD', 'DF' => 'B',
            default    => 'S',
        };
        $arc = 4 / 3 * (M_SQRT2 - 1);
        $this->_out(sprintf('%.2F %.2F m', ($x + $r) * $k, ($hp - $y) * $k));
        $xc = $x + $w - $r;
        $yc = $y + $r;
        $this->_out(sprintf('%.2F %.2F l', $xc * $k, ($hp - $y) * $k));
        $this->arc($xc + $r * $arc, $yc - $r, $xc + $r, $yc - $r * $arc, $xc + $r, $yc);
        $xc = $x + $w - $r;
        $yc = $y + $h - $r;
        $this->_out(sprintf('%.2F %.2F l', ($x + $w) * $k, ($hp - $yc) * $k));
        $this->arc($xc + $r, $yc + $r * $arc, $xc + $r * $arc, $yc + $r, $xc, $yc + $r);
        $xc = $x + $r;
        $yc = $y + $h - $r;
        $this->_out(sprintf('%.2F %.2F l', $xc * $k, ($hp - ($y + $h)) * $k));
        $this->arc($xc - $r * $arc, $yc + $r, $xc - $r, $yc + $r * $arc, $xc - $r, $yc);
        $xc = $x + $r;
        $yc = $y + $r;
        $this->_out(sprintf('%.2F %.2F l', $x * $k, ($hp - $yc) * $k));
        $this->arc($xc - $r, $yc - $r * $arc, $xc - $r * $arc, $yc - $r, $xc, $yc - $r);
        $this->_out($op);
    }

    private function arc(float $x1, float $y1, float $x2, float $y2, float $x3, float $y3): void
    {
        $h = $this->h;
        $this->_out(sprintf(
            '%.2F %.2F %.2F %.2F %.2F %.2F c',
            $x1 * $this->k,
            ($h - $y1) * $this->k,
            $x2 * $this->k,
            ($h - $y2) * $this->k,
            $x3 * $this->k,
            ($h - $y3) * $this->k,
        ));
    }

    /** Dash pattern in mm (0,0 = solid). */
    public function setDash(float $black = 0, float $white = 0): void
    {
        $this->_out($black > 0
            ? sprintf('[%.3F %.3F] 0 d', $black * $this->k, $white * $this->k)
            : '[] 0 d');
    }

    /** Large outline text rotated by `$angle` degrees around (x, y). */
    public function rotatedOutlineText(float $x, float $y, string $text, float $angle): void
    {
        $a  = deg2rad($angle);
        $c  = cos($a);
        $s  = sin($a);
        $cx = $x * $this->k;
        $cy = ($this->h - $y) * $this->k;
        $this->_out(sprintf('q %.5F %.5F %.5F %.5F %.2F %.2F cm 1 0 0 1 %.2F %.2F cm', $c, $s, -$s, $c, $cx, $cy, -$cx, -$cy));
        $this->_out('1 Tr');
        $this->Text($x, $y, $text);
        $this->_out('0 Tr Q');
    }

    /**
     * Wrap `$text` to `$width` mm in the current font, keeping at most
     * `$maxLines` lines (the last ending in "..." when cut).
     *
     * @return list<string> lines, already cp1252-encoded
     */
    public function wrap(string $text, float $width, int $maxLines): array
    {
        $text  = self::enc(trim(preg_replace('/\s+/', ' ', $text) ?? ''));
        if ($text === '') {
            return [];
        }
        $lines = [];
        $line  = '';
        foreach (explode(' ', $text) as $word) {
            $try = $line === '' ? $word : $line . ' ' . $word;
            if ($this->GetStringWidth($try) <= $width) {
                $line = $try;
                continue;
            }
            if ($line !== '') {
                $lines[] = $line;
            }
            // A single word longer than the line: hard-break it.
            while ($this->GetStringWidth($word) > $width && strlen($word) > 1) {
                $cut = strlen($word);
                while ($cut > 1 && $this->GetStringWidth(substr($word, 0, $cut)) > $width) {
                    --$cut;
                }
                $lines[] = substr($word, 0, $cut);
                $word    = substr($word, $cut);
            }
            $line = $word;
        }
        if ($line !== '') {
            $lines[] = $line;
        }
        if (count($lines) > $maxLines) {
            $lines = array_slice($lines, 0, $maxLines);
            $last  = $lines[$maxLines - 1];
            while ($last !== '' && $this->GetStringWidth($last . '...') > $width) {
                $last = substr($last, 0, -1);
            }
            $lines[$maxLines - 1] = rtrim($last) . '...';
        }

        return $lines;
    }
}
