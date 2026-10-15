<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Call\CallAccess;
use App\Domain\Doctor\DoctorCredentials;
use App\Domain\Doctor\DoctorStanding;
use App\Domain\Entity\Appointment;
use App\Domain\Entity\AuditEvent;
use App\Domain\Entity\Patient;
use App\Domain\Entity\Specialist;
use App\Domain\Entity\SpecialistCredential;
use App\Domain\Entity\SpecialistStatusEvent;
use App\Domain\Entity\User;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Enum\SpecialistStatus;
use App\Domain\Exception\ValidationException;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\AuditEventRepository;
use App\Domain\Repository\PrescriptionRepository;
use App\Domain\Repository\SpecialistCredentialRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\SpecialistStatusEventRepository;
use App\Domain\Repository\StaffSessionRepository;
use App\Domain\Repository\UserRepository;
use App\Domain\Settings\PractitionerTerms;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Middleware\DoctorStandingMiddleware;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use App\Infrastructure\Service\AppointmentPaymentService;
use App\Infrastructure\Service\CredentialExpiryService;
use App\Infrastructure\Service\DoctorCredentialService;
use App\Infrastructure\Service\DoctorOnboardingService;
use App\Infrastructure\Service\SpecialistSuspensionService;
use App\Infrastructure\Service\WalletService;
use App\Infrastructure\Storage\CredentialStore;
use DateTimeImmutable;
use Doctrine\ORM\EntityManagerInterface;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * Doctor onboarding + management: the documents and terms on the checklist,
 * the approval gate, identity fields locked after approval, suspension (what
 * it cancels and refunds, run again safely), reinstatement, who may do what
 * in which standing, the licence cron's stages, and the terms version.
 */
final class DoctorManagementTest extends TestCase
{
    private const TODAY = '2026-10-15';

    protected function tearDown(): void
    {
        PractitionerTerms::configure(PractitionerTerms::DEFAULT_VERSION);
    }

    private function em(): EntityManagerInterface
    {
        $_ENV['DB_SERVER_VERSION'] = '16';
        DoctrineEntityManagerFactory::reset();

        return DoctrineEntityManagerFactory::create();
    }

    private function doctor(?SpecialistStatus $status = SpecialistStatus::APPROVED, bool $terms = true): Specialist
    {
        $s = new Specialist('Dr. Ada Obi', 'Dermatology');
        (new \ReflectionProperty(Specialist::class, 'status'))->setValue($s, $status);
        $s->setPhotoUrl('/uploads/avatars/ada.jpg');
        $s->setBio('Board-certified dermatologist.');
        $s->setQualifications('MBBS, FMCP');
        $s->setMdcnNumber('MDCN/12345');
        $s->setSignatureKey('sig-key');
        $s->setWeeklyHours(['1' => [['09:00', '12:00']]]);
        $s->setConsultationFee('20000.00');
        if ($terms) {
            $s->acceptTerms(PractitionerTerms::version(), '203.0.113.7');
        }

        return $s;
    }

    private function document(string $type, string $status = SpecialistCredential::STATUS_PENDING, ?string $expires = null): SpecialistCredential
    {
        $c = new SpecialistCredential('s-1', $type, 'credentials/' . bin2hex(random_bytes(16)) . '.bin', 'doc.pdf', 'application/pdf', 1000, str_repeat('0', 64));
        $c->initTimestamps();
        $c->setExpiresAt($expires !== null ? new DateTimeImmutable($expires) : null);
        if ($status === SpecialistCredential::STATUS_VERIFIED) {
            $c->verify('11111111-1111-4111-8111-111111111111', 'Reviewer', ['register_checked' => true, 'register_reference' => 'REG-1', 'note' => null]);
        } elseif ($status === SpecialistCredential::STATUS_REJECTED) {
            $c->reject('Blurry', null, 'Reviewer');
        } elseif ($status === SpecialistCredential::STATUS_SUPERSEDED) {
            $c->supersede();
        }

        return $c;
    }

    /** @return list<SpecialistCredential> the MDCN certificate and a current licence, verified */
    private function verifiedDocuments(): array
    {
        return [
            $this->document(SpecialistCredential::TYPE_MDCN, SpecialistCredential::STATUS_VERIFIED),
            $this->document(SpecialistCredential::TYPE_LICENCE, SpecialistCredential::STATUS_VERIFIED, '2027-03-31'),
        ];
    }

    private function appointment(Specialist $doctor, string $at, string $fee = '20000.00', ?Patient $patient = null): Appointment
    {
        $doctor->setConsultationFee($fee);
        $a = new Appointment($patient ?? new Patient('pat' . bin2hex(random_bytes(3)) . '@example.test', 'Ada', 'Obi'), $doctor, new DateTimeImmutable($at));
        $a->initTimestamps();

        return $a;
    }

    // ----- Checklist: documents + terms -----

    public function testChecklistCountsUploadedDocumentsAndTheTermsInForce(): void
    {
        $s = $this->doctor(SpecialistStatus::INVITED);

        $none = DoctorOnboardingService::checklistFrom($s, false, true, [], null, self::TODAY);
        $this->assertFalse($none['mdcn_certificate']);
        $this->assertFalse($none['practising_licence']);
        $this->assertTrue($none['terms']);

        $waiting = DoctorOnboardingService::checklistFrom($s, false, true, [
            $this->document(SpecialistCredential::TYPE_MDCN),
            $this->document(SpecialistCredential::TYPE_LICENCE, SpecialistCredential::STATUS_PENDING, '2026-12-31'),
        ], null, self::TODAY);
        $this->assertTrue($waiting['mdcn_certificate'], 'uploaded and waiting counts — a reviewer verifies it in the review');
        $this->assertTrue($waiting['practising_licence']);
        $this->assertTrue(DoctorOnboardingService::isComplete($waiting));

        $bad = DoctorOnboardingService::checklistFrom($s, false, true, [
            $this->document(SpecialistCredential::TYPE_MDCN, SpecialistCredential::STATUS_REJECTED),
            $this->document(SpecialistCredential::TYPE_LICENCE, SpecialistCredential::STATUS_VERIFIED, '2026-10-14'),
        ], null, self::TODAY);
        $this->assertFalse($bad['mdcn_certificate'], 'a turned-down certificate does not count');
        $this->assertFalse($bad['practising_licence'], 'an expired licence does not count');

        $this->assertFalse(DoctorOnboardingService::checklistFrom($s, false, true, [], '2.0', self::TODAY)['terms'], 'a newer version must be accepted again');
    }

