<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Entity\Specialist;
use App\Domain\Entity\User;
use App\Domain\Enum\SpecialistStatus;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\AvailabilitySlotRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use App\Infrastructure\Service\AvailabilityService;
use App\Infrastructure\Service\DoctorOnboardingService;
use App\Infrastructure\Service\StaffPasswordService;
use DateTimeImmutable;
use Doctrine\ORM\EntityManagerInterface;
use PHPUnit\Framework\TestCase;

/**
 * Doctor onboarding: one-time set-password links (hashed, purpose-bound,
 * expiring, single-use), the checklist rule, and the review gate — above all
 * that a legacy doctor with no status still counts as approved, so the new
 * step never hides a live doctor.
 */
final class DoctorOnboardingTest extends TestCase
{
    private function em(): EntityManagerInterface
    {
        $_ENV['DB_SERVER_VERSION'] = '16';
        DoctrineEntityManagerFactory::reset();

        return DoctrineEntityManagerFactory::create();
    }

    /** A specialist as it was before onboarding existed (status column NULL). */
    private function legacySpecialist(): Specialist
    {
        $s = new Specialist('Dr. Grace Bell', 'Cardiology');
        (new \ReflectionProperty(Specialist::class, 'status'))->setValue($s, null);

        return $s;
    }

    private function completeSpecialist(): Specialist
    {
        $s = new Specialist('Dr. Ada Obi', 'Dermatology');
        $s->setPhotoUrl('/uploads/avatars/ada.jpg');
        $s->setBio('Board-certified dermatologist.');
        $s->setQualifications('MBBS, FMCP');
        $s->setMdcnNumber('mdcn/12345');
        $s->setSignatureKey('sig-key');
        $s->setWeeklyHours(['1' => [['09:00', '12:00']]]);

        return $s;
    }

    /** A staff login as it is once saved (timestamps set). */
    private function user(): User
    {
        $user = new User('dr@example.test', 'Ada', 'Obi');
        $user->initTimestamps();

        return $user;
    }

    // ----- One-time set-password links -----

    public function testTokenIsStoredOnlyAsItsHash(): void
    {
        $user  = $this->user();
        $token = $user->issuePasswordToken(User::TOKEN_INVITE, StaffPasswordService::INVITE_TTL);

        $this->assertMatchesRegularExpression('/^[0-9a-f]{64}$/', $token, '256 random bits, hex');
        $this->assertSame(hash('sha256', $token), User::hashPasswordToken($token));

        $stored = (new \ReflectionProperty(User::class, 'passwordTokenHash'))->getValue($user);
        $this->assertSame(User::hashPasswordToken($token), $stored);
        $this->assertNotSame($token, $stored, 'the plain token is never kept');
        $this->assertArrayNotHasKey('password_token_hash', $user->toArray());
    }

    public function testTokenIsBoundToItsPurposeAndExpires(): void
    {
        $now   = new DateTimeImmutable('2026-10-01 12:00:00');
        $user  = $this->user();
        $token = $user->issuePasswordToken(User::TOKEN_INVITE, StaffPasswordService::INVITE_TTL, $now);

        $this->assertTrue($user->passwordTokenMatches($token, User::TOKEN_INVITE, $now));
        $this->assertTrue($user->passwordTokenMatches($token, User::TOKEN_INVITE, $now->modify('+6 days 23 hours')));
        $this->assertFalse($user->passwordTokenMatches($token, User::TOKEN_INVITE, $now->modify('+7 days')), 'expired after 7 days');
        $this->assertFalse($user->passwordTokenMatches($token, User::TOKEN_RESET, $now), 'an invite link is not a reset link');
        $this->assertFalse($user->passwordTokenMatches(str_repeat('0', 64), User::TOKEN_INVITE, $now));
        $this->assertTrue($user->hasPendingInvite($now));
        $this->assertFalse($user->hasPendingInvite($now->modify('+8 days')));

        $reset = $user->issuePasswordToken(User::TOKEN_RESET, StaffPasswordService::RESET_TTL, $now);
        $this->assertFalse($user->passwordTokenMatches($token, User::TOKEN_INVITE, $now), 'a new link replaces the old one');
        $this->assertTrue($user->passwordTokenMatches($reset, User::TOKEN_RESET, $now->modify('+59 minutes')));
        $this->assertFalse($user->passwordTokenMatches($reset, User::TOKEN_RESET, $now->modify('+1 hour')), 'reset links last an hour');
    }

