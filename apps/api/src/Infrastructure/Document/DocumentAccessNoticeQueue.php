<?php

declare(strict_types=1);

namespace App\Infrastructure\Document;

/**
 * Notices (in-app notifications, emails) that document-sharing changes queue
 * while their transaction is open, sent only once it committed (spec §4.4):
 * a rolled-back request never notifies anyone. Request-scoped (one per
 * container). {@see DocumentSharingService::inPairs()} dispatches when it owns
 * the outermost transaction; a caller that owns it (the booking, a
 * reschedule) calls {@see dispatch()} after its commit and {@see discard()}
 * when it rolled back. Each task is run on its own, so one failing notice
 * never stops the rest.
 */
final class DocumentAccessNoticeQueue
{
    /** @var list<\Closure(): void> */
    private array $pending = [];

    public function push(\Closure $send): void
    {
        $this->pending[] = $send;
    }

    public function dispatch(): void
    {
        while ($this->pending !== []) {
            $task = array_shift($this->pending);
            try {
                $task();
            } catch (\Throwable $e) {
                error_log('[doc-access] notice failed: ' . $e::class . ': ' . $e->getMessage());
            }
        }
    }

    public function discard(): void
    {
        $this->pending = [];
    }

    public function count(): int
    {
        return count($this->pending);
    }
}
