<?php

declare(strict_types=1);

namespace App\Domain\Lab;

use App\Domain\Exception\ValidationException;

/**
 * The doctor's lab request form (spec §2.2): validation against the catalogue
 * — every error at once, keyed as the composer's fields — and the canonical
 * form the send idempotency hash is taken over. Pure.
 */
final class LabRequestForm
{
    public const MESSAGE = 'Complete the request before sending';

    private const UUID_V4 = '/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i';

    /**
     * The normalised form, or a 422 with every error.
     *
     * @param array<string,mixed> $body
     * @return array<string,mixed>
     * @throws ValidationException
     */
    public static function validate(array $body, bool $asksPregnancy, LabCatalogue $c): array
    {
        [$form, $errors] = self::check($body, $asksPregnancy, $c);
        if ($errors !== []) {
            throw new ValidationException($errors, self::MESSAGE);
        }

        return $form;
    }

    public static function isClientKey(mixed $key): bool
    {
        return is_string($key) && preg_match(self::UUID_V4, trim($key)) === 1;
    }

    /**
     * The normalised form and the errors (empty when it is valid):
     * {priority, purpose, clinical_question, history, medication, allergies,
     * clinical_flags, items (catalogue snapshots), imaging_safety, signature_mode}.
     *
     * @param array<string,mixed> $body
     * @return array{0: array<string,mixed>, 1: array<string,string>}
     */
    public static function check(array $body, bool $asksPregnancy, LabCatalogue $c): array
    {
        $e = [];
        if (!self::isClientKey($body['client_key'] ?? null)) {
            $e['client_key'] = 'Send the form key';
        }
        if (!is_string($body['catalogue_version'] ?? null) || trim($body['catalogue_version']) === '') {
            $e['catalogue_version'] = 'Send the catalogue version';
        }

        $priority = is_string($body['priority'] ?? null) ? trim($body['priority']) : '';
        if (!isset(LabRequestRules::PRIORITIES[$priority])) {
            $e['priority'] = 'Choose a priority';
        }
        $purpose = self::text($body['purpose'] ?? null);
        if ($purpose !== null && !isset(LabRequestRules::PURPOSES[$purpose])) {
            $e['purpose'] = 'Choose a purpose from the list';
        }

        $question = self::text($body['clinical_question'] ?? null) ?? '';
        if (mb_strlen($question) < LabRequestRules::QUESTION_MIN) {
            $e['clinical_question'] = 'Add the provisional diagnosis or clinical question';
        } elseif (mb_strlen($question) > LabRequestRules::QUESTION_MAX) {
            $e['clinical_question'] = 'Use ' . LabRequestRules::QUESTION_MAX . ' characters or fewer';
        }
        $texts = [];
        foreach (['history', 'medication', 'allergies'] as $field) {
            $texts[$field] = self::text($body[$field] ?? null);
            if ($texts[$field] !== null && mb_strlen($texts[$field]) > LabRequestRules::TEXT_MAX) {
                $e[$field] = 'Use ' . LabRequestRules::TEXT_MAX . ' characters or fewer';
            }
        }

        // Items first: the clinical screen depends on whether imaging is requested.
        [$items, $itemErrors] = self::items($body['items'] ?? null, $c);
        $e += $itemErrors;
        $imaging = array_filter($items, static fn (array $i): bool => $i['kind'] === 'imaging') !== [];

        $clinical = is_array($body['clinical'] ?? null) ? $body['clinical'] : [];
        $fasting  = self::bool($clinical['fasting'] ?? null);
        $hours    = null;
        if ($fasting === true) {
            $hours = self::int($clinical['fasting_hours'] ?? null);
            if ($hours === null || $hours < LabRequestRules::FASTING_HOURS[0] || $hours > LabRequestRules::FASTING_HOURS[1]) {
                $e['clinical.fasting_hours'] = 'Enter fasting hours from 1 to 24';
            }
        }
        $pregnant = null;
        $weeks    = null;
        if ($asksPregnancy) {
            $pregnant = self::bool($clinical['pregnant'] ?? null);
            if ($pregnant === null && $imaging) {
                $e['clinical.pregnant'] = 'Answer Pregnant? for the imaging safety screen';
            }
            if ($pregnant === true) {
                $weeks = self::int($clinical['weeks_pregnant'] ?? null);
                if ($weeks === null || $weeks < LabRequestRules::WEEKS_PREGNANT[0] || $weeks > LabRequestRules::WEEKS_PREGNANT[1]) {
                    $e['clinical.weeks_pregnant'] = 'Enter weeks from 1 to 42';
                }
            }
        }
        $alerts = [];
        $raw    = $clinical['infection_alerts'] ?? [];
        if ($raw !== null && $raw !== []) {
            $list = is_array($raw) && array_is_list($raw) ? $raw : null;
            if ($list === null || count($list) !== count(array_unique(array_map('strval', $list)))
                || array_diff(array_map('strval', $list), array_keys(LabRequestRules::INFECTION_ALERTS)) !== []) {
                $e['clinical.infection_alerts'] = 'Choose from the list';
            } else {
                $alerts = array_values(array_intersect(array_keys(LabRequestRules::INFECTION_ALERTS), array_map('strval', $list)));
            }
        }

        $safety = null;
        if ($imaging) {
            $raw      = is_array($body['imaging_safety'] ?? null) ? $body['imaging_safety'] : [];
            $allergy  = is_string($raw['contrast_allergy'] ?? null) ? $raw['contrast_allergy'] : '';
            $mobility = is_string($raw['mobility'] ?? null) ? $raw['mobility'] : '';
            if (!isset(LabRequestRules::CONTRAST_ALLERGY[$allergy]) || !isset(LabRequestRules::MOBILITY[$mobility])) {
                $e['imaging_safety'] = 'Complete the imaging safety screen';
            }
            $safety = [
                'contrast_allergy' => $allergy,
                'mobility'         => $mobility,
                'pregnant'         => $asksPregnancy ? ($pregnant === true ? 'yes' : ($pregnant === false ? 'no' : 'na')) : 'na',
            ];
        }

        if (($body['attest'] ?? null) !== true) {
            $e['attest'] = 'Confirm these tests are clinically indicated';
        }
        $signature = is_array($body['signature'] ?? null) ? $body['signature'] : [];
        $mode      = is_string($signature['mode'] ?? null) ? $signature['mode'] : '';
        if (!in_array($mode, ['saved', 'drawn'], true)) {
            $e['signature'] = 'Choose how to sign';
        }

        $form = [
            'priority'          => $priority,
            'purpose'           => $purpose,
            'clinical_question' => $question,
            'history'           => $texts['history'],
            'medication'        => $texts['medication'],
            'allergies'         => $texts['allergies'],
            'clinical_flags'    => [
                'fasting'          => $fasting,
                'fasting_hours'    => $fasting === true ? $hours : null,
                'pregnancy_asked'  => $asksPregnancy,
                'pregnant'         => $pregnant,
                'weeks_pregnant'   => $pregnant === true ? $weeks : null,
                'infection_alerts' => $alerts,
                'transfusion_3m'   => self::bool($clinical['transfusion_3m'] ?? null),
            ],
            'items'             => $items,
            'imaging_safety'    => $safety,
            'signature_mode'    => $mode,
        ];

        return [$form, $e];
    }

