<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Domain\Settings\PractitionerTerms;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AuditLogger;
use App\Infrastructure\Service\RequestClientTrait;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/doctor/terms/accept {version, agree: true} — the doctor accepts the
 * practitioner terms in force. The version must be the one in force (422
 * `version` when they changed meanwhile) and `agree` true. Records the
 * version, time and IP on the doctor and in the audit trail (with the text's
 * sha256). Accepting a version already accepted changes nothing. Returns the
 * same as GET /doctor/terms.
 */
final class AcceptDoctorTermsAction
{
    use ApiResponse;
    use ResolvesDoctorSpecialist;
    use RequestClientTrait;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly AuditLogger $audit,
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

        $problems = PractitionerTerms::acceptanceProblems((array) $request->getParsedBody());
        if ($problems !== []) {
            return $this->error($response, (string) reset($problems), 422, $problems);
        }

        $version = PractitionerTerms::version();
        if (!$specialist->hasAcceptedTerms($version)) {
            $ip = $this->clientIp($request);
            $specialist->acceptTerms($version, $ip);
            $this->specialists->save($specialist);
            try {
                $this->audit->record(
                    $specialist->getName(),
                    'doctor',
                    'specialist.terms_accepted',
                    null,
                    'specialist',
                    $specialist->getId(),
                    ['doctor' => $specialist->getName(), 'version' => $version, 'sha256' => PractitionerTerms::document()['sha256'], 'ip' => $ip],
                    (string) $request->getAttribute('user_id'),
                );
            } catch (\Throwable) {
                // non-fatal — the acceptance itself is saved.
            }
        }

        return $this->success($response, GetDoctorTermsAction::payload($specialist), 'Practitioner terms accepted');
    }
}
