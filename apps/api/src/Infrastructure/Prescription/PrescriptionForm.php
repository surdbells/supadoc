<?php

declare(strict_types=1);

namespace App\Infrastructure\Prescription;

use App\Domain\Entity\Drug;
use App\Domain\Entity\Prescription;
use App\Infrastructure\Drug\DrugRoute;
use DateTimeImmutable;

/**
 * The GVM-F-RX-01 prescription form: field catalogue, normalisation and
 * validation. Two levels:
 *
 *  - {@see normalize()} — always: types, ranges, lengths, known catalogue
 *    medicines. A draft may be incomplete but never malformed.
 *  - {@see sendErrors()} — before sending: everything the printed form needs
 *    (reason, medicines with full directions, pregnancy answer, validity).
 *
 * Medicine names are never taken from the client: each row's `rxcui` is looked
 * up in the RxNorm catalogue and the printed fields are snapshotted from it.
 */
final class PrescriptionForm
{
    /** key => [label, unit, min, max] — the ten health-reading boxes (AC7). */
    public const READINGS = [
        'temperature'       => ['Temperature', '°C', 30, 45],
        'heart_rate'        => ['Heart rate', 'beats/min', 20, 250],
        'blood_pressure'    => ['Blood pressure', 'mmHg', null, null],
        'respiratory_rate'  => ['Breathing rate', 'breaths/min', 4, 60],
        'oxygen_saturation' => ['Oxygen level', '%', 50, 100],
        'blood_sugar'       => ['Blood sugar', 'mmol/L', 1, 40],
        'weight'            => ['Weight', 'kg', 0.5, 400],
        'height'            => ['Height', 'cm', 30, 250],
        'bmi'               => ['BMI', 'kg/m²', 5, 90],
        'pain_score'        => ['Pain score', '/10', 0, 10],
    ];

    public const READING_SOURCES = [
        'patient_device' => "Patient's own device",
        'video'          => 'Seen on video',
        'clinic'         => 'Clinic',
        'lab'            => 'Lab',
    ];

    public const PREGNANCY = [
        'no'             => 'No',
        'pregnant'       => 'Pregnant',
        'breastfeeding'  => 'Breastfeeding',
        'unknown'        => 'Not sure',
        'not_applicable' => 'Not applicable',
    ];

    public const FOLLOW_UP_MODES = ['video' => 'Video', 'in_person' => 'In person'];

    public const MAX_REPEATS = 11;

    /**
     * Character limits sized to the space each box has on the printed form;
     * anything longer belongs in the consultation summary (GVM-RX-02 AC11).
     */
    public const LIMITS = [
        'reason'              => 220,
        'current_medications' => 110,
        'advice'              => 220,
        'tests_referrals'     => 110,
        'instructions'        => 110,
    ];

