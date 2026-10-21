<?php

declare(strict_types=1);

namespace App\Infrastructure\Document;

/**
 * The patient notices a doctor's reinstatement owes (spec §1.4): worked out
 * BEFORE the doctor's status flips (by {@see DocumentSharingService::doctorReinstated()}),
 * sent only once {@see \App\Infrastructure\Service\SpecialistSuspensionService::reinstate()}
 * saved the reinstatement — so a failed reinstatement tells nobody anything.
 */
final class ReinstatementNotices
{
    /** @param list<\Closure(): void> $tasks */
    public function __construct(private array $tasks = [])
    {
    }

    public function dispatch(): void
    {
        while ($this->tasks !== []) {
            $task = array_shift($this->tasks);
            try {
                $task();
            } catch (\Throwable $e) {
                error_log('[doc-access] reinstatement notice failed: ' . $e::class . ': ' . $e->getMessage());
            }
        }
    }

    public function count(): int
    {
        return count($this->tasks);
    }
}
