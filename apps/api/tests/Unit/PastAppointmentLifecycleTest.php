<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Action\Appointment\GetCallTokenAction;
use App\Action\Appointment\GetMyAppointmentAction;
use App\Action\Appointment\ListMyAppointmentsAction;
use App\Action\Appointment\ReschedulePortalAppointmentAction;
use App\Action\Appointment\ResolveAppointmentAction;
use App\Action\Doctor\ConfirmDoctorAppointmentAction;
use App\Action\Doctor\DeclineDoctorAppointmentAction;
use App\Action\Doctor\GetDoctorAppointmentAction;
use App\Domain\Appointment\AppointmentLifecycle;
use App\Domain\Call\CallAccess;
use App\Domain\Entity\Appointment;
use App\Domain\Entity\Patient;
use App\Domain\Entity\Specialist;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Exception\ValidationException;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\AuditEventRepository;
use App\Domain\Repository\NotificationRepository;
use App\Domain\Settings\BookingSettings;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Email\MailService;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use App\Infrastructure\Service\AppointmentPaymentService;
use App\Infrastructure\Service\AppointmentResolver;
use App\Infrastructure\Service\AuditLogger;
use App\Infrastructure\Service\CallPresence;
use App\Infrastructure\Service\ConsultationCompleter;
use App\Infrastructure\Service\PastAppointmentCloser;
use App\Infrastructure\Service\PatientNotifier;
use App\Infrastructure\Service\WalletService;
use DateTimeImmutable;
use DI\ContainerBuilder;
use Doctrine\ORM\EntityManagerInterface;
use Doctrine\ORM\Query;
use PHPUnit\Framework\TestCase;
use Psr\Log\NullLogger;
use Slim\Factory\AppFactory;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Routing\RoutingResults;

/**
 * Past appointments: lists split by TIME (phase / display status / `?when=`),
 * the cron closing what nobody closed (completed on proof, expired when never
 * confirmed, missed with who didn't come), the money rules (no-show and late
 * cancellation refunds, earnings) and the patient's cancel / reschedule window.
 */
final class PastAppointmentLifecycleTest extends TestCase
{
    private const START = '2026-10-14 10:00:00';

    private function em(): EntityManagerInterface
    {
        $_ENV['DB_SERVER_VERSION'] = '16';
        DoctrineEntityManagerFactory::reset();

        return DoctrineEntityManagerFactory::create();
    }

    /** A 30-minute consultation at START, moved to `$status` (as the system may). */
    private function appointment(AppointmentStatus $status = AppointmentStatus::CONFIRMED, string $amount = '10000.00', string $start = self::START): Appointment
    {
        $patient = new Patient('ada@example.test', 'Ada', 'Obi');
        $patient->initTimestamps();
        $doctor = new Specialist('Dr. Grace Bell', 'General Practice');
        $doctor->setSlotMinutes(30);
        $appointment = new Appointment($patient, $doctor, new DateTimeImmutable($start));
        $appointment->setAmount($amount);
        $appointment->initTimestamps();
        if ($status !== AppointmentStatus::PENDING) {
            $appointment->transitionTo($status === AppointmentStatus::MISSED ? AppointmentStatus::CONFIRMED : $status, true);
            $appointment->transitionTo($status, true);
        }

        return $appointment;
    }

    private static function at(string $time): DateTimeImmutable
    {
        return new DateTimeImmutable($time);
    }

    private static function sql(Query $query): string
    {
        $sql = $query->getSQL();

        return is_array($sql) ? implode(';', $sql) : $sql;
    }

    // ----- The state machine -----

    public function testMissedIsTerminalAndOnlyTheSystemOrStaffMoveIntoOrOutOfIt(): void
    {
        $this->assertTrue(AppointmentStatus::MISSED->isTerminal());
        $this->assertSame('Missed', AppointmentStatus::MISSED->label());
        $this->assertFalse(AppointmentStatus::CONFIRMED->canTransitionTo(AppointmentStatus::MISSED), 'not by a patient or a doctor');
        $this->assertTrue(AppointmentStatus::CONFIRMED->canTransitionTo(AppointmentStatus::MISSED, true));
        $this->assertTrue(AppointmentStatus::MISSED->canTransitionTo(AppointmentStatus::COMPLETED, true), 'held after all');
        $this->assertTrue(AppointmentStatus::MISSED->canTransitionTo(AppointmentStatus::CANCELLED, true));
        $this->assertFalse(AppointmentStatus::MISSED->canTransitionTo(AppointmentStatus::CANCELLED), 'a patient can\'t cancel a missed visit for a refund');

        foreach ([AppointmentStatus::PENDING, AppointmentStatus::RESCHEDULED] as $unconfirmed) {
            $this->assertFalse($unconfirmed->canTransitionTo(AppointmentStatus::COMPLETED), 'the doctor confirms first');
            $this->assertTrue($unconfirmed->canTransitionTo(AppointmentStatus::COMPLETED, true), 'the cron completes one that took place unconfirmed');
        }
        $this->assertFalse(AppointmentStatus::PROPOSED->canTransitionTo(AppointmentStatus::MISSED, true));

        $appointment = $this->appointment(AppointmentStatus::CONFIRMED);
        try {
            $appointment->transitionTo(AppointmentStatus::MISSED);
            $this->fail('an ordinary transition may not mark it missed');
        } catch (\DomainException) {
            $this->assertSame(AppointmentStatus::CONFIRMED, $appointment->getStatus());
        }
        $this->assertNull($appointment->getClosedAt());
        $appointment->transitionTo(AppointmentStatus::MISSED, true);
        $this->assertNotNull($appointment->getClosedAt(), 'closing records when');
    }

    // ----- Phase: by time, not status -----

