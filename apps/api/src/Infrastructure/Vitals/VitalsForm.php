<?php

declare(strict_types=1);

namespace App\Infrastructure\Vitals;

use DateTimeImmutable;

/**
 * The health-reading catalogue — the ten boxes on the GVM-F-RX-01 form (AC7) —
 * and its validation. Shared by the prescription form and the patient's own
 * "Update vitals" form, so both apply the same ranges, the same blood-pressure
 * rule and the same worked-out BMI. What each reading means (Normal, High…)
 * is {@see VitalsFlags}.
 */
final class VitalsForm
{
    /** key => [label, unit, min, max] */
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

    /** Input step for each number box (blood pressure is two whole numbers). */
    public const STEPS = [
        'temperature'       => 0.1,
        'heart_rate'        => 1,
        'respiratory_rate'  => 1,
        'oxygen_saturation' => 1,
        'blood_sugar'       => 0.1,
        'weight'            => 0.1,
        'height'            => 0.5,
        'bmi'               => 0.1,
        'pain_score'        => 1,
    ];

    /**
     * Systolic / diastolic bounds; the diastolic must also be below the systolic.
     * The upper bound is the usual entry maximum: a higher number is saved but
     * flagged as above the usual range (see {@see self::isAboveRange()}).
     */
    public const SYSTOLIC  = [50, 260];
    public const DIASTOLIC = [30, 160];

    /** Readings with a physical ceiling: their entry maximum is also the hard maximum. */
    public const BOUNDED = ['oxygen_saturation', 'pain_score'];

    /** Technical sanity ceiling for every other number (at most 4 digits before the decimal). */
    public const HARD_MAX = 9999;

    /** Ceiling for each blood-pressure number (keeps the 2–3 digit shape). */
    public const BP_HARD_MAX = 999;

    public const BP_FORMAT_ERROR  = 'Enter blood pressure as systolic/diastolic, e.g. 120/80';
    public const BP_CEILING_ERROR = 'Each blood pressure number must be 3 digits or fewer. Check what you entered.';

    /** Beyond the sanity ceiling: unit-free, since "9999 °C" is no limit anyone would recognise. */
    public const CEILING_ERROR = '%s is too large to be a reading. Check what you entered.';

    /** Where a patient's own readings come from. */
    public const PATIENT_SOURCES = [
        'self_reported'  => 'Self-reported',
        'patient_device' => "Patient's own device",
    ];

    /** Where a doctor's readings (on a prescription) come from. */
    public const DOCTOR_SOURCES = [
        'patient_device' => "Patient's own device",
        'video'          => 'Seen on video',
        'clinic'         => 'Clinic',
        'lab'            => 'Lab',
    ];

    public const SOURCES = self::PATIENT_SOURCES + self::DOCTOR_SOURCES;

    public const RECORDED_BY_PATIENT = 'patient';
    public const RECORDED_BY_DOCTOR  = 'doctor';

    /**
     * Range-check a set of readings. Blank boxes are skipped; BMI is worked out
     * from weight and height when it is not given. A value below a reading's
     * minimum is rejected; one above its usual maximum is accepted (and flagged
     * as above the usual range) unless the reading is physically bounded
     * ({@see self::BOUNDED}) or the value passes the sanity ceiling. Errors are keyed by the
     * reading key (or `source` / `taken_at`) — the caller adds any prefix.
     *
     * @param array<string,mixed>  $raw     reading key => value, plus optional `source` / `taken_at`
     * @param DateTimeImmutable    $latest  the latest acceptable `taken_at`
     * @param array<string,string> $sources the sources this caller may choose (key => label)
     * @return array{0: array<string,string>, 1: array<string,string>} [clean readings (+ source / taken_at), errors]
     */
    public static function normalize(array $raw, DateTimeImmutable $latest, array $sources = self::DOCTOR_SOURCES): array
    {
        $errors   = [];
        $readings = [];
        foreach (self::READINGS as $key => [$label, $unit, $min, $max]) {
            $value = trim((string) (is_scalar($raw[$key] ?? null) ? $raw[$key] : ''));
            if ($value === '') {
                continue;
            }
            if ($key === 'blood_pressure') {
                $error = self::bloodPressureError($value);
                if ($error !== null) {
                    $errors[$key] = $error;
                    continue;
                }
                $readings[$key] = (string) self::bloodPressure($value);
                continue;
            }
            if (!self::acceptsAbove($key)) {
                if (!is_numeric($value) || (float) $value < $min || (float) $value > $max) {
                    $errors[$key] = sprintf('%s must be a number between %s and %s', $label, $min, $max);
                    continue;
                }
            } elseif (!is_numeric($value) || (float) $value < $min) {
                $errors[$key] = sprintf('%s must be a number of at least %s %s', $label, $min, $unit);
                continue;
            } elseif (!is_finite((float) $value) || (float) $value > self::HARD_MAX) {
                $errors[$key] = sprintf(self::CEILING_ERROR, $label);
                continue;
            }
            $readings[$key] = self::number((float) $value);
        }
        if (!isset($readings['bmi']) && isset($readings['weight'], $readings['height'])) {
            $bmi = self::bmi((float) $readings['weight'], (float) $readings['height']);
            if ($bmi !== null) {
                $readings['bmi'] = $bmi;
            }
        }
        $source = trim((string) (is_scalar($raw['source'] ?? null) ? $raw['source'] : ''));
        if ($source !== '') {
            if (!array_key_exists($source, $sources)) {
                $errors['source'] = 'Choose where the readings came from';
            } else {
                $readings['source'] = $source;
            }
        }
        $takenAt = trim((string) (is_scalar($raw['taken_at'] ?? null) ? $raw['taken_at'] : ''));
        if ($takenAt !== '') {
            $at = self::parseDateTime($takenAt);
            if ($at === null || $at > $latest) {
                $errors['taken_at'] = 'Enter when the readings were taken (not in the future)';
            } else {
                $readings['taken_at'] = $at->format(DATE_ATOM);
            }
        }

        return [$readings, $errors];
    }

