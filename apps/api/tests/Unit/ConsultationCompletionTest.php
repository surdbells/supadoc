<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Action\Doctor\CompleteDoctorAppointmentAction;
use App\Domain\Entity\Appointment;
use App\Domain\Entity\Notification;
use App\Domain\Entity\Patient;
use App\Domain\Entity\Specialist;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Repository\AuditEventRepository;
use App\Domain\Repository\NotificationRepository;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Email\MailService;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use App\Infrastructure\Service\AuditLogger;
use App\Infrastructure\Service\ConsultationCompleter;
use App\Infrastructure\Service\PatientNotifier;
use DateTimeImmutable;
use DI\ContainerBuilder;
use Doctrine\ORM\EntityManagerInterface;
use PHPUnit\Framework\TestCase;
use Psr\Log\AbstractLogger;
use Psr\Log\NullLogger;
use Slim\Factory\AppFactory;
use Slim\Routing\RoutingResults;

/**
 * Ending a consultation (POST /api/doctor/appointments/{id}/complete and the
 * cron's auto-complete): only a confirmed visit that has started can be
 * completed, it is completed once however often it is asked (compare-and-set),
 * the cron only closes visits with proof they happened, and what the patient
 * is told stays generic.
 */
final class ConsultationCompletionTest extends TestCase
{
    private function em(): EntityManagerInterface
    {
        $_ENV['DB_SERVER_VERSION'] = '16';
        DoctrineEntityManagerFactory::reset();

        return DoctrineEntityManagerFactory::create();
    }

    private function completer(): ConsultationCompleter
    {
        $em = $this->em();

        return new ConsultationCompleter(
            $em,
            new AuditLogger(new AuditEventRepository($em)),
            new PatientNotifier(new NotificationRepository($em)),
            new MailService('', '', '', '', new NullLogger()),
        );
    }

    private static function neverAsked(): callable
    {
        return static function (): bool {
            self::fail('presence must not be checked once the consultation time has come');
        };
    }

    // ----- The doctor's rules -----

    public function testOnlyAConfirmedConsultationCanBeCompleted(): void
    {
        $past = new DateTimeImmutable('-1 hour');
        $this->assertNull(ConsultationCompleter::completionProblem(AppointmentStatus::CONFIRMED, $past, self::neverAsked()));

        foreach ([AppointmentStatus::PENDING, AppointmentStatus::RESCHEDULED] as $status) {
            $this->assertSame(
                'Confirm this appointment before marking the consultation completed',
                ConsultationCompleter::completionProblem($status, $past, static fn (): bool => true),
                $status->value . ' visits are not confirmed yet',
            );
        }
        $this->assertSame(
            "This appointment was cancelled, so it can't be marked completed",
            ConsultationCompleter::completionProblem(AppointmentStatus::CANCELLED, $past, static fn (): bool => true),
        );
        $this->assertNotNull(
            ConsultationCompleter::completionProblem(AppointmentStatus::COMPLETED, $past, static fn (): bool => true),
            'a completed visit is never completed again (the action answers it as an idempotent 200 first)',
        );
    }

    public function testAConsultationThatHasNotStartedCannotBeCompleted(): void
    {
        $now   = new DateTimeImmutable('2026-10-14 10:00:00');
        $later = new DateTimeImmutable('2026-10-14 10:30:00');

        $this->assertSame(
            "This consultation hasn't started yet",
            ConsultationCompleter::completionProblem(AppointmentStatus::CONFIRMED, $later, static fn (): bool => false, $now),
        );
        $this->assertNull(
            ConsultationCompleter::completionProblem(AppointmentStatus::CONFIRMED, $later, static fn (): bool => true, $now),
            'an early start counts once the doctor is in the call',
        );
        $this->assertNull(
            ConsultationCompleter::completionProblem(AppointmentStatus::CONFIRMED, $now, self::neverAsked(), $now),
            'the scheduled minute itself counts as started',
        );
    }

    public function testCompletingIsACompareAndSetSoItHappensOnce(): void
    {
        $sql = $this->completer()->claimQuery('00000000-0000-0000-0000-000000000001')->getSQL();
        $sql = is_array($sql) ? implode(';', $sql) : $sql;

        $this->assertStringStartsWith('UPDATE appointments', $sql);
        $this->assertMatchesRegularExpression(
            '/WHERE\s+\(?id = \?\s+AND\s+status = \?\)?/i',
            $sql,
            'only a row that is still confirmed is claimed — a repeat (or a racing cron) affects 0 rows',
        );
        $this->assertStringContainsString('updated_at = ?', $sql);

        $type = (new \ReflectionMethod(ConsultationCompleter::class, 'complete'))->getReturnType();
        $this->assertSame('bool', (string) $type, 'callers learn whether THIS call completed it (and so sent the notice)');
    }