    public function testPhaseFollowsTheClockWithAThirtyMinuteGraceAfterTheEnd(): void
    {
        $a = $this->appointment(AppointmentStatus::PENDING);

        $this->assertSame('2026-10-14T10:30:00', substr(AppointmentLifecycle::endsAt($a)->format(DATE_ATOM), 0, 19), 'ends_at = start + slot');
        $this->assertSame('upcoming', AppointmentLifecycle::phase($a, self::at('2026-10-14 09:59:59')));
        $this->assertSame('live', AppointmentLifecycle::phase($a, self::at('2026-10-14 10:00:00')), 'the start minute is live');
        $this->assertSame('live', AppointmentLifecycle::phase($a, self::at('2026-10-14 10:59:59')));
        $this->assertSame('past', AppointmentLifecycle::phase($a, self::at('2026-10-14 11:00:00')), 'end + 30 min: past');
        $this->assertSame('live', AppointmentLifecycle::phase($a, self::at('2026-10-14 12:00:00'), true), 'someone in the call keeps it live');

        foreach ([AppointmentStatus::COMPLETED, AppointmentStatus::CANCELLED, AppointmentStatus::MISSED] as $closed) {
            $this->assertSame('past', AppointmentLifecycle::phase($this->appointment($closed, '10000.00', '2026-12-01 10:00:00'), self::at(self::START)), $closed->value . ' is over, even before its time');
        }
    }

    public function testASeptemberBookingNobodyClosedShowsInHistoryNotAppointments(): void
    {
        $now = self::at('2026-10-15 09:00:00');
        foreach ([AppointmentStatus::PENDING, AppointmentStatus::RESCHEDULED] as $status) {
            $stale = $this->appointment($status, '0.00', '2026-09-05 14:30:00');
            $row   = $stale->toArray('patient', $now);
            $this->assertSame('past', $row['phase']);
            $this->assertSame('not_confirmed', $row['display_status']);
            $this->assertSame('Not confirmed', $row['display_label']);
            $this->assertSame("Doctor didn't confirm in time", $row['display_detail']);
            $this->assertTrue($row['needs_attention']);
            $this->assertFalse($row['can_cancel'], 'it has started: no cancelling it for a refund');
            $this->assertFalse($row['can_reschedule']);
        }

        $confirmed = $this->appointment(AppointmentStatus::CONFIRMED, '0.00', '2026-09-01 10:00:00')->toArray('patient', $now);
        $this->assertSame(['past', 'finalising', 'Being finalised'], [$confirmed['phase'], $confirmed['display_status'], $confirmed['display_label']]);
    }

    public function testDisplayIsWordedForTheViewer(): void
    {
        $now    = self::at('2026-10-15 09:00:00');
        $missed = $this->appointment(AppointmentStatus::MISSED);
        $expect = [
            'patient' => ["You didn't join", "Doctor didn't attend", 'Neither joined'],
            'doctor'  => ["Patient didn't join", "You didn't attend", 'Neither joined'],
            'staff'   => ["Patient didn't join", "Doctor didn't attend", 'Neither joined'],
        ];
        foreach ($expect as $audience => $details) {
            foreach (['patient', 'doctor', 'both'] as $i => $party) {
                $missed->setNoShow($party);
                $this->assertSame(['missed', 'Missed', $details[$i]], AppointmentLifecycle::display($missed, $now, $audience), "$audience / $party");
            }
        }

        $expired = $this->appointment(AppointmentStatus::CANCELLED);
        $expired->setClosureReason('expired_unconfirmed');
        $this->assertSame(['not_confirmed', 'Not confirmed', "You didn't confirm in time"], AppointmentLifecycle::display($expired, $now, 'doctor'));

        $upcoming = $this->appointment(AppointmentStatus::PENDING, '10000.00', '2026-10-20 10:00:00');
        $this->assertSame(['upcoming', 'Pending', 'Awaiting doctor confirmation'], AppointmentLifecycle::display($upcoming, $now, 'patient'));
        $this->assertSame(['upcoming', 'Pending', 'Awaiting your confirmation'], AppointmentLifecycle::display($upcoming, $now, 'doctor'));

        $moved = $this->appointment(AppointmentStatus::CONFIRMED, '10000.00', '2026-10-20 10:00:00');
        $moved->setRescheduledBy('doctor');
        $this->assertSame('Your doctor moved this consultation', AppointmentLifecycle::display($moved, $now, 'patient')[2]);

        $this->assertSame(['live', 'In progress', null], AppointmentLifecycle::display($this->appointment(), self::at('2026-10-14 10:10:00'), 'patient'));
    }

    public function testEveryPayloadCarriesTheLifecycleFields(): void
    {
        $now = self::at('2026-10-13 09:00:00');
        $row = $this->appointment(AppointmentStatus::CONFIRMED)->toArray('patient', $now);
        foreach (['ends_at', 'phase', 'display_status', 'display_label', 'display_detail', 'needs_attention', 'closure_reason', 'no_show', 'closed_at', 'rescheduled_by', 'refunded_amount', 'can_cancel', 'can_reschedule'] as $key) {
            $this->assertArrayHasKey($key, $row);
        }
        $this->assertTrue($row['can_cancel'], 'a confirmed visit can be cancelled until its start');

        $doctorRow = $this->appointment(AppointmentStatus::PENDING)->toArray('doctor', self::at('2026-10-14 10:59:00'));
        $this->assertTrue($doctorRow['can_confirm'], 'until 30 minutes after the end');
        $this->assertArrayNotHasKey('can_cancel', $doctorRow);
        $this->assertFalse($this->appointment(AppointmentStatus::PENDING)->toArray('doctor', self::at('2026-10-14 11:00:01'))['can_confirm']);

        $admin = $this->appointment(AppointmentStatus::CONFIRMED)->toAdminArray();
        $this->assertArrayHasKey('doctor_first_joined_at', $admin);
        $this->assertArrayHasKey('patient_first_joined_at', $admin);
    }

    // ----- Patient and doctor windows -----

    public function testThePatientCanCancelOrRescheduleOnlyBeforeTheStart(): void
    {
        foreach ([AppointmentStatus::PENDING, AppointmentStatus::CONFIRMED, AppointmentStatus::RESCHEDULED] as $status) {
            $a = $this->appointment($status);
            $this->assertNull(AppointmentLifecycle::patientChangeProblem($a, self::at('2026-10-14 09:59:59')));
            $this->assertSame('This consultation has started', AppointmentLifecycle::patientChangeProblem($a, self::at(self::START)));
        }
    }