    /**
     * @param callable(string):?Drug $findDrug catalogue lookup by RXCUI
     * @return array{0: array<string,mixed>, 1: array<string,string>} [clean form, errors]
     */
    public static function normalize(array $in, callable $findDrug, DateTimeImmutable $today, int $maxValidDays = 365): array
    {
        $errors = [];
        $clean  = [];

        // ----- health readings -----
        $readings = [];
        $rawReadings = is_array($in['readings'] ?? null) ? $in['readings'] : [];
        foreach (self::READINGS as $key => [$label, , $min, $max]) {
            $value = trim((string) (is_scalar($rawReadings[$key] ?? null) ? $rawReadings[$key] : ''));
            if ($value === '') {
                continue;
            }
            if ($key === 'blood_pressure') {
                if (preg_match('/^(\d{2,3})\s*\/\s*(\d{2,3})$/', $value, $m) !== 1
                    || (int) $m[1] < 50 || (int) $m[1] > 260 || (int) $m[2] < 30 || (int) $m[2] > 160
                    || (int) $m[2] >= (int) $m[1]) {
                    $errors["readings.$key"] = 'Enter blood pressure as systolic/diastolic, e.g. 120/80';
                    continue;
                }
                $readings[$key] = (int) $m[1] . '/' . (int) $m[2];
                continue;
            }
            if (!is_numeric($value) || (float) $value < $min || (float) $value > $max) {
                $errors["readings.$key"] = sprintf('%s must be a number between %s and %s', $label, $min, $max);
                continue;
            }
            $readings[$key] = self::number((float) $value);
        }
        if (!isset($readings['bmi']) && isset($readings['weight'], $readings['height']) && (float) $readings['height'] > 0) {
            $metres          = (float) $readings['height'] / 100;
            $readings['bmi'] = self::number(round((float) $readings['weight'] / ($metres * $metres), 1));
        }
        $source = trim((string) ($rawReadings['source'] ?? ''));
        if ($source !== '') {
            if (!array_key_exists($source, self::READING_SOURCES)) {
                $errors['readings.source'] = 'Choose where the readings came from';
            } else {
                $readings['source'] = $source;
            }
        }
        $takenAt = trim((string) ($rawReadings['taken_at'] ?? ''));
        if ($takenAt !== '') {
            $at = self::parseDateTime($takenAt);
            if ($at === null || $at > $today->modify('+1 day')) {
                $errors['readings.taken_at'] = 'Enter when the readings were taken (not in the future)';
            } else {
                $readings['taken_at'] = $at->format(DATE_ATOM);
            }
        }
        $clean['readings'] = $readings;

        // ----- consultation -----
        $clean['reason']              = self::text($in, 'reason', self::LIMITS['reason'], 'Reason for the prescription', $errors);
        $clean['current_medications'] = self::text($in, 'current_medications', self::LIMITS['current_medications'], 'Current medicines', $errors);
        $icd = strtoupper(trim((string) ($in['icd_code'] ?? '')));
        if ($icd !== '' && preg_match('/^[A-Z0-9][A-Z0-9.\-]{1,19}$/', $icd) !== 1) {
            $errors['icd_code'] = 'Enter a valid illness code, e.g. 1F40 or J45.9';
        }
        $clean['icd_code'] = $icd !== '' ? $icd : null;
        $pregnancy = trim((string) ($in['pregnancy_status'] ?? ''));
        if ($pregnancy !== '' && !array_key_exists($pregnancy, self::PREGNANCY)) {
            $errors['pregnancy_status'] = 'Choose an answer to the pregnancy question';
            $pregnancy = '';
        }
        $clean['pregnancy_status'] = $pregnancy !== '' ? $pregnancy : null;

        // ----- medicines -----
        $rawItems = is_array($in['items'] ?? null) ? array_values($in['items']) : [];
        if (count($rawItems) > Prescription::MAX_ITEMS) {
            $errors['items'] = sprintf('A prescription can hold at most %d medicines (two pages)', Prescription::MAX_ITEMS);
            $rawItems = array_slice($rawItems, 0, Prescription::MAX_ITEMS);
        }
        $items = [];
        foreach ($rawItems as $i => $row) {
            if (!is_array($row)) {
                continue;
            }
            $line   = self::itemFields($row);
            $rxcui  = trim((string) (is_scalar($row['rxcui'] ?? null) ? $row['rxcui'] : ''));
            $filled = $rxcui !== '' || implode('', array_filter($line, 'is_string')) !== '';
            if (!$filled) {
                continue; // a blank row
            }
            $n = count($items);
            if ($rxcui !== '') {
                $drug = $findDrug($rxcui);
                if ($drug === null) {
                    $errors["items.$n.rxcui"] = 'This medicine is not in the catalogue — search and choose it again';
                    $rxcui = '';
                } else {
                    $line = [
                        'rxcui'        => $drug->getRxcui(),
                        'name'         => $drug->getName(),
                        'generic_name' => $drug->getGenericName(),
                        'brand'        => $drug->getBrand(),
                        'branded'      => $drug->isBranded(),
                        'dose_form'    => $drug->getDoseForm(),
                    ] + $line;
                    if ($line['route'] === '') {
                        $line['route'] = (string) $drug->getRoute();
                    }
                }
            }
            if ($rxcui === '') {
                $line = ['rxcui' => null, 'name' => '', 'generic_name' => '', 'brand' => null, 'branded' => false, 'dose_form' => null] + $line;
            }
            if ($line['route'] !== '' && !in_array($line['route'], DrugRoute::ALL, true)) {
                $errors["items.$n.route"] = 'Choose how the medicine is taken';
            }
            foreach (['dose' => 40, 'frequency' => 40, 'duration' => 30, 'quantity' => 30, 'instructions' => self::LIMITS['instructions']] as $field => $max) {
                if (mb_strlen((string) $line[$field]) > $max) {
                    $errors["items.$n.$field"] = sprintf('Keep this under %d characters', $max);
                }
            }
            $repeats = $row['repeats'] ?? 0;
            if ($repeats === '' || $repeats === null) {
                $repeats = 0;
            }
            $whole = is_int($repeats)
                || (is_string($repeats) && ctype_digit($repeats))
                || (is_float($repeats) && floor($repeats) === $repeats);
            if (!$whole || (int) $repeats < 0 || (int) $repeats > self::MAX_REPEATS) {
                $errors["items.$n.repeats"] = sprintf('Repeats must be a whole number from 0 to %d', self::MAX_REPEATS);
                $repeats = 0;
            }
            $line['repeats'] = (int) $repeats;
            $items[]         = $line;
        }
        $clean['items'] = $items;

        // ----- advice + follow-up -----
        $clean['advice']          = self::text($in, 'advice', self::LIMITS['advice'], 'Advice', $errors);
        $clean['tests_referrals'] = self::text($in, 'tests_referrals', self::LIMITS['tests_referrals'], 'Tests or referrals', $errors);
        $clean['follow_up_date']  = null;
        $clean['follow_up_mode']  = null;
        $followUp = trim((string) ($in['follow_up_date'] ?? ''));
        if ($followUp !== '') {
            $date = self::parseDate($followUp);
            if ($date === null || $date < $today) {
                $errors['follow_up_date'] = 'Choose a follow-up date from today onwards';
            } else {
                $clean['follow_up_date'] = $date;
                $mode = trim((string) ($in['follow_up_mode'] ?? ''));
                if (!array_key_exists($mode, self::FOLLOW_UP_MODES)) {
                    $errors['follow_up_mode'] = 'Tick Video or In person for the follow-up';
                } else {
                    $clean['follow_up_mode'] = $mode;
                }
            }
        }

        // ----- validity -----
        $clean['valid_until'] = null;
        $validUntil = trim((string) ($in['valid_until'] ?? ''));
        if ($validUntil !== '') {
            $date = self::parseDate($validUntil);
            if ($date === null || $date < $today || $date > $today->modify("+{$maxValidDays} days")) {
                $errors['valid_until'] = sprintf('Valid until must be between today and %d days from now', $maxValidDays);
            } else {
                $clean['valid_until'] = $date;
            }
        }
        $clean['allows_repeats'] = filter_var($in['allows_repeats'] ?? false, FILTER_VALIDATE_BOOLEAN);

        return [$clean, $errors];
    }

