<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Action\Appointment\UpdateAppointmentStatusAction;
use App\Action\Call\JoinCallAction;
use App\Action\Doctor\DoctorAppointmentHistoryAction;
use App\Action\Doctor\DoctorCallPresenceAction;
use App\Action\Doctor\GetDoctorAppointmentAction;
use App\Action\Settings\UpdatePricingAction;
use App\Domain\Entity\Appointment;
use App\Domain\Entity\Patient;
use App\Domain\Entity\Specialist;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Enum\ConsultationType;
use App\Domain\Enum\SpecialistStatus;
use App\Domain\Exception\ValidationException;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\AppSettingRepository;
use App\Domain\Repository\ConsultationConsentRepository;
use App\Domain\Repository\RecordingRepository;
use App\Domain\Settings\ClinicTime;
use App\Infrastructure\Agora\AgoraRecordingService;
use App\Infrastructure\Agora\AgoraTokenService;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use App\Infrastructure\Service\AppointmentCheckout;
use App\Infrastructure\Service\AppointmentPaymentService;
use App\Infrastructure\Service\CallPresence;
use App\Infrastructure\Service\ConsultationCompleter;
use App\Infrastructure\Service\FollowUpService;
use App\Infrastructure\Service\GuestConsent;
use App\Infrastructure\Service\JwtService;
use App\Infrastructure\Service\PricingService;
use App\Infrastructure\Service\WalletService;
use DateTimeImmutable;
use DI\ContainerBuilder;
use Doctrine\ORM\EntityManagerInterface;
use PHPUnit\Framework\TestCase;
use Predis\Client as RedisClient;
use Slim\Factory\AppFactory;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Routing\RoutingResults;

/**
 * Follow-up consultations: the PROPOSED state and where it is kept out (call,
 * completion, prescribing), the pricing rules, when a proposal closes and is
 * nudged, who may answer what, and what the patient is told (generic only).
 */
final class FollowUpTest extends TestCase
{
    private const SECRET = 'test-secret-please-change-to-32+bytes-in-prod';

    private function em(): EntityManagerInterface
    {
        $_ENV['DB_SERVER_VERSION'] = '16';
        DoctrineEntityManagerFactory::reset();

        return DoctrineEntityManagerFactory::create();
    }

    private function doctor(string $fee = '20000.00'): Specialist
    {
        $doctor = new Specialist('Dr. Grace Bell', 'General Practice');
        $doctor->setConsultationFee($fee);
        $doctor->setStatus(SpecialistStatus::APPROVED); // a doctor who consults

        return $doctor;
    }

    private function patient(): Patient
    {
        $patient = new Patient('ada@example.test', 'Ada', 'Obi');
        $patient->initTimestamps(); // as if stored (toArray reads created_at)

        return $patient;
    }

    /** A consultation that has happened (completed) a day ago. */
    private function completedParent(?Specialist $doctor = null): Appointment
    {
        $parent = new Appointment($this->patient(), $doctor ?? $this->doctor(), new DateTimeImmutable('-1 day'));
        $parent->initTimestamps();
        $parent->transitionTo(AppointmentStatus::CONFIRMED);
        $parent->transitionTo(AppointmentStatus::COMPLETED);

        return $parent;
    }

    /** @param array<string,mixed> $pricing */
    private function proposal(?Appointment $parent = null, string $startsIn = '+2 days', ?string $expiresIn = '+1 day', array $pricing = []): Appointment
    {
        $parent ??= $this->completedParent();
        $proposal = Appointment::proposeFollowUp(
            $parent,
            new DateTimeImmutable($startsIn),
            $pricing + ['base_fee' => '20000.00', 'amount' => '10000.00', 'rule' => 'percent', 'discount_percent' => 50, 'window_days' => 14, 'window_ends_at' => '2026-10-28T10:00:00+00:00', 'waived' => false],
            '  Bring your blood pressure log.  ',
            new DateTimeImmutable($expiresIn ?? '+1 day'),
        );
        $proposal->initTimestamps();

        return $proposal;
    }

    /** No dependency is used on the paths these tests take (they all answer before any). */
    private function service(): FollowUpService
    {
        return (new \ReflectionClass(FollowUpService::class))->newInstanceWithoutConstructor();
    }

    // ----- The state machine -----