    public function testACancellationRefundsInFullUnlessALateWindowIsSet(): void
    {
        $confirmed = $this->appointment(AppointmentStatus::CONFIRMED);
        $hourBefore = self::at('2026-10-14 09:00:00');
        $this->assertSame(100, AppointmentLifecycle::cancelRefundPercent($confirmed, $hourBefore, 0, 50), 'late window off (the default)');
        $this->assertSame(50, AppointmentLifecycle::cancelRefundPercent($confirmed, $hourBefore, 2, 50), 'inside the late window');
        $this->assertSame(100, AppointmentLifecycle::cancelRefundPercent($confirmed, self::at('2026-10-14 07:59:00'), 2, 50), 'before it');
        $this->assertSame(100, AppointmentLifecycle::cancelRefundPercent($this->appointment(AppointmentStatus::PENDING), $hourBefore, 2, 50), 'never confirmed: always in full');

        $moved = $this->appointment(AppointmentStatus::CONFIRMED);
        $moved->setRescheduledBy('doctor');
        $this->assertSame(100, AppointmentLifecycle::cancelRefundPercent($moved, $hourBefore, 2, 50), 'the doctor moved it: the promised full refund until the start');
        $this->assertFalse(AppointmentLifecycle::inLateWindow($moved, $hourBefore, 2));
    }

    public function testThePatientCannotDodgeTheLateShareByMovingIt(): void
    {
        $hourBefore = self::at('2026-10-14 09:00:00');
        $confirmed  = $this->appointment(AppointmentStatus::CONFIRMED);
        $this->assertSame(AppointmentLifecycle::TOO_LATE_TO_MOVE, AppointmentLifecycle::patientRescheduleProblem($confirmed, $hourBefore, 2));
        $this->assertNull(AppointmentLifecycle::patientRescheduleProblem($confirmed, $hourBefore, 0), 'late window off (the default)');
        $this->assertNull(AppointmentLifecycle::patientRescheduleProblem($confirmed, self::at('2026-10-14 07:59:00'), 2), 'before the window');
        $this->assertNull(AppointmentLifecycle::patientRescheduleProblem($this->appointment(AppointmentStatus::PENDING), $hourBefore, 2), 'a request refunds in full anyway');
        $this->assertSame('This consultation has started', AppointmentLifecycle::patientRescheduleProblem($confirmed, self::at(self::START), 0));

        $moved = $this->appointment(AppointmentStatus::CONFIRMED);
        $moved->setRescheduledBy('doctor');
        $this->assertNull(AppointmentLifecycle::patientRescheduleProblem($moved, $hourBefore, 2), 'the doctor moved it: the patient may move it again until the start');
    }

    public function testAMoveClearsTheOldSlotsFirstJoinStamps(): void
    {
        $a = $this->appointment(AppointmentStatus::PENDING);
        $a->markFirstJoined('doctor', self::at('2026-10-14 10:01:00'));
        $a->markFirstJoined('patient', self::at('2026-10-14 10:02:00'));
        $this->assertTrue(AppointmentLifecycle::bothJoined($a));
        $this->assertSame('finalising', AppointmentLifecycle::display($a, self::at('2026-10-15 09:00:00'))[0], 'both came: left for proof or the back office');

        $a->setScheduledAt(self::at(self::START));
        $this->assertNotNull($a->getDoctorFirstJoinedAt(), 'not a move: the stamps stay');

        $a->setScheduledAt(self::at('2026-10-14 16:00:00'));
        $this->assertNull($a->getDoctorFirstJoinedAt(), 'moved: the old slot\'s stamps go');
        $this->assertNull($a->getPatientFirstJoinedAt());

        // Stamps outside this slot's window (an old slot's) never count.
        $stale = $this->appointment(AppointmentStatus::PENDING);
        $stale->markFirstJoined('doctor', self::at('2026-10-13 10:01:00'));
        $stale->markFirstJoined('patient', self::at('2026-10-13 10:02:00'));
        $this->assertFalse(AppointmentLifecycle::bothJoined($stale));
        $this->assertSame('not_confirmed', AppointmentLifecycle::display($stale, self::at('2026-10-15 09:00:00'))[0]);
    }

    public function testTheDoctorCanConfirmOrMoveUntilThirtyMinutesAfterTheEnd(): void
    {
        $a = $this->appointment(AppointmentStatus::PENDING);
        $this->assertNull(AppointmentLifecycle::doctorConfirmProblem($a, self::at('2026-10-14 11:00:00')));
        $this->assertNotNull(AppointmentLifecycle::doctorConfirmProblem($a, self::at('2026-10-14 11:00:01')));
        $this->assertNotNull(AppointmentLifecycle::doctorRescheduleProblem($a, self::at('2026-10-15 09:00:00')));

        // Declining a request: until the confirm grace ends (then the cron expires it).
        $this->assertNull(AppointmentLifecycle::doctorDeclineProblem($a, self::at('2026-10-14 11:00:00')));
        $this->assertSame('This consultation has ended, so it can no longer be declined', AppointmentLifecycle::doctorDeclineProblem($a, self::at('2026-10-14 11:00:01')));
        // Cancelling a confirmed one: only before its start (a no-show can't become a full-refund cancellation).
        $confirmed = $this->appointment(AppointmentStatus::CONFIRMED);
        $this->assertNull(AppointmentLifecycle::doctorDeclineProblem($confirmed, self::at('2026-10-14 09:59:59')));
        $this->assertNotNull(AppointmentLifecycle::doctorDeclineProblem($confirmed, self::at(self::START)));
        $this->assertTrue($confirmed->toArray('doctor', self::at('2026-10-14 09:59:59'))['can_decline']);
        $this->assertFalse($confirmed->toArray('doctor', self::at('2026-10-14 10:10:00'))['can_decline']);
        $this->assertTrue($a->toArray('doctor', self::at('2026-10-14 10:59:00'))['can_decline']);
    }

    // ----- Who didn't come -----