    public function testChoosingAPasswordUsesUpTheLink(): void
    {
        $user = $this->user();
        $this->assertFalse($user->hasPassword(), 'an invited login has no usable password');
        $this->assertFalse($user->verifyPassword(''));

        $token = $user->issuePasswordToken(User::TOKEN_INVITE, StaffPasswordService::INVITE_TTL);
        $user->choosePassword('a-strong-passphrase');

        $this->assertTrue($user->hasPassword());
        $this->assertTrue($user->verifyPassword('a-strong-passphrase'));
        $this->assertFalse($user->passwordTokenMatches($token, User::TOKEN_INVITE), 'single-use');
        $this->assertFalse($user->hasPendingInvite());
        $this->assertTrue($user->toArray()['password_set']);
    }

    public function testPasswordRuleMatchesTheSettingsChange(): void
    {
        $this->assertNotNull(StaffPasswordService::passwordProblem('short'));
        $this->assertNotNull(StaffPasswordService::passwordProblem('1234567'));
        $this->assertNull(StaffPasswordService::passwordProblem('12345678'));
    }

    // ----- Checklist -----

    public function testEmptyProfileFailsEveryItem(): void
    {
        $checklist = DoctorOnboardingService::checklistFrom(new Specialist('Dr. New', 'GP'), false, false);

        $this->assertSame(DoctorOnboardingService::ITEMS, array_keys($checklist));
        $this->assertSame([], array_filter($checklist));
        $this->assertFalse(DoctorOnboardingService::isComplete($checklist));
    }

    public function testCompleteProfilePasses(): void
    {
        $checklist = DoctorOnboardingService::checklistFrom($this->completeSpecialist(), false, true);

        $this->assertTrue(DoctorOnboardingService::isComplete($checklist), print_r($checklist, true));
        $this->assertFalse(DoctorOnboardingService::isComplete(
            DoctorOnboardingService::checklistFrom($this->completeSpecialist(), false, false),
        ), 'the payout account is required');
    }

    public function testAvailabilityCountsWeeklyHoursOrPublishedSlots(): void
    {
        $s = $this->completeSpecialist();
        $s->setWeeklyHours(['1' => [], '2' => []]); // days switched on with no windows
        $this->assertFalse(DoctorOnboardingService::checklistFrom($s, false, true)['availability']);
        $this->assertTrue(DoctorOnboardingService::checklistFrom($s, true, true)['availability'], 'open slots count');

        $s->setWeeklyHours(null);
        $this->assertFalse(DoctorOnboardingService::checklistFrom($s, false, true)['availability']);
    }

    public function testQualificationsCountTheStructuredEntries(): void
    {
        $s = $this->completeSpecialist();
        $s->setQualifications(null);
        $this->assertFalse(DoctorOnboardingService::checklistFrom($s, false, true)['qualifications']);

        $s->setQualificationEntries([['title' => 'MBBS', 'institution' => 'UNILAG', 'year' => '2010']]);
        $this->assertTrue(DoctorOnboardingService::checklistFrom($s, false, true)['qualifications']);
    }

    // ----- Review gate -----

    public function testNullStatusCountsAsApproved(): void
    {
        $legacy = $this->legacySpecialist();

        $this->assertTrue(SpecialistStatus::isListable(null));
        $this->assertTrue($legacy->isApproved());
        $this->assertSame(SpecialistStatus::APPROVED, $legacy->getStatus());
        $this->assertSame('approved', $legacy->toReviewArray()['status']);
        $this->assertTrue($legacy->isBookable());

        $legacy->setAvailable(false);
        $this->assertFalse($legacy->isBookable(), 'approved but switched off is not bookable');
    }

