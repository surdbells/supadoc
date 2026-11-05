<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Action\Appointment\RenderMyDocumentAction;
use App\Action\Doctor\RenderDoctorDocumentAction;
use App\Domain\Settings\ClinicTime;
use App\Infrastructure\Document\ClinicalDocumentPdfRenderer;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use App\Infrastructure\Prescription\PrescriptionPdf;
use DI\ContainerBuilder;
use PHPUnit\Framework\TestCase;

/**
 * Referrals and medical certificates as PDF (document viewer spec §5, §8.2),
 * checked like the prescription and lab request PDFs: the bytes are a PDF,
 * one page each, long text flows to "Page 2 of 2", empty optional fields and
 * text outside cp1252 never throw, the output stays under 1 MB, the letter
 * says what the HTML says, and the issue stamp and file name use the issuing
 * doctor's zone whatever the process zone.
 */
final class ClinicalDocumentPdfRendererTest extends TestCase
{
    private function renderer(): ClinicalDocumentPdfRenderer
    {
        return new ClinicalDocumentPdfRenderer('VideoMed', 'Telehealth Consultations', 'care@videomed.test');
    }

    /** @return array<string,mixed> */
    private function base(): array
    {
        return [
            'patient_name'     => 'Ada Lovelace',
            'patient_gender'   => 'female',
            'patient_dob'      => '1990-03-03',
            'doctor_name'      => 'Dr Alan Turing',
            'doctor_specialty' => 'Cardiology',
            'consult_date'     => '2026-11-03T15:00:00+00:00',
            'issued_at'        => '2026-11-05T03:12:00+00:00', // 4 Nov, 21:12 in Chicago
            'document_no'      => 'abcdef12-3456-7890-abcd-ef1234567890',
            'doctor_timezone'  => 'America/Chicago',
        ];
    }

    /** @return array<string,mixed> */
    private function referral(array $over = []): array
    {
        return $over + $this->base() + [
            'referral_type'    => 'specialist',
            'target'           => 'Neurology clinic',
            'reason'           => 'Persistent headaches',
            'priority'         => 'urgent',
            'clinical_summary' => "BP 150/95 on two readings.\nNo focal neurology.",
        ];
    }

    /** @return array<string,mixed> */
    private function certificate(array $over = []): array
    {
        return $over + $this->base() + [
            'type_label' => 'Sick leave certificate',
            'statement'  => 'Requires rest and is unfit for work.',
            'from_date'  => '2026-11-04',
            'to_date'    => '2026-11-06',
            'days'       => 3,
            'diagnosis'  => 'Migraine',
        ];
    }

    public function testEachKindRendersOnePageOfPdfUnderOneMegabyte(): void
    {
        foreach (['referral' => $this->referral(), 'certificate' => $this->certificate()] as $kind => $ctx) {
            $pdf = $this->renderer()->render($kind, $ctx);
            self::assertStringStartsWith('%PDF-', $pdf, $kind);
            self::assertLessThan(1024 * 1024, strlen($pdf), $kind);
            self::assertSame(1, self::pages($pdf), $kind);
            self::assertStringContainsString('(Page 1 of 1 ' . "\xB7" . ' Ref ABCDEF12) Tj', self::text($pdf), $kind);
        }
    }

    public function testAFourThousandCharacterSummaryWrapsToTwoPages(): void
    {
        $summary = substr(str_repeat('Intermittent headaches with photophobia and nausea, worse in the mornings. ', 60), 0, 4000);
        self::assertSame(4000, strlen($summary));
        $pdf  = $this->renderer()->render('referral', $this->referral(['clinical_summary' => $summary]));
        $text = self::text($pdf);

        self::assertSame(2, self::pages($pdf));
        self::assertStringContainsString('(Page 1 of 2 ' . "\xB7" . ' Ref ABCDEF12) Tj', $text);
        self::assertStringContainsString('(Page 2 of 2 ' . "\xB7" . ' Ref ABCDEF12) Tj', $text);
        self::assertStringContainsString('(With thanks for your assistance.) Tj', $text, 'the letter ends on page 2');
        self::assertLessThan(1024 * 1024, strlen($pdf));
    }

    public function testALongStatementSplitsItsBoxAcrossPages(): void
    {
        $statement = trim(str_repeat('The patient needs complete rest at home for the whole period. ', 120));
        $pdf       = $this->renderer()->render('certificate', $this->certificate(['statement' => $statement]));

        self::assertGreaterThanOrEqual(2, self::pages($pdf));
        self::assertStringContainsString('(Diagnosis) Tj', self::text($pdf));
    }