    /**
     * What must be present before the form can be sent.
     *
     * @param array<string,mixed> $clean normalised form
     * @return array<string,string>
     */
    public static function sendErrors(array $clean, bool $askPregnancy): array
    {
        $errors = [];
        if (($clean['reason'] ?? null) === null) {
            $errors['reason'] = 'Enter the reason for the prescription';
        }
        if ($askPregnancy && ($clean['pregnancy_status'] ?? null) === null) {
            $errors['pregnancy_status'] = 'Answer the pregnant or breastfeeding question';
        }
        $items = $clean['items'] ?? [];
        if ($items === []) {
            $errors['items'] = 'Add at least one medicine';
        }
        $anyRepeats = false;
        foreach ($items as $n => $line) {
            if (($line['rxcui'] ?? null) === null) {
                $errors["items.$n.rxcui"] = 'Choose the medicine from the catalogue';
            }
            foreach (['dose' => 'how much to take', 'route' => 'how to take it', 'frequency' => 'how often', 'duration' => 'for how long', 'quantity' => 'the quantity to give'] as $field => $label) {
                if (trim((string) ($line[$field] ?? '')) === '') {
                    $errors["items.$n.$field"] = 'Enter ' . $label;
                }
            }
            $anyRepeats = $anyRepeats || (int) ($line['repeats'] ?? 0) > 0;
        }
        if (($clean['valid_until'] ?? null) === null) {
            $errors['valid_until'] = 'Enter the date the prescription is valid until';
        }
        if ($anyRepeats && !($clean['allows_repeats'] ?? false)) {
            $errors['allows_repeats'] = 'Some medicines have repeats — answer Yes to "Does this prescription allow repeats?", or set repeats to 0';
        }

        return $errors;
    }

    /** Whether the pregnancy question applies: female, aged 12–55. */
    public static function asksPregnancy(?string $gender, ?DateTimeImmutable $dateOfBirth, DateTimeImmutable $today): bool
    {
        if (!in_array(strtolower((string) $gender), ['female', 'f', 'woman'], true)) {
            return false;
        }
        if ($dateOfBirth === null) {
            return true; // age unknown — better to ask
        }
        $age = $dateOfBirth->diff($today)->y;

        return $age >= 12 && $age <= 55;
    }

    /** @return array<string,string|bool> the editable (non-catalogue) fields of a row */
    private static function itemFields(array $row): array
    {
        return [
            'dose'          => trim((string) (is_scalar($row['dose'] ?? null) ? $row['dose'] : '')),
            'route'         => trim((string) (is_scalar($row['route'] ?? null) ? $row['route'] : '')),
            'frequency'     => trim((string) (is_scalar($row['frequency'] ?? null) ? $row['frequency'] : '')),
            'duration'      => trim((string) (is_scalar($row['duration'] ?? null) ? $row['duration'] : '')),
            'quantity'      => trim((string) (is_scalar($row['quantity'] ?? null) ? $row['quantity'] : '')),
            'no_substitute' => filter_var($row['no_substitute'] ?? false, FILTER_VALIDATE_BOOLEAN),
            'instructions'  => trim((string) (is_scalar($row['instructions'] ?? null) ? $row['instructions'] : '')),
        ];
    }

    /** @param array<string,string> $errors */
    private static function text(array $in, string $key, int $max, string $label, array &$errors): ?string
    {
        $value = trim((string) (is_scalar($in[$key] ?? null) ? $in[$key] : ''));
        if (mb_strlen($value) > $max) {
            $errors[$key] = sprintf('%s must be %d characters or fewer', $label, $max);
            $value = mb_substr($value, 0, $max);
        }

        return $value !== '' ? $value : null;
    }

    private static function parseDate(string $value): ?DateTimeImmutable
    {
        $d = DateTimeImmutable::createFromFormat('!Y-m-d', $value);

        return $d !== false && $d->format('Y-m-d') === $value ? $d : null;
    }

    private static function parseDateTime(string $value): ?DateTimeImmutable
    {
        try {
            return new DateTimeImmutable($value);
        } catch (\Throwable) {
            return null;
        }
    }

    private static function number(float $n): string
    {
        return rtrim(rtrim(number_format($n, 1, '.', ''), '0'), '.');
    }
}
