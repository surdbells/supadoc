<?php

declare(strict_types=1);

namespace App\Infrastructure\Vitals;

/**
 * Where a reading sits against typical adult resting ranges — "Normal",
 * "Elevated", "High", "Very low"… plus, for the worrying ones, whether to seek
 * medical attention. Worked out here, once, so the patient's Medical
 * Information, the doctor's side panel and the call screens all say the same
 * thing about the same number. A guide for the patient, not a diagnosis: the
 * doctor interprets the readings.
 *
 * Units are the catalogue's (°C, beats/min, %, mmHg, mmol/L, breaths/min, kg, cm).
 */
final class VitalsFlags
{
    public const NORMAL   = 'normal';
    public const LOW      = 'low';
    public const ELEVATED = 'elevated';
    public const HIGH     = 'high';
    public const CRITICAL = 'critical';

    public const SEEK_ATTENTION        = 'Seek medical attention';
    public const SEEK_URGENT_ATTENTION = 'Seek urgent medical attention';

    /**
     * The "normal" band of each reading, shown under the form's boxes. Weight
     * has none of its own (it is judged by BMI, which needs the height); height
     * and pain have none.
     */
    public const NORMAL_RANGES = [
        'temperature'       => '36.0–37.5',
        'heart_rate'        => '50–100',
        'blood_pressure'    => '90/60–129/84',
        'respiratory_rate'  => '12–20',
        'oxygen_saturation' => '95–100',
        'blood_sugar'       => '4.0–7.8',
        'bmi'               => '18.5–24.9',
    ];

    /**
     * The flag for one reading, or null when there is nothing to say (height,
     * a weight without a height on file, or a value that isn't a number). A
     * BMI is judged on its own value here; {@see VitalsService} leaves it
     * unflagged without a height on file or once it is older than the latest
     * weight or height.
     *
     * @param ?string $heightCm the patient's latest height — weight is judged by the BMI it gives
     * @return array{level: string, label: string, advice: ?string}|null
     */
    public static function flag(string $key, string $value, ?string $heightCm = null): ?array
    {
        $value = trim($value);
        if ($key === 'blood_pressure') {
            return self::bloodPressure($value);
        }
        if (!is_numeric($value)) {
            return null;
        }
        $n = (float) $value;

        return match ($key) {
            'temperature'       => self::temperature($n),
            'heart_rate'        => self::heartRate($n),
            'oxygen_saturation' => self::oxygen($n),
            'blood_sugar'       => self::bloodSugar($n),
            'respiratory_rate'  => self::breathing($n),
            'bmi'               => self::bmi($n),
            'weight'            => self::weight($n, $heightCm),
            'pain_score'        => self::pain($n),
            default             => null, // height — nothing to flag
        };
    }

    /** °C: <35 very low · 35.0–35.9 low · 36.0–37.5 normal · 37.6–37.9 elevated · 38.0–39.4 high · ≥39.5 very high. */
    private static function temperature(float $t): array
    {
        return match (true) {
            $t < 35.0  => self::make(self::CRITICAL, 'Very low'),
            $t < 36.0  => self::make(self::LOW),
            $t <= 37.5 => self::make(self::NORMAL),
            $t < 38.0  => self::make(self::ELEVATED),
            $t < 39.5  => self::make(self::HIGH),
            default    => self::make(self::CRITICAL, 'Very high'),
        };
    }

    /** beats/min: <40 very low · 40–49 low · 50–100 normal · 101–120 elevated · 121–130 high · >130 very high. */
    private static function heartRate(float $bpm): array
    {
        return match (true) {
            $bpm < 40   => self::make(self::CRITICAL, 'Very low'),
            $bpm < 50   => self::make(self::LOW),
            $bpm <= 100 => self::make(self::NORMAL),
            $bpm <= 120 => self::make(self::ELEVATED),
            $bpm <= 130 => self::make(self::HIGH),
            default     => self::make(self::CRITICAL, 'Very high'),
        };
    }

    /** %: ≥95 normal · 92–94 low (no advice) · <92 very low. */
    private static function oxygen(float $pct): array
    {
        return match (true) {
            $pct >= 95 => self::make(self::NORMAL),
            $pct >= 92 => self::make(self::LOW),
            default    => self::make(self::CRITICAL, 'Very low'),
        };
    }

