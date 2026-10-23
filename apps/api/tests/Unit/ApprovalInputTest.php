<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Application\ApprovalInput;
use App\Domain\Entity\DoctorApplication;
use App\Domain\Entity\DoctorApplicationDocument;
use App\Domain\Exception\ValidationException;
use DateTimeImmutable;
use PHPUnit\Framework\TestCase;

/** Spec §4.2 step 3: the approval form — fee, specialty, required slots, per-document attestation. */
final class ApprovalInputTest extends TestCase
{
    private const TODAY = '2026-10-23';

    /** @return array{0: DoctorApplication, 1: list<DoctorApplicationDocument>} */
    private function application(string $route): array
    {
        $app = new DoctorApplication($route, 'ada@example.com');
        $app->setSpecialty('Cardiology');
        if ($route === 'abroad') {
            $app->setAbroadLicence('GB', 'General Medical Council', '7012345', new DateTimeImmutable('2026-09-01'));
        }
        $docs = [];
        foreach (\App\Domain\Application\ApplicationDocuments::requiredFor($route) as $slot) {
            $docs[] = new DoctorApplicationDocument($app->getId(), $slot, 'applications/' . bin2hex(random_bytes(16)) . '.bin', $slot . '.pdf', 'application/pdf', 100, str_repeat('a', 64));
        }

        return [$app, $docs];
    }

    /** @param list<DoctorApplicationDocument> $docs @return array<string,mixed> */
    private function body(array $docs, array $over = []): array
    {
        $documents = [];
        foreach ($docs as $d) {
            $documents[$d->getId()] = [
                'checked'            => true,
                'register_reference' => 'Register checked 23 Oct',
                'number'             => in_array($d->getSlot(), ['practising_licence'], true) ? 'APL/1' : null,
                'expires_on'         => in_array($d->getSlot(), ['practising_licence', 'indemnity_certificate'], true) ? '2027-03-31' : null,
                'issued_on'          => $d->getSlot() === 'good_standing_certificate' ? '2026-09-01' : null,
            ];
        }

        return $over + ['attest' => true, 'consultation_fee' => '15000', 'documents' => $documents];
    }

    /** @return array<string,string> */
    private function errors(callable $call): array
    {
        try {
            $call();

            return [];
        } catch (ValidationException $e) {
            return $e->getErrors();
        }
    }

    private static function list(): callable
    {
        return static fn (string $v): ?string => strtolower(trim($v)) === 'cardiology' ? 'Cardiology' : (strtolower(trim($v)) === 'pediatrics' ? 'Pediatrics' : null);
    }

    public function testACompleteFormPasses(): void
    {
        [$app, $docs] = $this->application('ng');
        $out = ApprovalInput::validate($this->body($docs), $app, $docs, self::TODAY, self::list());
        $this->assertSame('15000.00', $out['fee']);
        $this->assertSame('Cardiology', $out['specialty']);
        $this->assertCount(6, $out['documents']);
        $this->assertSame('2027-03-31', $out['documents'][$docs[3]->getId()]['expires_on']?->format('Y-m-d'));
    }

    public function testFeeSpecialtyAndAttest(): void
    {
        [$app, $docs] = $this->application('ng');
        foreach (['0', '0.00', '-5', 'abc', '10000000.01', '1.234', ''] as $fee) {
            $this->assertArrayHasKey('consultation_fee', $this->errors(fn () => ApprovalInput::validate($this->body($docs, ['consultation_fee' => $fee]), $app, $docs, self::TODAY, self::list())), $fee);
        }
        $this->assertSame('10000000.00', ApprovalInput::fee('10000000'));
        $this->assertSame('99.50', ApprovalInput::fee(99.5));

        $e = $this->errors(fn () => ApprovalInput::validate($this->body($docs, ['attest' => false, 'specialty' => 'Astrology']), $app, $docs, self::TODAY, self::list()));
        $this->assertSame("Confirm that you checked this applicant's documents and identity against the MDCN register.", $e['attest']);
        $this->assertSame('Astrology is no longer on the specialty list. Choose one.', $e['specialty']);
        $out = ApprovalInput::validate($this->body($docs, ['specialty' => ' pediatrics ']), $app, $docs, self::TODAY, self::list());
        $this->assertSame('Pediatrics', $out['specialty']);
    }

    public function testRequiredSlotsAndPerDocumentChecks(): void
    {
        [$app, $docs] = $this->application('ng');
        $missingCv = array_values(array_filter($docs, static fn (DoctorApplicationDocument $d): bool => $d->getSlot() !== 'curriculum_vitae'));
        $e = $this->errors(fn () => ApprovalInput::validate($this->body($missingCv), $app, $missingCv, self::TODAY, self::list()));
        $this->assertSame('The application has no Curriculum vitae. Request it from the applicant first.', $e['documents']);

        $body = $this->body($docs);
        $lic  = $docs[3]->getId();
        $body['documents'][$lic] = ['checked' => false, 'register_reference' => '', 'number' => '', 'expires_on' => '2026-10-22'];
        $e = $this->errors(fn () => ApprovalInput::validate($body, $app, $docs, self::TODAY, self::list()));
        $this->assertArrayHasKey("documents.{$lic}.checked", $e);
        $this->assertArrayHasKey("documents.{$lic}.register_reference", $e);
        $this->assertArrayHasKey("documents.{$lic}.number", $e, 'a licence needs its number');
        $this->assertArrayHasKey("documents.{$lic}.expires_on", $e, 'an expired licence');

        $ind = $docs[5]->getId();
        unset($body['documents'][$lic]);
        $body['documents'][$ind]['expires_on'] = null;
        $e = $this->errors(fn () => ApprovalInput::validate($body, $app, $docs, self::TODAY, self::list()));
        $this->assertArrayHasKey("documents.{$ind}.expires_on", $e, 'indemnity needs its expiry');
    }

    public function testTheCertificateOfGoodStandingAge(): void
    {
        [$app, $docs] = $this->application('abroad');
        $gs   = $docs[0]->getId();
        $body = $this->body($docs);
        $body['documents'][$gs]['issued_on'] = '2026-04-22';
        $e = $this->errors(fn () => ApprovalInput::validate($body, $app, $docs, self::TODAY, self::list()));
        $this->assertSame('This certificate is more than 6 months old. Request a newer one.', $e["documents.{$gs}.issued_on"]);
        $body['documents'][$gs]['issued_on'] = '2026-04-23';
        $this->assertSame([], $this->errors(fn () => ApprovalInput::validate($body, $app, $docs, self::TODAY, self::list())));
        $this->assertSame('the General Medical Council register', ApprovalInput::registerName($app));
        $body['attest'] = false;
        $this->assertStringContainsString('General Medical Council register', $this->errors(fn () => ApprovalInput::validate($body, $app, $docs, self::TODAY, self::list()))['attest']);
    }

    public function testAdditionalDocumentsAreNotCarried(): void
    {
        [$app, $docs] = $this->application('ng');
        $extra   = new DoctorApplicationDocument($app->getId(), 'additional', 'applications/' . bin2hex(random_bytes(16)) . '.bin', 'x.pdf', 'application/pdf', 1, str_repeat('b', 64), 'info_response', null, 'Letter');
        $all     = [...$docs, $extra];
        $this->assertCount(6, ApprovalInput::carried($all));
        $this->assertSame([], ApprovalInput::problems($app, $all, self::list()));
    }
}
