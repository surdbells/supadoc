<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Lab\LabRequestRules;
use App\Domain\Settings\ClinicTime;
use DateTimeImmutable;
use DateTimeZone;
use PHPUnit\Framework\TestCase;

/**
 * The pure lab rules (lab spec §1.11): who is asked about pregnancy, the
 * validity calendar date, the pregnancy warning, the parenthesised list
 * filters, the advisory-lock namespace, the default result type and the
 * patient's preparation list.
 */
final class LabRequestRulesTest extends TestCase
{
    use LabFixtures;

    public function testWhoIsAskedAboutPregnancy(): void
    {
        $today = new DateTimeImmutable('2026-11-04');
        $age   = static fn (int $years): DateTimeImmutable => $today->modify("-{$years} years");
        $this->assertTrue(LabRequestRules::asksPregnancy('female', $age(30), $today));
        $this->assertTrue(LabRequestRules::asksPregnancy('Female', null, $today), 'female, no date of birth');
        $this->assertFalse(LabRequestRules::asksPregnancy('male', $age(30), $today));
        $this->assertFalse(LabRequestRules::asksPregnancy('m', null, $today));
        $this->assertFalse(LabRequestRules::asksPregnancy('female', $age(60), $today));
        foreach ([null, 'other', 'non-binary', ''] as $gender) {
            $this->assertTrue(LabRequestRules::asksPregnancy($gender, null, $today), var_export($gender, true) . ' with no date of birth');
            $this->assertTrue(LabRequestRules::asksPregnancy($gender, $age(25), $today), var_export($gender, true) . ' at 25');
            $this->assertFalse(LabRequestRules::asksPregnancy($gender, $age(60), $today), var_export($gender, true) . ' at 60');
        }
    }

    public function testValidityIsAClinicCalendarDateEndingAtTheNextClinicMidnight(): void
    {
        foreach (['UTC', 'PRC', 'America/Chicago'] as $process) {
            $zone = date_default_timezone_get();
            date_default_timezone_set($process);
            try {
                $sent = new DateTimeImmutable('2026-11-04 23:30', ClinicTime::zone());
                $v    = LabRequestRules::validity($sent);
                $this->assertSame('2026-12-04', $v['valid_until']->format('Y-m-d'), $process);
                $this->assertSame('2026-12-05 00:00', $v['expires_at']->setTimezone(ClinicTime::zone())->format('Y-m-d H:i'), $process);
                $this->assertSame($process, $v['expires_at']->getTimezone()->getName(), 'on the process clock');
                $this->assertSame('4 Dec 2026', LabRequestRules::dateLabel($v['valid_until']));
            } finally {
                date_default_timezone_set($zone);
            }
        }
        $this->assertSame('2026-11-05', LabRequestRules::validity(new DateTimeImmutable('2026-10-06 23:59:59', ClinicTime::zone()))['valid_until']->format('Y-m-d'));
        $this->assertNull(LabRequestRules::parseDate('2026-02-30'));
        $this->assertNull(LabRequestRules::parseDate('4 Nov 2026'));
        $this->assertSame('2026-11-04', LabRequestRules::parseDate('2026-11-04')?->format('Y-m-d'));
    }

    public function testThePregnancyWarning(): void
    {
        $c    = self::catalogue();
        $item = static fn (string $code): array => (array) $c->item($code);
        $this->assertTrue(LabRequestRules::pregnancyWarning(true, [$item('XR-CHEST')]));
        $this->assertTrue(LabRequestRules::pregnancyWarning(true, [$item('CT-HEAD')]));
        $this->assertTrue(LabRequestRules::pregnancyWarning(true, [$item('MRI-KNEE')]), 'contrast possible');
        $this->assertFalse(LabRequestRules::pregnancyWarning(true, [$item('US-OBS'), $item('FBC')]));
        $this->assertFalse(LabRequestRules::pregnancyWarning(false, [$item('XR-CHEST')]));
        $this->assertFalse(LabRequestRules::pregnancyWarning(null, [$item('XR-CHEST')]));
        $r = self::labRequest(['items' => [['code' => 'OT-MAMMO']], 'imaging_safety' => ['contrast_allergy' => 'no', 'mobility' => 'walking']]);
        $this->assertTrue(LabRequestRules::pregnancyWarning(true, $r->getItems()), 'request items too');
    }

    public function testEveryGroupFilterIsOneParenthesisedFragment(): void
    {
        $this->assertSame(LabRequestRules::GROUPS, array_keys(LabRequestRules::GROUP_SQL));
        foreach (LabRequestRules::GROUP_SQL as $group => $sql) {
            $this->assertStringStartsWith('(', $sql, $group);
            $depth = 0;
            $len   = strlen($sql);
            for ($i = 0; $i < $len; ++$i) {
                $depth += $sql[$i] === '(' ? 1 : ($sql[$i] === ')' ? -1 : 0);
                if ($depth === 0) {
                    $this->assertSame($len - 1, $i, "{$group}: the outermost parentheses close at the end");
                }
            }
            $this->assertStringNotContainsString('NOW()', strtoupper($sql));
        }
    }