    // ----- Approval gate -----

    public function testApprovalNeedsVerifiedDocumentsTheTermsAndAnAttestation(): void
    {
        $s = $this->doctor(SpecialistStatus::PENDING_REVIEW);
        $checklist = static fn (array $docs): array => DoctorOnboardingService::checklistFrom($s, false, true, $docs, null, self::TODAY);
        $version   = PractitionerTerms::version();

        $waiting  = [$this->document(SpecialistCredential::TYPE_MDCN), $this->document(SpecialistCredential::TYPE_LICENCE, SpecialistCredential::STATUS_PENDING, '2027-01-31')];
        $problems = DoctorOnboardingService::approvalProblems($s, $checklist($waiting), $waiting, $version, self::TODAY, false);
        $this->assertSame(['mdcn_certificate', 'practising_licence', 'attest'], array_keys($problems), 'uploaded is not verified; the reviewer must attest');

        $verified = $this->verifiedDocuments();
        $this->assertSame([], DoctorOnboardingService::approvalProblems($s, $checklist($verified), $verified, $version, self::TODAY, true));

        $expired = [$verified[0], $this->document(SpecialistCredential::TYPE_LICENCE, SpecialistCredential::STATUS_VERIFIED, '2026-10-14')];
        $this->assertArrayHasKey('practising_licence', DoctorOnboardingService::approvalProblems($s, $checklist($expired), $expired, $version, self::TODAY, true));

        $noTerms = $this->doctor(SpecialistStatus::PENDING_REVIEW, false);
        $this->assertArrayHasKey('terms', DoctorOnboardingService::approvalProblems(
            $noTerms,
            DoctorOnboardingService::checklistFrom($noTerms, false, true, $verified, null, self::TODAY),
            $verified,
            $version,
            self::TODAY,
            true,
        ));

        $s->setSignatureKey(null);
        $this->assertStringContainsString('their signature', DoctorOnboardingService::approvalProblems($s, $checklist($verified), $verified, $version, self::TODAY, true)['checklist'] ?? '');

        foreach ([SpecialistStatus::INVITED, SpecialistStatus::REJECTED, SpecialistStatus::APPROVED, SpecialistStatus::SUSPENDED, null] as $status) {
            $other = $this->doctor($status);
            $this->assertSame(['status'], array_keys(DoctorOnboardingService::approvalProblems($other, $checklist($verified), $verified, $version, self::TODAY, true)), ($status?->value ?? 'legacy') . ' is not approvable');
        }
    }

    public function testApprovalSnapshotsWhatWasApproved(): void
    {
        $s = $this->doctor(SpecialistStatus::PENDING_REVIEW);
        $s->setCertifications([['name' => 'FWACP', 'body' => 'WACP', 'year' => '2019']]);
        $s->approve('11111111-1111-4111-8111-111111111111');
        $s->snapshotApproval(['c-1', 'c-2'], '11111111-1111-4111-8111-111111111111', 'Reviewer');

        $snapshot = $s->getApprovedSnapshot();
        $this->assertSame('Dr. Ada Obi', $snapshot['name']);
        $this->assertSame('MDCN/12345', $snapshot['mdcn_number']);
        $this->assertSame([['name' => 'FWACP', 'body' => 'WACP', 'year' => '2019']], $snapshot['certifications']);
        $this->assertSame(['c-1', 'c-2'], $snapshot['credential_ids']);
        $this->assertSame('Reviewer', $snapshot['approved_by_name']);
        $this->assertTrue($s->toArray()['verified']);
    }

    // ----- Locked identity fields -----

    public function testApprovedIdentityFieldsWaitForAReview(): void
    {
        $onboarding = $this->doctor(SpecialistStatus::INVITED);
        $this->assertFalse($onboarding->hasLockedFields(), 'edited freely before approval');
        $this->assertSame([], $onboarding->toPrivateArray()['locked_fields']);

        $s = $this->doctor();
        $this->assertTrue($s->hasLockedFields());
        $this->assertTrue($this->doctor(SpecialistStatus::SUSPENDED)->hasLockedFields());
        $this->assertTrue($this->doctor(null)->hasLockedFields(), 'a legacy doctor is approved');

        $this->assertTrue($s->stageChanges(['name' => 'Dr. Ada Obi-Nwosu', 'mdcn_number' => 'MDCN/12345']));
        $this->assertSame('Dr. Ada Obi', $s->getName(), 'nothing changes until approved');
        $this->assertSame(['name' => 'Dr. Ada Obi-Nwosu'], $s->getPendingFields(), 'an unchanged value is not a change');
        $this->assertSame(['name' => 'Dr. Ada Obi-Nwosu'], $s->toPrivateArray()['pending_changes']);
        $this->assertTrue($s->toReviewArray()['has_pending_changes']);

        $this->assertFalse($s->stageChanges(['name' => 'Dr. Ada Obi-Nwosu']), 'the same request again tells nobody');
        $this->assertTrue($s->stageChanges(['specialty' => 'Paediatric Dermatology']));
        $this->assertSame(['name', 'specialty'], array_keys($s->getPendingFields()));

        $this->assertFalse($s->stageChanges(['specialty' => 'Dermatology']), 'setting it back takes the request back');
        $this->assertSame(['name'], array_keys($s->getPendingFields()));

        $before = $s->approvePendingChanges();
        $this->assertSame(['name' => 'Dr. Ada Obi'], $before);
        $this->assertSame('Dr. Ada Obi-Nwosu', $s->getName());
        $this->assertSame([], $s->getPendingFields());

        $s->stageChanges(['qualification_entries' => [['title' => 'MBBS', 'institution' => 'UNILAG', 'year' => '2010']]]);
        $s->rejectPendingChanges('Upload your new certificate first');
        $this->assertSame([], $s->getPendingFields());
        $this->assertSame([], $s->getQualificationEntries(), 'a turned-down request changes nothing');
        $this->assertSame('Upload your new certificate first', $s->toPrivateArray()['changes_review_note']);

        $s->stageChanges(['qualifications' => 'MBBS, FMCP, FWACP']);
        $this->assertNull($s->getChangesReviewNote(), 'a new request clears the old reason');
    }