    public function testAProposalCanOnlyBeAcceptedOrClosed(): void
    {
        $this->assertSame([AppointmentStatus::CONFIRMED, AppointmentStatus::CANCELLED], AppointmentStatus::PROPOSED->allowedTransitions());
        $this->assertFalse(AppointmentStatus::PROPOSED->canTransitionTo(AppointmentStatus::COMPLETED), 'never completed without being accepted');
        $this->assertFalse(AppointmentStatus::PROPOSED->canTransitionTo(AppointmentStatus::RESCHEDULED));
        $this->assertFalse(AppointmentStatus::PROPOSED->isTerminal());
        $this->assertSame('Proposed', AppointmentStatus::PROPOSED->label());

        // Nothing moves back into PROPOSED.
        foreach (AppointmentStatus::cases() as $status) {
            $this->assertNotContains(AppointmentStatus::PROPOSED, $status->allowedTransitions(), $status->value);
        }
    }

    public function testEveryStatusMatchHandlesProposed(): void
    {
        // A match() without the case throws UnhandledMatchError at runtime.
        $past = new DateTimeImmutable('-1 hour');
        foreach (AppointmentStatus::cases() as $status) {
            $this->assertNotSame('', $status->label());
            $status->allowedTransitions();
            ConsultationCompleter::completionProblem($status, $past, static fn (): bool => true);
        }
        $this->assertSame(
            "The patient hasn't accepted this follow-up yet, so it can't be marked completed",
            ConsultationCompleter::completionProblem(AppointmentStatus::PROPOSED, $past, static fn (): bool => true),
        );
        $this->assertSame('Follow-up Consultation', ConsultationType::FOLLOW_UP->label());
    }

    // ----- The appointment -----

    public function testADoctorsProposalIsAPricedVideoFollowUpOfItsParent(): void
    {
        $parent   = $this->completedParent();
        $proposal = $this->proposal($parent);

        $this->assertSame(AppointmentStatus::PROPOSED, $proposal->getStatus());
        $this->assertSame(ConsultationType::FOLLOW_UP, $proposal->getType());
        $this->assertSame($parent, $proposal->getParent());
        $this->assertSame($parent->getPatient(), $proposal->getPatient());
        $this->assertSame($parent->getSpecialist(), $proposal->getSpecialist());
        $this->assertSame('doctor', $proposal->getProposedBy());
        $this->assertSame('10000.00', $proposal->getAmount(), 'the follow-up price is the amount, so refunds use it');
        $this->assertSame('unpaid', $proposal->getPaymentStatus(), 'nothing is charged until the patient accepts');
        $this->assertSame('Bring your blood pressure log.', $proposal->getFollowUpNote());
        $this->assertTrue($proposal->isOpenProposal(new DateTimeImmutable()));
        $this->assertFalse($proposal->isOpenProposal(new DateTimeImmutable('+2 days')), 'past its expiry');

        $a = $proposal->toArray();
        $this->assertSame('proposed', $a['status']);
        $this->assertSame($parent->getId(), $a['parent_appointment_id']);
        $this->assertSame(['id', 'scheduled_at', 'status', 'specialist_name'], array_keys($a['parent']));
        $this->assertSame('Dr. Grace Bell', $a['parent']['specialist_name']);
        $this->assertSame('doctor', $a['proposed_by']);
        $this->assertSame('Bring your blood pressure log.', $a['follow_up_note']);
        $this->assertSame('percent', $a['follow_up_pricing']['rule']);
        $this->assertNotNull($a['expires_at']);

        // The back office never sees what the two wrote each other.
        $proposal->setDeclineReason('Feeling better');
        $admin = $proposal->toAdminArray();
        $this->assertArrayNotHasKey('follow_up_note', $admin);
        $this->assertArrayNotHasKey('decline_reason', $admin);
        $this->assertSame('proposed', $admin['status']);
    }

    public function testAnOrdinaryBookingCarriesNoFollowUpFields(): void
    {
        $booking = new Appointment($this->patient(), $this->doctor(), new DateTimeImmutable('+1 day'));
        $booking->initTimestamps();
        $a = $booking->toArray();

        foreach (['parent_appointment_id', 'parent', 'proposed_by', 'follow_up_note', 'follow_up_pricing', 'expires_at', 'decline_reason', 'follow_up_outcome'] as $key) {
            $this->assertArrayHasKey($key, $a);
            $this->assertNull($a[$key], $key);
        }
    }

    public function testAClosedProposalRecordsHowItClosed(): void
    {
        $proposal = $this->proposal();
        $this->assertNull($proposal->toArray()['follow_up_outcome'], 'still open');

        foreach (['declined', 'withdrawn', 'expired'] as $outcome) {
            $proposal->setFollowUpOutcome($outcome);
            $this->assertSame($outcome, $proposal->getFollowUpOutcome());
            $this->assertSame($outcome, $proposal->toArray()['follow_up_outcome']);
            $this->assertSame($outcome, $proposal->toAdminArray()['follow_up_outcome'], 'not private: the back office may see how it closed');
        }

        $this->expectException(\InvalidArgumentException::class);
        $proposal->setFollowUpOutcome('accepted');
    }

