<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Entity\Drug;
use App\Domain\Entity\Prescription;
use App\Domain\Entity\PrescriptionCheckThrottle;
use App\Infrastructure\Drug\DrugRoute;
use App\Infrastructure\Drug\DrugSearchTerms;
use App\Infrastructure\Prescription\PrescriptionForm;
use App\Infrastructure\Prescription\PrescriptionNumberGenerator;
use App\Infrastructure\Prescription\PrescriptionPdfRenderer;
use App\Infrastructure\Prescription\SignatureStore;
use App\Infrastructure\Service\JwtService;
use App\Infrastructure\Storage\FileVault;
use App\Domain\Exception\ValidationException;
use DateTimeImmutable;
use PHPUnit\Framework\TestCase;

/** E-prescribing: form rules, numbering, lifecycle, catalogue search, PDF, signed links, vault, throttle. */
final class PrescriptionTest extends TestCase
{
    private const SECRET = 'test-secret-please-change-to-32+bytes-in-prod';

    private function drug(string $rxcui = '308191', string $tty = 'SCD'): Drug
    {
        return new Drug($rxcui, $tty, 'amoxicillin 500 MG Oral Capsule', 'amoxicillin 500 MG Oral Capsule', null, 'Oral Capsule', 'Oral', 'amoxicillin 500 mg oral capsule');
    }

    /** @return callable(string): ?Drug */
    private function catalogue(): callable
    {
        return fn (string $rxcui): ?Drug => $rxcui === '308191' ? $this->drug() : null;
    }

    private function today(): DateTimeImmutable
    {
        return new DateTimeImmutable('2026-10-07');
    }

    private function row(array $over = []): array
    {
        return $over + ['rxcui' => '308191', 'dose' => '1 capsule', 'route' => '', 'frequency' => 'Every 8 hours', 'duration' => '5 days', 'quantity' => '15', 'repeats' => 0, 'no_substitute' => false, 'instructions' => 'After food'];
    }

    // ----- form -----

    public function testMedicineNamesComeFromTheCatalogueNotTheClient(): void
    {
        [$clean, $errors] = PrescriptionForm::normalize(['items' => [$this->row(['name' => 'Fake Drug 9000'])]], $this->catalogue(), $this->today());
        $this->assertSame([], $errors);
        $this->assertSame('amoxicillin 500 MG Oral Capsule', $clean['items'][0]['name']);
        $this->assertSame('Oral', $clean['items'][0]['route'], 'route defaults from the dose form');
    }

    public function testUnknownMedicineIsRejected(): void
    {
        [, $errors] = PrescriptionForm::normalize(['items' => [$this->row(['rxcui' => '999'])]], $this->catalogue(), $this->today());
        $this->assertArrayHasKey('items.0.rxcui', $errors);
    }

    public function testBlankRowsAreDroppedAndAtMostTenMedicines(): void
    {
        [$clean] = PrescriptionForm::normalize(['items' => [['rxcui' => '', 'dose' => ''], $this->row()]], $this->catalogue(), $this->today());
        $this->assertCount(1, $clean['items']);

        [, $errors] = PrescriptionForm::normalize(['items' => array_fill(0, 11, $this->row())], $this->catalogue(), $this->today());
        $this->assertArrayHasKey('items', $errors);
    }

    public function testReadingsAreRangeCheckedAndBmiIsDerived(): void
    {
        [$clean, $errors] = PrescriptionForm::normalize(['readings' => [
            'blood_pressure' => '148/92', 'weight' => '72', 'height' => '168', 'temperature' => '37.8', 'source' => 'video',
        ]], $this->catalogue(), $this->today());
        $this->assertSame([], $errors);
        $this->assertSame('148/92', $clean['readings']['blood_pressure']);
        $this->assertSame('25.5', $clean['readings']['bmi']);

        [, $errors] = PrescriptionForm::normalize(['readings' => ['temperature' => '60', 'blood_pressure' => '80/120', 'source' => 'tv']], $this->catalogue(), $this->today());
        $this->assertArrayHasKey('readings.temperature', $errors);
        $this->assertArrayHasKey('readings.blood_pressure', $errors);
        $this->assertArrayHasKey('readings.source', $errors);
    }

