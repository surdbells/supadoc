<?php

declare(strict_types=1);

namespace App\Infrastructure\Middleware;

use App\Domain\Entity\DoctorApplication;
use App\Domain\Exception\ApplicationProblem;
use App\Domain\Repository\DoctorApplicationRepository;
use App\Domain\Settings\ClinicTime;
use App\Infrastructure\Application\ApplicationDraftPurger;
use App\Infrastructure\Service\JwtService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;

/**
 * The doctor applicant's session (spec §3.1): a Bearer token of one scope —
 * `application_draft` for the draft routes, `application_access` for the
 * status routes — whose application still exists. Publishes the application
 * as the request attribute `doctor_application`.
 *
 *  - a bad, missing or wrong-scope token, or one whose application is gone:
 *    401 `applicant_token_invalid`;
 *  - draft scope: an expired draft is purged (under the application lock) → 404
 *    `draft_not_found`; a submitted one → 409 `draft_submitted` (with its
 *    reference), except on submit itself (`$allowSubmitted`: the idempotent
 *    replay).
 *
 * Constructed in config/routes.php (never `static`).
 */
final class ApplicantTokenMiddleware implements MiddlewareInterface
{
    public const ATTRIBUTE = 'doctor_application';

    public function __construct(
        private readonly JwtService $jwt,
        private readonly string $scope,
        private readonly DoctorApplicationRepository $applications,
        private readonly ?ApplicationDraftPurger $purger = null,
        private readonly bool $allowSubmitted = false,
    ) {
    }

    public function process(ServerRequestInterface $request, RequestHandlerInterface $handler): ResponseInterface
    {
        $header = $request->getHeaderLine('Authorization');
        $token  = preg_match('/^Bearer\s+(\S+)$/i', trim($header), $m) === 1 ? $m[1] : '';
        $id     = $token !== '' ? $this->jwt->verifyApplicantToken($token, $this->scope) : null;
        $app    = $id !== null ? $this->applications->findApplication($id) : null;
        if (!$app instanceof DoctorApplication) {
            throw new ApplicationProblem(401, 'applicant_token_invalid', 'Your session has ended. Resume your application or check your status again.');
        }

        if ($this->scope === JwtService::APPLICATION_DRAFT) {
            $now = ClinicTime::now();
            // The purge re-reads the row under its lock (refreshing $app): a draft submitted or saved meanwhile stays.
            if ($app->isExpiredDraft($now) && ($this->purger === null || $this->purger->purge($app, $now))) {
                throw new ApplicationProblem(404, 'draft_not_found', 'Your saved application has expired. Start a new one.');
            }
            if (!$app->isDraft() && !$this->allowSubmitted) {
                throw new ApplicationProblem(409, 'draft_submitted', 'This application has already been submitted. Check its status with your reference number.', ['reference' => $app->getReference()]);
            }
        } elseif ($app->isDraft()) {
            throw new ApplicationProblem(401, 'applicant_token_invalid', 'Your session has ended. Resume your application or check your status again.');
        }

        return $handler->handle($request->withAttribute(self::ATTRIBUTE, $app));
    }
}