    public function testEntriesStoredInAnotherKeyOrderAreNotAChange(): void
    {
        $s = $this->doctor();
        // As a JSON column may hand them back: other key order, a number, a missing key, a blank row.
        $s->setQualificationEntries([['year' => 2010, 'title' => 'MBBS', 'institution' => 'UNILAG'], ['title' => ' ', 'institution' => '']]);
        $s->setCertifications([['body' => 'WACP', 'name' => 'FWACP']]);
        $s->setMdcnNumber(null);

        $this->assertFalse($s->stageChanges([
            'qualification_entries' => [['title' => 'MBBS', 'institution' => 'UNILAG', 'year' => '2010']],
            'certifications'        => [['name' => 'FWACP', 'body' => 'WACP', 'year' => '']],
            'mdcn_number'           => '',
            'name'                  => 'Dr. Ada Obi ',
        ]));
        $this->assertSame([], $s->getPendingFields(), 'nothing a reviewer could see differs');

        $this->assertTrue($s->stageChanges(['certifications' => [['name' => 'FWACP', 'body' => 'WACP', 'year' => '2019']]]));
        $this->assertSame(['certifications'], array_keys($s->getPendingFields()));
        $this->assertFalse($s->stageChanges(['certifications' => [['year' => '2019', 'body' => 'WACP', 'name' => 'FWACP']]]), 'the same request in another order tells nobody');
    }

    // ----- Standing -----

    public function testWhoMayPractise(): void
    {
        $this->assertNull(DoctorStanding::problem($this->doctor()));
        $this->assertNull(DoctorStanding::problem($this->doctor(null)), 'a legacy doctor who accepted the terms');
        $this->assertSame(DoctorStanding::SUSPENDED, DoctorStanding::problem($this->doctor(SpecialistStatus::SUSPENDED))[0]);
        foreach ([SpecialistStatus::INVITED, SpecialistStatus::PENDING_REVIEW, SpecialistStatus::REJECTED] as $status) {
            $this->assertSame(DoctorStanding::NOT_APPROVED, DoctorStanding::problem($this->doctor($status))[0], $status->value);
        }
        $this->assertSame(DoctorStanding::TERMS, DoctorStanding::problem($this->doctor(SpecialistStatus::APPROVED, false))[0]);
        $this->assertSame(DoctorStanding::TERMS, DoctorStanding::problem($this->doctor(), '1.1')[0], 'a new version needs accepting again');
        $this->assertSame(['code' => DoctorStanding::SUSPENDED], array_intersect_key((array) DoctorStanding::payload($this->doctor(SpecialistStatus::SUSPENDED)), ['code' => true]));
    }

    public function testANewTermsVersionDoesNotCutADoctorOutOfAConsultationUnderWay(): void
    {
        $now    = new DateTimeImmutable();
        $claims = ['role' => 'doctor', 'uid' => 2, 'name' => 'Dr. Ada Obi', 'gid' => null];
        $doctor = $this->doctor(); // accepted the version in force …
        PractitionerTerms::configure('9.9'); // … then a new one is published
        $started = $this->appointment($doctor, '-10 minutes');
        $future  = $this->appointment($doctor, '+1 day');

        $this->assertNull(CallAccess::doctorProblem($started, $now), 'they finish the consultation already under way');
        $this->assertNull(CallAccess::problem($started, $claims, null, $now), 'a renewal or rejoin');
        $this->assertNull(CallAccess::doctorJoinBlocked($started, $now), 'and get its link');
        [$status, , $errors] = CallAccess::problem($future, $claims, null, $now);
        $this->assertSame([403, DoctorStanding::TERMS], [$status, $errors['code']], 'but start no new one');
        $this->assertSame(DoctorStanding::TERMS, CallAccess::doctorJoinBlocked($future, $now)['code'] ?? null);

        foreach ([[SpecialistStatus::SUSPENDED, DoctorStanding::SUSPENDED], [SpecialistStatus::PENDING_REVIEW, DoctorStanding::NOT_APPROVED]] as [$standing, $code]) {
            $underWay = $this->appointment($this->doctor($standing), '-10 minutes');
            [$status, , $errors] = CallAccess::problem($underWay, $claims, null, $now);
            $this->assertSame([403, $code], [$status, $errors['code']], $standing->value . ': refused even mid-consultation');
        }
    }

    public function testOwingNewTermsTheDoctorMayStillFinishTheirConsultationUnderWay(): void
    {
        $em         = $this->em();
        $middleware = new DoctorStandingMiddleware(new UserRepository($em), new SpecialistRepository($em), new AppointmentRepository($em), new PrescriptionRepository($em));
        $handler    = new class implements RequestHandlerInterface {
            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                return new Response(204);
            }
        };
        $doctor = $this->doctor(); // accepted the version in force …
        PractitionerTerms::configure('9.9'); // … then a new one is published
        $login = new User('ada.terms@example.test', 'Ada', 'Obi');
        $login->setRoles(['doctor']);
        $login->setSpecialistId($doctor->getId());
        $started = $this->appointment($doctor, '-10 minutes');
        $future  = $this->appointment($doctor, '+1 day');
        $other   = $this->appointment($this->doctor(), '-10 minutes'); // someone else's consultation
        foreach ([$doctor, $login, $started, $future, $other, $other->getSpecialist()] as $entity) {
            $em->persist($entity); // known without a database (assigned ids land in the identity map)
        }
        $prescribe = static fn (string $appointmentId): ServerRequestInterface => (new ServerRequestFactory())
            ->createServerRequest('POST', '/api/doctor/prescriptions')
            ->withParsedBody(['appointment_id' => $appointmentId])
            ->withAttribute('user_id', $login->getId())
            ->withAttribute('user_roles', ['doctor']);