    /**
     * What the idempotency hash covers (pure, catalogue-independent): the
     * patient / consultation / source ids lower-cased, the texts trimmed, the
     * infection alerts sorted, the items in order. Not hashed: signature,
     * attest, client_key.
     *
     * @param array<string,mixed> $body
     * @return array<string,mixed>
     */
    public static function canonical(array $body): array
    {
        $clinical = is_array($body['clinical'] ?? null) ? $body['clinical'] : [];
        $alerts   = is_array($clinical['infection_alerts'] ?? null) ? array_map(static fn ($a): string => strtolower(trim((string) $a)), $clinical['infection_alerts']) : [];
        $alerts   = array_values(array_unique($alerts));
        sort($alerts);
        $items = [];
        foreach (is_array($body['items'] ?? null) ? $body['items'] : [] as $item) {
            $item    = is_array($item) ? $item : [];
            $items[] = [
                'code'             => strtoupper(trim((string) ($item['code'] ?? ''))),
                'specimen_mode'    => self::text($item['specimen_mode'] ?? null),
                'specimen_code'    => self::text($item['specimen_code'] ?? null),
                'preparation_code' => self::text($item['preparation_code'] ?? null),
            ];
        }
        $safety = is_array($body['imaging_safety'] ?? null) ? $body['imaging_safety'] : null;

        return [
            'patient_id'        => self::lowerId($body['patient_id'] ?? null),
            'appointment_id'    => self::lowerId($body['appointment_id'] ?? null),
            'duplicated_from'   => self::lowerId($body['duplicated_from'] ?? null),
            'priority'          => self::text($body['priority'] ?? null),
            'purpose'           => self::text($body['purpose'] ?? null),
            'clinical_question' => self::text($body['clinical_question'] ?? null),
            'history'           => self::text($body['history'] ?? null),
            'medication'        => self::text($body['medication'] ?? null),
            'allergies'         => self::text($body['allergies'] ?? null),
            'clinical'          => [
                'fasting'          => self::bool($clinical['fasting'] ?? null),
                'fasting_hours'    => self::int($clinical['fasting_hours'] ?? null),
                'pregnant'         => self::bool($clinical['pregnant'] ?? null),
                'weeks_pregnant'   => self::int($clinical['weeks_pregnant'] ?? null),
                'infection_alerts' => $alerts,
                'transfusion_3m'   => self::bool($clinical['transfusion_3m'] ?? null),
            ],
            'items'             => $items,
            'imaging_safety'    => $safety === null ? null : [
                'contrast_allergy' => self::text($safety['contrast_allergy'] ?? null),
                'mobility'         => self::text($safety['mobility'] ?? null),
            ],
            'catalogue_version' => self::text($body['catalogue_version'] ?? null),
        ];
    }