    public function testAPatientBookedFollowUpIsLinkedAndTyped(): void
    {
        $parent  = $this->completedParent();
        $booking = new Appointment($parent->getPatient(), $parent->getSpecialist(), new DateTimeImmutable('+3 days'));
        $booking->bookAsFollowUpOf($parent, ['amount' => '10000.00', 'rule' => 'percent']);

        $this->assertSame(ConsultationType::FOLLOW_UP, $booking->getType());
        $this->assertSame('patient', $booking->getProposedBy());
        $this->assertSame(AppointmentStatus::PENDING, $booking->getStatus(), 'the normal booking flow');
        $this->assertNull($booking->getExpiresAt());
    }

    // ----- Prices -----

    public function testFollowUpPricingRules(): void
    {
        $parent = new DateTimeImmutable('2026-10-01 10:00:00');
        $inside = new DateTimeImmutable('2026-10-10 10:00:00');
        $price  = static fn (string $mode, DateTimeImmutable $start, bool $waived = false, string $fee = '20000.00', int $pct = 50): array
            => PricingService::followUpPrice($fee, $mode, $pct, 14, $parent, $start, $waived);

        $this->assertSame(['10000.00', 'percent', 50], [$price('percent', $inside)['amount'], $price('percent', $inside)['rule'], $price('percent', $inside)['discount_percent']]);
        $this->assertSame(['0.00', 'free'], [$price('free', $inside)['amount'], $price('free', $inside)['rule']]);
        $this->assertSame(['20000.00', 'full'], [$price('full', $inside)['amount'], $price('full', $inside)['rule']]);

        $this->assertSame('20000.00', $price('percent', $inside, false, '20000.00', 0)['amount'], '0% off');
        $this->assertSame('0.00', $price('percent', $inside, false, '20000.00', 100)['amount'], '100% off');
        $this->assertSame('166.66', $price('percent', $inside, false, '333.33')['amount'], 'rounds down to the kobo, in the patient\'s favour');

        $edge = new DateTimeImmutable('2026-10-15 10:00:00');
        $this->assertSame('percent', $price('percent', $edge)['rule'], 'the last moment of the window still counts');
        $late = $price('free', new DateTimeImmutable('2026-10-15 10:01:00'));
        $this->assertSame(['20000.00', 'outside_window', 0], [$late['amount'], $late['rule'], $late['discount_percent']], 'outside the window it is the full fee');
        $this->assertSame('2026-10-15T10:00:00+00:00', (new DateTimeImmutable($late['window_ends_at']))->setTimezone(new \DateTimeZone('UTC'))->format(DATE_ATOM));

        $waived = $price('full', new DateTimeImmutable('2026-12-01 10:00:00'), true);
        $this->assertSame(['0.00', 'waived', true], [$waived['amount'], $waived['rule'], $waived['waived']], 'a waiver wins, even outside the window');
    }

    public function testPricingSettingsAreValidated(): void
    {
        $action = new UpdatePricingAction(new PricingService(new AppSettingRepository($this->em())));
        $patch  = function (array $body) use ($action): array {
            $request = (new ServerRequestFactory())->createServerRequest('PATCH', '/api/settings/pricing')->withParsedBody($body);
            $res     = $action($request, (new ResponseFactory())->createResponse());

            return [$res->getStatusCode(), json_decode((string) $res->getBody(), true)['errors'] ?? []];
        };

        [$status, $errors] = $patch(['follow_up_fee_mode' => 'half', 'follow_up_discount_percent' => 101, 'follow_up_window_days' => 0]);
        $this->assertSame(422, $status);
        $this->assertSame(['follow_up_fee_mode', 'follow_up_discount_percent', 'follow_up_window_days'], array_keys($errors));

        [$status, $errors] = $patch(['follow_up_discount_percent' => '12.5', 'follow_up_window_days' => '366']);
        $this->assertSame(422, $status);
        $this->assertArrayHasKey('follow_up_discount_percent', $errors, 'whole numbers only');
        $this->assertArrayHasKey('follow_up_window_days', $errors);
    }

    // ----- When a proposal closes, who may propose -----