    /**
     * "120 / 80" → "120/80"; null when malformed, below the minimums, beyond the
     * sanity ceiling or the diastolic is not below the systolic. Numbers above
     * the usual maximum (260/160) are accepted.
     */
    public static function bloodPressure(string $value): ?string
    {
        if (self::bloodPressureError($value) !== null
            || preg_match('/^(\d+)\s*\/\s*(\d+)$/', trim($value), $m) !== 1) {
            return null;
        }

        return (int) $m[1] . '/' . (int) $m[2];
    }

    /** Why a blood pressure is rejected, or null when it is accepted. */
    public static function bloodPressureError(string $value): ?string
    {
        if (preg_match('/^(\d+)\s*\/\s*(\d+)$/', trim($value), $m) !== 1) {
            return self::BP_FORMAT_ERROR;
        }
        if (strlen(ltrim($m[1], '0')) > 3 || strlen(ltrim($m[2], '0')) > 3) {
            return self::BP_CEILING_ERROR;
        }
        [$sys, $dia] = [(int) $m[1], (int) $m[2]];
        if ($sys < self::SYSTOLIC[0] || $dia < self::DIASTOLIC[0] || $dia >= $sys) {
            return self::BP_FORMAT_ERROR;
        }

        return null;
    }

    /**
     * BMI (kg/m², one decimal) from weight in kg and height in cm; null when
     * below the BMI minimum or beyond the sanity ceiling. A BMI above the usual
     * maximum (90) is worked out and flagged as above the usual range.
     */
    public static function bmi(float $weightKg, float $heightCm): ?string
    {
        if ($weightKg <= 0 || $heightCm <= 0) {
            return null;
        }
        $metres = $heightCm / 100;
        $bmi    = round($weightKg / ($metres * $metres), 1);

        return $bmi >= self::READINGS['bmi'][2] && $bmi <= self::HARD_MAX ? self::number($bmi) : null;
    }

    /** The most a reading may be before it is rejected (blood pressure: each number). */
    public static function hardMax(string $key): int|float
    {
        if ($key === 'blood_pressure') {
            return self::BP_HARD_MAX;
        }

        return in_array($key, self::BOUNDED, true) ? (self::READINGS[$key][3] ?? 0) : self::HARD_MAX;
    }

    /** Whether a value above the usual maximum is accepted (false for oxygen and pain). */
    public static function acceptsAbove(string $key): bool
    {
        return isset(self::READINGS[$key]) && !in_array($key, self::BOUNDED, true);
    }

    /** Whether a stored reading is above its usual entry range (still saved — "check the reading"). */
    public static function isAboveRange(string $key, string $value): bool
    {
        if (!self::acceptsAbove($key)) {
            return false;
        }
        $value = trim($value);
        if ($key === 'blood_pressure') {
            if (preg_match('/^(\d{2,3})\s*\/\s*(\d{2,3})$/', $value, $m) !== 1) {
                return false;
            }

            return (int) $m[1] > self::SYSTOLIC[1] || (int) $m[2] > self::DIASTOLIC[1];
        }

        return is_numeric($value) && (float) $value > (float) self::READINGS[$key][3];
    }

    /** The usual maximum as people see it ("45", blood pressure "260/160"); null for bounded readings. */
    public static function usualMax(string $key): ?string
    {
        if (!self::acceptsAbove($key)) {
            return null;
        }
        if ($key === 'blood_pressure') {
            return self::SYSTOLIC[1] . '/' . self::DIASTOLIC[1];
        }

        return self::number((float) self::READINGS[$key][3]);
    }

    /**
     * The catalogue as the API serves it, for building a form. `normal_range`
     * is the typical adult band the flags use (null where there is none).
     * `max` is the usual entry maximum; `max_hard` the most the API accepts
     * (null for blood pressure — see `systolic` / `diastolic`) and
     * `accepts_above` whether a value above `max` is saved, with a warning.
     *
     * @return list<array<string,mixed>>
     */
    public static function fields(): array
    {
        $fields = [];
        foreach (self::READINGS as $key => [$label, $unit, $min, $max]) {
            $field = [
                'key'           => $key,
                'label'         => $label,
                'unit'          => $unit,
                'min'           => $min,
                'max'           => $max,
                'step'          => self::STEPS[$key] ?? null,
                'normal_range'  => VitalsFlags::NORMAL_RANGES[$key] ?? null,
                'max_hard'      => $key === 'blood_pressure' ? null : self::hardMax($key),
                'accepts_above' => self::acceptsAbove($key),
            ];
            if ($key === 'blood_pressure') {
                $field['systolic']  = ['min' => self::SYSTOLIC[0], 'max' => self::SYSTOLIC[1], 'max_hard' => self::BP_HARD_MAX];
                $field['diastolic'] = ['min' => self::DIASTOLIC[0], 'max' => self::DIASTOLIC[1], 'max_hard' => self::BP_HARD_MAX];
            }
            if ($key === 'bmi') {
                $field['derived'] = true; // worked out from weight and height
            }
            $fields[] = $field;
        }

        return $fields;
    }

    public static function number(float $n): string
    {
        return rtrim(rtrim(number_format($n, 1, '.', ''), '0'), '.');
    }

    private static function parseDateTime(string $value): ?DateTimeImmutable
    {
        try {
            return new DateTimeImmutable($value);
        } catch (\Throwable) {
            return null;
        }
    }
}