    public function testWhoDidNotComeIsDecidedFromPresenceInTheWindow(): void
    {
        $start = self::at(self::START);
        $none  = ['first' => null, 'last' => null];
        $span  = static fn (string $from, string $to): array => ['first' => self::at($from), 'last' => self::at($to)];

        $this->assertSame('both', AppointmentLifecycle::noShowParty($none, $none, $start));
        $this->assertSame('doctor', AppointmentLifecycle::noShowParty($none, $span('2026-10-14 10:00:00', '2026-10-14 10:20:00'), $start), 'the patient waited alone');
        $this->assertSame('patient', AppointmentLifecycle::noShowParty($span('2026-10-14 09:58:00', '2026-10-14 10:25:00'), $none, $start), 'the doctor waited alone');
        $this->assertSame('doctor', AppointmentLifecycle::noShowParty(
            $span('2026-10-14 10:40:00', '2026-10-14 10:45:00'),
            $span('2026-10-14 10:02:00', '2026-10-14 10:20:00'),
            $start,
        ), 'the doctor came after the patient (on time) had given up');
        $this->assertSame('both', AppointmentLifecycle::noShowParty(
            $span('2026-10-14 10:40:00', '2026-10-14 10:45:00'),
            $span('2026-10-14 10:20:00', '2026-10-14 10:25:00'),
            $start,
        ), 'both late, never together');
        $this->assertNull(AppointmentLifecycle::noShowParty(
            $span('2026-10-14 10:00:00', '2026-10-14 10:30:00'),
            $span('2026-10-14 10:05:00', '2026-10-14 10:06:00'),
            $start,
        ), 'they overlapped without proof — left for the back office');

        // Someone seen only before the start, who left before it, didn't really come.
        $this->assertSame('doctor', AppointmentLifecycle::noShowParty(
            $span('2026-10-14 09:46:00', '2026-10-14 09:46:00'),
            $span('2026-10-14 10:05:00', '2026-10-14 10:30:00'),
            $start,
        ), 'the doctor\'s only sign was before the start; the patient came on time and stayed');
        $this->assertSame('patient', AppointmentLifecycle::noShowParty(
            $span('2026-10-14 10:05:00', '2026-10-14 10:30:00'),
            $span('2026-10-14 09:46:00', '2026-10-14 09:46:00'),
            $start,
        ), 'mirror: the doctor stayed the whole slot — no refund and no strike against them');
        // A lone late arrival never earns the fee or blames the other side.
        $this->assertSame('both', AppointmentLifecycle::noShowParty($span('2026-10-14 10:55:00', '2026-10-14 10:55:00'), $none, $start), 'the doctor opened the call page at end + 25');
        $this->assertSame('both', AppointmentLifecycle::noShowParty($none, $span('2026-10-14 10:55:00', '2026-10-14 10:55:00'), $start), 'the patient opened it at end + 25');
        $this->assertSame('doctor', AppointmentLifecycle::noShowParty($none, $span('2026-10-14 10:15:00', '2026-10-14 10:15:00'), $start), 'on time = within 15 minutes of the start');

        $a = $this->appointment();
        $this->assertTrue(AppointmentLifecycle::inPresenceWindow($a, self::at('2026-10-14 09:45:00')));
        $this->assertFalse(AppointmentLifecycle::inPresenceWindow($a, self::at('2026-10-14 09:44:59')));
        $this->assertTrue(AppointmentLifecycle::inPresenceWindow($a, self::at('2026-10-14 11:00:00')));
        $this->assertFalse(AppointmentLifecycle::inPresenceWindow($a, self::at('2026-10-14 11:00:01')));
    }

    // ----- Money -----

    public function testNoShowRefundsFollowTheParty(): void
    {
        $a = $this->appointment(AppointmentStatus::CONFIRMED, '15000.00');
        $a->addGuest('Ben', 'ben@example.test', '5000.00', 'booking', null, self::at(self::START));
        $this->assertSame('5000.00', $a->guestFeesTotal());

        $this->assertSame('15000.00', PastAppointmentCloser::noShowRefund($a, 100), 'the doctor didn\'t come: everything back');
        $this->assertSame('5000.00', PastAppointmentCloser::noShowRefund($a, 0), 'guest fees always go back');
        $this->assertSame('10000.00', PastAppointmentCloser::noShowRefund($a, 50));
        $this->assertSame('appt_noshow_refund_' . $a->getId(), PastAppointmentCloser::noShowRefundReference($a), 'one fixed reference: a re-run can\'t refund twice');

        $closer = (new \ReflectionClass(PastAppointmentCloser::class))->newInstanceWithoutConstructor();
        (new \ReflectionProperty(PastAppointmentCloser::class, 'settings'))->setValue($closer, new BookingSettings());
        $this->assertSame(100, $closer->refundPercent('doctor'));
        $this->assertSame(0, $closer->refundPercent('patient'), 'default: the doctor earns the fee');
        $this->assertSame(0, $closer->refundPercent('both'), 'default (the user\'s choice)');
    }

    public function testRefundsAreRecordedAndNeverExceedWhatWasPaid(): void
    {
        $a = $this->appointment(AppointmentStatus::MISSED, '15000.00');
        $this->assertSame('0.00', $a->refundableAmount(), 'nothing paid, nothing to refund');
        $this->assertNull($a->toArray()['refunded_amount']);

        $a->setPaymentStatus('paid');
        $this->assertSame('15000.00', $a->refundableAmount());
        $a->recordRefund('5000.00');
        $this->assertSame('5000.00', $a->getRefundedAmount());
        $this->assertSame('paid', $a->getPaymentStatus(), 'a partial refund leaves it paid');
        $this->assertSame('10000.00', $a->refundableAmount());
        $a->recordRefund('10000.00');
        $this->assertSame('refunded', $a->getPaymentStatus());
        $this->assertSame('0.00', $a->refundableAmount());

        $legacy = $this->appointment(AppointmentStatus::CANCELLED, '8000.00');
        $legacy->setPaymentStatus('refunded');
        $this->assertSame('8000.00', $legacy->getRefundedAmount(), 'a row refunded before refunded_amount existed');

        // Nothing paid → the wallet is never touched (an untouched WalletService would throw).
        $payments = new AppointmentPaymentService((new \ReflectionClass(WalletService::class))->newInstanceWithoutConstructor());
        $unpaid   = $this->appointment(AppointmentStatus::MISSED);
        $this->assertSame('0.00', $payments->refundPart($unpaid, '10000.00', 'appt_noshow_refund_x', 'x'));
        $this->assertNull($payments->refundForCancellation($unpaid));
    }

