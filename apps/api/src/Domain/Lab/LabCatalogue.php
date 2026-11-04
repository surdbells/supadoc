<?php

declare(strict_types=1);

namespace App\Domain\Lab;

/**
 * The versioned lab & diagnostics catalogue (spec §1.6): tests, panels,
 * microbiology, imaging studies and physiological tests, with their default
 * specimens, imaging preparations and safety flags — loaded from
 * `resources/lab/catalogue-<version>.json` and validated on load (a bad file
 * throws, so the container never serves a broken list).
 *
 * A future catalogue is a new file and a version bump; a request keeps its own
 * snapshot of every item and the `catalogue_version` it was sent with. Retired
 * codes stay in the file with `"active": false` ({@see item()} ignores them).
 */
final class LabCatalogue
{
    public const VERSION = '2026-11.1';

    public const KINDS      = ['lab', 'imaging', 'physiological'];
    public const CATEGORIES = ['routine_panel', 'single_test', 'microbiology', 'imaging', 'physiological'];
    public const MODALITIES = ['x_ray' => 'X-Ray', 'ultrasound' => 'Ultrasound', 'ct' => 'CT', 'mri' => 'MRI', 'other' => 'Others'];
    public const SITES      = ['urine', 'blood', 'stool', 'sputum', 'wound_swab', 'csf'];
    public const PREPARATIONS = ['none', 'full_bladder', 'fasting', 'bowel_prep'];

    /** @var array<string, array<string,mixed>> code => item (every item, active or not) */
    private array $items = [];

    /** @var array<string, array{code:string, label:string, manual:bool}> */
    private array $specimens = [];

    /** @var array<string, array{code:string, label:string, specimen:string}> */
    private array $sites = [];

    /** @var array<string, array{code:string, label:string, patient_text:?string}> */
    private array $preparations = [];

    /** @var list<string> */
    private array $quickAdd = [];

    private string $version;

    public function __construct(string $path)
    {
        $raw = @file_get_contents($path);
        if ($raw === false) {
            throw new \RuntimeException('Lab catalogue not found: ' . basename($path));
        }
        $data = json_decode($raw, true);
        if (!is_array($data)) {
            throw new \RuntimeException('Lab catalogue is not valid JSON: ' . basename($path));
        }
        $this->load($data);
    }

    /** The bundled catalogue (resources/lab/catalogue-{VERSION}.json). */
    public static function defaultPath(): string
    {
        return dirname(__DIR__, 3) . '/resources/lab/catalogue-' . self::VERSION . '.json';
    }

    public function version(): string
    {
        return $this->version;
    }

    /** An active item by code, or null (unknown or retired). @return array<string,mixed>|null */
    public function item(string $code): ?array
    {
        $item = $this->items[strtoupper(trim($code))] ?? null;

        return $item !== null && $item['active'] ? $item : null;
    }

    /** Every active item, in catalogue order. @return list<array<string,mixed>> */
    public function items(): array
    {
        return array_values(array_filter($this->items, static fn (array $i): bool => (bool) $i['active']));
    }

    /** @return array{code:string, label:string, manual:bool}|null */
    public function specimen(string $code): ?array
    {
        return $this->specimens[$code] ?? null;
    }

    /** The "Choose manually" list. @return list<array{code:string, label:string, manual:bool}> */
    public function manualSpecimens(): array
    {
        return array_values(array_filter($this->specimens, static fn (array $s): bool => $s['manual']));
    }

    /** @return array{code:string, label:string, patient_text:?string}|null */
    public function preparation(string $code): ?array
    {
        return $this->preparations[$code] ?? null;
    }

    /** @return array{code:string, label:string, specimen:string}|null */
    public function site(string $code): ?array
    {
        return $this->sites[$code] ?? null;
    }

    /** The Quick add codes, in their order (LD §3.4). @return list<string> */
    public function quickAdd(): array
    {
        return $this->quickAdd;
    }