    public function testAProposalClosesTwoHoursBeforeItStartsButWithinThreeDays(): void
    {
        $now = new DateTimeImmutable('2026-10-14 09:00:00');

        $this->assertEquals(new DateTimeImmutable('2026-10-14 18:00:00'), FollowUpService::expiresAt(new DateTimeImmutable('2026-10-14 20:00:00'), $now));
        $this->assertEquals(new DateTimeImmutable('2026-10-17 09:00:00'), FollowUpService::expiresAt(new DateTimeImmutable('2026-10-24 10:00:00'), $now), 'at most 72 hours after proposing');
        $this->assertEquals(new DateTimeImmutable('2026-10-14 11:30:00'), FollowUpService::earliestProposalStart($now), 'the patient always gets 30 minutes to answer');
    }

    public function testOnlyAConsultationUnderWayOrCompletedCanBeFollowedUp(): void
    {
        $now = new DateTimeImmutable();
        $this->assertNull(FollowUpService::doctorParentProblem($this->completedParent(), $now));

        $inCall = new Appointment(new Patient('ada@example.test', 'Ada', 'Obi'), $this->doctor(), new DateTimeImmutable('-10 minutes'));
        $inCall->transitionTo(AppointmentStatus::CONFIRMED);
        $this->assertNull(FollowUpService::doctorParentProblem($inCall, $now), 'from the in-call Follow-ups tab');

        $later = new Appointment(new Patient('ada@example.test', 'Ada', 'Obi'), $this->doctor(), new DateTimeImmutable('+1 day'));
        $later->transitionTo(AppointmentStatus::CONFIRMED);
        $this->assertNotNull(FollowUpService::doctorParentProblem($later, $now), 'it has not taken place yet');

        $pending = new Appointment(new Patient('ada@example.test', 'Ada', 'Obi'), $this->doctor(), new DateTimeImmutable('-1 hour'));
        $this->assertNotNull(FollowUpService::doctorParentProblem($pending, $now));
        $this->assertNotNull(FollowUpService::doctorParentProblem($this->proposal(), $now), 'not a proposal of a proposal');
    }

    public function testAPatientFollowsUpTheirOwnCompletedConsultationWithThatDoctor(): void
    {
        $parent = $this->completedParent();
        $doctor = $parent->getSpecialist()->getId();

        $this->assertNull(FollowUpService::patientParentProblem($parent, $doctor));
        $this->assertSame('parent_appointment_id', FollowUpService::patientParentProblem(null, $doctor)[0], 'not theirs (or not found)');
        $this->assertSame('specialist_id', FollowUpService::patientParentProblem($parent, 'another-doctor')[0]);

        $upcoming = new Appointment($parent->getPatient(), $parent->getSpecialist(), new DateTimeImmutable('+1 day'));
        $this->assertSame('parent_appointment_id', FollowUpService::patientParentProblem($upcoming, $doctor)[0], 'not completed yet');
    }

    public function testTheNudgeComesOnceADayBeforeExpiryButNeverOnTopOfTheProposal(): void
    {
        $now = new DateTimeImmutable();

        $due = $this->proposal(null, '+2 days', '+20 hours');
        $this->forceCreatedAt($due, '-13 hours');
        $this->assertTrue(FollowUpService::isNudgeDue($due, $now));

        $due->markFollowUpNudged($now);
        $this->assertFalse(FollowUpService::isNudgeDue($due, $now), 'only once');

        $fresh = $this->proposal(null, '+1 day', '+20 hours');
        $this->assertFalse(FollowUpService::isNudgeDue($fresh, $now), 'proposed just now — the proposal email is enough');

        $far = $this->proposal(null, '+4 days', '+30 hours');
        $this->forceCreatedAt($far, '-40 hours');
        $this->assertFalse(FollowUpService::isNudgeDue($far, $now), 'more than a day left');

        $expired = $this->proposal(null, '+1 day', '-1 minute');
        $this->forceCreatedAt($expired, '-2 days');
        $this->assertFalse(FollowUpService::isNudgeDue($expired, $now), 'expired ones are cancelled, not nudged');
    }

    // ----- Answering -----

    public function testOnlyAnOpenProposalCanBeAnswered(): void
    {
        $now = new DateTimeImmutable();
        $this->assertNull(FollowUpService::responseProblem($this->proposal(), $now));
        $this->assertStringContainsString('expired', (string) FollowUpService::responseProblem($this->proposal(null, '+2 days', '-1 minute'), $now));

        $withdrawn = $this->proposal();
        $withdrawn->transitionTo(AppointmentStatus::CANCELLED);
        $this->assertSame('This follow-up proposal is no longer open.', FollowUpService::responseProblem($withdrawn, $now));

        $booking = new Appointment(new Patient('ada@example.test', 'Ada', 'Obi'), $this->doctor(), new DateTimeImmutable('+1 day'));
        $this->assertSame('This appointment is not a follow-up proposal.', FollowUpService::responseProblem($booking, $now));
    }