    public function testEmptyOptionalFieldsNeverThrow(): void
    {
        $bare = [
            'patient_name' => 'Ada Lovelace',
            'doctor_name'  => 'Dr Alan Turing',
        ];
        $referral = $this->renderer()->render('referral', $bare + ['target' => 'Neurology', 'reason' => 'Headaches']);
        $cert     = $this->renderer()->render('certificate', $bare + ['statement' => 'Unfit for work.', 'diagnosis' => null, 'from_date' => null, 'to_date' => null, 'days' => null]);
        $empty    = $this->renderer()->render('certificate', ['patient_dob' => '', 'clinical_summary' => '', 'statement' => '', 'items' => ['not', 'a', 'string']]);

        foreach ([$referral, $cert, $empty] as $pdf) {
            self::assertStringStartsWith('%PDF-', $pdf);
            self::assertSame(1, self::pages($pdf));
            self::assertStringContainsString('(Page 1 of 1) Tj', self::text($pdf), 'no reference: no "Ref" in the footer');
        }
        $text = self::text($referral);
        self::assertStringNotContainsString('DOB', $text, 'no date of birth: no DOB line');
        self::assertStringNotContainsString('CLINICAL SUMMARY', $text);
        self::assertStringContainsString('(Attending doctor) Tj', $text, 'no specialty: the HTML\'s fallback under the signature');
        self::assertStringNotContainsString('Diagnosis', self::text($cert));
        self::assertStringNotContainsString('Period', self::text($cert));
    }

    public function testTextOutsideCp1252IsEncodedWithoutAnException(): void
    {
        $pdf = $this->renderer()->render('referral', $this->referral([
            'patient_name'     => 'Zoë Ångström',
            'doctor_name'      => 'Dr Ọláolúwa Adébáyọ̀',
            'target'           => 'Клиника неврологии 王小明',
            'reason'           => 'Fees ₦5,000 — “urgent” review 😀',
            'clinical_summary' => "Ünïcödé ✓\u{0000}\u{FEFF} \xC3\x28 (invalid UTF-8)",
        ]));
        $text = self::strings($pdf);

        self::assertStringStartsWith('%PDF-', $pdf);
        self::assertSame(1, self::pages($pdf));
        self::assertStringContainsString("Zo\xEB \xC5ngstr\xF6m", $text, 'cp1252 letters are kept');
        // The rest is transliterated or replaced, depending on the platform's iconv.
        self::assertStringContainsString('NGN 5,000 - "urgent" review', $text, 'enc() maps the naira sign, dashes and quotes');
    }

    public function testTheLetterSaysWhatTheHtmlSays(): void
    {
        $text = self::text($this->renderer()->render('referral', $this->referral()));
        foreach ([
            '(Video) Tj', '(Med) Tj', '(Telehealth Consultations) Tj', '(care@videomed.test) Tj',
            '(REFERRAL LETTER) Tj', '(Ref: ABCDEF12) Tj', '(Issued: 4 Nov 2026, 21:12 CST) Tj',
            '(PATIENT) Tj', '(Ada Lovelace) Tj', '(Gender: Female ' . "\xB7" . ' DOB: 3 Mar 1990) Tj',
            '(ATTENDING DOCTOR) Tj', '(Dr Alan Turing) Tj', '(Cardiology) Tj', '(Consultation: 3 Nov 2026) Tj',
            '(REFERRAL) Tj', '(URGENT) Tj', '(Dear Colleague,) Tj',
            '(I would be grateful if you could kindly see the above-named patient regarding the following.) Tj',
            '(Refer to) Tj', '(Neurology clinic) Tj', '(Service) Tj', '(Specialist) Tj', '(Reason) Tj', '(Persistent headaches) Tj',
            '(CLINICAL SUMMARY) Tj', '(BP 150/95 on two readings.) Tj', '(No focal neurology.) Tj',
            '(With thanks for your assistance.) Tj',
            '(Electronically signed and verified - no wet signature required.) Tj',
            'This document was issued electronically via VideoMed. Its authenticity can be verified',
        ] as $needle) {
            self::assertStringContainsString($needle, $text, $needle);
        }
        self::assertSame(1, preg_match('#/F(\d+) 16\.00 Tf#', $text, $m), 'the signature is set at 16 pt');
        $raw = $this->renderer()->render('referral', $this->referral());
        self::assertMatchesRegularExpression('#/BaseFont /Helvetica-Oblique#', $raw, 'in Helvetica Italic');

        $routine = self::text($this->renderer()->render('referral', $this->referral(['priority' => 'routine'])));
        self::assertStringNotContainsString('URGENT', $routine);

        $cert = self::text($this->renderer()->render('certificate', $this->certificate()));
        foreach ([
            '(SICK LEAVE CERTIFICATE) Tj',
            '(This is to certify that I have examined the above-named patient and provide the following on medical grounds:) Tj',
            '(Requires rest and is unfit for work.) Tj',
            '(Period) Tj', '(4 Nov 2026 to 6 Nov 2026 \(3 days\)) Tj', '(Diagnosis) Tj', '(Migraine) Tj',
        ] as $needle) {
            self::assertStringContainsString($needle, $cert, $needle);
        }
    }

