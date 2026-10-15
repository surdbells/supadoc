<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Entity\AuditEvent;
use App\Domain\Repository\AuditEventRepository;

/**
 * Records clinically significant actions to the append-only audit trail. Kept as
 * a thin service so actions record an event with one call and never touch the
 * EntityManager directly for auditing.
 */
final class AuditLogger
{
    public function __construct(private readonly AuditEventRepository $events)
    {
    }

    /**
     * Whether an event can be recorded now — false once a failed transaction
     * closed the entity manager for the rest of the request (every write
     * would throw).
     */
    public function isWritable(): bool
    {
        return $this->events->isWritable();
    }

    /**
     * @param array<string,mixed> $metadata
     * @param string|null         $actorId the acting user's id, when known (null: the system)
     */
    public function record(
        string $actorName,
        string $actorRole,
        string $action,
        ?string $appointmentId = null,
        ?string $resourceType = null,
        ?string $resourceId = null,
        array $metadata = [],
        ?string $actorId = null,
    ): void {
        $this->events->save(new AuditEvent(
            $actorName,
            $actorRole,
            $action,
            $appointmentId,
            $resourceType,
            $resourceId,
            $metadata,
            $actorId,
        ));
    }
}
