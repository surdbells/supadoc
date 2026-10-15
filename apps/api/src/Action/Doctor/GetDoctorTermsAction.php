<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\Specialist;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Domain\Settings\PractitionerTerms;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor/terms — the practitioner terms in force (version, title, the
 * text as plain blocks to render without HTML, its sha256) and whether the
 * signed-in doctor has accepted this version.
 */
final class GetDoctorTermsAction
{
    use ApiResponse;
    use ResolvesDoctorSpecialist;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $specialist = $this->doctorSpecialist($request, $this->users, $this->specialists);
        if ($specialist === null) {
            return $this->error($response, 'This account is not a doctor profile', 403);
        }

        return $this->success($response, self::payload($specialist));
    }

    /** @return array<string,mixed> */
    public static function payload(Specialist $specialist): array
    {
        $doc = PractitionerTerms::document();

        return [
            'version'          => $doc['version'],
            'title'            => $doc['title'],
            'blocks'           => $doc['blocks'],
            'sha256'           => $doc['sha256'],
            'accepted_version' => $specialist->getTermsVersion(),
            'accepted_at'      => $specialist->getTermsAcceptedAt()?->format(DATE_ATOM),
            'accepted'         => $specialist->hasAcceptedTerms($doc['version']),
        ];
    }
}
