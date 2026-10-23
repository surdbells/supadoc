<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Application\ApplicationSections;
use App\Domain\Contact\Countries;
use PHPUnit\Framework\TestCase;

/** Spec §9.1: the API's lists equal the Wave 0 fixtures the UI is tested against too. */
final class ApplicationFixturesParityTest extends TestCase
{
    private const DIR = __DIR__ . '/../../../../fixtures/doctor-applications/';

    public function testCountriesEqualTheFixture(): void
    {
        $fixture = json_decode((string) file_get_contents(self::DIR . 'world-countries.json'), true, flags: JSON_THROW_ON_ERROR);
        $mine    = [];
        foreach (Countries::ALL as $iso => $c) {
            $row = ['iso' => $iso, 'name' => $c['name'], 'dial' => $c['dial']];
            if (in_array($iso, Countries::PRIMARY, true)) {
                $row['primary'] = true;
            }
            $mine[] = $row;
        }
        $this->assertSame($fixture, $mine, 'same entries, same order');
        $this->assertSame('NG', array_key_first(Countries::ALL));
        foreach (Countries::ALL as $iso => $c) {
            $this->assertMatchesRegularExpression('/^\+\d{1,4}$/', $c['dial'], $iso);
        }
        $this->assertFalse(Countries::exists('AQ'), 'no dial code, dropped');
        $this->assertSame('United Kingdom', Countries::name('GB'));
    }

    public function testExactlyOnePrimaryPerSharedCode(): void
    {
        $byDial = [];
        foreach (Countries::ALL as $iso => $c) {
            $byDial[$c['dial']][] = $iso;
        }
        foreach ($byDial as $dial => $isos) {
            if (count($isos) > 1) {
                $this->assertCount(1, array_intersect($isos, Countries::PRIMARY), "one primary for {$dial}");
            }
        }
    }

    public function testLanguagesEqualTheFixture(): void
    {
        $this->assertSame(json_decode((string) file_get_contents(self::DIR . 'application-languages.json'), true), ApplicationSections::LANGUAGES);
    }
}