    // ----- The cron's auto-complete -----

    public function testOverdueIsTwelveHoursAfterTheSlotEnds(): void
    {
        $start = new DateTimeImmutable('2026-10-13 09:00:00');

        $this->assertFalse(ConsultationCompleter::isOverdue($start, 30, new DateTimeImmutable('2026-10-13 21:29:00')));
        $this->assertTrue(ConsultationCompleter::isOverdue($start, 30, new DateTimeImmutable('2026-10-13 21:30:00')));
        $this->assertFalse(ConsultationCompleter::isOverdue($start, 60, new DateTimeImmutable('2026-10-13 21:30:00')), 'a longer slot ends later');
        $this->assertTrue(ConsultationCompleter::isOverdue($start, 0, new DateTimeImmutable('2026-10-13 21:15:00')), 'never shorter than the shortest slot');
    }

    public function testOnlyConfirmedVisitsWithProofAreCandidates(): void
    {
        $query = $this->completer()->overdueQuery(new DateTimeImmutable('2026-10-14 00:00:00'));
        $sql   = $query->getSQL();
        $sql   = is_array($sql) ? implode(';', $sql) : $sql;

        $this->assertStringContainsString('deleted_at IS NULL', $sql);
        $this->assertStringContainsString('scheduled_at < ?', $sql);
        foreach (['clinical_notes', 'prescriptions', 'medical_certificates', 'referrals', 'lab_orders', 'transcript_segments'] as $table) {
            $this->assertMatchesRegularExpression(
                "/EXISTS \\(SELECT \\w+\\.appointment_id FROM $table \\w+ WHERE \\w+\\.appointment_id = a0_\\.id/",
                $sql,
                "$table counts as proof the consultation happened — looked up per candidate on its appointment_id index",
            );
        }
        $this->assertStringNotContainsString(' IN (SELECT', $sql, 'no uncorrelated subquery that reads a whole table each run');
        $this->assertSame('confirmed', $query->getParameter('confirmed')?->getValue());
        $this->assertStringContainsString('LIMIT', $sql);
    }

    public function testOnlyTheDoctorsPresenceCountsAsProof(): void
    {
        $query = $this->completer()->overdueQuery(new DateTimeImmutable('2026-10-14 00:00:00'));
        $dql   = (string) $query->getDQL();
        $sql   = $query->getSQL();
        $sql   = is_array($sql) ? implode(';', $sql) : $sql;

        // A patient alone with captions on (the doctor never came) writes
        // patient-role transcript segments — they must not close the visit.
        $this->assertStringContainsString('ev_t.role = :ev_doctor', $dql, "only the doctor's words on the transcript count");
        $this->assertSame('doctor', $query->getParameter('ev_doctor')?->getValue());

        // Call samples count only when both sides were connected at the same
        // time — a patient who waited and left, then a doctor who joined later,
        // is a no-show, not a consultation.
        $this->assertSame(2, substr_count($sql, 'session_metrics'), "a doctor's sample, then a patient's one near it");
        $this->assertStringContainsString('ev_md.role = :ev_doctor', $dql);
        $this->assertStringContainsString('ev_mp.role = :ev_patient', $dql);
        $this->assertSame('patient', $query->getParameter('ev_patient')?->getValue());
        $this->assertMatchesRegularExpression(
            "/(\\w+)\\.appointment_id = (\\w+)\\.appointment_id AND \\1\\.role = \\? AND \\1\\.created_at BETWEEN \\(\\2\\.created_at - \\(60 \\|\\| ' SECOND'\\)::interval\\) AND \\(\\2\\.created_at \\+ \\(60 \\|\\| ' SECOND'\\)::interval\\)/",
            $sql,
            "the patient's sample is within a minute of the doctor's",
        );
    }

    public function testEvidenceLookupsCompile(): void
    {
        $queries = $this->completer()->evidenceQueries(['00000000-0000-0000-0000-000000000001']);

        $this->assertSame(['clinical_note', 'prescription', 'certificate', 'referral', 'lab_order', 'transcript', 'session'], array_keys($queries));
        foreach ($queries as $kind => $query) {
            $sql = $query->getSQL();
            $sql = is_array($sql) ? implode(';', $sql) : $sql;
            $this->assertStringStartsWith('SELECT DISTINCT', $sql, "$kind: one row per appointment, not per sample");
            $this->assertStringContainsString('appointment_id IN (?)', $sql, $kind);
        }
        $this->assertStringContainsString('ev_t.role = :ev_doctor', (string) $queries['transcript']->getDQL());
        $this->assertSame('doctor', $queries['transcript']->getParameter('ev_doctor')?->getValue());
        $this->assertSame('patient', $queries['session']->getParameter('ev_patient')?->getValue());
    }