    /**
     * mmHg, the worse of the two numbers decides: ≥180 / ≥120 very high ·
     * 140–179 / 90–119 high · 130–139 / 85–89 elevated · <90 / <60 low.
     */
    private static function bloodPressure(string $value): ?array
    {
        if (preg_match('/^(\d{2,3})\s*\/\s*(\d{2,3})$/', $value, $m) !== 1) {
            return null;
        }
        [$sys, $dia] = [(int) $m[1], (int) $m[2]];

        return match (true) {
            $sys >= 180 || $dia >= 120 => self::make(self::CRITICAL, 'Very high'),
            $sys >= 140 || $dia >= 90  => self::make(self::HIGH),
            $sys >= 130 || $dia >= 85  => self::make(self::ELEVATED),
            $sys < 90 || $dia < 60     => self::make(self::LOW),
            default                    => self::make(self::NORMAL),
        };
    }

    /** mmol/L: <3.0 very low · 3.0–3.9 low · 4.0–7.8 normal · 7.9–11.0 elevated · 11.1–16.6 high · ≥16.7 very high. */
    private static function bloodSugar(float $mmol): array
    {
        return match (true) {
            $mmol < 3.0   => self::make(self::CRITICAL, 'Very low'),
            $mmol < 4.0   => self::make(self::LOW),
            $mmol <= 7.8  => self::make(self::NORMAL),
            $mmol <= 11.0 => self::make(self::ELEVATED),
            $mmol < 16.7  => self::make(self::HIGH),
            default       => self::make(self::CRITICAL, 'Very high'),
        };
    }

    /** breaths/min: <8 very low · 8–11 low · 12–20 normal · 21–24 elevated · 25–29 high · ≥30 very high. */
    private static function breathing(float $rate): array
    {
        return match (true) {
            $rate < 8   => self::make(self::CRITICAL, 'Very low'),
            $rate < 12  => self::make(self::LOW),
            $rate <= 20 => self::make(self::NORMAL),
            $rate <= 24 => self::make(self::ELEVATED),
            $rate < 30  => self::make(self::HIGH),
            default     => self::make(self::CRITICAL, 'Very high'),
        };
    }

    /**
     * kg/m²: <18.5 low · 18.5–24.9 normal · 25–29.9 elevated · ≥30 high. Never
     * "seek medical attention" — a BMI is something to talk over with the
     * doctor, not an alarm.
     */
    private static function bmi(float $bmi): array
    {
        $flag = match (true) {
            $bmi < 18.5 => self::make(self::LOW),
            $bmi < 25   => self::make(self::NORMAL),
            $bmi < 30   => self::make(self::ELEVATED),
            default     => self::make(self::HIGH),
        };
        $flag['advice'] = null;

        return $flag;
    }

    /** Weight is judged by the BMI it gives with the latest height; no height, no flag. */
    private static function weight(float $kg, ?string $heightCm): ?array
    {
        if ($heightCm === null || !is_numeric(trim($heightCm))) {
            return null;
        }
        $bmi = VitalsForm::bmi($kg, (float) trim($heightCm));

        return $bmi !== null ? self::bmi((float) $bmi) : null;
    }

    /** 0–10: 0 none · 1–3 mild · 4–6 moderate · 7–10 severe (no advice — the patient knows their pain). */
    private static function pain(float $score): array
    {
        return match (true) {
            $score <= 0 => self::make(self::NORMAL, 'None'),
            $score < 4  => self::make(self::NORMAL, 'Mild'),
            $score < 7  => self::make(self::ELEVATED, 'Moderate'),
            default     => ['level' => self::HIGH, 'label' => 'Severe', 'advice' => null],
        };
    }

    /** @return array{level: string, label: string, advice: ?string} */
    private static function make(string $level, ?string $label = null): array
    {
        return [
            'level'  => $level,
            'label'  => $label ?? match ($level) {
                self::LOW      => 'Low',
                self::ELEVATED => 'Elevated',
                self::HIGH     => 'High',
                default        => 'Normal',
            },
            'advice' => match ($level) {
                self::HIGH     => self::SEEK_ATTENTION,
                self::CRITICAL => self::SEEK_URGENT_ATTENTION,
                default        => null,
            },
        ];
    }
}
