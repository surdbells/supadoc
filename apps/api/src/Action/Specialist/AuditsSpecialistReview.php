<?php

declare(strict_types=1);

namespace App\Action\Specialist;

use App\Domain\Entity\Specialist;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\AuditLogger;
use Psr\Http\Message\ServerRequestInterface;

/**
 * Records back-office doctor-management decisions (invite / approve / reject,
 * edits, document views, suspensions) in the audit trail against the doctor
 * (`specialist` / their id), attributed to the signed-in admin by name and id.
 * Best-effort — the decision itself has already been saved.
 */
trait AuditsSpecialistReview
{
    /**
     * The signed-in reviewer as [user id, display name].
     *
     * @return array{0:string, 1:string}
     */
    private function reviewer(ServerRequestInterface $request, UserRepository $users): array
    {
        $id = (string) $request->getAttribute('user_id');
        try {
            $a    = $users->find($id)?->toArray() ?? [];
            $name = trim(((string) ($a['first_name'] ?? '')) . ' ' . ((string) ($a['last_name'] ?? '')));
        } catch (\Throwable) {
            $name = '';
        }

        return [$id, $name !== '' ? $name : 'Admin'];
    }

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
            [$id, $name] = $this->reviewer($request, $users);
            $audit->record(
                $name,
                'admin',
                $action,
                null,
                'specialist',
                $specialist->getId(),
                $metadata + ['doctor' => $specialist->getName()],
                $id !== '' ? $id : null,
            );
        } catch (\Throwable) {
            // non-fatal
        }
    }
}