    public function testNewDoctorIsHiddenUntilApproved(): void
    {
        $s = new Specialist('Dr. New', 'GP');
        $this->assertSame(SpecialistStatus::INVITED, $s->getStatus());
        $this->assertFalse($s->isApproved());
        $this->assertFalse($s->isBookable());

        $s->submitForReview();
        $this->assertSame(SpecialistStatus::PENDING_REVIEW, $s->getStatus());
        $this->assertFalse($s->isBookable());

        $s->reject('Please upload a clearer photo.');
        $this->assertSame(SpecialistStatus::REJECTED, $s->getStatus());
        $this->assertSame('Please upload a clearer photo.', $s->toReviewArray()['rejection_reason']);
        $this->assertFalse($s->isApproved());

        $s->submitForReview();
        $this->assertNull($s->getRejectionReason(), 'resubmitting clears the old reason');

        $s->approve('admin-1');
        $this->assertTrue($s->isApproved());
        $this->assertTrue($s->isBookable());
        $this->assertTrue($s->toArray()['verified']);
        $this->assertNotNull($s->toReviewArray()['approved_at']);

        foreach ([SpecialistStatus::INVITED, SpecialistStatus::PENDING_REVIEW, SpecialistStatus::REJECTED, SpecialistStatus::SUSPENDED] as $status) {
            $this->assertFalse(SpecialistStatus::isListable($status), $status->value . ' must not be listed');
        }
    }

    public function testDirectoryQueryOnlyListsApprovedOrLegacyDoctors(): void
    {
        $repo = new SpecialistRepository($this->em());

        $public = $repo->directoryQuery();
        $this->assertStringContainsString('e.status IS NULL OR e.status = :listedStatus', (string) $public->getDQL());
        $this->assertSame('approved', $public->getParameter('listedStatus')?->getValue());
        $sql = $public->getQuery()->getSQL(); // compiles offline — bad field names throw
        $this->assertStringContainsStringIgnoringCase('status IS NULL OR', $sql);

        $admin = $repo->directoryQuery(approvedOnly: false);
        $this->assertStringNotContainsString('listedStatus', (string) $admin->getDQL(), 'the back office sees everyone');
        $admin->getQuery()->getSQL();

        // The facet queries share the same gate.
        $facet = $repo->onlyListed($this->em()->createQueryBuilder()->select('e.specialty')->from(Specialist::class, 'e'));
        $this->assertStringContainsStringIgnoringCase('status IS NULL OR', $facet->getQuery()->getSQL());
    }

    public function testUnapprovedDoctorsNeverGetTheDefaultHours(): void
    {
        $em      = $this->em();
        $service = new AvailabilityService(new AppointmentRepository($em), new AvailabilitySlotRepository($em));
        $hours   = new \ReflectionMethod(AvailabilityService::class, 'weeklyHours');

        $this->assertNotSame([], $hours->invoke($service, $this->legacySpecialist()), 'approved doctors keep the weekday default');
        $this->assertSame([], $hours->invoke($service, new Specialist('Dr. New', 'GP')), 'no made-up hours while onboarding');

        $own = new Specialist('Dr. New', 'GP');
        $own->setWeeklyHours(['2' => [['10:00', '11:00']]]);
        $this->assertSame(['2' => [['10:00', '11:00']]], $hours->invoke($service, $own), 'their own hours always apply');
    }

    // ----- Emails -----

    public function testEmailsCarryTheLinkAndEscapeInput(): void
    {
        $invite = EmailTemplates::doctorInvite('Dr <b>Ada</b>', 'https://doctor.example/auth/set-password?token=abc', 7);
        $this->assertStringContainsString('https://doctor.example/auth/set-password?token=abc', $invite['html']);
        $this->assertStringContainsString('7 days', $invite['html']);
        $this->assertStringNotContainsString('<b>Ada</b>', $invite['html']);

        $reset = EmailTemplates::staffPasswordReset('Ada', 'https://doctor.example/auth/reset-password?token=def', 60);
        $this->assertStringContainsString('reset-password?token=def', $reset['html']);
        $this->assertStringContainsString('60 minutes', $reset['html']);

        $rejected = EmailTemplates::doctorRejected('Dr Ada', '<script>x</script> Add your MDCN number', 'https://doctor.example');
        $this->assertStringNotContainsString('<script>', $rejected['html']);
        $this->assertStringContainsString('https://doctor.example/onboarding', $rejected['html']);

        $approved = EmailTemplates::doctorApproved('Dr Ada', 'https://doctor.example');
        $this->assertStringContainsString('https://doctor.example/dashboard', $approved['html']);
    }

    public function testInviteNameStripsTheHonorific(): void
    {
        $this->assertSame(['Grace', 'Bell'], DoctorOnboardingService::nameParts('Dr. Grace Bell'));
        $this->assertSame(['Ada', 'Obi Nwosu'], DoctorOnboardingService::nameParts('Prof Ada Obi Nwosu'));
        $this->assertSame(['Chidi', 'Doctor'], DoctorOnboardingService::nameParts('Dr Chidi'));
    }
}
