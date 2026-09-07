<?php

declare(strict_types=1);

namespace App\Infrastructure\Document;

/**
 * Renders clinical documents (prescription, referral letter, medical certificate)
 * as standalone, print-ready A4 HTML with a branded letterhead. No PDF engine is
 * required — the document opens in the browser and prints (or "Save as PDF")
 * pixel-consistently thanks to `@media print` rules. The rendering surface is
 * isolated here so a future server-side PDF path can wrap the same HTML.
 *
 * Every dynamic value is HTML-escaped; documents only ever contain data the
 * doctor entered plus the consultation's own patient/doctor details.
 */
final class ClinicalDocumentRenderer
{
    private const CERULEAN = '#1565c0';
    private const TEAL     = '#00897b';
    private const INK      = '#1c2b3a';
    private const SLATE    = '#546e7a';
    private const CLOUD    = '#e0e5e9';

    public function __construct(
        private readonly string $clinicName = 'VideoMed',
        private readonly string $clinicTagline = 'Telehealth Consultations',
        private readonly string $clinicContact = '',
    ) {
    }

    /**
     * @param 'prescription'|'referral'|'certificate' $kind
     * @param array<string,mixed> $ctx
     */
    public function render(string $kind, array $ctx): string
    {
        return match ($kind) {
            'prescription' => $this->prescription($ctx),
            'referral'     => $this->referral($ctx),
            'certificate'  => $this->certificate($ctx),
            default        => throw new \InvalidArgumentException("Unknown document kind: {$kind}"),
        };
    }

    // ----- Documents -----

    /** @param array<string,mixed> $ctx */
    private function prescription(array $ctx): string
    {
        /** @var list<array<string,string>> $items */
        $items = (array) ($ctx['items'] ?? []);
        $rows  = '';
        foreach ($items as $i => $it) {
            $sub = array_filter([
                $this->line('Dose', (string) ($it['dosage'] ?? '')),
                $this->line('Frequency', (string) ($it['frequency'] ?? '')),
                $this->line('Route', (string) ($it['route'] ?? '')),
                $this->line('Duration', (string) ($it['duration'] ?? '')),
                $this->line('Quantity', (string) ($it['quantity'] ?? '')),
                $this->line('Refills', (string) ($it['refills'] ?? '')),
            ]);
            $instr = trim((string) ($it['instructions'] ?? ''));
            $rows .= '<tr>'
                . '<td style="padding:12px 10px;border-bottom:1px solid ' . self::CLOUD . ';vertical-align:top;font-weight:700;color:' . self::SLATE . ';width:28px;">' . ($i + 1) . '.</td>'
                . '<td style="padding:12px 10px;border-bottom:1px solid ' . self::CLOUD . ';vertical-align:top;">'
                . '<div style="font-size:15px;font-weight:700;color:' . self::INK . ';">' . $this->e(trim((string) ($it['medication'] ?? '')) . ' ' . (string) ($it['strength'] ?? '')) . '</div>'
                . ($sub !== [] ? '<div style="margin-top:4px;color:' . self::SLATE . ';font-size:13px;">' . implode(' &nbsp;•&nbsp; ', $sub) . '</div>' : '')
                . ($instr !== '' ? '<div style="margin-top:4px;color:' . self::INK . ';font-size:13px;font-style:italic;">' . $this->e($instr) . '</div>' : '')
                . '</td></tr>';
        }
        if ($rows === '') {
            $rows = '<tr><td style="padding:16px;color:' . self::SLATE . ';">No medications listed.</td></tr>';
        }

        $body = '<div style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:' . self::TEAL . ';">℞ Prescription</div>'
            . '<table style="width:100%;border-collapse:collapse;">' . $rows . '</table>';

        $notes = trim((string) ($ctx['notes'] ?? ''));
        if ($notes !== '') {
            $body .= $this->noteBlock('Notes to the patient', $notes);
        }

        return $this->document('Prescription', $body, $ctx);
    }

