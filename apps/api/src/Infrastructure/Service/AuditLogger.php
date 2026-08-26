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
     * @param array<string,mixed> $metadata
     */
    public function record(
        string $actorName,
        string $actorRole,
        string $action,
        ?string $appointmentId = null,
        ?string $resourceType = null,
        ?string $resourceId = null,
        array $metadata = [],
    ): void {
        $this->events->save(new AuditEvent(
            $actorName,
            $actorRole,
            $action,
            $appointmentId,
            $resourceType,
            $resourceId,
            $metadata,
        ));
    }
}