    public function testStaffRefundOptionsAreValidated(): void
    {
        $this->assertSame('full', AppointmentResolver::refundMode('cancel', null, null), 'cancelling refunds by default');
        $this->assertSame('policy', AppointmentResolver::refundMode('no_show', '', null));
        $this->assertSame('none', AppointmentResolver::refundMode('held', null, null));
        $this->assertSame('amount', AppointmentResolver::refundMode('refund', 'amount', '2500'));
        foreach ([['refund', 'none', null], ['cancel', 'policy', null], ['cancel', 'amount', '0'], ['cancel', 'amount', 'lots']] as [$action, $mode, $amount]) {
            try {
                AppointmentResolver::refundMode($action, $mode, $amount);
                $this->fail("accepted $action / $mode / " . var_export($amount, true));
            } catch (ValidationException $e) {
                $this->assertNotSame([], $e->getErrors());
            }
        }
        $this->assertNull(AppointmentResolver::reason('', false));
        try {
            AppointmentResolver::reason('  ');
            $this->fail('a resolve needs a reason');
        } catch (ValidationException $e) {
            $this->assertArrayHasKey('reason', $e->getErrors());
        }

        // An amount refund is safe to retry with the client's key (the same reference).
        $this->assertNull(AppointmentResolver::idempotencyKey(null));
        $this->assertSame('dlg-1234abcd', AppointmentResolver::idempotencyKey('dlg-1234abcd'));
        $a = $this->appointment(AppointmentStatus::MISSED, '15000.00');
        $this->assertSame('appt_staff_refund_' . $a->getId() . '_k_dlg-1234abcd', AppointmentResolver::staffRefundReference($a, '5000.00', 'dlg-1234abcd'));
        $this->assertSame('appt_staff_refund_' . $a->getId() . '_0_500000', AppointmentResolver::staffRefundReference($a, '5000.00'));
        $this->expectException(ValidationException::class);
        AppointmentResolver::idempotencyKey('short');
    }

    public function testNoShowAndLateCancelSettingsAreClamped(): void
    {
        $settings = new BookingSettings();
        foreach ([['noshow_patient_refund_pct' => 101], ['missed_after_hours' => 0], ['late_cancel_refund_pct' => -1], ['doctor_noshow_alert_threshold' => 0], ['unconfirmed_expiry_minutes_after_end' => 1441]] as $patch) {
            try {
                $settings->update($patch);
                $this->fail('accepted ' . json_encode($patch));
            } catch (ValidationException $e) {
                $this->assertArrayHasKey((string) array_key_first($patch), $e->getErrors());
            }
        }
        $this->assertSame(12, $settings->get('missed_after_hours'));
    }

    // ----- Queries -----

    public function testListsSplitAtTheEndPlusTheGrace(): void
    {
        $repo = new AppointmentRepository($this->em());
        $now  = self::at('2026-10-15 09:00:00');

        $upcoming = $repo->paginatedBuilder('00000000-0000-0000-0000-000000000001', null, 'upcoming', $now)->getQuery();
        $sql      = self::sql($upcoming);
        $this->assertStringContainsString("slot_minutes || ' MINUTE')::interval) <= ?", $sql, 'ends_at, computed per row from the doctor\'s slot');
        $this->assertStringContainsString('NOT (', $sql, 'upcoming is everything not past');
        $this->assertSame('2026-10-15 08:30:00', $upcoming->getParameter('w_grace')?->getValue()->format('Y-m-d H:i:s'), 'past = ended at least 30 minutes ago');
        $this->assertSame(['completed', 'cancelled', 'missed'], $upcoming->getParameter('w_closed')?->getValue(), 'closed ones are past whatever their time');

        $past = $repo->paginatedBuilder(null, null, 'past', $now, ['00000000-0000-0000-0000-0000000000aa'])->getQuery();
        $this->assertStringContainsString('NOT IN (?)', self::sql($past), 'a call running over stays upcoming');
        $this->assertSame(['00000000-0000-0000-0000-0000000000aa'], $past->getParameter('w_live')?->getValue());

        $attention = $repo->paginatedBuilder(null, null, 'attention', $now)->getQuery();
        $this->assertSame(['pending', 'confirmed', 'rescheduled'], $attention->getParameter('w_open')?->getValue());

        $doctor = $repo->specialistListBuilder('00000000-0000-0000-0000-000000000001', [AppointmentStatus::MISSED], null, 'past', $now)->getQuery();
        $this->assertStringContainsString('specialist_id = ?', self::sql($doctor));
        self::sql($repo->scheduleWhenQuery('00000000-0000-0000-0000-000000000001', 'upcoming', $now));

        $this->assertSame('past', AppointmentRepository::parseWhen(' PAST '));
        $this->assertNull(AppointmentRepository::parseWhen('attention', ['upcoming', 'past']), 'patients get upcoming | past only');
    }

    public function testEarningsCountCompletedAndPatientNoShowsLessRefunds(): void
    {
        $repo = new AppointmentRepository($this->em());
        $q    = $repo->earnedSumQuery('00000000-0000-0000-0000-000000000001', self::at('2026-10-01'), self::at('2026-10-15'));
        $sql  = self::sql($q);
        $this->assertStringContainsString('SUM(', $sql);
        $this->assertStringContainsString('COALESCE(', $sql, 'less what was refunded');
        $this->assertSame('missed', $q->getParameter('earn_missed')?->getValue());
        $this->assertSame('patient', $q->getParameter('earn_patient')?->getValue(), 'only a patient no-show earns the doctor the fee');

        self::sql($repo->openRequestsCountQuery('00000000-0000-0000-0000-000000000001', self::at(self::START)));
        self::sql($repo->doctorNoShowsQuery('00000000-0000-0000-0000-000000000001', self::at('2026-09-14'), self::at(self::START)));
        $stamp = self::sql($repo->firstJoinStampQuery('00000000-0000-0000-0000-000000000001', 'doctor', self::at(self::START)));
        $this->assertStringContainsString('doctor_first_joined_at IS NULL', $stamp, 'stored once: a compare-and-set on the empty column');
        $this->assertNull($repo->firstJoinStampQuery('x', 'guest', self::at(self::START)));
    }