    /** @param array<string,mixed> $ctx */
    private function referral(array $ctx): string
    {
        $priority = strtolower((string) ($ctx['priority'] ?? 'routine'));
        $badge = $priority === 'urgent'
            ? '<span style="display:inline-block;margin-left:8px;padding:2px 10px;border-radius:999px;background:#fdecea;color:#c62828;font-size:11px;font-weight:700;text-transform:uppercase;">Urgent</span>'
            : '';

        $body = '<div style="margin:0 0 12px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:' . self::TEAL . ';">Referral' . $badge . '</div>'
            . '<p style="margin:0 0 16px;font-size:14px;color:' . self::INK . ';line-height:1.6;">'
            . 'Dear Colleague,<br>I would be grateful if you could kindly see the above-named patient regarding the following.'
            . '</p>'
            . $this->kv([
                'Refer to'   => (string) ($ctx['target'] ?? ''),
                'Service'    => ucfirst((string) ($ctx['referral_type'] ?? '')),
                'Reason'     => (string) ($ctx['reason'] ?? ''),
            ]);

        $summary = trim((string) ($ctx['clinical_summary'] ?? ''));
        if ($summary !== '') {
            $body .= $this->noteBlock('Clinical summary', $summary);
        }
        $body .= '<p style="margin:20px 0 0;font-size:14px;color:' . self::INK . ';">With thanks for your assistance.</p>';

        return $this->document('Referral Letter', $body, $ctx);
    }

    /** @param array<string,mixed> $ctx */
    private function certificate(array $ctx): string
    {
        $title = (string) ($ctx['type_label'] ?? 'Medical Certificate');
        $rows  = [];
        $from  = (string) ($ctx['from_date'] ?? '');
        $to    = (string) ($ctx['to_date'] ?? '');
        if ($from !== '' && $to !== '') {
            $rows['Period'] = $this->humanDate($from) . ' to ' . $this->humanDate($to)
                . (($ctx['days'] ?? null) ? ' (' . (int) $ctx['days'] . ' day' . ((int) $ctx['days'] === 1 ? '' : 's') . ')' : '');
        }
        $diagnosis = trim((string) ($ctx['diagnosis'] ?? ''));
        if ($diagnosis !== '') {
            $rows['Diagnosis'] = $diagnosis;
        }

        $body = '<div style="margin:0 0 12px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:' . self::TEAL . ';">' . $this->e($title) . '</div>'
            . '<p style="margin:0 0 16px;font-size:14px;color:' . self::INK . ';line-height:1.7;">'
            . 'This is to certify that I have examined the above-named patient and provide the following on medical grounds:'
            . '</p>'
            . '<div style="padding:16px 18px;border:1px solid ' . self::CLOUD . ';border-radius:10px;background:#f7f9fb;font-size:15px;color:' . self::INK . ';line-height:1.7;white-space:pre-wrap;">'
            . $this->e((string) ($ctx['statement'] ?? '')) . '</div>';

        if ($rows !== []) {
            $body .= '<div style="margin-top:16px;">' . $this->kv($rows) . '</div>';
        }

        return $this->document($title, $body, $ctx);
    }

    // ----- Shared layout -----

