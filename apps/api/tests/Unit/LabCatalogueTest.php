<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Lab\LabCatalogue;
use PHPUnit\Framework\TestCase;

/**
 * The bundled lab catalogue (lab spec §1.6): 80 active items in five groups,
 * the Quick add order, microbiology fixed by its site, the imaging safety
 * flags exactly as signed off, the copy fixes, and a broken file refused.
 */
final class LabCatalogueTest extends TestCase
{
    use LabFixtures;

    public function testTheCatalogueHasEightyItemsInFiveGroups(): void
    {
        $c     = self::catalogue();
        $items = $c->items();
        $this->assertSame(LabCatalogue::VERSION, $c->version());
        $this->assertCount(80, $items);
        $byCategory = array_count_values(array_column($items, 'category'));
        $this->assertSame(['routine_panel' => 6, 'single_test' => 20, 'microbiology' => 24, 'imaging' => 23, 'physiological' => 7], $byCategory);
        $codes = array_column($items, 'code');
        $this->assertSame($codes, array_values(array_unique($codes)));
        $this->assertSame(['FBC', 'MP', 'RBS', 'HIV', 'WIDAL', 'UA', 'HBSAG'], $c->quickAdd());
        $common = array_column(array_filter($items, static fn (array $i): bool => $i['common']), 'code');
        sort($common);
        $quick = $c->quickAdd();
        sort($quick);
        $this->assertSame($quick, $common, 'the common items are the Quick add ones');
    }

    public function testMicrobiologyImagingAndSafetyFlags(): void
    {
        $c = self::catalogue();
        foreach ($c->items() as $i) {
            if ($i['category'] === 'microbiology') {
                $this->assertNotNull($i['site'], $i['code']);
                $this->assertSame($c->site((string) $i['site'])['specimen'], $i['default_specimen'], $i['code']);
            }
            if ($i['kind'] === 'imaging') {
                $this->assertNotNull($i['modality'], $i['code']);
                $this->assertNotNull($c->preparation((string) $i['default_preparation']), $i['code']);
            } else {
                $this->assertFalse($i['ionising'], $i['code']);
                $this->assertFalse($i['contrast_possible'], $i['code']);
            }
        }
        $contrast = array_column(array_filter($c->items(), static fn (array $i): bool => $i['contrast_possible']), 'code');
        sort($contrast);
        $this->assertSame(['CT-AP', 'CT-CHEST', 'CT-CTPA', 'CT-HEAD', 'MRI-BRAIN', 'MRI-CARDIAC', 'MRI-KNEE', 'MRI-LSPINE', 'OT-FLUORO'], $contrast);
        $ionising = array_column(array_filter($c->items(), static fn (array $i): bool => $i['ionising']), 'code');
        sort($ionising);
        $this->assertSame(['CT-AP', 'CT-CHEST', 'CT-CTPA', 'CT-HEAD', 'OT-DEXA', 'OT-FLUORO', 'OT-MAMMO', 'XR-ABDO', 'XR-CHEST', 'XR-HAND', 'XR-KNEE', 'XR-LSPINE', 'XR-PELVIS'], $ionising);
        $this->assertSame(8, $c->item('FBS')['fasting_hours']);
        $this->assertSame(10, $c->item('LIPID')['fasting_hours']);
        $this->assertSame('fasting', $c->item('US-ABDO')['default_preparation']);
        $this->assertSame('full_bladder', $c->item('US-OBS')['default_preparation']);
    }

    public function testLabelsCopyAndPreparations(): void
    {
        $c = self::catalogue();
        $this->assertSame('HbA1c', $c->item('HBA1C')['label']);
        $this->assertSame('MRI - Knee', $c->item('MRI-KNEE')['label']);
        $this->assertSame('Gram stain - Blood', $c->item('GRAM-BLOOD')['label']);
        $this->assertSame('HIV screening', $c->item('HIV')['label']);
        $this->assertSame('ECG (12-lead)', $c->item('ECG12')['label']);
        $this->assertSame('Full bladder', $c->preparation('full_bladder')['label']);
        foreach (['full_bladder', 'fasting', 'bowel_prep'] as $code) {
            $this->assertNotNull($c->preparation($code)['patient_text'], $code);
        }
        $this->assertNull($c->preparation('none')['patient_text']);
        $this->assertCount(12, $c->manualSpecimens(), 'blood culture bottles are set by the site only');
        $options = $c->options();
        $this->assertSame(['catalogue_version', 'priorities', 'purposes', 'categories', 'sites', 'modalities', 'specimens', 'preparations', 'infection_alerts', 'mobility', 'items', 'limits'], array_keys($options));
        $this->assertSame(['code', 'kind', 'category', 'modality', 'site', 'label', 'name', 'short', 'synonyms', 'common', 'default_specimen', 'fasting_hours', 'default_preparation', 'contrast_possible', 'ionising'], array_keys($options['items'][0]));
        $this->assertSame('Others', $options['modalities'][4]['label']);
        $this->assertSame(['value' => 'stat', 'label' => 'STAT', 'subtitle' => 'Under 1 hour'], $options['priorities'][2]);
    }

    public function testARetiredCodeIsNotOffered(): void
    {
        $data = json_decode((string) file_get_contents(LabCatalogue::defaultPath()), true);
        $data['items'][0]['active'] = false;
        $c = new LabCatalogue($this->write($data));
        $this->assertNull($c->item($data['items'][0]['code']));
        $this->assertCount(79, $c->items());
    }

    public function testABrokenFileIsRefused(): void
    {
        $data = json_decode((string) file_get_contents(LabCatalogue::defaultPath()), true);
        $dup  = $data;
        $dup['items'][] = $data['items'][0];
        $unknown = $data;
        $unknown['items'][0]['default_specimen'] = 'saliva';
        $ionisingLab = $data;
        $ionisingLab['items'][0]['ionising'] = true;
        foreach (['duplicate code' => $dup, 'unknown specimen' => $unknown, 'ionising lab test' => $ionisingLab] as $why => $bad) {
            try {
                new LabCatalogue($this->write($bad));
                $this->fail('accepted a catalogue with a ' . $why);
            } catch (\RuntimeException $e) {
                $this->assertStringStartsWith('Invalid lab catalogue', $e->getMessage(), $why);
            }
        }
        $this->expectException(\RuntimeException::class);
        new LabCatalogue(sys_get_temp_dir() . '/no-such-lab-catalogue.json');
    }

    /** @param array<string,mixed> $data */
    private function write(array $data): string
    {
        $path = (string) tempnam(sys_get_temp_dir(), 'labcat');
        file_put_contents($path, json_encode($data));
        register_shutdown_function(static fn () => @unlink($path));

        return $path;
    }
}