    public function testRepeatsMustBeAWholeNumberInRange(): void
    {
        foreach (['-1', '12', '1.5', 'two'] as $bad) {
            [, $errors] = PrescriptionForm::normalize(['items' => [$this->row(['repeats' => $bad])]], $this->catalogue(), $this->today());
            $this->assertArrayHasKey('items.0.repeats', $errors, "repeats={$bad}");
        }
        [$clean, $errors] = PrescriptionForm::normalize(['items' => [$this->row(['repeats' => '3'])]], $this->catalogue(), $this->today());
        $this->assertSame([], $errors);
        $this->assertSame(3, $clean['items'][0]['repeats']);
    }

    public function testDatesAndTextLimits(): void
    {
        [, $errors] = PrescriptionForm::normalize([
            'valid_until'    => '2026-10-01',
            'follow_up_date' => '2026-10-10',
            'reason'         => str_repeat('x', PrescriptionForm::LIMITS['reason'] + 1),
        ], $this->catalogue(), $this->today());
        $this->assertArrayHasKey('valid_until', $errors, 'valid-until in the past');
        $this->assertArrayHasKey('follow_up_mode', $errors, 'follow-up date needs Video or In person');
        $this->assertArrayHasKey('reason', $errors);
    }

    public function testSendRequiresEverythingThePrintedFormNeeds(): void
    {
        [$clean] = PrescriptionForm::normalize(['items' => [$this->row(['dose' => '', 'repeats' => 2])]], $this->catalogue(), $this->today());
        $errors = PrescriptionForm::sendErrors($clean, askPregnancy: true);
        $this->assertArrayHasKey('reason', $errors);
        $this->assertArrayHasKey('pregnancy_status', $errors);
        $this->assertArrayHasKey('items.0.dose', $errors);
        $this->assertArrayHasKey('valid_until', $errors);
        $this->assertArrayHasKey('allows_repeats', $errors, 'repeats without allowing repeats');

        [$ok] = PrescriptionForm::normalize([
            'reason' => 'Acute sinusitis', 'pregnancy_status' => 'no', 'valid_until' => '2026-11-06', 'allows_repeats' => true,
            'items'  => [$this->row(['repeats' => 1])],
        ], $this->catalogue(), $this->today());
        $this->assertSame([], PrescriptionForm::sendErrors($ok, askPregnancy: true));
    }

    public function testPregnancyQuestionOnlyForFemales12To55(): void
    {
        $today = $this->today();
        $this->assertTrue(PrescriptionForm::asksPregnancy('female', new DateTimeImmutable('1990-01-01'), $today));
        $this->assertFalse(PrescriptionForm::asksPregnancy('female', new DateTimeImmutable('1960-01-01'), $today));
        $this->assertFalse(PrescriptionForm::asksPregnancy('female', new DateTimeImmutable('2020-01-01'), $today));
        $this->assertFalse(PrescriptionForm::asksPregnancy('male', new DateTimeImmutable('1990-01-01'), $today));
        $this->assertTrue(PrescriptionForm::asksPregnancy('Female', null, $today), 'unknown age → ask');
    }

    // ----- numbering + lifecycle -----

    public function testNumberFormat(): void
    {
        $n = PrescriptionNumberGenerator::format('2026-10-04', 27);
        $this->assertSame('GVM-RX-20261004-00027', $n);
        $this->assertTrue(PrescriptionNumberGenerator::isValid($n));
        $this->assertFalse(PrescriptionNumberGenerator::isValid('GVM-RX-2026104-27'));
    }

