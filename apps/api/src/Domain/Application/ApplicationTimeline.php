<?php

declare(strict_types=1);

namespace App\Domain\Application;

use App\Domain\Enum\DoctorApplicationStatus as S;

/**
 * The applicant's status timeline (spec §3.2.20, §6.5.12). Pure. Rows:
 * Submitted and Under Review; More Info Needed and Interview Scheduled only once
 * they happened (or are current); then exactly one outcome row — Approved
 * (pending until reached) unless the outcome is Rejected or Withdrawn. Rows
 * that never happened are hidden once the status is final.
 *
 * Done rows are ordered by when each last happened and the current row comes
 * straight after the latest done one — after a reply, the current Under Review
 * sits below the done More Info Needed, never above it. Then the pending rows.
 */
final class ApplicationTimeline
{
    /**
     * @param list<array{to_status:string, at:string}> $changes the applicant-visible status changes (any order), `at` ISO
     * @return list<array{key:string, label:string, state:string, at:?string, description:?string}>
     */
    public static function rows(S $status, array $changes): array
    {
        /** @var array<string,string> $last key => latest ISO */
        $last = [];
        foreach ($changes as $c) {
            $key = (string) ($c['to_status'] ?? '');
            $at  = (string) ($c['at'] ?? '');
            if ($key === '' || $at === '') {
                continue;
            }
            if (!isset($last[$key]) || self::ts($at) >= self::ts($last[$key])) {
                $last[$key] = $at;
            }
        }
        $current  = $status->value;
        $terminal = $status->isTerminal();
        $outcome  = in_array($current, ['rejected', 'withdrawn'], true) ? $current : 'approved';

        $base = ['submitted', 'under_review', 'more_info_needed', 'interview_scheduled', $outcome];
        $done = [];
        $pending = [];
        foreach ($base as $key) {
            $happened = isset($last[$key]) || $key === 'submitted'; // an application past draft was submitted
            if ($key === $current) {
                continue;
            }
            if ($happened) {
                $done[] = $key;
            } elseif (!$terminal && in_array($key, ['under_review', 'approved'], true)) {
                $pending[] = $key;
            }
        }
        usort($done, static fn (string $a, string $b): int => self::ts($last[$a] ?? '') <=> self::ts($last[$b] ?? '') ?: array_search($a, $base, true) <=> array_search($b, $base, true));

        $rows = [];
        foreach ($done as $key) {
            $rows[] = self::row($key, 'done', $last[$key] ?? null, null);
        }
        if ($current !== 'draft') {
            $rows[] = self::row($current, 'current', $last[$current] ?? null, $status->applicantDescription());
        }
        foreach ($pending as $key) {
            $rows[] = self::row($key, 'pending', null, null);
        }

        return $rows;
    }

    /** @return array{key:string, label:string, state:string, at:?string, description:?string} */
    private static function row(string $key, string $state, ?string $at, ?string $description): array
    {
        return [
            'key'         => $key,
            'label'       => S::from($key)->applicantLabel(),
            'state'       => $state,
            'at'          => $at,
            'description' => $description,
        ];
    }

    private static function ts(string $iso): int
    {
        if ($iso === '') {
            return 0;
        }
        try {
            return (new \DateTimeImmutable($iso))->getTimestamp();
        } catch (\Throwable) {
            return 0;
        }
    }
}
