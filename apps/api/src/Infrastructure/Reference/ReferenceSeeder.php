<?php

declare(strict_types=1);

namespace App\Infrastructure\Reference;

use App\Domain\Entity\ReferenceItem;
use App\Domain\Reference\ReferenceCategory;
use Doctrine\DBAL\Connection;
use Doctrine\DBAL\ParameterType;
use Ramsey\Uuid\Uuid;

/**
 * Seeds the `specialty` reference list (bin/prod-migrate.php). Safe to run on
 * every deploy — it only ever ADDS a label the list lacks (case and spacing
 * aside), never changes or removes one:
 *
 *  - every specialty a doctor (not deleted) already has, in the spelling most
 *    of them use, so no existing doctor is left off the list; and
 *  - the first time only (recorded in the {@see STANDARD_DONE_KEY} setting),
 *    the standard list ({@see ReferenceCategory::STANDARD_SPECIALTIES}) — so
 *    a standard specialty the back office later deletes is not added back.
 *
 * New items go after the existing ones (sort_order steps of 10): the standard
 * list in its own order, then the doctors' other specialties alphabetically.
 */
final class ReferenceSeeder
{
    public const STANDARD_DONE_KEY = 'prod_migrate.reference_specialty_seeded';

    /**
     * The labels to add, in order (pure — see the class comment).
     *
     * @param list<string>      $existing labels already on the list (active or not)
     * @param array<string,int> $inUse    stored specialty => doctors with it
     * @param list<string>      $standard the standard list, or [] once it was seeded
     * @return list<string>
     */
    public static function plan(array $existing, array $inUse, array $standard): array
    {
        $have = [];
        foreach ($existing as $label) {
            $have[ReferenceItem::keyOf($label)] = true;
        }

        // The doctors' spellings, grouped: the most used wins (a tie goes to
        // the one that sorts first, e.g. "Cardiology" before "cardiology").
        $spelling = [];
        $votes    = [];
        foreach ($inUse as $value => $count) {
            $label = ReferenceItem::normaliseLabel((string) $value);
            if ($label === '' || mb_strlen($label) > ReferenceItem::LABEL_MAX) {
                continue;
            }
            $key                 = ReferenceItem::keyOf($label);
            $votes[$key][$label] = ($votes[$key][$label] ?? 0) + (int) $count;
        }
        foreach ($votes as $key => $options) {
            // (Keys untyped: PHP turns a numeric-looking label into an int key.)
            uksort($options, static fn ($a, $b): int => [$options[$b], (string) $a] <=> [$options[$a], (string) $b]);
            $spelling[(string) $key] = (string) array_key_first($options);
        }

        $add = [];
        foreach ($standard as $label) {
            $key = ReferenceItem::keyOf($label);
            if (!isset($have[$key])) {
                $add[]      = $spelling[$key] ?? ReferenceItem::normaliseLabel($label);
                $have[$key] = true;
            }
        }
        $others = array_diff_key($spelling, $have);
        ksort($others, SORT_STRING);
        foreach ($others as $label) {
            $add[] = $label;
        }

        return $add;
    }

    /**
     * Add what {@see plan()} says to the `specialty` list (inside the caller's
     * transaction, if any). Returns the labels added and whether the standard
     * list was added this time.
     *
     * @return array{added: list<string>, standard: string}
     */
    public static function seedSpecialties(Connection $conn, ?\DateTimeImmutable $now = null): array
    {
        $category = ReferenceCategory::SPECIALTY;
        $now      = ($now ?? new \DateTimeImmutable())->format('Y-m-d H:i:s');

        $standardDone = $conn->fetchOne('SELECT 1 FROM app_settings WHERE setting_key = ?', [self::STANDARD_DONE_KEY]) !== false;

        $rows = $conn->fetchAllAssociative('SELECT code, label, sort_order FROM reference_items WHERE category = ?', [$category]);
        $inUse = [];
        foreach ($conn->fetchAllAssociative('SELECT specialty, COUNT(*) AS n FROM specialists WHERE deleted_at IS NULL GROUP BY specialty') as $row) {
            $inUse[(string) $row['specialty']] = (int) $row['n'];
        }

        $labels = self::plan(
            array_map(static fn (array $r): string => (string) $r['label'], $rows),
            $inUse,
            $standardDone ? [] : ReferenceCategory::STANDARD_SPECIALTIES,
        );

        $codes = [];
        $order = -1;
        foreach ($rows as $r) {
            $codes[(string) $r['code']] = true;
            $order                      = max($order, (int) $r['sort_order']);
        }
        $order = $order < 0 ? 0 : $order;

        $added = [];
        foreach ($labels as $label) {
            $code = self::freeCode(ReferenceItem::slugOf($label), $codes);
            $order += 10;
            // ON CONFLICT: an item the back office added a moment ago wins.
            $inserted = $conn->executeStatement(
                'INSERT INTO reference_items (id, category, code, label, label_key, sort_order, active, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
                [Uuid::uuid4()->toString(), $category, $code, $label, ReferenceItem::keyOf($label), $order, true, $now, $now],
                [ParameterType::STRING, ParameterType::STRING, ParameterType::STRING, ParameterType::STRING, ParameterType::STRING, ParameterType::INTEGER, ParameterType::BOOLEAN, ParameterType::STRING, ParameterType::STRING],
            );
            if ($inserted > 0) {
                $codes[$code] = true;
                $added[]      = $label;
            }
        }

        if (!$standardDone) {
            $conn->executeStatement(
                'INSERT INTO app_settings (setting_key, value) VALUES (?, ?) ON CONFLICT DO NOTHING',
                [self::STANDARD_DONE_KEY, (new \DateTimeImmutable())->format(DATE_ATOM)],
            );
        }

        return ['added' => $added, 'standard' => $standardDone ? 'already seeded' : 'seeded'];
    }

    /** @param array<string,true> $taken */
    private static function freeCode(string $base, array $taken): string
    {
        if (!isset($taken[$base])) {
            return $base;
        }
        for ($n = 2; ; $n++) {
            $suffix    = '-' . $n;
            $candidate = rtrim(substr($base, 0, ReferenceItem::CODE_MAX - strlen($suffix)), '-') . $suffix;
            if (!isset($taken[$candidate])) {
                return $candidate;
            }
        }
    }
}