    public function testLifecycleAndEffectiveExpiry(): void
    {
        $rx = new Prescription('p-1', 's-1', null, 'GVM-RX-20261007-00001', new DateTimeImmutable('2026-10-10'));
        $this->assertSame('draft', $rx->effectiveStatus($this->today()));
        $rx->send(['name' => 'Dr. A'], ['name' => 'B'], 'saved', null, new DateTimeImmutable('2026-10-07 10:00'));
        $this->assertSame('active', $rx->effectiveStatus(new DateTimeImmutable('2026-10-10')), 'valid through the valid-until day');
        $this->assertSame('expired', $rx->effectiveStatus(new DateTimeImmutable('2026-10-11')), 'expired the day after');
        $rx->cancel('Wrong dose', new DateTimeImmutable());
        $this->assertSame('cancelled', $rx->effectiveStatus(new DateTimeImmutable('2026-10-11')));
    }

    public function testExtraPageForMoreThanFiveMedicines(): void
    {
        $rx = new Prescription('p-1', 's-1', null, 'GVM-RX-20261007-00002', new DateTimeImmutable('2026-11-06'));
        $rx->setItems(array_fill(0, 5, ['rxcui' => '1', 'name' => 'x']));
        $this->assertSame(1, $rx->pageCount());
        $rx->setItems(array_fill(0, 7, ['rxcui' => '1', 'name' => 'x']));
        $this->assertSame(2, $rx->pageCount());
    }

    public function testSummaryNeverNamesMedicines(): void
    {
        $rx = new Prescription('p-1', 's-1', null, 'GVM-RX-20261007-00003', new DateTimeImmutable('2026-11-06'));
        $rx->setItems([['rxcui' => '308191', 'name' => 'amoxicillin 500 MG Oral Capsule']]);
        $rx->setConsultation('Sinusitis', null, null, null);
        $rx->initTimestamps();
        $json = json_encode($rx->toSummaryArray());
        $this->assertStringNotContainsString('amoxicillin', (string) $json);
        $this->assertStringNotContainsString('Sinusitis', (string) $json);
    }

    // ----- catalogue -----

    public function testInnNamesMapToRxNorm(): void
    {
        $this->assertSame(['acetaminophen', '500'], DrugSearchTerms::from('Paracetamol 500'));
        $this->assertSame(['albuterol'], DrugSearchTerms::from('salbutamol'));
        $this->assertSame(['sulfamethoxazole', 'trimethoprim'], DrugSearchTerms::from('co-trimoxazole'));
        $this->assertSame(['ferrous', 'sulfate'], DrugSearchTerms::from('Ferrous sulphate'));
        $this->assertSame([], DrugSearchTerms::from('a'));
    }

    public function testRouteFromDoseForm(): void
    {
        $this->assertSame('Oral', DrugRoute::fromDoseForm('Extended Release Oral Tablet'));
        $this->assertSame('Eye', DrugRoute::fromDoseForm('Ophthalmic Solution'));
        $this->assertSame('Injection', DrugRoute::fromDoseForm('Prefilled Syringe'));
        $this->assertSame('Inhalation', DrugRoute::fromDoseForm('Metered Dose Inhaler'));
        $this->assertSame('Sublingual', DrugRoute::fromDoseForm('Sublingual Tablet'));
        $this->assertSame('Topical', DrugRoute::fromDoseForm('Topical Cream'));
    }

    public function testBundledDatasetIsPresentAndWellFormed(): void
    {
        $path = __DIR__ . '/../../resources/rxnorm/rxnorm-prescribable.tsv.gz';
        $this->assertFileExists($path);
        $gz     = gzopen($path, 'rb');
        $header = rtrim((string) gzgets($gz), "\n");
        $first  = explode("\t", rtrim((string) gzgets($gz), "\n"));
        gzclose($gz);
        $this->assertSame("rxcui\ttty\tname\tpsn\tbrand\tdose_form\troute\tsynonyms", $header);
        $this->assertCount(8, $first);
        $this->assertContains($first[1], ['SCD', 'SBD', 'GPCK', 'BPCK']);
    }

    // ----- PDF -----

