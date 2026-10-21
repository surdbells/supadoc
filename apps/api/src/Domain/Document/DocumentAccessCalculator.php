<?php

declare(strict_types=1);

namespace App\Domain\Document;

use DateTimeImmutable;

/**
 * Folds the policy query's covering-grant rows (one per grant × document a
 * doctor may see) into one entry per (specialist, document) — spec §2.2. Pure.
 *
 * For each pair the result says until when the document is visible (`until`:
 * NULL when any covering grant has no end, else the latest end), what to
 * format (`until_label_at`, from the winning grant's duration), whether it is
 * seen through the whole folder (`via` = folder when any covering grant is a
 * folder share, else document), the covering grant with the latest end
 * (`grant_id`), every covering grant (`grant_ids`) and when it was first
 * shared (`shared_at` = the earliest covering grant's creation).
 */
final class DocumentAccessCalculator
{
    /**
     * @param iterable<array{specialist_id:string, document_id:string, grant_id:string, scope:string, duration:string, expires_at:mixed, created_at:mixed}> $rows
     * @return array<string, array<string, array{until:?DateTimeImmutable, until_label_at:?DateTimeImmutable, indefinite:bool, via:string, grant_id:string, grant_ids:list<string>, shared_at:DateTimeImmutable}>>
     */
    public static function reduce(iterable $rows): array
    {
        $out = [];
        foreach ($rows as $row) {
            $specialist = strtolower((string) $row['specialist_id']);
            $document   = strtolower((string) $row['document_id']);
            $grantId    = strtolower((string) $row['grant_id']);
            $expires    = DocumentSharingRules::fromSql($row['expires_at'] ?? null);
            $created    = DocumentSharingRules::fromSql($row['created_at'] ?? null) ?? new DateTimeImmutable('@0');
            $duration   = (string) $row['duration'];
            $folder     = (string) $row['scope'] === 'all';

            $current = $out[$specialist][$document] ?? null;
            if ($current === null) {
                $out[$specialist][$document] = [
                    'until'          => $expires,
                    'until_label_at' => DocumentSharingRules::untilLabelAt($expires, $duration),
                    'indefinite'     => $expires === null,
                    'via'            => $folder ? 'folder' : 'document',
                    'grant_id'       => $grantId,
                    'grant_ids'      => [$grantId],
                    'shared_at'      => $created,
                ];
                continue;
            }

            if (!in_array($grantId, $current['grant_ids'], true)) {
                $current['grant_ids'][] = $grantId;
            }
            if ($folder) {
                $current['via'] = 'folder';
            }
            if ($created < $current['shared_at']) {
                $current['shared_at'] = $created;
            }
            // The winning end: NULL beats any date, else the later one.
            if (!$current['indefinite'] && ($expires === null || $expires > $current['until'])) {
                $current['until']          = $expires;
                $current['until_label_at'] = DocumentSharingRules::untilLabelAt($expires, $duration);
                $current['indefinite']     = $expires === null;
                $current['grant_id']       = $grantId;
            }
            $out[$specialist][$document] = $current;
        }

        return $out;
    }
}
