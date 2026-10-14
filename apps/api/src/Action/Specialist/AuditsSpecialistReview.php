<?php

declare(strict_types=1);

namespace App\Action\Specialist;

use App\Domain\Entity\Specialist;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\AuditLogger;
use Psr\Http\Message\ServerRequestInterface;

/**
 * Records back-office onboarding decisions (invite / approve / reject) in the
 * audit trail, attributed to the signed-in admin. Best-effort — the decision
 * itself has already been saved.
 */
trait AuditsSpecialistReview
{
    /** @param array<string,mixed> $metadata */
    private function auditReview(
        ServerRequestInterface $request,
        UserRepository $users,
        AuditLogger $audit,
        string $action,
        Specialist $specialist,
        array $metadata = [],
    ): void {
        try {
            $actor = $users->find((string) $request->getAttribute('user_id'));
            $a     = $actor?->toArray() ?? [];
            $name  = trim(((string) ($a['first_name'] ?? '')) . ' ' . ((string) ($a['last_name'] ?? '')));
            $audit->record(
                $name !== '' ? $name : 'Admin',
                'admin',
                $action,
                null,
                'specialist',
                $specialist->getId(),
                $metadata + ['doctor' => $specialist->getName()],
            );
        } catch (\Throwable) {
            // non-fatal
        }
    }
}