    /**
     * complete() against an EntityManager double: `$transaction` plays the
     * claim + audit transaction (its result, or a throw as when the audit
     * insert fails and it rolls back). `$events` records, in order, the
     * transaction and every entity written or email sent outside it.
     *
     * @param callable(): bool $transaction
     * @param list<string> $events
     */
    private function completeWith(callable $transaction, array &$events): bool
    {
        $em = $this->createMock(EntityManagerInterface::class);
        $em->expects($this->once())->method('wrapInTransaction')->willReturnCallback(
            static function () use ($transaction, &$events): bool {
                $events[] = 'transaction';

                return $transaction();
            },
        );
        $em->method('persist')->willReturnCallback(static function (object $entity) use (&$events): void {
            $events[] = $entity::class;
        });
        // MailService logs every send it is asked for (unconfigured here, so it skips it).
        $mailLog = new class (static function () use (&$events): void {
            $events[] = 'email';
        }) extends AbstractLogger {
            public function __construct(private readonly \Closure $sent)
            {
            }

            public function log($level, string|\Stringable $message, array $context = []): void
            {
                ($this->sent)();
            }
        };
        $completer = new ConsultationCompleter(
            $em,
            new AuditLogger(new AuditEventRepository($em)),
            new PatientNotifier(new NotificationRepository($em)),
            new MailService('', '', '', '', $mailLog),
        );
        $patient = new Patient('ada@example.test', 'Ada', 'Obi');
        $patient->initTimestamps(); // Doctrine fires these on persist; toArray() reads createdAt.
        $appointment = new Appointment($patient, new Specialist('Dr. Grace Bell', 'General Practice'), new DateTimeImmutable('-1 hour'));
        $appointment->initTimestamps();

        return $completer->complete($appointment, 'Dr. Grace Bell', 'doctor', 'appointment.completed');
    }

    public function testThePatientIsToldOnlyAfterTheCompletionCommits(): void
    {
        $events = [];
        $this->assertTrue($this->completeWith(static fn (): bool => true, $events));

        // The audit event is written inside the transaction (with the status
        // change), never after it; the notice and the email follow the commit.
        $this->assertSame(['transaction', Notification::class, 'email'], $events);
    }

    public function testAFailedAuditWriteLeavesNothingHalfDone(): void
    {
        $events = [];
        try {
            $this->completeWith(static function (): bool {
                throw new \RuntimeException('audit insert failed');
            }, $events);
            $this->fail('the failure surfaces, so the request (or cron run) is retried');
        } catch (\RuntimeException $e) {
            $this->assertSame('audit insert failed', $e->getMessage());
        }

        // Rolled back with the status change: the visit is still confirmed, so a
        // retry completes it — and the patient was told nothing in the meantime.
        $this->assertSame(['transaction'], $events);
    }

    public function testLosingTheRaceSendsNothing(): void
    {
        $events = [];
        $this->assertFalse($this->completeWith(static fn (): bool => false, $events));
        $this->assertSame(['transaction'], $events, 'someone else completed (and announced) it first');
    }

    // ----- What the patient is told -----

    public function testTheEmailIsGenericAndOpensTheHistory(): void
    {
        $mail = EmailTemplates::consultationCompleted([
            'id'           => 'abc-123',
            'specialist'   => ['name' => 'Dr Grace Bell', 'specialty' => 'General Practice'],
            'scheduled_at' => '2026-10-14T09:00:00+00:00',
            'status'       => 'completed',
            'status_label' => 'Completed',
            'notes'        => 'Chest pain and amoxicillin allergy',
        ], 'Ada <b>', 'https://app.example');

        $this->assertStringContainsString('https://app.example/dashboard/history/abc-123', $mail['html']);
        $this->assertStringNotContainsString('Chest pain', $mail['html'], 'never the reason for the visit');
        $this->assertStringNotContainsString('amoxicillin', $mail['html'] . $mail['subject']);
        $this->assertStringNotContainsString('Ada <b>', $mail['html'], 'the name is escaped');
    }

    // ----- Wiring -----

    public function testTheEndpointIsRoutedAndResolves(): void
    {
        $_ENV['DB_SERVER_VERSION'] = '16';
        DoctrineEntityManagerFactory::reset();
        $builder = new ContainerBuilder();
        $builder->addDefinitions(__DIR__ . '/../../config/container.php');
        $container = $builder->build();
        $this->assertIsObject($container->get(CompleteDoctorAppointmentAction::class));
        $this->assertIsObject($container->get(ConsultationCompleter::class));

        AppFactory::setContainer($container);
        $app = AppFactory::create();
        (require __DIR__ . '/../../config/routes.php')($app);
        $result = $app->getRouteResolver()->computeRoutingResults('/api/doctor/appointments/00000000-0000-0000-0000-000000000001/complete', 'POST');
        $this->assertSame(RoutingResults::FOUND, $result->getRouteStatus());
    }
}