    /**
     * The `/doctor/lab-requests/options` payload (LabOptionsDto) minus
     * `has_signature`: fixed lists, the catalogue and the form limits.
     *
     * @return array<string,mixed>
     */
    public function options(): array
    {
        return [
            'catalogue_version' => $this->version,
            'priorities'        => array_map(
                static fn (string $v, array $p): array => ['value' => $v, 'label' => $p[0], 'subtitle' => $p[1]],
                array_keys(LabRequestRules::PRIORITIES),
                LabRequestRules::PRIORITIES,
            ),
            'purposes'          => self::pairs(LabRequestRules::PURPOSES),
            'categories'        => self::pairs(LabRequestRules::LAB_CATEGORIES),
            'sites'             => array_values(array_map(static fn (array $s): array => ['value' => $s['code'], 'label' => $s['label'], 'specimen' => $s['specimen']], $this->sites)),
            'modalities'        => self::pairs(self::MODALITIES),
            'specimens'         => array_values(array_map(static fn (array $s): array => ['value' => $s['code'], 'label' => $s['label'], 'manual' => $s['manual']], $this->specimens)),
            'preparations'      => array_values(array_map(static fn (array $p): array => ['value' => $p['code'], 'label' => $p['label'], 'patient_text' => $p['patient_text']], $this->preparations)),
            'infection_alerts'  => self::pairs(LabRequestRules::INFECTION_ALERTS),
            'mobility'          => self::pairs(LabRequestRules::MOBILITY),
            'items'             => array_map(static fn (array $i): array => [
                'code'                => $i['code'],
                'kind'                => $i['kind'],
                'category'            => $i['category'],
                'modality'            => $i['modality'],
                'site'                => $i['site'],
                'label'               => $i['label'],
                'name'                => $i['name'],
                'short'               => $i['short'],
                'synonyms'            => $i['synonyms'],
                'common'              => $i['common'],
                'default_specimen'    => $i['default_specimen'],
                'fasting_hours'       => $i['fasting_hours'],
                'default_preparation' => $i['default_preparation'],
                'contrast_possible'   => $i['contrast_possible'],
                'ionising'            => $i['ionising'],
            ], $this->items()),
            'limits'            => [
                'max_items'      => LabRequestRules::MAX_ITEMS,
                'question_min'   => LabRequestRules::QUESTION_MIN,
                'question_max'   => LabRequestRules::QUESTION_MAX,
                'text_max'       => LabRequestRules::TEXT_MAX,
                'fasting_hours'  => LabRequestRules::FASTING_HOURS,
                'weeks_pregnant' => LabRequestRules::WEEKS_PREGNANT,
                'comment_max'    => LabRequestRules::COMMENT_MAX,
                'reason_max'     => LabRequestRules::REASON_MAX,
            ],
        ];
    }

    /** @param array<string,string> $map @return list<array{value:string, label:string}> */
    private static function pairs(array $map): array
    {
        $out = [];
        foreach ($map as $value => $label) {
            $out[] = ['value' => (string) $value, 'label' => $label];
        }

        return $out;
    }