    public function testAcceptingNeedsAPaymentMethodUnlessFree(): void
    {
        try {
            $this->service()->accept($this->proposal(), '', '', null);
            $this->fail('a paid follow-up needs wallet or card');
        } catch (ValidationException $e) {
            $this->assertArrayHasKey('payment_method', $e->getErrors());
        }

        try {
            $this->service()->accept($this->proposal(null, '+2 days', '-1 minute'), 'wallet', '', null);
            $this->fail('an expired proposal cannot be accepted');
        } catch (ValidationException $e) {
            $this->assertArrayHasKey('status', $e->getErrors());
        }
    }

    public function testRepeatsAreAnsweredWithoutDoingAnythingTwice(): void
    {
        $accepted = $this->proposal();
        $accepted->transitionTo(AppointmentStatus::CONFIRMED);
        $this->assertFalse($this->service()->accept($accepted, 'wallet', '', null), 'already accepted: nothing charged again');

        $closed = $this->proposal();
        $closed->transitionTo(AppointmentStatus::CANCELLED);
        $this->assertFalse($this->service()->decline($closed, null));
        $this->assertFalse($this->service()->withdraw($closed));
    }

    public function testARepeatCreditsASecondCardPaymentToTheWallet(): void
    {
        // Paid by card on one device while it was accepted on another: the
        // repeat charges nothing again, but that payment must not go unused.
        $byWallet = $this->proposal();
        $byWallet->transitionTo(AppointmentStatus::CONFIRMED);
        $byWallet->setPaymentStatus('paid');
        $this->assertSame('ref_second', FollowUpService::strayCardReference($byWallet, ' Card ', ' ref_second '));
        $this->assertNull(FollowUpService::strayCardReference($byWallet, 'wallet', ''), 'nothing paid by card');
        $this->assertNull(FollowUpService::strayCardReference($byWallet, 'card', '  '), 'no reference');

        $byCard = $this->proposal();
        $byCard->transitionTo(AppointmentStatus::CONFIRMED);
        $byCard->payByCard('ref_theirs');
        $this->assertNull(FollowUpService::strayCardReference($byCard, 'card', 'ref_theirs'), 'the very payment it was confirmed with');
        $this->assertSame('ref_other', FollowUpService::strayCardReference($byCard, 'card', 'ref_other'));

        // accept() hands a stray payment to the payments' wallet credit (this
        // dependency-less service fails loudly the moment it is reached)…
        $service = $this->service();
        (new \ReflectionProperty(FollowUpService::class, 'intents'))
            ->setValue($service, (new \ReflectionClass(\App\Infrastructure\Service\PaymentIntentService::class))->newInstanceWithoutConstructor());

        $credited = 'untouched';
        $this->assertFalse($service->accept($byCard, 'card', 'ref_theirs', null, $credited), 'the same payment: a plain repeat');
        $this->assertNull($credited);
        $this->assertFalse($service->accept($byWallet, 'wallet', '', null, $credited));
        $this->assertNull($credited);

        // …and only then.
        try {
            $service->accept($byWallet, 'card', 'ref_second', null, $credited);
            $this->fail('a second card payment must be credited to the wallet');
        } catch (\Error $e) {
            $this->assertStringContainsString('PaymentIntentService::$intents', $e->getMessage(), 'reached settleUnusedFor()');
        }
    }

    public function testAnAcceptedFollowUpCannotBeDeclinedOrWithdrawn(): void
    {
        $accepted = $this->proposal();
        $accepted->transitionTo(AppointmentStatus::CONFIRMED);

        foreach ([fn () => $this->service()->decline($accepted, null), fn () => $this->service()->withdraw($accepted)] as $answer) {
            try {
                $answer();
                $this->fail('cancel the appointment instead');
            } catch (ValidationException $e) {
                $this->assertStringContainsString('cancel the appointment instead', $e->getMessage());
            }
        }
    }

    public function testMoneyIsTakenForThePriceAtTheChosenTimeWithoutTouchingTheProposal(): void
    {
        // Accepting at another slot charges that slot's price before the
        // proposal changes: a free re-quote posts nothing (any wallet call on
        // this state-less wallet would fail loudly) and leaves the stored price.
        $proposal = $this->proposal();
        $wallet   = (new \ReflectionClass(WalletService::class))->newInstanceWithoutConstructor();

        $this->assertNull((new AppointmentPaymentService($wallet))->chargeForBooking($proposal, '0.00'));
        $this->assertSame('paid', $proposal->getPaymentStatus());
        $this->assertSame('10000.00', $proposal->getAmount(), 'the amount changes only once it is accepted');
    }