    public function testPdfRendersTwoBrandedPagesUnderOneMegabyte(): void
    {
        $rx = new Prescription('p-1', 's-1', 'a-1', 'GVM-RX-20261007-00027', new DateTimeImmutable('2026-11-06'));
        $rx->setItems(array_fill(0, 7, $this->row(['name' => 'amoxicillin 500 MG Oral Capsule', 'route' => 'Oral'])));
        $rx->setConsultation('Acute sinusitis', 'CA01', null, 'no');
        $rx->send(['name' => 'Dr. Grace Bell', 'mdcn_number' => 'MDCN/R/45821'], ['name' => 'Amaka Okafor'], 'saved', null, new DateTimeImmutable());

        $pdf = (new PrescriptionPdfRenderer())->render($rx, ['name' => 'Amaka Okafor'], ['name' => 'Dr. Grace Bell'], null, 'https://example.test/check-prescription', 'EXPIRED');
        $this->assertStringStartsWith('%PDF-', $pdf);
        $this->assertLessThan(1024 * 1024, strlen($pdf));
        $this->assertSame(2, preg_match_all('#/Type /Page\b#', $pdf));
    }

    // ----- signed links, vault, signatures, throttle -----

    public function testFileLinksVerifyAndAreTypeScoped(): void
    {
        $jwt   = new JwtService(self::SECRET, 900, 43200);
        $token = $jwt->issueFileLink(['rx' => 'abc', 'vt' => 'patient', 'vid' => 'p-1', 'dl' => 1], 900);
        $claims = $jwt->verifyFileLink($token);
        $this->assertSame('abc', $claims['rx'] ?? null);
        $this->assertNull($jwt->verifyFileLink($jwt->issueAccessToken('u', 'staff')), 'an access token is not a file link');
        $this->assertNull($jwt->verifyFileLink($token . 'x'));
    }

    public function testVaultRoundTripsAndDetectsTampering(): void
    {
        $dir   = sys_get_temp_dir() . '/vault-test-' . bin2hex(random_bytes(4));
        $vault = new FileVault($dir, str_repeat('k', 32));
        $key   = $vault->put('signatures', 'secret-bytes');
        $this->assertSame('secret-bytes', $vault->get($key));
        $this->assertStringNotContainsString('secret-bytes', (string) file_get_contents($dir . '/' . $key));

        $path = $dir . '/' . $key;
        $blob = (string) file_get_contents($path);
        file_put_contents($path, substr($blob, 0, -1) . chr(ord(substr($blob, -1)) ^ 1));
        $this->assertNull($vault->get($key), 'tampered ciphertext must not decrypt');
        $vault->delete($key);
    }

    public function testSignaturesAreValidatedAndFlattened(): void
    {
        $store = new SignatureStore(new FileVault(sys_get_temp_dir() . '/vault-sig', str_repeat('k', 32)));
        $im    = imagecreatetruecolor(200, 60);
        imagesavealpha($im, true);
        imagefill($im, 0, 0, imagecolorallocatealpha($im, 0, 0, 0, 127));
        ob_start();
        imagepng($im);
        $png = (string) ob_get_clean();

        $flat = $store->normalize($png);
        $info = getimagesizefromstring($flat);
        $this->assertSame(IMAGETYPE_PNG, $info[2]);
        // Colour type 2 (RGB, no alpha) — embeddable by FPDF.
        $this->assertSame(2, ord($flat[25]));

        $this->expectException(ValidationException::class);
        $store->normalize('not an image at all');
    }

    public function testCheckThrottleLocksAfterConsecutiveMisses(): void
    {
        $now = new DateTimeImmutable('2026-10-07 10:00');
        $t   = new PrescriptionCheckThrottle(hash('sha256', 'device'));
        for ($i = 0; $i < 4; ++$i) {
            $t->fail($now, 5, 15);
        }
        $this->assertNull($t->lockedUntil($now));
        $t->fail($now, 5, 15);
        $this->assertEquals($now->modify('+15 minutes'), $t->lockedUntil($now));
        $this->assertNull($t->lockedUntil($now->modify('+16 minutes')), 'lock runs out');
        $t->reset($now);
        $this->assertSame(0, $t->getFailures());
    }
}