    /** @param array<string,mixed> $ctx */
    private function document(string $docTitle, string $bodyHtml, array $ctx): string
    {
        $patientMeta = array_filter([
            ($ctx['patient_gender'] ?? '') !== '' ? 'Gender: ' . ucfirst((string) $ctx['patient_gender']) : '',
            ($ctx['patient_dob'] ?? '') !== '' ? 'DOB: ' . $this->humanDate((string) $ctx['patient_dob']) : '',
        ]);

        $docNo   = strtoupper(substr((string) ($ctx['document_no'] ?? ''), 0, 8));
        $issued  = $this->humanDateTime((string) ($ctx['issued_at'] ?? ''));
        $consult = (string) ($ctx['consult_date'] ?? '') !== '' ? $this->humanDate((string) $ctx['consult_date']) : '';

        $header = '<tr><td style="padding:0 0 20px;border-bottom:3px solid ' . self::CERULEAN . ';">'
            . '<table style="width:100%;border-collapse:collapse;"><tr>'
            . '<td style="vertical-align:top;">'
            . '<div style="font-size:24px;font-weight:800;letter-spacing:-.02em;"><span style="color:' . self::CERULEAN . ';">' . $this->e($this->wordOne($this->clinicName)) . '</span><span style="color:' . self::TEAL . ';">' . $this->e($this->wordRest($this->clinicName)) . '</span></div>'
            . '<div style="margin-top:2px;color:' . self::SLATE . ';font-size:12px;">' . $this->e($this->clinicTagline) . '</div>'
            . ($this->clinicContact !== '' ? '<div style="margin-top:2px;color:' . self::SLATE . ';font-size:12px;">' . $this->e($this->clinicContact) . '</div>' : '')
            . '</td>'
            . '<td style="vertical-align:top;text-align:right;">'
            . '<div style="font-size:16px;font-weight:700;color:' . self::INK . ';text-transform:uppercase;letter-spacing:.03em;">' . $this->e($docTitle) . '</div>'
            . ($docNo !== '' ? '<div style="margin-top:4px;color:' . self::SLATE . ';font-size:12px;">Ref: ' . $this->e($docNo) . '</div>' : '')
            . ($issued !== '' ? '<div style="color:' . self::SLATE . ';font-size:12px;">Issued: ' . $this->e($issued) . '</div>' : '')
            . '</td></tr></table></td></tr>';

        $meta = '<tr><td style="padding:20px 0;">'
            . '<table style="width:100%;border-collapse:collapse;"><tr>'
            . '<td style="vertical-align:top;width:55%;">'
            . '<div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:' . self::SLATE . ';">Patient</div>'
            . '<div style="margin-top:4px;font-size:16px;font-weight:700;color:' . self::INK . ';">' . $this->e((string) ($ctx['patient_name'] ?? '')) . '</div>'
            . ($patientMeta !== [] ? '<div style="margin-top:2px;color:' . self::SLATE . ';font-size:13px;">' . $this->e(implode(' • ', $patientMeta)) . '</div>' : '')
            . '</td>'
            . '<td style="vertical-align:top;text-align:right;">'
            . '<div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:' . self::SLATE . ';">Attending doctor</div>'
            . '<div style="margin-top:4px;font-size:16px;font-weight:700;color:' . self::INK . ';">' . $this->e((string) ($ctx['doctor_name'] ?? '')) . '</div>'
            . ((string) ($ctx['doctor_specialty'] ?? '') !== '' ? '<div style="margin-top:2px;color:' . self::SLATE . ';font-size:13px;">' . $this->e((string) $ctx['doctor_specialty']) . '</div>' : '')
            . ($consult !== '' ? '<div style="margin-top:2px;color:' . self::SLATE . ';font-size:13px;">Consultation: ' . $this->e($consult) . '</div>' : '')
            . '</td></tr></table></td></tr>';

        $body = '<tr><td style="padding:8px 0 28px;">' . $bodyHtml . '</td></tr>';

        $signature = '<tr><td style="padding:28px 0 0;">'
            . '<table style="width:100%;border-collapse:collapse;"><tr>'
            . '<td style="vertical-align:bottom;">'
            . '<div style="font-family:\'Segoe Script\',\'Comic Sans MS\',cursive;font-size:22px;color:' . self::CERULEAN . ';border-bottom:1px solid ' . self::CLOUD . ';padding-bottom:6px;width:260px;">' . $this->e((string) ($ctx['doctor_name'] ?? '')) . '</div>'
            . '<div style="margin-top:6px;font-size:13px;font-weight:700;color:' . self::INK . ';">' . $this->e((string) ($ctx['doctor_name'] ?? '')) . '</div>'
            . '<div style="color:' . self::SLATE . ';font-size:12px;">' . $this->e((string) ($ctx['doctor_specialty'] ?? 'Attending doctor')) . '</div>'
            . '<div style="margin-top:8px;color:' . self::SLATE . ';font-size:11px;">Electronically signed &amp; verified — no wet signature required.</div>'
            . '</td></tr></table></td></tr>';

        $footer = '<tr><td style="padding:24px 0 0;border-top:1px solid ' . self::CLOUD . ';color:' . self::SLATE . ';font-size:11px;line-height:1.6;">'
            . 'This document was issued electronically via ' . $this->e($this->clinicName) . '. '
            . 'Its authenticity can be verified using the reference above. This is a confidential medical document intended only for the named patient.'
            . '</td></tr>';

        $toolbar = '<div class="toolbar" style="max-width:720px;margin:0 auto 16px;text-align:right;">'
            . '<button onclick="window.print()" style="cursor:pointer;border:0;background:' . self::CERULEAN . ';color:#fff;font-size:14px;font-weight:600;padding:10px 18px;border-radius:8px;">Print / Save as PDF</button>'
            . '</div>';

        $page = '<table role="presentation" style="max-width:720px;margin:0 auto;background:#fff;border-collapse:collapse;padding:48px;box-shadow:0 1px 8px rgba(20,40,70,.08);" cellpadding="0" cellspacing="0" width="720">'
            . '<tr><td style="padding:48px;">'
            . '<table style="width:100%;border-collapse:collapse;">'
            . $header . $meta . $body . $signature . $footer
            . '</table></td></tr></table>';

        return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
            . '<meta name="viewport" content="width=device-width, initial-scale=1">'
            . '<title>' . $this->e($docTitle) . ' — ' . $this->e((string) ($ctx['patient_name'] ?? '')) . '</title>'
            . '<style>'
            . 'body{margin:0;background:#eef2f5;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:24px 12px;}'
            . '@page{size:A4;margin:14mm;}'
            . '@media print{body{background:#fff;padding:0;}.toolbar{display:none!important;}table[role=presentation]{box-shadow:none!important;max-width:none!important;}table[role=presentation]>tr>td,table[role=presentation] td{padding:0!important;}}'
            . '</style></head><body>'
            . $toolbar . $page
            . '</body></html>';
    }