    public function testAProposalIsOnlyTakenFromADoctorWhoCanStillBeBooked(): void
    {
        $proposal = $this->proposal();
        $proposal->getSpecialist()->setStatus(SpecialistStatus::SUSPENDED); // after proposing

        foreach ([
            'accept'   => fn () => $this->service()->accept($proposal, 'wallet', '', null),
            'checkout' => fn () => $this->service()->checkoutAmount($proposal, null),
        ] as $way => $take) {
            try {
                $take();
                $this->fail("$way: no money moves for a suspended doctor");
            } catch (ValidationException $e) {
                $this->assertArrayHasKey('specialist_id', $e->getErrors(), $way);
            }
        }
        $this->assertSame(AppointmentStatus::PROPOSED, $proposal->getStatus());
        $this->assertSame('unpaid', $proposal->getPaymentStatus());
    }

    public function testACardCheckoutOnlyStartsWhenAcceptingCanStillSucceed(): void
    {
        $closing = $this->proposal(null, '+2 days', '+10 minutes');
        try {
            $this->service()->checkoutAmount($closing, null);
            $this->fail('the payment would outlive the proposal');
        } catch (ValidationException $e) {
            $this->assertStringContainsString('too soon to pay by card', $e->getErrors()['status']);
        }

        try {
            $this->service()->checkoutAmount($this->proposal(null, '+2 days', '-1 minute'), null);
            $this->fail('expired');
        } catch (ValidationException $e) {
            $this->assertStringContainsString('expired', $e->getErrors()['status']);
        }

        $open = $this->proposal();
        $this->assertSame('10000.00', $this->service()->checkoutAmount($open, null), "the doctor's price at the proposed time");
        $this->assertSame('10000.00', $this->service()->checkoutAmount($open, $open->getScheduledAt()), 'its own slot is not "taken"');
    }

    public function testAnUnusedCardPaymentIsCreditedUnderTheKeyItAlwaysHad(): void
    {
        // An acceptance now takes its wallet money inside the claim's own
        // transaction, so a losing one takes nothing (the old race refunds are
        // gone; tests/Integration/Card covers the race). An unused card payment
        // still goes to the wallet under the reference it always used — so one
        // credited before payment intents existed can never be credited again.
        $this->assertSame('fu_card_credit_vma_abc', AppointmentCheckout::walletCreditKey('vma_abc'));
        $this->assertSame('fu_card_credit_vma_abc', \App\Infrastructure\Service\PaymentIntentService::walletCreditKey('vma_abc'));
        $this->assertSame('card_overpay_vma_abc', \App\Infrastructure\Service\PaymentIntentService::overpaymentKey('vma_abc'));
        $this->assertNotSame(
            \App\Infrastructure\Service\PaymentIntentService::walletCreditKey('vma_abc'),
            \App\Infrastructure\Service\PaymentIntentService::overpaymentKey('vma_abc'),
            'a payment used with an overpayment can never also be credited whole',
        );
    }

    public function testRequestedTimesAreStoredOnTheServerClock(): void
    {
        // Doctrine keeps a datetime's wall-clock time and drops its offset.
        $at = FollowUpService::parseStart('2030-10-21T15:00:00+01:00');
        $this->assertSame(date_default_timezone_get(), $at->getTimezone()->getName());
        $this->assertSame((new DateTimeImmutable('2030-10-21T14:00:00Z'))->getTimestamp(), $at->getTimestamp());
        if (date_default_timezone_get() === 'UTC') {
            $this->assertSame('2030-10-21 14:00', $at->format('Y-m-d H:i'), 'not 15:00 read back as 15:00Z');
        }
    }

    public function testAnExpiryOlderThanThreeDaysClosesQuietly(): void
    {
        $now = new DateTimeImmutable('2026-10-21T12:00:00Z');
        $at  = static function (string $expires) use ($now): Appointment {
            $parent = new Appointment(new Patient('q@example.test', 'Q', 'Uiet'), new Specialist('Dr. Q', 'General Practice'), $now->modify('-10 days'));

            return Appointment::proposeFollowUp($parent, $now->modify('+1 day'), ['amount' => '0.00'], null, $now->modify($expires));
        };

        $this->assertTrue(FollowUpService::expiresQuietly($at('-4 days'), $now), 'the backlog of a first cron run');
        $this->assertFalse(FollowUpService::expiresQuietly($at('-2 days'), $now));
        $this->assertFalse(FollowUpService::expiresQuietly($at('-1 hour'), $now));
    }