    public function testTheCloserOnlyPicksVisitsWithoutProofAndClaimsThemOnce(): void
    {
        $em        = $this->em();
        $completer = new ConsultationCompleter($em, new AuditLogger(new AuditEventRepository($em)), new PatientNotifier(new NotificationRepository($em)), new MailService('', '', '', '', new NullLogger()));
        $closer    = (new \ReflectionClass(PastAppointmentCloser::class))->newInstanceWithoutConstructor();
        foreach (['em' => $em, 'completer' => $completer] as $prop => $value) {
            (new \ReflectionProperty(PastAppointmentCloser::class, $prop))->setValue($closer, $value);
        }

        $expired = $closer->expiredUnconfirmedQuery(self::at(self::START));
        $sql     = self::sql($expired);
        $this->assertSame(['pending', 'rescheduled'], $expired->getParameter('requests')?->getValue());
        $this->assertStringContainsString('NOT (EXISTS (SELECT', $sql, 'a visit with proof is completed by the evidence pass, never expired');
        $this->assertStringContainsString('LIMIT', $sql);

        $this->assertStringContainsString("slot_minutes || ' MINUTE')::interval) < ?", $sql, 'strictly after the doctor\'s confirm window');
        $this->assertStringContainsString('doctor_first_joined_at IS NOT NULL', $sql, 'one both sides joined is never expired');
        $this->assertStringContainsString('patient_first_joined_at IS NOT NULL', $sql);

        $missed = $closer->missedCandidatesQuery(self::at(self::START));
        $this->assertSame('confirmed', $missed->getParameter('confirmed')?->getValue());
        $this->assertStringContainsString('NOT (EXISTS (SELECT', self::sql($missed));
        $this->assertNull($missed->getParameter('afterId'), 'the first page has no cursor');

        // Every page after the first starts after the previous one's last row,
        // so rows left open never crowd newer ones out.
        foreach ([$closer->missedCandidatesQuery(self::at(self::START), [self::at('2026-10-01 09:00:00'), 'abc']), $closer->expiredUnconfirmedQuery(self::at(self::START), [self::at('2026-10-01 09:00:00'), 'abc'])] as $page) {
            $this->assertSame('abc', $page->getParameter('afterId')?->getValue());
            $this->assertSame('2026-10-01 09:00:00', $page->getParameter('afterAt')?->getValue()->format('Y-m-d H:i:s'));
            $this->assertMatchesRegularExpression('/ORDER BY a0_\.scheduled_at ASC, a0_\.id ASC/', self::sql($page));
        }

        (new \ReflectionProperty(PastAppointmentCloser::class, 'settings'))->setValue($closer, new BookingSettings());
        $this->assertSame(30, $closer->unconfirmedExpiryMinutes(), 'never inside the doctor\'s 30-minute confirm grace');

        $claim = self::sql($closer->closeClaimQuery('id', AppointmentStatus::CONFIRMED, self::at(self::START), AppointmentStatus::MISSED, 'no_show', 'patient'));
        $this->assertStringStartsWith('UPDATE appointments', $claim);
        $this->assertMatchesRegularExpression('/WHERE\s+\(?id = \?\s+AND\s+status = \?\s+AND\s+scheduled_at = \?\)?/i', $claim, 'only while still confirmed at the same time: a re-run or a racing reschedule affects 0 rows');
        foreach (['closure_reason = ?', 'no_show = ?', 'closed_at = ?'] as $set) {
            $this->assertStringContainsString($set, $claim);
        }

        foreach ($closer->presenceQueries(['00000000-0000-0000-0000-000000000001']) as $kind => $query) {
            $presence = self::sql($query);
            $this->assertStringContainsString('GROUP BY', $presence, $kind);
            $this->assertStringContainsString("(15 || ' MINUTE')::interval", $presence, "$kind: from 15 minutes before the start");
        }

        // The evidence pass now also completes unconfirmed visits (system only).
        $all = $completer->claimQuery('id', [AppointmentStatus::PENDING, AppointmentStatus::RESCHEDULED, AppointmentStatus::CONFIRMED], 'auto_completed');
        $this->assertStringContainsString('status IN (?)', self::sql($all));
        $this->assertSame('auto_completed', $all->getParameter('reason')?->getValue());
        $this->assertTrue(ConsultationCompleter::isOverdue(self::at(self::START), 30, self::at('2026-10-14 11:30:00'), 1), 'missed_after_hours sets the window');
        $this->assertFalse(ConsultationCompleter::isOverdue(self::at(self::START), 30, self::at('2026-10-14 11:29:00'), 1));
        $this->assertNotNull(ConsultationCompleter::completionProblem(AppointmentStatus::MISSED, self::at(self::START), static fn (): bool => true));
    }

    /** A run() result with every count at zero, overridden by `$over`. */
    private static function runResult(array $over = []): array
    {
        return $over + [
            'completed'       => 0,
            'completed_quiet' => 0,
            'kinds'           => [],
            'expired'         => 0,
            'missed'          => ['doctor' => 0, 'patient' => 0, 'both' => 0],
            'ambiguous'       => 0,
            'quiet'           => 0,
            'refunded'        => '0.00',
            'alerts'          => 0,
            'errors'          => 0,
            'failed_ids'      => [],
        ];
    }

