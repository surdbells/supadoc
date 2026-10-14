<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Entity\Specialist;
use App\Domain\Entity\User;
use App\Domain\Enum\SpecialistStatus;
use App\Domain\Repository\SpecialistRepository;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use App\Infrastructure\Service\AfterResponse;
use App\Infrastructure\Service\DoctorOnboardingService;
use App\Infrastructure\Service\StaffPasswordService;
use Doctrine\ORM\EntityManagerInterface;
use PHPUnit\Framework\TestCase;

/**
 * Review fixes for doctor onboarding: no login can be minted for a live doctor
 * from the editable contact email, set-password links die with an email or
 * password change, forgot-password never returns its link, the public directory
 * hides switched-off doctors, and the reviewers' email carries no profile data.
 */
final class OnboardingHardeningTest extends TestCase
{
    private function em(): EntityManagerInterface
    {
        $_ENV['DB_SERVER_VERSION'] = '16';
        DoctrineEntityManagerFactory::reset();

        return DoctrineEntityManagerFactory::create();
    }

    private function specialist(?SpecialistStatus $status): Specialist
    {
        $s = new Specialist('Dr. Grace Bell', 'Cardiology');
        (new \ReflectionProperty(Specialist::class, 'status'))->setValue($s, $status);

        return $s;
    }

    private function user(): User
    {
        $user = new User('dr@example.test', 'Ada', 'Obi');
        $user->initTimestamps();

        return $user;
    }

    // ----- Invite: never a new login for a live doctor -----

    public function testLiveDoctorsCannotGetANewLoginFromTheContactEmail(): void
    {
        foreach ([null, SpecialistStatus::APPROVED, SpecialistStatus::SUSPENDED] as $status) {
            $this->assertNotNull(
                DoctorOnboardingService::newLoginProblem($this->specialist($status)),
                ($status?->value ?? 'legacy NULL') . ' doctors have patient records — their login comes from Staff',
            );
        }
        foreach ([SpecialistStatus::INVITED, SpecialistStatus::PENDING_REVIEW, SpecialistStatus::REJECTED] as $status) {
            $this->assertNull(
                DoctorOnboardingService::newLoginProblem($this->specialist($status)),
                $status->value . ' doctors are still onboarding and can be invited',
            );
        }
    }

    // ----- Set-password links die with an email or password change -----

    public function testChangingTheEmailVoidsAnOutstandingLink(): void
    {
        $user  = $this->user();
        $token = $user->issuePasswordToken(User::TOKEN_INVITE, StaffPasswordService::INVITE_TTL);

        $user->setEmail('  DR@example.test ');
        $this->assertTrue($user->passwordTokenMatches($token, User::TOKEN_INVITE), 'same address (normalised) keeps the link');

        $user->setEmail('fixed@example.test');
        $this->assertFalse($user->passwordTokenMatches($token, User::TOKEN_INVITE), 'the link sent to the old address is dead');
        $this->assertFalse($user->hasPendingInvite());
        $this->assertSame('fixed@example.test', $user->getEmail());
    }

    public function testSettingAPasswordVoidsAnOutstandingLink(): void
    {
        $user  = $this->user();
        $reset = $user->issuePasswordToken(User::TOKEN_RESET, StaffPasswordService::RESET_TTL);

        $user->setPassword('admin-chosen-pass'); // admin reset, or a change in Settings
        $this->assertFalse($user->passwordTokenMatches($reset, User::TOKEN_RESET));
        $this->assertTrue($user->verifyPassword('admin-chosen-pass'));

        $invite = $user->issuePasswordToken(User::TOKEN_INVITE, StaffPasswordService::INVITE_TTL);
        $user->choosePassword('doctor-chosen-pass');
        $this->assertFalse($user->passwordTokenMatches($invite, User::TOKEN_INVITE));
        $this->assertTrue($user->verifyPassword('doctor-chosen-pass'));
    }

    // ----- Forgot password -----