    public function testThePdfMetadataCarriesNoPatientDetails(): void
    {
        // The Info dictionary is not compressed: it is in the raw bytes.
        $raw = $this->renderer()->render('referral', $this->referral());
        self::assertStringContainsString('/Title (Referral letter ABCDEF12)', $raw);
        self::assertStringNotContainsString('Ada', $raw);
        self::assertStringNotContainsString('Lovelace', $raw);
    }

    public function testAHugeFieldIsShortenedSoTheFileStaysSmall(): void
    {
        $pdf  = $this->renderer()->render('referral', $this->referral(['clinical_summary' => str_repeat('word ', 30000)]));
        $text = self::strings($pdf);

        self::assertLessThan(1024 * 1024, strlen($pdf));
        self::assertStringContainsString('[...] (shortened for print)', $text);
        self::assertSame(ClinicalDocumentPdfRenderer::MAX_FIELD / 5, substr_count($text, 'word'), 'the first MAX_FIELD characters are kept');
        self::assertLessThanOrEqual(10, self::pages($pdf));
    }

    public function testAnUnbrokenPasteInAnyFreeTextFieldRendersQuickly(): void
    {
        // A pasted token, URL or separator line has no space to break at. The
        // byte-by-byte hard break of PrescriptionPdf::wrap() is O(n^3) on it
        // (seconds at 3 000 characters, minutes at 20 000). The canary comes
        // first so that a regression fails here instead of hanging below.
        $start = hrtime(true);
        $this->renderer()->render('referral', $this->referral(['reason' => str_repeat('Q', 3000)]));
        self::assertLessThan(0.5, (hrtime(true) - $start) / 1e9, 'a 3 000-character token');

        $paste = str_repeat('Q', ClinicalDocumentPdfRenderer::MAX_FIELD + 5000);
        foreach ([
            ['referral', 'reason'],
            ['referral', 'clinical_summary'],
            ['certificate', 'statement'],
            ['certificate', 'diagnosis'],
        ] as [$kind, $field]) {
            $ctx   = $kind === 'referral' ? $this->referral([$field => $paste]) : $this->certificate([$field => $paste]);
            $start = hrtime(true);
            $pdf   = $this->renderer()->render($kind, $ctx);
            $secs  = (hrtime(true) - $start) / 1e9;
            $text  = self::strings($pdf);

            self::assertLessThan(2.0, $secs, "$kind $field");
            self::assertLessThan(1024 * 1024, strlen($pdf), "$kind $field");
            self::assertStringContainsString('[...] (shortened for print)', $text, "$kind $field");
            self::assertSame(ClinicalDocumentPdfRenderer::MAX_FIELD, substr_count($text, 'Q'), "$kind $field: every kept character is printed, none lost at a break");
            self::assertStringContainsString('(Electronically signed and verified - no wet signature required.) Tj', self::text($pdf), "$kind $field: the letter still ends");
        }
    }