    public function testTheCronSkipsVisitsThatFailedAndRetriesOnAFreshEntityManager(): void
    {
        $em        = $this->em();
        $completer = new ConsultationCompleter($em, new AuditLogger(new AuditEventRepository($em)), new PatientNotifier(new NotificationRepository($em)), new MailService('', '', '', '', new NullLogger()));
        $closer    = (new \ReflectionClass(PastAppointmentCloser::class))->newInstanceWithoutConstructor();
        foreach (['em' => $em, 'completer' => $completer] as $prop => $value) {
            (new \ReflectionProperty(PastAppointmentCloser::class, $prop))->setValue($closer, $value);
        }

        // Every pass leaves out the visits that failed earlier in the run…
        $skip = ['00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b'];
        foreach ([
            'completion' => $completer->overdueQuery(self::at(self::START), [AppointmentStatus::PENDING, AppointmentStatus::CONFIRMED], $skip),
            'expiry'     => $closer->expiredUnconfirmedQuery(self::at(self::START), null, $skip),
            'missed'     => $closer->missedCandidatesQuery(self::at(self::START), [self::at('2026-10-01 09:00:00'), 'abc'], $skip),
        ] as $pass => $query) {
            $this->assertStringContainsString('a.id NOT IN (:skip)', (string) $query->getDQL(), $pass);
            $this->assertSame($skip, $query->getParameter('skip')?->getValue(), $pass);
            $this->assertStringContainsString('NOT IN', self::sql($query), "$pass: compiles");
        }
        // …and nothing is left out on a first attempt.
        foreach ([$completer->overdueQuery(self::at(self::START)), $closer->expiredUnconfirmedQuery(self::at(self::START)), $closer->missedCandidatesQuery(self::at(self::START))] as $query) {
            $this->assertNull($query->getParameter('skip'));
        }

        // A run that leaves the entity manager closed is repeated on a fresh
        // one, skipping every visit that has failed so far; the results add up.
        $runs = [
            [self::runResult(['completed' => 2, 'kinds' => ['prescription' => 2], 'errors' => 1, 'failed_ids' => ['a']]), false],
            [self::runResult(['expired' => 1, 'refunded' => '5000.00', 'ambiguous' => 1, 'errors' => 1, 'failed_ids' => ['b']]), false],
            [self::runResult(['missed' => ['doctor' => 1, 'patient' => 0, 'both' => 0], 'refunded' => '10000.00', 'kinds' => ['clinical_note' => 1], 'completed' => 1, 'ambiguous' => 3, 'alerts' => 1]), true],
        ];
        $calls = [];
        $total = PastAppointmentCloser::runWithRetries(static function (array $skipIds, int $attempt) use (&$calls, $runs): array {
            $calls[] = [$attempt, $skipIds];

            return $runs[$attempt];
        });
        $this->assertSame([[0, []], [1, ['a']], [2, ['a', 'b']]], $calls, 'each retry skips every visit that failed before it');
        $this->assertSame(2, $total['retries']);
        $this->assertSame(3, $total['completed']);
        $this->assertSame(['clinical_note' => 1, 'prescription' => 2], $total['kinds']);
        $this->assertSame(1, $total['expired']);
        $this->assertSame(1, $total['missed']['doctor']);
        $this->assertSame('15000.00', $total['refunded']);
        $this->assertSame(3, $total['ambiguous'], 'the same open rows are seen again: the most any attempt saw, not the sum');
        $this->assertSame(2, $total['errors']);
        $this->assertSame(1, $total['alerts']);
        $this->assertSame(['a', 'b'], $total['failed_ids']);

        // At most RETRIES re-runs, however often it closes again…
        $attempts = 0;
        $stuck    = PastAppointmentCloser::runWithRetries(static function (array $skipIds, int $attempt) use (&$attempts): array {
            ++$attempts;

            return [self::runResult(['errors' => 1, 'failed_ids' => ['row-' . $attempt]]), false];
        });
        $this->assertSame(PastAppointmentCloser::RETRIES + 1, $attempts);
        $this->assertSame(PastAppointmentCloser::RETRIES, $stuck['retries']);
        $this->assertSame(['row-0', 'row-1', 'row-2', 'row-3'], $stuck['failed_ids']);

        // …and none when the entity manager survived (one bad row that didn't close it).
        $attempts = 0;
        $fine     = PastAppointmentCloser::runWithRetries(static function () use (&$attempts): array {
            ++$attempts;

            return [self::runResult(['errors' => 1, 'failed_ids' => ['x']]), true];
        });
        $this->assertSame(1, $attempts);
        $this->assertSame(0, $fine['retries']);
        $this->assertSame(['x'], $fine['failed_ids']);

        // A failing row is recorded for the retry to skip (its log line kept out of the test output).
        $out    = self::runResult();
        $failed = new \ReflectionMethod(PastAppointmentCloser::class, 'failed');
        $appt   = $this->appointment();
        $log    = (string) tempnam(sys_get_temp_dir(), 'closer');
        $was    = ini_set('error_log', $log);
        try {
            $failed->invokeArgs($closer, [new \RuntimeException('audit insert failed'), $appt, &$out]);
        } finally {
            ini_set('error_log', $was === false ? '' : $was);
        }
        $this->assertStringContainsString($appt->getId(), (string) file_get_contents($log));
        @unlink($log);
        $this->assertSame([$appt->getId()], $out['failed_ids']);
        $this->assertSame(1, $out['errors']);
    }

    // ----- What people are told -----

    public function testClosingEmailsAreGeneric(): void
    {
        foreach ([['not_confirmed', null], ['missed', 'doctor'], ['missed', 'patient'], ['missed', 'both']] as [$why, $party]) {
            $mail = EmailTemplates::appointmentClosedUnheld('Ada <b>', 'Dr Grace Bell', 'Wed 14 Oct, 10:00 AM WAT', $why, $party, '₦15,000.00', 'https://app.example/dashboard/history/abc');
            $this->assertStringContainsString('https://app.example/dashboard/history/abc', $mail['html']);
            $this->assertStringNotContainsString('Ada <b>', $mail['html'], 'escaped');
            $this->assertStringContainsString('₦15,000.00', $mail['html']);
        }
    }

    public function testTheDoctorIsToldOfARefundOnlyWhenOneWasMade(): void
    {
        $when = 'Wed 14 Oct, 10:00 AM WAT';
        $this->assertStringEndsWith('so it was cancelled and the patient refunded.', PastAppointmentCloser::doctorNotConfirmedText('Ada Obi', $when, true));
        $this->assertStringNotContainsString('refunded', PastAppointmentCloser::doctorNotConfirmedText('Ada Obi', $when, false), 'unpaid or free: nothing went back');
        $this->assertStringEndsWith('refunded in full.', PastAppointmentCloser::doctorMissedText('doctor', 'Ada Obi', $when, true));
        $this->assertStringNotContainsString('refunded', PastAppointmentCloser::doctorMissedText('doctor', 'Ada Obi', $when, false));
        $this->assertStringNotContainsString('refunded', PastAppointmentCloser::doctorMissedText('patient', 'Ada Obi', $when, true));
    }