    /** sha256 of the canonical JSON. @param array<string,mixed> $body */
    public static function hash(array $body): string
    {
        return hash('sha256', (string) json_encode(self::canonical($body), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
    }

    /**
     * @return array{0: list<array<string,mixed>>, 1: array<string,string>}
     */
    private static function items(mixed $raw, LabCatalogue $c): array
    {
        $errors = [];
        if (!is_array($raw) || !array_is_list($raw) || $raw === []) {
            return [[], ['items' => 'Add at least one test']];
        }
        if (count($raw) > LabRequestRules::MAX_ITEMS) {
            return [[], ['items' => 'Add up to ' . LabRequestRules::MAX_ITEMS . ' tests']];
        }
        $codes = array_map(static fn ($i): string => is_array($i) ? strtoupper(trim((string) ($i['code'] ?? ''))) : '', $raw);
        if (count(array_filter($codes, static fn (string $code): bool => $code !== '')) !== count(array_unique(array_filter($codes, static fn (string $code): bool => $code !== '')))) {
            $errors['items'] = 'Each test can be added once';
        }
        $out = [];
        foreach ($raw as $n => $input) {
            $input = is_array($input) ? $input : [];
            $item  = $c->item($codes[$n]);
            if ($item === null) {
                $errors["items.$n.code"] = "This test isn't in the list any more. Remove it and add it again.";
                continue;
            }
            $snap = [
                'code'              => $item['code'],
                'kind'              => $item['kind'],
                'category'          => $item['category'],
                'modality'          => $item['modality'],
                'site'              => $item['site'],
                'label'             => $item['label'],
                'name'              => $item['name'],
                'short'             => $item['short'],
                'specimen_mode'     => null,
                'specimen_code'     => null,
                'specimen_label'    => null,
                'preparation_code'  => null,
                'preparation_label' => null,
                'contrast_possible' => $item['contrast_possible'],
                'ionising'          => $item['ionising'],
            ];
            if ($item['kind'] === 'lab') {
                $mode     = $item['category'] === 'microbiology' ? 'auto' : (($input['specimen_mode'] ?? 'auto') === 'manual' ? 'manual' : 'auto');
                $specimen = $item['default_specimen'];
                if ($mode === 'manual') {
                    $chosen = $c->specimen((string) ($input['specimen_code'] ?? ''));
                    if ($chosen === null || !$chosen['manual']) {
                        $errors["items.$n.specimen_code"] = 'Choose a specimen for ' . $item['short'];
                    } else {
                        $specimen = $chosen['code'];
                    }
                }
                $snap['specimen_mode']  = $mode;
                $snap['specimen_code']  = $specimen;
                $snap['specimen_label'] = $specimen !== null ? ($c->specimen($specimen)['label'] ?? $specimen) : null;
            } elseif ($item['kind'] === 'imaging') {
                $prepCode = $input['preparation_code'] ?? null;
                $prepCode = is_string($prepCode) && $prepCode !== '' ? $prepCode : ($item['default_preparation'] ?? 'none');
                $prep     = $c->preparation((string) $prepCode);
                if ($prep === null) {
                    $errors["items.$n.preparation_code"] = 'Choose a preparation from the list';
                } else {
                    $snap['preparation_code']  = $prep['code'];
                    $snap['preparation_label'] = $prep['label'];
                }
            }
            $out[] = $snap;
        }

        return [$out, $errors];
    }

    /** A trimmed string, or null when empty / not a string. */
    private static function text(mixed $v): ?string
    {
        if (!is_string($v)) {
            return null;
        }
        $v = trim($v);

        return $v !== '' ? $v : null;
    }

    private static function bool(mixed $v): ?bool
    {
        return is_bool($v) ? $v : null;
    }

    private static function int(mixed $v): ?int
    {
        if (is_int($v)) {
            return $v;
        }
        if (is_string($v) && preg_match('/^\s*-?\d{1,4}\s*$/', $v) === 1) {
            return (int) trim($v);
        }
        if (is_float($v) && floor($v) === $v) {
            return (int) $v;
        }

        return null;
    }

    private static function lowerId(mixed $v): ?string
    {
        return is_string($v) && trim($v) !== '' ? strtolower(trim($v)) : null;
    }
}