    /** @param array<string,mixed> $data */
    private function load(array $data): void
    {
        $fail = static function (string $why): never {
            throw new \RuntimeException('Invalid lab catalogue: ' . $why);
        };
        $this->version = is_string($data['version'] ?? null) && $data['version'] !== '' ? $data['version'] : $fail('no version');

        foreach ((array) ($data['specimens'] ?? []) as $s) {
            $code = is_array($s) && is_string($s['code'] ?? null) ? $s['code'] : $fail('a specimen has no code');
            if (isset($this->specimens[$code])) {
                $fail('duplicate specimen ' . $code);
            }
            $this->specimens[$code] = ['code' => $code, 'label' => (string) ($s['label'] ?? $code), 'manual' => (bool) ($s['manual'] ?? false)];
        }
        foreach ((array) ($data['sites'] ?? []) as $s) {
            $code = is_array($s) && is_string($s['code'] ?? null) ? $s['code'] : $fail('a site has no code');
            if (!in_array($code, self::SITES, true)) {
                $fail('unknown site ' . $code);
            }
            if (!isset($this->specimens[(string) ($s['specimen'] ?? '')])) {
                $fail('site ' . $code . ' names an unknown specimen');
            }
            $this->sites[$code] = ['code' => $code, 'label' => (string) ($s['label'] ?? $code), 'specimen' => (string) $s['specimen']];
        }
        foreach ((array) ($data['preparations'] ?? []) as $p) {
            $code = is_array($p) && is_string($p['code'] ?? null) ? $p['code'] : $fail('a preparation has no code');
            if (!in_array($code, self::PREPARATIONS, true)) {
                $fail('unknown preparation ' . $code);
            }
            $text = $p['patient_text'] ?? null;
            $this->preparations[$code] = ['code' => $code, 'label' => (string) ($p['label'] ?? $code), 'patient_text' => is_string($text) && $text !== '' ? $text : null];
        }
        if (!isset($this->preparations['none'])) {
            $fail('the "none" preparation is missing');
        }

        foreach ((array) ($data['items'] ?? []) as $i) {
            $code = is_array($i) && is_string($i['code'] ?? null) && $i['code'] !== '' ? $i['code'] : $fail('an item has no code');
            if ($code !== strtoupper($code)) {
                $fail('item code ' . $code . ' is not upper-case');
            }
            if (isset($this->items[$code])) {
                $fail('duplicate item ' . $code);
            }
            $kind     = (string) ($i['kind'] ?? '');
            $category = (string) ($i['category'] ?? '');
            if (!in_array($kind, self::KINDS, true) || !in_array($category, self::CATEGORIES, true)) {
                $fail('item ' . $code . ' has an unknown kind or category');
            }
            $imaging = $kind === 'imaging';
            if ($imaging !== ($category === 'imaging') || ($kind === 'physiological') !== ($category === 'physiological')) {
                $fail('item ' . $code . ': kind and category disagree');
            }
            $modality = $i['modality'] ?? null;
            if ($imaging ? !isset(self::MODALITIES[(string) $modality]) : $modality !== null) {
                $fail('item ' . $code . ' has a wrong modality');
            }
            $site = $i['site'] ?? null;
            if ($category === 'microbiology' ? !isset($this->sites[(string) $site]) : $site !== null) {
                $fail('item ' . $code . ' has a wrong site');
            }
            $specimen = $i['default_specimen'] ?? null;
            if ($kind === 'lab' ? !isset($this->specimens[(string) $specimen]) : $specimen !== null) {
                $fail('item ' . $code . ' names an unknown specimen');
            }
            if ($category === 'microbiology' && $specimen !== $this->sites[(string) $site]['specimen']) {
                $fail('item ' . $code . ': a microbiology specimen is fixed by its site');
            }
            $prep = $i['default_preparation'] ?? null;
            if ($imaging ? !isset($this->preparations[(string) $prep]) : $prep !== null) {
                $fail('item ' . $code . ' names an unknown preparation');
            }
            $contrast = (bool) ($i['contrast_possible'] ?? false);
            $ionising = (bool) ($i['ionising'] ?? false);
            if (!$imaging && ($contrast || $ionising)) {
                $fail('item ' . $code . ': only imaging can be ionising or contrast-possible');
            }
            $fasting = $i['fasting_hours'] ?? null;
            if ($fasting !== null && (!is_int($fasting) || $fasting < LabRequestRules::FASTING_HOURS[0] || $fasting > LabRequestRules::FASTING_HOURS[1])) {
                $fail('item ' . $code . ' has bad fasting hours');
            }
            foreach (['label', 'name', 'short'] as $text) {
                if (!is_string($i[$text] ?? null) || trim($i[$text]) === '') {
                    $fail('item ' . $code . ' has no ' . $text);
                }
            }
            $this->items[$code] = [
                'code'                => $code,
                'kind'                => $kind,
                'category'            => $category,
                'modality'            => $modality !== null ? (string) $modality : null,
                'site'                => $site !== null ? (string) $site : null,
                'label'               => (string) $i['label'],
                'name'                => (string) $i['name'],
                'short'               => (string) $i['short'],
                'synonyms'            => array_values(array_map('strval', (array) ($i['synonyms'] ?? []))),
                'common'              => (bool) ($i['common'] ?? false),
                'default_specimen'    => $specimen !== null ? (string) $specimen : null,
                'fasting_hours'       => $fasting,
                'default_preparation' => $prep !== null ? (string) $prep : null,
                'contrast_possible'   => $contrast,
                'ionising'            => $ionising,
                'active'              => (bool) ($i['active'] ?? true),
            ];
        }
        if ($this->items === []) {
            $fail('no items');
        }
        foreach ((array) ($data['quick_add'] ?? []) as $code) {
            if (!is_string($code) || !isset($this->items[$code])) {
                $fail('quick add names an unknown item');
            }
            $this->quickAdd[] = $code;
        }
    }
}