    public function testTheDoctorMayAddAMessageForThePatientWhenDeclining(): void
    {
        // Optional, trimmed, up to 500 characters (not bytes).
        $this->assertNull(DeclineDoctorAppointmentAction::note([]));
        $this->assertNull(DeclineDoctorAppointmentAction::note(['reason' => null]));
        $this->assertNull(DeclineDoctorAppointmentAction::note(['reason' => "  \n "]), 'blank: no message');
        $this->assertSame("I'm away that day.", DeclineDoctorAppointmentAction::note(['reason' => "  I'm away that day. \n"]));
        $this->assertSame(str_repeat('é', 500), DeclineDoctorAppointmentAction::note(['reason' => str_repeat('é', 500)]));
        $this->assertSame(
            ['reason' => 'Keep the message to the patient to 500 characters or fewer'],
            DeclineDoctorAppointmentAction::note(['reason' => str_repeat('a', 501)]),
        );
        $this->assertIsArray(DeclineDoctorAppointmentAction::note(['reason' => ['not', 'text']]));

        // The endpoint refuses a long one with 422 errors.reason before it looks anything up.
        $_ENV['DB_SERVER_VERSION'] = '16';
        DoctrineEntityManagerFactory::reset();
        $builder = new ContainerBuilder();
        $builder->addDefinitions(__DIR__ . '/../../config/container.php');
        $action  = $builder->build()->get(DeclineDoctorAppointmentAction::class);
        $request = (new ServerRequestFactory())
            ->createServerRequest('POST', '/api/doctor/appointments/00000000-0000-0000-0000-000000000001/decline')
            ->withParsedBody(['reason' => str_repeat('a', 501)]);
        $res  = $action($request, (new ResponseFactory())->createResponse(), ['id' => '00000000-0000-0000-0000-000000000001']);
        $body = json_decode((string) $res->getBody(), true);
        $this->assertSame(422, $res->getStatusCode());
        $this->assertSame('Keep the message to the patient to 500 characters or fewer', $body['errors']['reason'] ?? null);

        // The patient's email shows it as written — escaped, line breaks kept — and only when there is one.
        $appt = $this->appointment(AppointmentStatus::CANCELLED)->toArray();
        $with = EmailTemplates::appointmentStatusUpdate($appt, 'Ada', 'https://app.example', "Sorry <b>Ada</b>,\nI'm away that day.");
        $this->assertStringContainsString('Message from your doctor', $with['html']);
        $this->assertStringContainsString('Sorry &lt;b&gt;Ada&lt;/b&gt;,<br>', $with['html']);
        $this->assertStringNotContainsString('<b>Ada', $with['html']);
        foreach ([null, '   '] as $none) {
            $this->assertStringNotContainsString('Message from your doctor', EmailTemplates::appointmentStatusUpdate($appt, 'Ada', 'https://app.example', $none)['html']);
        }

        // Documented: an optional body with `reason` (≤ 500).
        $spec = (require __DIR__ . '/../../config/openapi.php')['paths']['/api/doctor/appointments/{id}/decline']['post'];
        $this->assertFalse($spec['requestBody']['required']);
        $this->assertSame(500, $spec['requestBody']['content']['application/json']['schema']['properties']['reason']['maxLength']);
    }

    public function testTheQuietBacklogCanRefundWithoutAReceipt(): void
    {
        foreach ([[WalletService::class, 'credit'], [AppointmentPaymentService::class, 'refundForCancellation'], [AppointmentPaymentService::class, 'refundPart']] as [$class, $method]) {
            $params = (new \ReflectionMethod($class, $method))->getParameters();
            $last   = $params[count($params) - 1];
            $this->assertSame('sendReceipt', $last->getName(), "$class::$method");
            $this->assertTrue($last->getDefaultValue(), "$class::$method sends a receipt by default");
        }
    }

    public function testThePatientListRefusesAnUnknownTimeSplit(): void
    {
        $action = new ListMyAppointmentsAction(new AppointmentRepository($this->em()), new CallPresence(new \Predis\Client()), new BookingSettings());
        foreach (['attention', 'later'] as $when) {
            $request = (new ServerRequestFactory())
                ->createServerRequest('GET', '/api/portal/appointments')
                ->withAttribute('customer_id', 'p1')
                ->withQueryParams(['when' => $when]);
            $res  = $action($request, (new ResponseFactory())->createResponse());
            $body = json_decode((string) $res->getBody(), true);
            $this->assertSame(422, $res->getStatusCode(), $when);
            $this->assertSame('Use upcoming or past', $body['errors']['when']);
        }
    }

    public function testAClosedConsultationHasNoCallToken(): void
    {
        $now = self::at('2026-10-15 09:00:00');
        foreach ([[AppointmentStatus::COMPLETED, 'ended'], [AppointmentStatus::MISSED, 'ended'], [AppointmentStatus::CANCELLED, 'cancelled']] as [$status, $code]) {
            $problem = CallAccess::problem($this->appointment($status), ['role' => 'patient'], null, $now);
            $this->assertSame(410, $problem[0] ?? null, $status->value);
            $this->assertSame($code, $problem[2]['code']);
        }
        $this->assertNull(CallAccess::problem($this->appointment(AppointmentStatus::CONFIRMED), ['role' => 'patient'], null, $now));
    }

    // ----- Wiring -----

    public function testTheResolveEndpointIsRoutedAndTheServicesResolve(): void
    {
        $_ENV['DB_SERVER_VERSION'] = '16';
        DoctrineEntityManagerFactory::reset();
        $builder = new ContainerBuilder();
        $builder->addDefinitions(__DIR__ . '/../../config/container.php');
        $container = $builder->build();
        foreach ([
            PastAppointmentCloser::class,
            AppointmentResolver::class,
            ResolveAppointmentAction::class,
            // Autowired with their new dependencies (presence, settings).
            GetMyAppointmentAction::class,
            GetDoctorAppointmentAction::class,
            ListMyAppointmentsAction::class,
            ReschedulePortalAppointmentAction::class,
            DeclineDoctorAppointmentAction::class,
            ConfirmDoctorAppointmentAction::class,
            GetCallTokenAction::class,
        ] as $id) {
            $this->assertIsObject($container->get($id));
        }

        AppFactory::setContainer($container);
        $app = AppFactory::create();
        (require __DIR__ . '/../../config/routes.php')($app);
        $result = $app->getRouteResolver()->computeRoutingResults('/api/appointments/00000000-0000-0000-0000-000000000001/resolve', 'POST');
        $this->assertSame(RoutingResults::FOUND, $result->getRouteStatus());
    }
}