        $this->assertSame(204, $middleware->process($prescribe($started->getId()), $handler)->getStatusCode(), 'their consultation under way');
        $refused = $middleware->process($prescribe($future->getId()), $handler);
        $this->assertSame(403, $refused->getStatusCode(), 'one that has not started: accept the terms first');
        $this->assertSame(DoctorStanding::TERMS, json_decode((string) $refused->getBody(), true)['errors']['code'] ?? null);
        $this->assertSame(403, $middleware->process($prescribe($other->getId()), $handler)->getStatusCode(), 'never another doctor\'s');
    }

    public function testASuspendedDoctorSeesOnlyTheirAccountEarningsAndDocuments(): void
    {
        $allowed = [
            ['GET', '/doctor/onboarding'],
            ['GET', '/doctor/credentials'],
            ['POST', '/doctor/credentials'],
            ['GET', '/doctor/credentials/{id}/file'],
            ['DELETE', '/doctor/credentials/{id}'],
            ['GET', '/doctor/terms'],
            ['POST', '/doctor/terms/accept'],
            ['GET', '/doctor/profile'],
            ['PATCH', '/doctor/profile'],
            ['GET', '/doctor/earnings'],
            ['GET', '/doctor/earnings/transactions'],
            ['GET', '/doctor/payouts'],
            ['GET', '/doctor/payout-account'],
        ];
        $refused = [
            ['GET', '/doctor/dashboard'],
            ['GET', '/doctor/appointments'],
            ['GET', '/doctor/appointments/{id}'],
            ['PUT', '/doctor/appointments/{id}/note'],
            ['POST', '/doctor/appointments/{id}/confirm'],
            ['GET', '/doctor/patients'],
            ['GET', '/doctor/patients/{id}'],
            ['POST', '/doctor/prescriptions'],
            ['POST', '/doctor/availability'],
            ['DELETE', '/doctor/availability/{id}'],
            ['POST', '/doctor/payouts'],
            ['GET', '/doctor/reviews'],
            ['POST', '/doctor/signature'],
        ];
        foreach ($allowed as [$method, $path]) {
            $this->assertTrue(DoctorStanding::allows(DoctorStanding::SUSPENDED, $method, $path), "suspended: $method $path");
        }
        foreach ($refused as [$method, $path]) {
            $this->assertFalse(DoctorStanding::allows(DoctorStanding::SUSPENDED, $method, $path), "suspended: $method $path");
        }
    }

    public function testAnOnboardingDoctorSetsUpButDoesNoClinicalWork(): void
    {
        foreach ([['POST', '/doctor/availability'], ['POST', '/doctor/availability/block'], ['POST', '/doctor/signature'], ['GET', '/doctor/dashboard'], ['PUT', '/doctor/payout-account'], ['POST', '/doctor/onboarding/submit']] as [$method, $path]) {
            $this->assertTrue(DoctorStanding::allows(DoctorStanding::NOT_APPROVED, $method, $path), "$method $path");
        }
        foreach ([['GET', '/doctor/appointments'], ['POST', '/doctor/prescriptions'], ['GET', '/doctor/patients'], ['POST', '/doctor/payouts']] as [$method, $path]) {
            $this->assertFalse(DoctorStanding::allows(DoctorStanding::NOT_APPROVED, $method, $path), "$method $path");
        }
    }

    public function testADoctorOwingTheTermsReadsButStartsNoClinicalWork(): void
    {
        foreach ([['GET', '/doctor/appointments/{id}/note'], ['GET', '/doctor/patients/{id}'], ['POST', '/doctor/availability'], ['POST', '/doctor/payouts'], ['POST', '/doctor/terms/accept']] as [$method, $path]) {
            $this->assertTrue(DoctorStanding::allows(DoctorStanding::TERMS, $method, $path), "$method $path");
        }
        foreach ([['PUT', '/doctor/appointments/{id}/note'], ['POST', '/doctor/appointments/{id}/confirm'], ['POST', '/doctor/prescriptions'], ['POST', '/doctor/prescriptions/{rxId}/send']] as [$method, $path]) {
            $this->assertFalse(DoctorStanding::allows(DoctorStanding::TERMS, $method, $path), "$method $path");
        }
        $this->assertTrue(DoctorStanding::allows(null, 'POST', '/doctor/prescriptions'), 'in good standing: everything');
    }

    public function testTheStandingMiddlewareCostsNothingForOtherStaff(): void
    {
        $em         = $this->em();
        $middleware = new DoctorStandingMiddleware(new UserRepository($em), new SpecialistRepository($em), new AppointmentRepository($em), new PrescriptionRepository($em));
        $handler    = new class implements RequestHandlerInterface {
            public int $calls = 0;

            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                $this->calls++;

                return new Response(204);
            }
        };
        $request = (new ServerRequestFactory())->createServerRequest('GET', '/api/doctor/appointments');

        // No database is reachable here: these must pass without a lookup.
        $this->assertSame(204, $middleware->process($request->withAttribute('user_roles', ['admin']), $handler)->getStatusCode());
        $me = (new ServerRequestFactory())->createServerRequest('GET', '/api/me/notifications')->withAttribute('user_roles', ['doctor']);
        $this->assertSame(204, $middleware->process($me, $handler)->getStatusCode(), "a doctor's own account is always open");
        $this->assertSame(2, $handler->calls);
    }

    public function testADoctorOnlyLoginStaysInItsPortal(): void
    {
        $em         = $this->em();
        $middleware = new DoctorStandingMiddleware(new UserRepository($em), new SpecialistRepository($em), new AppointmentRepository($em), new PrescriptionRepository($em));
        $handler    = new class implements RequestHandlerInterface {
            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                return new Response(204);
            }
        };
        $doctor = $this->doctor(SpecialistStatus::SUSPENDED);
        $login  = new User('ada.obi@example.test', 'Ada', 'Obi');
        $login->setRoles(['doctor']);
        $login->setSpecialistId($doctor->getId());
        // Known to the entity manager without a database (assigned ids land in the identity map).
        $em->persist($doctor);
        $em->persist($login);
        $as = static fn (string $method, string $path, array $roles): ServerRequestInterface => (new ServerRequestFactory())
            ->createServerRequest($method, $path)
            ->withAttribute('user_id', $login->getId())
            ->withAttribute('user_roles', $roles);

        $refused = $middleware->process($as('GET', '/api/appointments', ['doctor']), $handler);
        $this->assertSame(403, $refused->getStatusCode(), 'every patient\'s appointments are not a doctor\'s');
        $this->assertSame('doctor_portal_only', json_decode((string) $refused->getBody(), true)['errors']['code'] ?? null);

        $suspended = $middleware->process($as('GET', '/api/doctor/appointments', ['doctor']), $handler);
        $this->assertSame(403, $suspended->getStatusCode());
        $this->assertSame(DoctorStanding::SUSPENDED, json_decode((string) $suspended->getBody(), true)['errors']['code'] ?? null);
        $this->assertSame(204, $middleware->process($as('GET', '/api/doctor/earnings', ['doctor']), $handler)->getStatusCode());

        $login->setRoles(['doctor', 'admin']);
        $this->assertSame(204, $middleware->process($as('GET', '/api/appointments', ['doctor', 'admin']), $handler)->getStatusCode(), 'also back-office staff: their staff routes stay');
        $this->assertTrue(DoctorStandingMiddleware::alsoStaff(['doctor', 'support']));
        $this->assertFalse(DoctorStandingMiddleware::alsoStaff(['doctor']));
    }

    public function testASuspendedDoctorMayNotChangeTheirAvailability(): void
    {
        $suspended = $this->doctor(SpecialistStatus::SUSPENDED);
        foreach (DoctorStanding::AVAILABILITY_FIELDS as $field) {
            $this->assertSame(DoctorStanding::SUSPENDED, DoctorStanding::profileEditProblem($suspended, ['bio' => 'x', $field => null])[0] ?? null, $field);
        }
        $this->assertNull(DoctorStanding::profileEditProblem($suspended, ['bio' => 'Dermatologist', 'languages' => 'English']), 'the rest of the profile stays theirs');
        $this->assertNull(DoctorStanding::profileEditProblem($this->doctor(), ['weekly_hours' => [], 'available' => false]), 'a practising doctor pauses with `available`');
        $this->assertNull(DoctorStanding::profileEditProblem($this->doctor(SpecialistStatus::INVITED), ['slot_minutes' => 30]), 'set up while onboarding');
    }

    // ----- Suspension -----

    public function testSuspensionCancelsAndRefundsEveryFutureBookingAndWithdrawsProposals(): void
    {
        $doctor = $this->doctor();
        $now    = new DateTimeImmutable();
        $shared = new Patient('repeat@example.test', 'Bola', 'Ade');

        $paid = $this->appointment($doctor, '+2 days', '20000.00', $shared);
        $paid->setPaymentStatus('paid');
        $paid->addGuest('Guest', 'guest@example.test', '5000.00', 'wallet', null, $now);
        $paid->setAmount('25000.00');

        $free = $this->appointment($doctor, '+3 days', '0.00', $shared);
        $free->setPaymentStatus('paid');

        $unpaid = $this->appointment($doctor, '+4 days');
        $moved  = $this->appointment($doctor, '+5 days');
        $moved->transitionTo(AppointmentStatus::RESCHEDULED);
        $past = $this->appointment($doctor, '-1 hour');
        $past->setPaymentStatus('paid');
        $cancelled = $this->appointment($doctor, '+6 days');
        $cancelled->transitionTo(AppointmentStatus::CANCELLED);
        $proposal = Appointment::proposeFollowUp($past, new DateTimeImmutable('+7 days'), ['amount' => '10000.00'], null, new DateTimeImmutable('+2 days'));

        $plan = SpecialistSuspensionService::plan([$paid, $free, $unpaid, $moved, $past, $cancelled, $proposal], $now);

        $this->assertSame([$paid, $free, $unpaid, $moved], $plan['bookings'], 'future pending / confirmed / rescheduled only');
        $this->assertSame([$proposal], $plan['proposals']);
        $this->assertSame(1, $plan['refunds'], 'only a paid, non-free booking is refunded');
        $this->assertSame('25000.00', $plan['refund_total'], 'guest fees included');
        $this->assertSame('5000.00', $plan['guest_fees']);
        $this->assertSame(1, $plan['guests']);
        $this->assertSame(4, $plan['patients'], 'each patient once');
        $this->assertSame([], $plan['in_progress']);
    }

    public function testABookingInProgressIsCancelledUnlessTheConsultationIsTakingPlace(): void
    {
        $doctor = $this->doctor();
        $now    = new DateTimeImmutable();

        $waiting = $this->appointment($doctor, '-10 minutes');
        $waiting->setPaymentStatus('paid');
        $talking = $this->appointment($doctor, '-5 minutes');
        $talking->transitionTo(AppointmentStatus::CONFIRMED);
        $over     = $this->appointment($doctor, '-31 minutes');
        $future   = $this->appointment($doctor, '+1 day');
        $proposal = Appointment::proposeFollowUp($over, new DateTimeImmutable('-1 minute'), ['amount' => '10000.00'], null, new DateTimeImmutable('-2 hours'));

        $plan = SpecialistSuspensionService::plan([$future, $talking, $waiting, $over, $proposal], $now, 30, [$talking->getId()]);

        $this->assertSame([$future, $waiting], $plan['bookings'], 'started, slot not over, no proof it is taking place: cancelled and refunded');
        $this->assertSame([$talking], $plan['in_progress'], 'proof it is taking place: left to finish');
        $this->assertSame([], $plan['proposals'], 'a proposal whose time came is the follow-up cron\'s');
        $this->assertSame(1, $plan['refunds']);
        $this->assertSame('20000.00', $plan['refund_total']);

        $this->assertSame([$future], SpecialistSuspensionService::plan([$future, $waiting], $now)['bookings'], 'no slot length: future ones only');
        $this->assertEquals($now->modify('-30 minutes'), SpecialistSuspensionService::endedBefore($now, 30));
        $this->assertSame($now, SpecialistSuspensionService::endedBefore($now, 0));
    }

    public function testCancellingABookingRefundsThroughTheWalletAndIsSafeToRepeat(): void
    {
        /** @var SpecialistSuspensionService $service */
        $service = (new \ReflectionClass(SpecialistSuspensionService::class))->newInstanceWithoutConstructor();
        // A wallet with no state: any posting fails loudly the moment it is reached.
        $wallet = (new \ReflectionClass(WalletService::class))->newInstanceWithoutConstructor();
        (new \ReflectionProperty(SpecialistSuspensionService::class, 'payments'))->setValue($service, new AppointmentPaymentService($wallet));
        $doctor = $this->doctor();
        $now    = new DateTimeImmutable();

        $free = $this->appointment($doctor, '+1 day', '0.00');
        $free->setPaymentStatus('paid');
        $this->assertSame(['cancelled' => true, 'refunded' => null], $service->cancelBooking($free, $now));
        $this->assertSame(AppointmentStatus::CANCELLED, $free->getStatus());
        $this->assertSame(['cancelled' => false, 'refunded' => null], $service->cancelBooking($free, $now), 'a re-run leaves it alone');

        $started = $this->appointment($doctor, '-10 minutes');
        $this->assertFalse($service->cancelBooking($started, $now)['cancelled'], 'with no slot length, one that started is left alone');
        $this->assertSame(AppointmentStatus::PENDING, $started->getStatus());
        $over = $this->appointment($doctor, '-40 minutes');
        $this->assertFalse($service->cancelBooking($over, $now, 30)['cancelled'], 'its slot is over');
        $this->assertSame(['cancelled' => true, 'refunded' => null], $service->cancelBooking($started, $now, 30), 'in progress, slot not over');
        $this->assertSame(AppointmentStatus::CANCELLED, $started->getStatus());

        $paid = $this->appointment($doctor, '+1 day');
        $paid->setPaymentStatus('paid');
        try {
            $service->cancelBooking($paid, $now);
            $this->fail('a paid booking is refunded to the wallet');
        } catch (\Error $e) {
            $this->assertStringContainsString('WalletService::', $e->getMessage(), 'reached the wallet credit');
        }
        $this->assertSame(AppointmentStatus::CANCELLED, $paid->getStatus());
    }

    public function testSuspensionAndReinstatementRules(): void
    {
        $this->assertArrayHasKey('status', SpecialistSuspensionService::suspendProblems($this->doctor(SpecialistStatus::INVITED), 'conduct', 'x'));
        $this->assertSame(['code'], array_keys(SpecialistSuspensionService::suspendProblems($this->doctor(), 'holiday', 'x')));
        $this->assertSame(['reason'], array_keys(SpecialistSuspensionService::suspendProblems($this->doctor(), 'conduct', '  ')));
        $this->assertSame([], SpecialistSuspensionService::suspendProblems($this->doctor(null), 'complaint', 'Under review'), 'a legacy doctor can be suspended');
        $this->assertSame([], SpecialistSuspensionService::suspendProblems($this->doctor(SpecialistStatus::SUSPENDED), 'conduct', 'x'), 'running it again is allowed');

        $s = $this->doctor();
        $s->suspend('licence_expired', 'Your licence expired', null);
        $this->assertFalse($s->isApproved());
        $this->assertFalse($s->isBookable());
        $this->assertFalse($s->toArray()['verified']);
        $this->assertSame('licence_expired', $s->toReviewArray()['suspension_code']);
        $this->assertSame(DoctorStanding::SUSPENDED, DoctorStanding::problem($s)[0]);

        $this->assertSame(['note', 'practising_licence'], array_keys(SpecialistSuspensionService::reinstateProblems($s, '', [], self::TODAY)));
        $expired = [$this->document(SpecialistCredential::TYPE_LICENCE, SpecialistCredential::STATUS_VERIFIED, '2026-10-01')];
        $this->assertArrayHasKey('practising_licence', SpecialistSuspensionService::reinstateProblems($s, 'Renewed', $expired, self::TODAY));
        $this->assertSame([], SpecialistSuspensionService::reinstateProblems($s, 'Renewed licence verified', $this->verifiedDocuments(), self::TODAY));
        $this->assertSame(['status'], array_keys(SpecialistSuspensionService::reinstateProblems($this->doctor(), 'x', $this->verifiedDocuments(), self::TODAY)));

        $s->reinstate();
        $this->assertTrue($s->isApproved());
        $this->assertNull($s->getSuspensionCode());
        $this->assertNull($s->toReviewArray()['suspension_reason']);
    }

    // ----- Documents -----

    public function testDocumentsMustBePdfJpgOrPngByTheirContent(): void
    {
        $pdf = CredentialStore::inspect("%PDF-1.4\n% test", '../MDCN <cert>.pdf');
        $this->assertSame('application/pdf', $pdf['mime']);
        $this->assertSame(64, strlen($pdf['sha256']));
        $this->assertStringNotContainsString('/', $pdf['name']);
        $this->assertStringNotContainsString('<', $pdf['name']);

        $png = base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', true);
        $this->assertSame('image/png', CredentialStore::inspect((string) $png, 'licence.PNG')['mime']);

        foreach ([['%PDF-1.4', 'cert.exe'], ['%PDF-1.4', 'cert.png'], ['not a pdf', 'cert.pdf'], ['', 'cert.pdf']] as [$bytes, $name]) {
            try {
                CredentialStore::inspect($bytes, $name);
                $this->fail("refused: $name");
            } catch (ValidationException $e) {
                $this->assertArrayHasKey('file', $e->getErrors());
            }
        }
    }

    public function testALicenceNeedsItsNumberAndAnExpiryNotYetPast(): void
    {
        $errors = static function (array $body): array {
            try {
                DoctorCredentialService::uploadFields($body, self::TODAY);

                return [];
            } catch (ValidationException $e) {
                return $e->getErrors();
            }
        };

        $this->assertSame(['number', 'expires_at'], array_keys($errors(['type' => SpecialistCredential::TYPE_LICENCE])));
        $this->assertSame(['expires_at'], array_keys($errors(['type' => SpecialistCredential::TYPE_LICENCE, 'number' => 'APL-2026-1', 'expires_at' => '2026-10-14'])));
        $this->assertSame(['expires_at'], array_keys($errors(['type' => SpecialistCredential::TYPE_LICENCE, 'number' => 'APL-1', 'expires_at' => '2026-02-30'])));
        $this->assertSame(['issued_at'], array_keys($errors(['type' => SpecialistCredential::TYPE_MDCN, 'issued_at' => '2027-01-01'])));
        $this->assertSame(['type'], array_keys($errors(['type' => 'passport'])));
        $this->assertSame([], $errors(['type' => SpecialistCredential::TYPE_MDCN]), 'the certificate needs no number or expiry');

        $ok = DoctorCredentialService::uploadFields(['type' => SpecialistCredential::TYPE_LICENCE, 'number' => 'apl/2026/77', 'expires_at' => '2026-12-31', 'issued_at' => '2026-01-01'], self::TODAY);
        $this->assertSame('APL/2026/77', $ok['number']);
        $this->assertSame('2026-12-31', $ok['expires_at']?->format('Y-m-d'));
    }

    public function testVerifyingNeedsTheRegisterAttestation(): void
    {
        $errors = static function (SpecialistCredential $c, array $body): array {
            try {
                DoctorCredentialService::verifyFields($c, $body, self::TODAY);

                return [];
            } catch (ValidationException $e) {
                return $e->getErrors();
            }
        };
        $licence = $this->document(SpecialistCredential::TYPE_LICENCE, SpecialistCredential::STATUS_PENDING, '2027-03-31');

        $this->assertSame(['register_checked', 'register_reference'], array_keys($errors($licence, [])));
        $this->assertSame(['expires_at'], array_keys($errors($licence, ['register_checked' => true, 'register_reference' => 'REG-1', 'expires_at' => '2026-09-30'])), 'correcting it to a past date');
        $this->assertSame(['status'], array_keys($errors($this->document(SpecialistCredential::TYPE_MDCN, SpecialistCredential::STATUS_VERIFIED), ['register_checked' => true, 'register_reference' => 'REG-1'])));

        $ok = DoctorCredentialService::verifyFields($licence, ['register_checked' => true, 'register_reference' => ' REG-2026-0042 ', 'note' => ''], self::TODAY);
        $this->assertSame(['register_checked' => true, 'register_reference' => 'REG-2026-0042', 'note' => null], $ok['attestation']);

        $licence->verify(null, 'Reviewer', $ok['attestation']);
        $this->assertArrayNotHasKey('attestation', $licence->toArray(), 'the doctor never sees the attestation');
        $this->assertSame($ok['attestation'], $licence->toArray(true)['attestation']);
        $this->assertArrayNotHasKey('vault_key', $licence->toArray(true));
    }

    public function testTheCurrentLicenceIsTheLongestValidVerifiedOne(): void
    {
        $old  = $this->document(SpecialistCredential::TYPE_LICENCE, SpecialistCredential::STATUS_VERIFIED, '2026-12-31');
        $new  = $this->document(SpecialistCredential::TYPE_LICENCE, SpecialistCredential::STATUS_VERIFIED, '2027-12-31');
        $wait = $this->document(SpecialistCredential::TYPE_LICENCE, SpecialistCredential::STATUS_PENDING, '2028-12-31');

        $this->assertSame($new, DoctorCredentials::currentLicence([$old, $new, $wait], self::TODAY));
        $this->assertNull(DoctorCredentials::currentLicence([$wait], self::TODAY), 'waiting is not verified');
        $this->assertFalse(DoctorCredentials::complete([$new], self::TODAY), 'the MDCN certificate too');
        $this->assertTrue(DoctorCredentials::complete($this->verifiedDocuments(), self::TODAY));

        $this->assertSame('missing', DoctorCredentials::licenceStatus(null, self::TODAY));
        $this->assertSame('expired', DoctorCredentials::licenceStatus('2026-10-14', self::TODAY));
        $this->assertSame('expiring', DoctorCredentials::licenceStatus('2026-11-14', self::TODAY));
        $this->assertSame('valid', DoctorCredentials::licenceStatus('2026-11-15', self::TODAY));
    }

    // ----- Licence cron -----

    public function testLicenceRemindersGoOncePerStageMostUrgentFirst(): void
    {
        $stages = [30, 14, 7, 1];
        $this->assertNull(DoctorCredentials::dueStage(40, $stages, null), 'too early');
        $this->assertSame(30, DoctorCredentials::dueStage(30, $stages, null));
        $this->assertSame(30, DoctorCredentials::dueStage(20, $stages, null));
        $this->assertNull(DoctorCredentials::dueStage(20, $stages, 30), 'already sent');
        $this->assertSame(14, DoctorCredentials::dueStage(13, $stages, 30));
        $this->assertSame(7, DoctorCredentials::dueStage(5, $stages, null), 'first noticed late: only the most urgent one');
        $this->assertNull(DoctorCredentials::dueStage(5, $stages, 7));
        $this->assertSame(1, DoctorCredentials::dueStage(0, $stages, 7), 'expires today');
        $this->assertNull(DoctorCredentials::dueStage(0, $stages, 1));
        $this->assertNull(DoctorCredentials::dueStage(-1, $stages, null), 'expired: the expiry step takes over');

        $this->assertSame([30, 14, 7, 1], CredentialExpiryService::cleanStages(['7', ' 30', 'x', '14', '1', '7', '-3']));
        $this->assertSame([30, 14, 7, 1], CredentialExpiryService::cleanStages([]));
        $this->assertSame(30, DoctorCredentials::daysUntil('2026-11-14', self::TODAY));
        $this->assertSame(-1, DoctorCredentials::daysUntil('2026-10-14', self::TODAY));
    }

    public function testAnExpiredLicenceSuspendsOnlyAfterTheGrace(): void
    {
        $this->assertFalse(CredentialExpiryService::pastGrace('2026-10-15', self::TODAY, 0), 'valid through its last day');
        $this->assertTrue(CredentialExpiryService::pastGrace('2026-10-14', self::TODAY, 0), 'the day after, with no grace');
        $this->assertFalse(CredentialExpiryService::pastGrace('2026-10-12', self::TODAY, 3));
        $this->assertTrue(CredentialExpiryService::pastGrace('2026-10-11', self::TODAY, 3));
    }

    public function testAnExpiredLicenceSuspendsFinishesAnUnfinishedSuspensionOrIsJustMarked(): void
    {
        $this->assertSame('suspend', CredentialExpiryService::expiryStep($this->doctor(), false));
        $this->assertSame('suspend', CredentialExpiryService::expiryStep($this->doctor(null), false), 'a legacy doctor practising on it');
        $this->assertSame('mark', CredentialExpiryService::expiryStep($this->doctor(), true), 'another licence is current');

        $unfinished = $this->doctor();
        $unfinished->suspend('licence_expired', 'Your licence expired', null);
        $this->assertSame('finish', CredentialExpiryService::expiryStep($unfinished, false), 'run again: only what is still live is cancelled');

        $otherReason = $this->doctor();
        $otherReason->suspend('conduct', 'Under review', 'reviewer-id');
        $this->assertSame('mark', CredentialExpiryService::expiryStep($otherReason, false));
        $this->assertSame('mark', CredentialExpiryService::expiryStep($this->doctor(SpecialistStatus::PENDING_REVIEW), false), 'not practising yet');
    }

    public function testALegacyDoctorWithBothDocumentsVerifiedIsNoLongerLegacy(): void
    {
        $legacy = $this->doctor(null);
        $this->assertTrue(DoctorCredentialService::completesLegacy($legacy, $this->verifiedDocuments(), self::TODAY), 'no due date set yet still counts');
        $this->assertFalse(DoctorCredentialService::completesLegacy($legacy, [$this->verifiedDocuments()[1]], self::TODAY), 'the MDCN certificate too');

        $due = $this->doctor();
        $due->setCredentialsDueAt(new DateTimeImmutable('2026-11-14'));
        $this->assertTrue(DoctorCredentialService::completesLegacy($due, $this->verifiedDocuments(), self::TODAY));

        $approved = $this->doctor();
        $approved->snapshotApproval(['c-1', 'c-2'], null, 'Reviewer');
        $this->assertFalse(DoctorCredentialService::completesLegacy($approved, $this->verifiedDocuments(), self::TODAY), 'approved with documents: nothing to clear');
        $this->assertFalse(DoctorCredentialService::completesLegacy($this->doctor(SpecialistStatus::PENDING_REVIEW), $this->verifiedDocuments(), self::TODAY), 'onboarding: the approval snapshots them');
    }

    public function testAStatusEventsMetaIsAlwaysAnObject(): void
    {
        $event = new SpecialistStatusEvent('s-1', 'approved', 'suspended', null, 'System', 'Expired', 'licence_expired', []);
        $this->assertSame('{}', json_encode($event->toArray()['meta']));
        $lifted = new SpecialistStatusEvent('s-1', 'suspended', 'approved', null, 'Reviewer', 'Renewed', null, ['lifted_code' => 'conduct']);
        $this->assertSame('{"lifted_code":"conduct"}', json_encode($lifted->toArray()['meta']));
    }

    // ----- Terms -----

    public function testTheTermsInForceAreVersionedAndReadable(): void
    {
        PractitionerTerms::configure('1.0');
        $doc = PractitionerTerms::document();
        $this->assertSame('1.0', $doc['version']);
        $this->assertSame('VideoMed Practitioner Terms', $doc['title']);
        $this->assertMatchesRegularExpression('/^[0-9a-f]{64}$/', $doc['sha256']);
        $text = implode("\n", array_column($doc['blocks'], 'text'));
        foreach (['Version 1.0', 'Annual Practising Licence', 'Nigeria Data Protection Act 2023', 'controlled drugs', 'suspend'] as $needle) {
            $this->assertStringContainsString($needle, $text);
        }
        foreach ($doc['blocks'] as $block) {
            $this->assertContains($block['type'], ['h1', 'h2', 'h3', 'p', 'ul', 'ol']);
            $this->assertStringNotContainsString('**', $block['text']);
        }

        $this->assertSame(
            [['type' => 'h2', 'text' => 'Title'], ['type' => 'p', 'text' => 'One two'], ['type' => 'ul', 'text' => 'bold item'], ['type' => 'ol', 'text' => 'First']],
            PractitionerTerms::blocks("## Title\nOne\ntwo\n\n- **bold** item\n1. First"),
        );

        PractitionerTerms::configure('not a version');
        $this->assertSame('1.0', PractitionerTerms::version());

        PractitionerTerms::configure('2.0');
        $this->expectException(\RuntimeException::class);
        PractitionerTerms::document();
    }

    public function testAcceptingNeedsTheVersionInForceAndTheBoxTicked(): void
    {
        PractitionerTerms::configure('1.1');
        $this->assertSame(['version', 'agree'], array_keys(PractitionerTerms::acceptanceProblems(['version' => '1.0'])));
        $this->assertSame([], PractitionerTerms::acceptanceProblems(['version' => '1.1', 'agree' => true]));

        $s = $this->doctor(SpecialistStatus::APPROVED, false);
        $s->acceptTerms('1.0', '203.0.113.7');
        $this->assertSame(DoctorStanding::TERMS, DoctorStanding::problem($s)[0], '1.0 accepted, 1.1 in force');
        $s->acceptTerms('1.1', '203.0.113.8');
        $this->assertNull(DoctorStanding::problem($s));
        $this->assertSame('203.0.113.8', $s->getTermsAcceptedIp());
        $this->assertSame('1.1', $s->toReviewArray()['terms_version']);
    }

    // ----- Audit + emails + queries -----

    public function testAuditEventsCarryTheActor(): void
    {
        $id    = '22222222-2222-4222-8222-222222222222';
        $event = new AuditEvent('Reviewer', 'admin', 'specialist.suspended', null, 'specialist', 's-1', ['code' => 'conduct'], $id);
        $this->assertSame($id, $event->toArray()['actor_id']);
        $this->assertNull((new AuditEvent('System', 'system', 'x', null, null, null, [], 'not-a-uuid'))->toArray()['actor_id']);
    }

    public function testPatientNoticesNeverSayWhyTheDoctorStopped(): void
    {
        $mail = EmailTemplates::doctorUnavailableCancellation('Bola', 'Dr. Ada Obi', 'Dermatology', 'Tue 21 Oct, 3:00 PM WAT', '₦25,000.00', 'https://patient.example/dashboard/specialists?specialty=Dermatology');
        $this->assertStringContainsString('₦25,000.00', $mail['html']);
        $this->assertStringContainsString('specialty=Dermatology', $mail['html']);
        $this->assertStringContainsString('no longer available', $mail['html']);
        foreach (['suspend', 'licence', 'conduct', 'complaint'] as $word) {
            $this->assertStringNotContainsStringIgnoringCase($word, $mail['html']);
        }

        $suspended = EmailTemplates::doctorSuspended('Dr <b>Ada</b>', 'Professional conduct concern', '<script>x</script>', 'https://doctor.example');
        $this->assertStringNotContainsString('<script>', $suspended['html']);
        $this->assertStringContainsString('https://doctor.example/onboarding', $suspended['html']);
        $this->assertStringContainsString('tomorrow', EmailTemplates::doctorLicenceExpiring('Dr Ada', 1, '16 Oct 2026', 'https://doctor.example')['subject']);
    }

    public function testDoctorManagementQueriesCompile(): void
    {
        $em    = $this->em();
        $today = new DateTimeImmutable(self::TODAY);
        $repo  = new SpecialistRepository($em);
        foreach ([null, ...SpecialistRepository::ADMIN_FILTERS] as $filter) {
            $sql = $repo->adminQuery('ada', $filter, $today)->getQuery()->getSQL();
            $this->assertStringContainsStringIgnoringCase('specialists', $sql, (string) $filter);
        }
        $this->assertStringContainsStringIgnoringCase('specialist_credentials', $repo->adminQuery(null, 'credentials_pending', $today)->getQuery()->getSQL());
        $this->assertStringContainsStringIgnoringCase('approved_snapshot IS NULL', $repo->legacyWithoutCredentialsDueQuery()->getQuery()->getSQL());

        $credentials = new SpecialistCredentialRepository($em);
        $credentials->forSpecialistQuery('s-1')->getSQL();
        $this->assertStringContainsStringIgnoringCase('JOIN specialists', $credentials->countPendingFromLiveDoctorsQuery()->getSQL());
        $this->assertStringContainsStringIgnoringCase('expires_at <=', $credentials->verifiedLicencesExpiringByQuery($today)->getSQL());

        $this->assertStringContainsStringIgnoringCase('specialist_status_events', (new SpecialistStatusEventRepository($em))->forSpecialistQuery('s-1')->getSQL());
        $this->assertStringContainsStringIgnoringCase('resource_type', (new AuditEventRepository($em))->forResourceQuery('specialist', 's-1')->getSQL());
        $this->assertStringContainsStringIgnoringCase('UPDATE staff_sessions', (new StaffSessionRepository($em))->revokeAllForUserQuery('u-1', $today)->getSQL());
    }
}