    // ----- Helpers -----

    /** @param array<string,string> $pairs */
    private function kv(array $pairs): string
    {
        $rows = '';
        foreach ($pairs as $k => $v) {
            if (trim((string) $v) === '') {
                continue;
            }
            $rows .= '<tr>'
                . '<td style="padding:6px 16px 6px 0;vertical-align:top;color:' . self::SLATE . ';font-size:13px;font-weight:600;white-space:nowrap;width:120px;">' . $this->e($k) . '</td>'
                . '<td style="padding:6px 0;vertical-align:top;color:' . self::INK . ';font-size:14px;line-height:1.6;">' . $this->e($v) . '</td>'
                . '</tr>';
        }

        return '<table style="width:100%;border-collapse:collapse;">' . $rows . '</table>';
    }

    private function noteBlock(string $label, string $text): string
    {
        return '<div style="margin-top:18px;">'
            . '<div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:' . self::SLATE . ';margin-bottom:6px;">' . $this->e($label) . '</div>'
            . '<div style="font-size:14px;color:' . self::INK . ';line-height:1.6;white-space:pre-wrap;">' . $this->e($text) . '</div>'
            . '</div>';
    }

    private function line(string $label, string $value): string
    {
        $value = trim($value);
        return $value === '' ? '' : '<strong style="color:' . self::INK . ';font-weight:600;">' . $this->e($label) . ':</strong> ' . $this->e($value);
    }

    private function wordOne(string $s): string
    {
        // "VideoMed" -> "Video"; a spaced name -> first word.
        if (str_contains($s, ' ')) {
            return explode(' ', $s, 2)[0];
        }
        if (preg_match('/^([A-Z][a-z0-9]+)([A-Z].*)$/', $s, $m)) {
            return $m[1];
        }

        return $s;
    }

    private function wordRest(string $s): string
    {
        if (str_contains($s, ' ')) {
            return ' ' . explode(' ', $s, 2)[1];
        }
        if (preg_match('/^([A-Z][a-z0-9]+)([A-Z].*)$/', $s, $m)) {
            return $m[2];
        }

        return '';
    }

    private function humanDate(string $iso): string
    {
        if ($iso === '') {
            return '';
        }
        try {
            return (new \DateTimeImmutable($iso))->format('j M Y');
        } catch (\Throwable) {
            return $iso;
        }
    }

    private function humanDateTime(string $iso): string
    {
        if ($iso === '') {
            return '';
        }
        try {
            return (new \DateTimeImmutable($iso))->format('j M Y, H:i');
        } catch (\Throwable) {
            return $iso;
        }
    }

    private function e(string $s): string
    {
        return htmlspecialchars($s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    }
}
