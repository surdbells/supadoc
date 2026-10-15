<?php

declare(strict_types=1);

namespace App\Action\Specialist;

use App\Domain\Entity\Specialist;
use App\Domain\Repository\SpecialistRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\SpecialistSuspensionService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/specialists/{id}/suspend/preview — what suspending this doctor would
 * do, for the confirm dialog: future bookings to cancel, follow-up proposals
 * to withdraw, patients to tell, refunds (count + total, guest fees included)
 * and guests. Changes nothing. Also lists the suspension codes. Needs
 * `specialists.manage`.
 */
final class PreviewSpecialistSuspensionAction
{
    use ApiResponse;

    public function __construct(
        private readonly SpecialistRepository $specialists,
        private readonly SpecialistSuspensionService $suspensions,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        /** @var Specialist $specialist */
        $specialist = $this->specialists->findOrFail((string) ($args['id'] ?? ''));

        return $this->success($response, $this->suspensions->preview($specialist) + [
            'codes' => array_map(
                static fn (string $code, string $label): array => ['code' => $code, 'label' => $label],
                array_keys(SpecialistSuspensionService::CODES),
                array_values(SpecialistSuspensionService::CODES),
            ),
        ]);
    }
}