    public function testADeclineReasonIsBounded(): void
    {
        $this->expectException(ValidationException::class);
        $this->service()->decline($this->proposal(), str_repeat('x', FollowUpService::MAX_REASON_LENGTH + 1));
    }

    // ----- Kept out of the call -----

    public function testAnUnacceptedProposalHasNoCallToJoin(): void
    {
        $em       = $this->em();
        $proposal = $this->proposal();
        $uow      = $em->getUnitOfWork();
        foreach ([$proposal->getPatient(), $proposal->getSpecialist(), $proposal->getParent(), $proposal] as $entity) {
            $uow->registerManaged($entity, ['id' => $entity->getId()], []);
        }

        $jwt     = new JwtService(self::SECRET, 900, 1209600);
        $consent = new GuestConsent(
            new ConsultationConsentRepository($em),
            new RecordingRepository($em),
            new AgoraRecordingService('', '', '', ['vendor' => 0, 'region' => 0, 'bucket' => '', 'accessKey' => '', 'secretKey' => '']),
            new CallPresence(new RedisClient()),
        );
        $action  = new JoinCallAction($jwt, new AppointmentRepository($em), new AgoraTokenService('', ''), $consent, new CallPresence(new RedisClient()));
        $token   = $jwt->issueCallAccess($proposal->getId(), 'Ada Obi', 'patient', 1);
        $request = (new ServerRequestFactory())->createServerRequest('GET', '/api/public/call/' . $token);
        $res     = $action($request, (new ResponseFactory())->createResponse(), ['token' => $token]);

        $this->assertSame(409, $res->getStatusCode());
        $errors = json_decode((string) $res->getBody(), true)['errors'];
        $this->assertSame('proposed', $errors['status']);
        $this->assertSame('not_confirmed', $errors['code']);
        $this->assertSame('call', array_key_first($errors), 'the message is the first field, so apiErrorMessage shows it');
    }

    // ----- What the patient is told -----

    public function testNoticesAreGenericAndOnTheClinicClock(): void
    {
        ClinicTime::configure('Africa/Lagos');
        $when = FollowUpService::whenLabel(new DateTimeImmutable('2026-10-20T14:00:00+00:00'));
        $this->assertSame('Tue 20 Oct, 3:00 PM WAT', $when);

        $mail = EmailTemplates::followUpProposed('Ada', 'Dr. Grace <Bell>', $when, 'Sun 18 Oct, 9:00 AM WAT', '₦10,000.00', 'https://app.example/dashboard/appointments/x');
        $this->assertStringContainsString('proposed a follow-up consultation on Tue 20 Oct, 3:00 PM WAT. Open VideoMed to accept or choose another time.', $mail['html']);
        $this->assertStringContainsString('Dr. Grace &lt;Bell&gt;', $mail['html'], 'escaped');
        $this->assertStringNotContainsString('blood pressure', $mail['html'], 'the note never reaches an email');
        $this->assertStringContainsString('https://app.example/dashboard/appointments/x', $mail['html']);

        $reminder = EmailTemplates::followUpProposed('Ada', 'Dr. Grace Bell', $when, 'Sun 18 Oct, 9:00 AM WAT', 'Free', 'https://app.example/x', true);
        $this->assertStringStartsWith('Reminder:', $reminder['subject']);

        $this->assertSame('Follow-up proposal withdrawn', EmailTemplates::followUpClosed('Ada', 'Dr. Grace Bell', $when, 'withdrawn', 'https://app.example/x')['subject']);
        $this->assertSame('Follow-up proposal closed', EmailTemplates::followUpClosed('Ada', 'Dr. Grace Bell', $when, 'expired', 'https://app.example/x')['subject']);
    }

    // ----- Queries + routes -----

