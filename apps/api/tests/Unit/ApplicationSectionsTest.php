<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Application\ApplicationSections as Sections;
use App\Domain\Application\NameFold;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * The form's rules (spec §2.11), pinned by the shared fixture
 * fixtures/doctor-applications/validation-cases.json — the same cases the
 * onboarding UI's validators.spec.ts runs — plus the stored values.
 */
final class ApplicationSectionsTest extends TestCase
{
    private const FIXTURE = __DIR__ . '/../../../../fixtures/doctor-applications/validation-cases.json';

    /** @return iterable<string, array{array<string,mixed>}> */
    public static function cases(): iterable
    {
        $cases = json_decode((string) file_get_contents(self::FIXTURE), true, flags: JSON_THROW_ON_ERROR);
        foreach ($cases as $i => $case) {
            yield sprintf('#%03d %s', $i, $case['title']) => [$case];
        }
    }

    /** @param array<string,mixed> $case */
    #[DataProvider('cases')]
    public function testTheSharedFixture(array $case): void
    {
        $specialties = $case['context']['specialties'] ?? null;
        $resolver    = $specialties === null ? null : self::resolver($specialties);
        $result      = Sections::validate($case['section'], $case['values'], $case['route'], $case['today'], $case['partial'], $resolver, $case['context']['personal'] ?? []);

        $expected = $case['errors'];
        ksort($expected);
        $actual = $result['errors'];
        ksort($actual);
        $this->assertSame($expected, $actual);
    }

    public function testTheFixtureCoversEveryRule(): void
    {
        $cases    = json_decode((string) file_get_contents(self::FIXTURE), true);
        $messages = [];
        foreach ($cases as $c) {
            foreach ($c['errors'] as $m) {
                $messages[preg_replace('/\d+ \w+ \d{4}/', 'DATE', $m)] = true;
            }
        }
        foreach (Sections::M as $key => $message) {
            $this->assertArrayHasKey(str_replace('%s', 'DATE', $message), $messages, "fixture has no case for {$key}");
        }
    }

    public function testStoredValuesAreNormalised(): void
    {
        $r = Sections::validate('personal', [
            'first_name' => "  A\u{0000}da ", 'last_name' => 'Obi', 'email' => ' Ada.Obi@Example.COM ', 'phone' => '0803 123 4567',
            'date_of_birth' => '1985-03-12', 'gender' => 'female', 'country_of_residence' => 'NG', 'city' => ' Lagos ',
        ], 'ng', '2026-10-23', false);
        $this->assertSame([], $r['errors']);
        $this->assertSame('Ada', $r['values']['first_name']);
        $this->assertSame('ada.obi@example.com', $r['values']['email']);
        $this->assertSame('+2348031234567', $r['values']['phone']);
        $this->assertSame('Lagos', $r['values']['city']);

        $r = Sections::validate('professional', [
            'specialty' => '  cardiology ', 'years_experience' => 12.0, 'languages' => ['English', 'English', 'Yoruba'], 'bio' => str_repeat('a', 40),
        ], 'ng', '2026-10-23', false, self::resolver(['Cardiology']));
        $this->assertSame([], $r['errors']);
        $this->assertSame('Cardiology', $r['values']['specialty'], 'the list spelling is kept');
        $this->assertSame(12, $r['values']['years_experience']);
        $this->assertSame(['English', 'Yoruba'], $r['values']['languages']);
        $this->assertNull($r['values']['workplace']);

        $r = Sections::validate('licence', ['mdcn_number' => 'mdcn/1', 'full_registration_year' => 2012, 'licence_expires_on' => '2027-01-01'], 'ng', '2026-10-23', false);
        $this->assertSame('MDCN/1', $r['values']['mdcn_number']);
    }

    public function testQualificationsNeedOneToTenEntries(): void
    {
        $entry = ['degree' => 'MBBS', 'institution' => 'University of Lagos', 'year_awarded' => 2010];
        $this->assertSame(['entries' => 'Add your primary medical degree.'], Sections::validate('qualifications', ['entries' => []], 'ng', '2026-10-23', false)['errors']);
        $this->assertSame([], Sections::validate('qualifications', ['entries' => []], 'ng', '2026-10-23', true)['errors'], 'partial: none yet is fine');
        $this->assertSame(['entries' => 'You can add up to 10 qualifications.'], Sections::validate('qualifications', ['entries' => array_fill(0, 11, $entry)], 'ng', '2026-10-23', true)['errors']);
    }

    public function testTheCertificateOfGoodStandingWindowClampsToTheMonthEnd(): void
    {
        $this->assertSame('2026-04-23', Sections::goodStandingEarliest('2026-10-23'));
        $this->assertSame('2026-02-28', Sections::goodStandingEarliest('2026-08-31'));
        $this->assertSame('2028-02-29', Sections::goodStandingEarliest('2028-08-31'));
        $this->assertSame('2025-07-31', Sections::goodStandingEarliest('2026-01-31'));
        $this->assertSame('3 March 2026', Sections::longDate('2026-03-03'));
    }

    public function testANigerianRegulatorIsRefusedOnTheAbroadRoute(): void
    {
        $r = Sections::validate('licence', ['regulator_country' => 'NG'], 'abroad', '2026-10-23', true);
        $this->assertSame(['regulator_country' => 'For a Nigerian licence, go back and choose Nigeria.'], $r['errors']);
    }

    public function testConsentNeedsBothNamesInTheSignatureAndPartialSkipsTicks(): void
    {
        $values = ['accept_terms' => true, 'authorise_verification' => true, 'confirm_accurate' => true, 'signature_name' => 'Ada Obi', 'consent_version' => '2026-10'];
        $this->assertSame([], Sections::validate('consent', $values, 'ng', '2026-10-23', false, null, ['first_name' => 'Ada', 'last_name' => 'Obi'])['errors']);
        $this->assertArrayHasKey('signature_name', Sections::validate('consent', $values, 'ng', '2026-10-23', false, null, [])['errors'], 'no names on file: no match');
        $this->assertSame([], Sections::validate('consent', ['accept_terms' => false], 'ng', '2026-10-23', true)['errors']);
        $this->assertTrue(Sections::isComplete('consent', $values, 'ng', '2026-10-23', null, ['first_name' => 'Ada', 'last_name' => 'Obi']));
    }

    public function testAccentFoldingWithoutIconvOrIntl(): void
    {
        $this->assertSame('olatunde adebayo', NameFold::fold('Ọlátúndé  ADÉBÁYỌ'));
        $this->assertSame('adebayo ola', NameFold::fold("Ade\u{0301}ba\u{0301}yo\u{0323} O\u{0323}la"), 'combining marks typed separately');
        $this->assertSame('zoe emile celik', NameFold::fold('Zoë Émile Çelik'));
        $this->assertSame('łukasz', NameFold::fold('Łukasz'), 'no decomposition: kept, as NFD keeps it');
    }

    public function testTheLanguageListEqualsTheContract(): void
    {
        $this->assertSame(
            json_decode((string) file_get_contents(__DIR__ . '/../../../../fixtures/doctor-applications/application-languages.json'), true),
            Sections::LANGUAGES,
        );
    }

    /** @param list<string> $labels @return callable(string): ?string */
    private static function resolver(array $labels): callable
    {
        return static function (string $value) use ($labels): ?string {
            $key = mb_strtolower(trim((string) preg_replace('/\s+/u', ' ', $value)));
            foreach ($labels as $label) {
                if (mb_strtolower($label) === $key) {
                    return $label;
                }
            }

            return null;
        };
    }
}