    public function testTheLockNamespaceIsItsOwn(): void
    {
        $others = [
            \App\Infrastructure\Service\SlotLock::NAMESPACE,
            \App\Infrastructure\Document\DocumentAccessSweeper::SWEEP_LOCK,
            \App\Infrastructure\Application\DoctorApplicationService::LOCK_APPLICATION,
            \App\Infrastructure\Application\DoctorApplicationService::LOCK_EMAIL,
            \App\Infrastructure\Application\DoctorApplicationService::LOCK_REFERENCE,
            (new \ReflectionClassConstant(\App\Infrastructure\Document\DocumentSharingService::class, 'LOCK_NAMESPACE'))->getValue(),
            (new \ReflectionClassConstant(\App\Infrastructure\Drug\DrugCatalogueImporter::class, 'LOCK_ID'))->getValue(),
        ];
        $this->assertNotContains(LabRequestRules::LOCK_NAMESPACE, $others);
        // …and every advisory lock in src/ names a constant (no literal that could collide).
        foreach (new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator(dirname(__DIR__, 2) . '/src')) as $file) {
            if ($file->isFile() && $file->getExtension() === 'php') {
                $src = (string) file_get_contents($file->getPathname());
                $this->assertDoesNotMatchRegularExpression('/pg_(try_)?advisory_(xact_)?lock\(' . LabRequestRules::LOCK_NAMESPACE . '\b/', $src, $file->getFilename());
            }
        }
    }

    public function testTheDefaultResultType(): void
    {
        $type = static fn (array $codes, array $safety = ['contrast_allergy' => 'no', 'mobility' => 'walking']): string => LabRequestRules::defaultDocumentType(
            self::labRequest(['items' => array_map(static fn (string $c): array => ['code' => $c], $codes), 'imaging_safety' => $safety])->getItems(),
        );
        $this->assertSame('laboratory_test_report', $type(['FBC', 'MP']));
        $this->assertSame('xray_report', $type(['XR-CHEST', 'XR-KNEE']));
        $this->assertSame('ultrasound_report', $type(['US-OBS']));
        $this->assertSame('ct_scan_report', $type(['CT-HEAD']));
        $this->assertSame('mri_report', $type(['MRI-BRAIN']));
        $this->assertSame('radiology_report', $type(['OT-DEXA']));
        $this->assertSame('radiology_report', $type(['XR-CHEST', 'CT-HEAD']));
        $this->assertSame('ecg_report', $type(['ECG12']));
        $this->assertSame('echocardiogram_report', $type(['ECHO-TTE', 'ECHO-TOE']));
        $this->assertSame('laboratory_test_report', $type(['ECG12', 'SPIRO']));
        $this->assertSame('laboratory_test_report', $type(['FBC', 'XR-CHEST']));
        foreach (LabRequestRules::RESULT_DOCUMENT_TYPES as $t) {
            $this->assertTrue(\App\Domain\Document\DocumentType::isValid($t), $t);
        }
    }

    public function testThePatientsPreparationList(): void
    {
        $r = self::labRequest([
            'items'          => [['code' => 'LIPID'], ['code' => 'US-ABDO'], ['code' => 'US-PELVIS'], ['code' => 'US-OBS'], ['code' => 'CT-HEAD']],
            'imaging_safety' => ['contrast_allergy' => 'yes', 'mobility' => 'walking'],
            'clinical'       => ['fasting' => true, 'fasting_hours' => 10, 'infection_alerts' => []],
        ]);
        $list = LabRequestRules::patientInstructions($r, self::catalogue());
        $this->assertSame(['fasting', 'preparation_fasting', 'preparation_full_bladder', 'contrast', 'bring'], array_column($list, 'key'));
        $this->assertSame("Don't eat or drink anything except water for 10 hours before your sample is taken.", $list[0]['text']);
        $this->assertSame('Show the request PDF at the lab, on your phone or printed, with a photo ID.', end($list)['text']);
        $this->assertSame(['bring'], array_column(LabRequestRules::patientInstructions(self::labRequest(), self::catalogue()), 'key'));
        $statements = LabRequestRules::consentStatements('Dr. James Smith');
        $this->assertSame(['tests', 'pays_lab', 'lab_disclosure', 'share_results'], array_column($statements, 'key'));
        $this->assertSame([true, true, true, false], array_column($statements, 'required'));
        $this->assertSame([false, false, false, true], array_column($statements, 'default'));
        $this->assertStringContainsString('with Dr. James Smith.', $statements[3]['text']);
    }
}
