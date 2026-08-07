<?php

declare(strict_types=1);

namespace App\Domain\Settings;

/**
 * Shape + normalization for a patient's health profile: emergency contact,
 * insurance and medical records. Every section is user-owned free text, so the
 * store is permissive — values are trimmed to strings, arrays are capped, and
 * fully-empty rows are dropped. Saving a section replaces it wholesale (that is
 * what the forms submit); there is no per-field merge.
 */
final class HealthProfile
{
    private const MAX_ROWS = 50;

    public static function emptyEmergencyContact(): array
    {
        return ['full_name' => '', 'relationship' => '', 'phone' => '', 'email' => ''];
    }

    public static function emptyInsurance(): array
    {
        return ['provider' => '', 'plan' => '', 'policy_number' => '', 'coverage_status' => '', 'expiry_date' => ''];
    }

    public static function emptyMedical(): array
    {
        return ['history' => [], 'allergies' => [], 'medications' => [], 'conditions' => []];
    }

    public static function normalizeEmergencyContact(array $in): array
    {
        return [
            'full_name'    => self::str($in['full_name'] ?? ''),
            'relationship' => self::str($in['relationship'] ?? ''),
            'phone'        => self::str($in['phone'] ?? ''),
            'email'        => self::str($in['email'] ?? ''),
        ];
    }

    public static function normalizeInsurance(array $in): array
    {
        return [
            'provider'        => self::str($in['provider'] ?? ''),
            'plan'            => self::str($in['plan'] ?? ''),
            'policy_number'   => self::str($in['policy_number'] ?? ''),
            'coverage_status' => self::str($in['coverage_status'] ?? ''),
            'expiry_date'     => self::str($in['expiry_date'] ?? ''),
        ];
    }

    public static function normalizeMedical(array $in): array
    {
        return [
            'history'     => self::rows($in['history'] ?? [], ['condition', 'year', 'note']),
            'allergies'   => self::rows($in['allergies'] ?? [], ['allergen', 'severity', 'reaction']),
            'medications' => self::rows($in['medications'] ?? [], ['name', 'dosage', 'frequency']),
            'conditions'  => self::rows($in['conditions'] ?? [], ['condition', 'status', 'since']),
        ];
    }

    /**
     * Coerce a list of row objects to the given keys, dropping non-arrays and
     * rows where every field is blank, and capping the total.
     */
    private static function rows(mixed $rows, array $keys): array
    {
        if (!is_array($rows)) {
            return [];
        }

        $out = [];
        foreach (array_slice(array_values($rows), 0, self::MAX_ROWS) as $row) {
            if (!is_array($row)) {
                continue;
            }
            $obj      = [];
            $nonEmpty = false;
            foreach ($keys as $key) {
                $value     = self::str($row[$key] ?? '');
                $obj[$key] = $value;
                $nonEmpty  = $nonEmpty || $value !== '';
            }
            if ($nonEmpty) {
                $out[] = $obj;
            }
        }

        return $out;
    }

    private static function str(mixed $value): string
    {
        return trim((string) (is_scalar($value) ? $value : ''));
    }
}
