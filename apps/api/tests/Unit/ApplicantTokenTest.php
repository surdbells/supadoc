<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Entity\DoctorApplication;
use App\Domain\Exception\ApplicationProblem;
use App\Domain\Repository\DoctorApplicationRepository;
use App\Infrastructure\Middleware\ApplicantTokenMiddleware;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use App\Infrastructure\Service\JwtService;
use DateTimeImmutable;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/** Spec §2.8 / §3.1: applicant tokens by scope, refused by validateAccessToken; the middleware's answers. */
final class ApplicantTokenTest extends TestCase
{
    private const SECRET = 'a-test-secret-that-is-at-least-32-bytes-long';

    private JwtService $jwt;

    protected function setUp(): void
    {
        $this->jwt = new JwtService(self::SECRET, 900, 43200);
    }

    public function testIssueAndVerifyByScope(): void
    {
        $draft  = $this->jwt->issueApplicantToken('app-1', JwtService::APPLICATION_DRAFT, 14400);
        $access = $this->jwt->issueApplicantToken('app-1', JwtService::APPLICATION_ACCESS, 1800);
        $this->assertSame('app-1', $this->jwt->verifyApplicantToken($draft, JwtService::APPLICATION_DRAFT));
        $this->assertNull($this->jwt->verifyApplicantToken($draft, JwtService::APPLICATION_ACCESS), 'wrong scope');
        $this->assertSame('app-1', $this->jwt->verifyApplicantToken($access, JwtService::APPLICATION_ACCESS));
        $this->assertNull($this->jwt->verifyApplicantToken('garbage', JwtService::APPLICATION_DRAFT));
        $this->assertNull((new JwtService('another-secret-that-is-also-32-bytes-long!', 900, 1))->verifyApplicantToken($draft, JwtService::APPLICATION_DRAFT));
        $this->assertNull($this->jwt->verifyApplicantToken($this->jwt->issueApplicantToken('app-1', JwtService::APPLICATION_DRAFT, -10), JwtService::APPLICATION_DRAFT), 'expired');
    }

    public function testValidateAccessTokenRefusesBothApplicantTypes(): void
    {
        foreach ([JwtService::APPLICATION_DRAFT, JwtService::APPLICATION_ACCESS] as $scope) {
            try {
                $this->jwt->validateAccessToken($this->jwt->issueApplicantToken('app-1', $scope, 600));
                $this->fail("{$scope} must not pass as a staff/customer access token");
            } catch (\RuntimeException) {
                $this->addToAssertionCount(1);
            }
        }
    }

    public function testTheMiddleware(): void
    {
        $_ENV['DB_SERVER_VERSION'] = '16';
        DoctrineEntityManagerFactory::reset();
        $em   = DoctrineEntityManagerFactory::create();
        $repo = new DoctrineApplicationsInMemory($em);

        $draft = new DoctorApplication('ng', 'ada@example.com');
        $draft->touchDraft(new DateTimeImmutable(), 30);
        $submitted = new DoctorApplication('ng', 'bola@example.com');
        $submitted->markSubmitted('GVM-DR-2026-12345', new DateTimeImmutable());
        $expired = new DoctorApplication('ng', 'chidi@example.com');
        $expired->touchDraft(new DateTimeImmutable('-31 days'), 30);
        foreach ([$draft, $submitted, $expired] as $app) {
            $em->getUnitOfWork()->registerManaged($app, ['id' => $app->getId()], []);
        }

        $draftMw  = new ApplicantTokenMiddleware($this->jwt, JwtService::APPLICATION_DRAFT, $repo->repository());
        $submitMw = new ApplicantTokenMiddleware($this->jwt, JwtService::APPLICATION_DRAFT, $repo->repository(), null, true);
        $trackMw  = new ApplicantTokenMiddleware($this->jwt, JwtService::APPLICATION_ACCESS, $repo->repository());
        $tok      = fn (DoctorApplication $a, string $scope): string => $this->jwt->issueApplicantToken($a->getId(), $scope, 600);

        $this->assertSame($draft->getId(), $this->pass($draftMw, $tok($draft, JwtService::APPLICATION_DRAFT)));
        $this->assertSame([401, 'applicant_token_invalid'], $this->refusal($draftMw, null));
        $this->assertSame([401, 'applicant_token_invalid'], $this->refusal($draftMw, 'not-a-token'));
        $this->assertSame([401, 'applicant_token_invalid'], $this->refusal($draftMw, $tok($draft, JwtService::APPLICATION_ACCESS)), 'an access token opens no draft route');
        $this->assertSame([409, 'draft_submitted'], $this->refusal($draftMw, $tok($submitted, JwtService::APPLICATION_DRAFT)));
        $this->assertSame($submitted->getId(), $this->pass($submitMw, $tok($submitted, JwtService::APPLICATION_DRAFT)), 'submit replays');
        $this->assertSame([404, 'draft_not_found'], $this->refusal($draftMw, $tok($expired, JwtService::APPLICATION_DRAFT)));
        $this->assertSame([401, 'applicant_token_invalid'], $this->refusal($trackMw, $tok($submitted, JwtService::APPLICATION_DRAFT)), 'a draft token opens no status route');
        $this->assertSame($submitted->getId(), $this->pass($trackMw, $tok($submitted, JwtService::APPLICATION_ACCESS)));
        $this->assertSame([401, 'applicant_token_invalid'], $this->refusal($trackMw, $tok($draft, JwtService::APPLICATION_ACCESS)), 'a draft has no status page');

        try {
            $this->pass($draftMw, $tok($submitted, JwtService::APPLICATION_DRAFT));
        } catch (ApplicationProblem $p) {
            $this->assertSame('GVM-DR-2026-12345', $p->extra['reference']);
        }
        DoctrineEntityManagerFactory::reset();
    }

    private function pass(ApplicantTokenMiddleware $mw, ?string $token): string
    {
        $request = (new ServerRequestFactory())->createServerRequest('GET', '/api/public/doctor-applications/drafts/current');
        if ($token !== null) {
            $request = $request->withHeader('Authorization', 'Bearer ' . $token);
        }
        $handler = new class implements RequestHandlerInterface {
            public string $seen = '';

            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                $this->seen = $request->getAttribute(ApplicantTokenMiddleware::ATTRIBUTE)->getId();

                return new Response();
            }
        };
        $mw->process($request, $handler);

        return $handler->seen;
    }

    /** @return array{0:int, 1:string} */
    private function refusal(ApplicantTokenMiddleware $mw, ?string $token): array
    {
        try {
            $this->pass($mw, $token);
        } catch (ApplicationProblem $p) {
            return [$p->status, $p->errorCode];
        }
        $this->fail('expected a refusal');
    }
}

/** Builds the real repository over an offline EntityManager whose identity map holds the test rows. */
final class DoctrineApplicationsInMemory
{
    public function __construct(private readonly \Doctrine\ORM\EntityManagerInterface $em)
    {
    }

    public function repository(): DoctorApplicationRepository
    {
        return new DoctorApplicationRepository($this->em);
    }
}
