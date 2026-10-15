<?php

declare(strict_types=1);

namespace App\Action\Specialist;

use App\Domain\Entity\AuditEvent;
use App\Domain\Entity\Specialist;
use App\Domain\Entity\SpecialistStatusEvent;
use App\Domain\Repository\AuditEventRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\SpecialistStatusEventRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/specialists/{id}/history — the doctor page's History tab: their
 * status changes (submitted, approved, sent back, suspended, reinstated — who,
 * when, why) and everything recorded against them in the audit trail
 * (invites, edits with before/after, documents uploaded / viewed / verified,
 * terms accepted, change requests), each newest first, up to 200 of each.
 * Needs `specialists.manage`.
 */
final class GetSpecialistHistoryAction
{
    use ApiResponse;

    public function __construct(
        private readonly SpecialistRepository $specialists,
        private readonly SpecialistStatusEventRepository $statusEvents,
        private readonly AuditEventRepository $audit,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        /** @var Specialist $specialist */
        $specialist = $this->specialists->findOrFail((string) ($args['id'] ?? ''));

        return $this->success($response, [
            'status_events' => array_map(
                static fn (SpecialistStatusEvent $e): array => $e->toArray(),
                $this->statusEvents->forSpecialist($specialist->getId()),
            ),
            'audit'         => array_map(
                static fn (AuditEvent $e): array => $e->toArray(),
                $this->audit->forResource('specialist', $specialist->getId()),
            ),
        ]);
    }
}