    public function testForgotPasswordNeverHandsBackTheLink(): void
    {
        $type = (new \ReflectionMethod(StaffPasswordService::class, 'requestReset'))->getReturnType();
        $this->assertInstanceOf(\ReflectionNamedType::class, $type);
        $this->assertSame('void', $type->getName(), 'the reset link must have no way back to the (public) caller');
    }

    public function testDeferredWorkRunsOnTheCliAndNeverThrows(): void
    {
        $ran = [];
        AfterResponse::defer(static function () use (&$ran): void {
            $ran[] = 'first';
        });
        $log = ini_set('error_log', \PHP_OS_FAMILY === 'Windows' ? 'NUL' : '/dev/null');
        try {
            AfterResponse::defer(static function (): void {
                throw new \RuntimeException('mail down');
            });
        } finally {
            ini_set('error_log', (string) $log);
        }
        AfterResponse::defer(static function () use (&$ran): void {
            $ran[] = 'after a failure';
        });

        $this->assertSame(['first', 'after a failure'], $ran);
    }

    // ----- Public directory: approved (or legacy) AND available -----

    public function testDirectoryAndFacetsHideUnavailableDoctors(): void
    {
        $repo = new SpecialistRepository($this->em());

        $public = $repo->directoryQuery();
        $this->assertStringContainsString('e.available = true', (string) $public->getDQL());
        $this->assertStringContainsString('e.status IS NULL OR e.status = :listedStatus', (string) $public->getDQL(), 'legacy doctors stay listed');
        $public->getQuery()->getSQL(); // compiles offline

        $facet = $repo->onlyListed($this->em()->createQueryBuilder()->select('e.specialty')->from(Specialist::class, 'e'));
        $this->assertStringContainsString('e.available = true', (string) $facet->getDQL(), 'facets count the same set');
        $facet->getQuery()->getSQL();

        $admin = $repo->directoryQuery(approvedOnly: false);
        $this->assertStringNotContainsString('e.available', (string) $admin->getDQL(), 'the back office still sees switched-off doctors');
        $narrowed = $repo->directoryQuery(availableOnly: true, approvedOnly: false);
        $this->assertSame(1, substr_count((string) $narrowed->getDQL(), 'e.available = true'));
    }

    // ----- Reviewers' email -----

    public function testReviewersEmailHasOnlyTheNameAndALink(): void
    {
        $mail = EmailTemplates::doctorReadyForReview('Dr <b>Ada</b>', 'https://backoffice.example/');
        $this->assertStringContainsString('https://backoffice.example/specialists?filter=review', $mail['html']);
        $this->assertStringNotContainsString('<b>Ada</b>', $mail['html']);
        $this->assertStringContainsString('Dr &lt;b&gt;Ada&lt;/b&gt;', $mail['html']);
        $this->assertStringContainsString('ready for review', strtolower($mail['subject']));

        $noLink = EmailTemplates::doctorReadyForReview('Dr Ada', '');
        $this->assertStringNotContainsString('href=', $noLink['html']);
        $this->assertStringContainsString('Needs review', $noLink['html']);
    }

    public function testBackofficeUrlComesFromItsSettingOrTheCorsList(): void
    {
        $this->assertSame('https://bo.example', DoctorOnboardingService::backofficeUrlFromEnv(['BACKOFFICE_WEB_URL' => ' https://bo.example/ ']));
        $this->assertSame('https://backoffice.dosthq.com', DoctorOnboardingService::backofficeUrlFromEnv([
            'CORS_ALLOWED_ORIGINS' => 'https://app.dosthq.com, https://backoffice.dosthq.com ,https://doctor.dosthq.com',
        ]));
        $this->assertSame('', DoctorOnboardingService::backofficeUrlFromEnv(['CORS_ALLOWED_ORIGINS' => 'https://app.dosthq.com']));
        $this->assertSame('', DoctorOnboardingService::backofficeUrlFromEnv(['BACKOFFICE_WEB_URL' => 'javascript:alert(1)']));
    }
}