    public function testTheRenderersWrapBreaksLinesExactlyLikePrescriptionPdf(): void
    {
        $wrap = new \ReflectionMethod(ClinicalDocumentPdfRenderer::class, 'wrap');
        $r    = $this->renderer();
        $pdf  = new PrescriptionPdf('P', 'mm', 'A4');
        $pdf->AddPage();
        $texts = [
            '',
            '   ',
            'Persistent headaches with photophobia and nausea, worse in the mornings.',
            str_repeat('A', 300),
            'See ' . str_repeat('x', 250) . ' then ' . str_repeat('W', 180) . ' end.',
            'https://example.test/' . str_repeat('ab/', 90) . '?q=' . str_repeat('9', 60),
            str_repeat('=', 120) . "\t\t" . str_repeat('-', 400),
            'Fees ₦5,000 — “urgent” • review… ' . str_repeat('é', 200) . ' 王小明 😀',
            "two  spaces\u{00A0}and\nnew lines " . str_repeat('i', 500),
            'I',
            str_repeat('MW', 3),
        ];
        foreach ([['', 10.0], ['B', 12.0], ['I', 16.0], ['', 7.5]] as [$style, $size]) {
            $pdf->SetFont('Helvetica', $style, $size);
            foreach ([1.0, 4.0, 40.0, 86.0, 148.0, 182.0] as $width) {
                foreach ([1, 2, PHP_INT_MAX] as $max) {
                    foreach ($texts as $i => $text) {
                        if ($width < 10 && strlen($text) > 160) {
                            continue; // the reference is O(n^3) at a few bytes a line
                        }
                        self::assertSame(
                            $pdf->wrap($text, $width, $max),
                            $wrap->invoke($r, $pdf, $text, $width, $max),
                            "text $i, $style $size pt, $width mm, $max lines",
                        );
                    }
                }
            }
        }
    }

    public function testTheIssueStampAndFileNameUseTheDoctorsZoneWhateverTheProcessZone(): void
    {
        $zone = date_default_timezone_get();
        try {
            foreach (['UTC', 'Asia/Shanghai'] as $process) {
                date_default_timezone_set($process);
                ClinicTime::configure('Africa/Lagos');
                $r = $this->renderer();
                self::assertSame('referral-2026-11-04.pdf', $r->filename('referral', $this->referral()), $process);
                self::assertSame('medical-certificate-2026-11-04.pdf', $r->filename('certificate', $this->certificate()), $process);
                self::assertSame('referral-2026-11-05.pdf', $r->filename('referral', $this->referral(['doctor_timezone' => 'Africa/Lagos'])), $process);
                self::assertSame('referral-2026-11-05.pdf', $r->filename('referral', $this->referral(['doctor_timezone' => null])), 'no zone: the clinic\'s');
                self::assertMatchesRegularExpression('/^referral-\d{4}-\d{2}-\d{2}\.pdf$/', $r->filename('referral', ['issued_at' => 'not a date']));

                $text = self::text($r->render('referral', $this->referral()));
                self::assertStringContainsString('(Issued: 4 Nov 2026, 21:12 CST) Tj', $text, $process);
                self::assertStringContainsString('(Consultation: 3 Nov 2026) Tj', $text, $process);
                self::assertStringContainsString('(Gender: Female ' . "\xB7" . ' DOB: 3 Mar 1990) Tj', $text, 'calendar days never shift');
            }
        } finally {
            date_default_timezone_set($zone);
        }
    }

    public function testTheContainerWiresTheRendererIntoBothRoutes(): void
    {
        $_ENV['DB_SERVER_VERSION'] = '16';
        DoctrineEntityManagerFactory::reset();
        $builder = new ContainerBuilder();
        $builder->addDefinitions(__DIR__ . '/../../config/container.php');
        $c = $builder->build();

        self::assertInstanceOf(ClinicalDocumentPdfRenderer::class, $c->get(ClinicalDocumentPdfRenderer::class));
        foreach ([RenderDoctorDocumentAction::class, RenderMyDocumentAction::class] as $action) {
            $types = array_map(
                static fn (\ReflectionParameter $p): string => (string) $p->getType(),
                (new \ReflectionMethod($action, '__construct'))->getParameters(),
            );
            self::assertContains(ClinicalDocumentPdfRenderer::class, $types, $action);
            self::assertIsObject($c->get($action), $action);
        }
        DoctrineEntityManagerFactory::reset();
    }

    public function testUnknownKindThrows(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->renderer()->render('prescription', $this->base());
    }

    private static function pages(string $pdf): int
    {
        return (int) preg_match_all('#/Type /Page\b#', $pdf);
    }

    /** Every shown string, unescaped, in drawing order, joined with spaces (wrapped lines read as one text). */
    private static function strings(string $pdf): string
    {
        preg_match_all('/\(((?:\\\\.|[^\\\\)])*)\) Tj/s', self::text($pdf), $m);

        return implode(' ', array_map(
            static fn (string $s): string => strtr($s, ['\\(' => '(', '\\)' => ')', '\\\\' => '\\', '\\r' => "\r"]),
            $m[1],
        ));
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
