<?php

declare(strict_types=1);

namespace App\Action\Specialist;

use App\Domain\Doctor\DoctorCredentials;
use App\Domain\Entity\Specialist;
use App\Domain\Repository\SpecialistCredentialRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Domain\Settings\ClinicTime;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\DoctorOnboardingService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/specialists?q=&filter=&page=&per_page=&sort_by=&sort_dir= — the
 * back-office specialist list, server-paginated. Staff-scoped and gated on
 * `specialists.manage`. Unlike the public/portal directories, it includes
 * every specialist whatever their status, each one's (otherwise server-side)
 * contact email, review status, licence standing, documents waiting and
 * doctor-login state, so an operator can find, review and fix them.
 *
 * `q` searches name, specialty, email and MDCN number; `filter` is one of
 * review | changes | onboarding | rejected | approved | suspended |
 * licence_expiring | licence_expired | credentials_missing |
 * credentials_pending; `sort_by` name (default, A–Z) | specialty | created_at
 * | submitted_at | licence_expires_at. With none of page / per_page / q /
 * filter it returns everyone (up to 500, by name) as before, for pickers.
 */
final class ListSpecialistsAdminAction
{
    use ApiResponse;

    /** The unpaginated (picker) form's cap. */
    private const ALL_LIMIT = 500;

    public function __construct(
        private readonly SpecialistRepository $specialists,
        private readonly SpecialistCredentialRepository $credentials,
        private readonly UserRepository $users,
        private readonly DoctorOnboardingService $onboarding,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $query  = $request->getQueryParams();
        $search = trim((string) ($query['q'] ?? $query['search'] ?? ''));
        $filter = strtolower(trim((string) ($query['filter'] ?? '')));
        if ($filter !== '' && $filter !== 'all' && !in_array($filter, SpecialistRepository::ADMIN_FILTERS, true)) {
            return $this->error($response, 'Validation failed', 422, [
                'filter' => 'Use one of: all, ' . implode(', ', SpecialistRepository::ADMIN_FILTERS),
            ]);
        }
        $filter = $filter === 'all' ? '' : $filter;

        $paged = isset($query['page']) || isset($query['per_page']) || $search !== '' || $filter !== '';
        $p     = $this->getPaginationParams($query + ['sort_by' => 'name', 'sort_dir' => 'asc']);
        if (!$paged) {
            $p = ['page' => 1, 'per_page' => self::ALL_LIMIT, 'offset' => 0] + $p;
        }

        $todayYmd = ClinicTime::todayYmd();
        $page     = $this->specialists->adminPage(
            $p['offset'],
            $p['per_page'],
            $search !== '' ? $search : null,
            $filter !== '' ? $filter : null,
            $p['sort_by'],
            $p['sort_dir'],
            ClinicTime::today(),
        );
        $ids     = array_map(static fn (Specialist $s): string => $s->getId(), $page['items']);
        $logins  = $this->users->findBySpecialistIds($ids);
        $waiting = $this->credentials->pendingCountsFor($ids);

        $rows = array_map(
            fn (Specialist $s): array => $s->toArray()
                + ['email' => $s->getEmail()]
                + $s->toReviewArray()
                + [
                    'licence_status'      => DoctorCredentials::licenceStatus($s->getLicenceExpiresAt()?->format('Y-m-d'), $todayYmd),
                    'credentials_missing' => $s->getCredentialsDueAt() !== null,
                    'credentials_pending' => $waiting[$s->getId()] ?? 0,
                    'login'               => $this->onboarding->loginArray($logins[$s->getId()] ?? null),
                ],
            $page['items'],
        );

        return $this->paginated($response, $rows, $page['total'], $p['page'], $p['per_page']);
    }
}
