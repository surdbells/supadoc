<?php

declare(strict_types=1);

namespace App\Infrastructure\Vitals;

use DateTimeImmutable;

/**
 * The health-reading catalogue — the ten boxes on the GVM-F-RX-01 form (AC7) —
 * and its validation. Shared by the prescription form and the patient's own
 * "Update vitals" form, so both apply the same ranges, the same blood-pressure
 * rule and the same worked-out BMI.
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

    /** Systolic / diastolic bounds; the diastolic must also be below the systolic. */
    public const SYSTOLIC  = [50, 260];
    public const DIASTOLIC = [30, 160];

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
     * from weight and height when it is not given. Errors are keyed by the
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
        foreach (self::READINGS as $key => [$label, , $min, $max]) {
            $value = trim((string) (is_scalar($raw[$key] ?? null) ? $raw[$key] : ''));
            if ($value === '') {
                continue;
            }
            if ($key === 'blood_pressure') {
                $bp = self::bloodPressure($value);
                if ($bp === null) {
                    $errors[$key] = 'Enter blood pressure as systolic/diastolic, e.g. 120/80';
                    continue;
                }
                $readings[$key] = $bp;
                continue;
            }
            if (!is_numeric($value) || (float) $value < $min || (float) $value > $max) {
                $errors[$key] = sprintf('%s must be a number between %s and %s', $label, $min, $max);
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

    /** "120 / 80" → "120/80"; null when malformed or out of range. */
    public static function bloodPressure(string $value): ?string
    {
        if (preg_match('/^(\d{2,3})\s*\/\s*(\d{2,3})$/', trim($value), $m) !== 1) {
            return null;
        }
        [$sys, $dia] = [(int) $m[1], (int) $m[2]];
        if ($sys < self::SYSTOLIC[0] || $sys > self::SYSTOLIC[1]
            || $dia < self::DIASTOLIC[0] || $dia > self::DIASTOLIC[1] || $dia >= $sys) {
            return null;
        }

        return $sys . '/' . $dia;
    }

    /** BMI (kg/m², one decimal) from weight in kg and height in cm; null when outside the BMI range. */
    public static function bmi(float $weightKg, float $heightCm): ?string
    {
        if ($weightKg <= 0 || $heightCm <= 0) {
            return null;
        }
        $metres = $heightCm / 100;
        $bmi    = round($weightKg / ($metres * $metres), 1);
        [, , $min, $max] = self::READINGS['bmi'];

        return $bmi >= $min && $bmi <= $max ? self::number($bmi) : null;
    }

    /**
     * The catalogue as the API serves it, for building a form.
     *
     * @return list<array<string,mixed>>
     */
    public static function fields(): array
    {
        $fields = [];
        foreach (self::READINGS as $key => [$label, $unit, $min, $max]) {
            $field = ['key' => $key, 'label' => $label, 'unit' => $unit, 'min' => $min, 'max' => $max, 'step' => self::STEPS[$key] ?? null];
            if ($key === 'blood_pressure') {
                $field['systolic']  = ['min' => self::SYSTOLIC[0], 'max' => self::SYSTOLIC[1]];
                $field['diastolic'] = ['min' => self::DIASTOLIC[0], 'max' => self::DIASTOLIC[1]];
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