    public function testProposalQueriesCompile(): void
    {
        $repo = new AppointmentRepository($this->em());
        $now  = new DateTimeImmutable();
        $id   = '00000000-0000-0000-0000-000000000001';

        $sql = static fn (\Doctrine\ORM\Query $q): string => is_array($q->getSQL()) ? implode(';', $q->getSQL()) : (string) $q->getSQL();

        $claim = $sql($repo->proposalClaimQuery($id, AppointmentStatus::CONFIRMED, $now));
        $this->assertStringStartsWith('UPDATE appointments', $claim);
        $this->assertMatchesRegularExpression('/status = \?/', $claim, 'only a row still proposed is claimed');
        $this->assertStringContainsString('expires_at > ?', $claim, 'accepting also needs it unexpired');
        $this->assertStringNotContainsString('expires_at', $sql($repo->proposalClaimQuery($id, AppointmentStatus::CANCELLED)));

        $this->assertStringContainsString('expires_at > ?', $sql($repo->forSpecialistBetweenQuery($id, $now, $now->modify('+1 day'), $now)), 'an open proposal holds its slot until it expires');
        $this->assertStringContainsString('parent_appointment_id', $sql($repo->followUpsQuery($id)));
        $this->assertStringContainsString('parent_appointment_id', $sql($repo->openProposalQuery($id, $now)));
        $this->assertStringContainsString('expires_at <= ?', $sql($repo->expiredProposalsQuery($now)));
        $this->assertStringContainsString('follow_up_nudged_at IS NULL', $sql($repo->proposalsClosingByQuery($now, $now->modify('+1 day'))));

        // Unaccepted proposals aren't bookings in the back-office analytics…
        $analytics = $sql($repo->analyticsQuery($now->modify('-30 days'), $now));
        $this->assertMatchesRegularExpression('/status <> \?/', $analytics);
        // …but an ordinary booking (no proposed_by) still counts, cancelled or not.
        $this->assertStringContainsString('proposed_by IS NULL', $analytics);

        // The doctor's schedule: what's coming soonest first, then the latest earlier ones — not the oldest 100.
        $since = AppointmentRepository::scheduleSince($now);
        $this->assertEquals($now->modify('-1 day'), $since, "all of the doctor's today, whatever their timezone");
        $coming = $sql($repo->scheduleQuery($id, $since, true, 100));
        $this->assertStringContainsString('scheduled_at >= ?', $coming);
        $this->assertMatchesRegularExpression('/ORDER BY \S+scheduled_at ASC/', $coming);
        $earlier = $sql($repo->scheduleQuery($id, $since, false, 100));
        $this->assertStringContainsString('scheduled_at < ?', $earlier);
        $this->assertMatchesRegularExpression('/ORDER BY \S+scheduled_at DESC/', $earlier);
    }

    public function testFollowUpRoutesResolve(): void
    {
        $_ENV['DB_SERVER_VERSION'] = '16';
        DoctrineEntityManagerFactory::reset();
        $builder = new ContainerBuilder();
        $builder->addDefinitions(__DIR__ . '/../../config/container.php');
        $container = $builder->build();
        $this->assertInstanceOf(FollowUpService::class, $container->get(FollowUpService::class));
        $this->assertInstanceOf(UpdateAppointmentStatusAction::class, $container->get(UpdateAppointmentStatusAction::class));

        AppFactory::setContainer($container);
        $app = AppFactory::create();
        (require __DIR__ . '/../../config/routes.php')($app);

        $id = '6f1c3a52-1b1e-4c55-9d2b-0c8e5b0f6a11';
        // One consultation by id — registered after the static routes it would shadow.
        $byId = $app->getRouteResolver()->computeRoutingResults("/api/doctor/appointments/$id", 'GET');
        $this->assertSame(RoutingResults::FOUND, $byId->getRouteStatus());
        $this->assertSame(GetDoctorAppointmentAction::class, $app->getRouteResolver()->resolveRoute((string) $byId->getRouteIdentifier())->getCallable());
        foreach (['history' => DoctorAppointmentHistoryAction::class, 'presence' => DoctorCallPresenceAction::class] as $path => $action) {
            $result = $app->getRouteResolver()->computeRoutingResults("/api/doctor/appointments/$path", 'GET');
            $this->assertSame($action, $app->getRouteResolver()->resolveRoute((string) $result->getRouteIdentifier())->getCallable(), $path);
        }

        foreach ([
            ['POST', "/api/doctor/appointments/$id/follow-up"],
            ['GET', "/api/doctor/appointments/$id/follow-up/quote"],
            ['POST', "/api/doctor/appointments/$id/follow-up/withdraw"],
            ['GET', "/api/doctor/appointments/$id/follow-ups"],
            ['POST', "/api/portal/appointments/$id/follow-up/accept"],
            ['POST', "/api/portal/appointments/$id/follow-up/decline"],
            ['GET', "/api/portal/appointments/$id/follow-up/quote"],
            ['GET', "/api/portal/appointments/$id/follow-ups"],
        ] as [$method, $path]) {
            $result = $app->getRouteResolver()->computeRoutingResults($path, $method);
            $this->assertSame(RoutingResults::FOUND, $result->getRouteStatus(), "$method $path");
        }
    }

    private function forceCreatedAt(Appointment $appointment, string $ago): void
    {
        $prop = new \ReflectionProperty(Appointment::class, 'createdAt');
        $prop->setValue($appointment, new DateTimeImmutable($ago));
    }
}
