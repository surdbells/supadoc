<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Action\Admin\AdminDashboardAction;
use App\Domain\Dashboard\AuditEventDescriber;
use App\Domain\Dashboard\DashboardPeriod;
use App\Domain\Repository\AdminDashboardRepository;
use App\Domain\Repository\AppointmentRepository;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use App\Infrastructure\Service\AdminDashboardService;
use DateTimeImmutable;
use DateTimeZone;
use DI\ContainerBuilder;
use Doctrine\ORM\EntityManagerInterface;
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * The back-office dashboard (GET /api/admin/dashboard), offline: every
 * aggregate query compiles to SQL, who sees which part, the period windows on
 * the viewer's calendar, the change maths and the activity wording. The
 * Postgres-backed figures are covered by tests/Integration/Dashboard.
 */
final class AdminDashboardTest extends TestCase
{
    private const ADMIN = ['appointments.view', 'appointments.create', 'appointments.book', 'appointments.update', 'settings.manage', 'specialists.manage', 'monitoring.view', 'staff.manage', 'payouts.manage', 'support.manage'];

    private function em(): EntityManagerInterface
    {
        $_ENV['DB_SERVER_VERSION'] = '16';
        DoctrineEntityManagerFactory::reset();

        return DoctrineEntityManagerFactory::create();
    }

    public function testEveryDashboardQueryCompilesToSql(): void
    {
        $repo   = new AdminDashboardRepository($this->em());
        $p      = DashboardPeriod::of('7d', new DateTimeZone('Africa/Lagos'), new DateTimeImmutable('2026-10-16 14:30:00', new DateTimeZone('Africa/Lagos')));
        $w      = [$p->from, $p->now, $p->previousFrom, $p->previousTo];
        $bounds = $p->trendBounds();
        $soon   = $p->now->modify('+2 hours');

        $queries = [
            'appointments'      => $repo->bookingTotalsQuery(...$w),
            'closed_at'         => $repo->closedTotalsQuery(...$w),
            'patients'          => $repo->newPatientsQuery(...$w),
            'specialists'       => $repo->activeDoctorsQuery(),
            'wallet_transactions' => $repo->walletTotalsQuery(...[...$w, 'NGN']),
            'reviews'           => $repo->ratingsQuery(...$w),
            'refunded_amount'   => $repo->dailyBookingsQuery($bounds),
            'COALESCE'          => $repo->dailyCompletedQuery($bounds),
            'GROUP BY'          => $repo->statusBreakdownQuery($p->from, $p->tomorrowStart),
            'specialty'         => $repo->topSpecialtiesQuery($p->from, $p->tomorrowStart),
            'no_show'           => $repo->topDoctorsQuery($p->from, $p->tomorrowStart),
            'scheduled_at'      => $repo->liveCandidatesQuery($p->now),
            'ORDER BY'          => $repo->startingSoonQuery($p->now, $soon),
            'COUNT('            => $repo->startingSoonCountQuery($p->now, $soon),
            'payouts'           => $repo->pendingPayoutsQuery('NGN'),
            'status'            => $repo->heldTopupsQuery('NGN'),
            'payment_intents'   => $repo->cardPaymentsInReviewQuery('NGN'),
            'audit_events'      => $repo->recentActivityQuery(8),
        ];
        foreach ($queries as $needle => $query) {
            $this->assertStringContainsStringIgnoringCase($needle, $query->getSQL(), "query expected to mention $needle");
        }

        // "Starting soon" leaves out bookings already in a call (shown as in
        // progress), list and count alike — and only when there are any.
        $live = ['00000000-0000-0000-0000-000000000000'];
        $this->assertStringNotContainsStringIgnoringCase('NOT IN', $repo->startingSoonQuery($p->now, $soon)->getSQL());
        $this->assertStringContainsStringIgnoringCase('NOT IN', $repo->startingSoonQuery($p->now, $soon, $live)->getSQL());
        $this->assertStringContainsStringIgnoringCase('NOT IN', $repo->startingSoonCountQuery($p->now, $soon, $live)->getSQL());
        $this->assertSame($live, $repo->startingSoonCountQuery($p->now, $soon, [...$live, ...$live, ''])->getParameter('live')?->getValue());

        // Live candidates come newest first, so stale never-closed bookings
        // can't push a call running now past the limit.
        $this->assertMatchesRegularExpression('/ORDER BY \S+ DESC, \S+ DESC/i', $repo->liveCandidatesQuery($p->now)->getSQL());

        // One bucket pair per trend day.
        $this->assertSame(DashboardPeriod::TREND_DAYS * 2, substr_count($repo->dailyBookingsQuery($bounds)->getDQL(), ' AS '));

        // The "needs attention" count reuses the appointment list's filter (the
        // dashboard passes no live ids, like the list it links to; the builder
        // still supports them).
        $sql = (new AppointmentRepository($this->em()))
            ->paginatedBuilder(null, null, 'attention', new DateTimeImmutable(), ['00000000-0000-0000-0000-000000000000'])
            ->select('COUNT(e.id)')
            ->getQuery()
            ->getSQL();
        $this->assertStringContainsStringIgnoringCase('COUNT(', $sql);
        $this->assertStringContainsStringIgnoringCase('NOT IN', $sql);
    }

    public function testWindowsAreBoundInTheProcessZone(): void
    {
        $repo  = new AdminDashboardRepository($this->em());
        $lagos = new DateTimeZone('Africa/Lagos'); // UTC+1, no DST
        $p     = DashboardPeriod::of('today', $lagos, new DateTimeImmutable('2026-10-16 00:30:00', $lagos));
        $param = $repo->newPatientsQuery($p->from, $p->now, $p->previousFrom, $p->previousTo)->getParameter('cf')?->getValue();

        $this->assertInstanceOf(DateTimeImmutable::class, $param);
        $this->assertSame(date_default_timezone_get(), $param->getTimezone()->getName());
        $this->assertSame($p->from->getTimestamp(), $param->getTimestamp());
    }

    public function testPeriodWindowsFollowTheViewersCalendar(): void
    {
        $zone = new DateTimeZone('Africa/Lagos');
        $now  = new DateTimeImmutable('2026-10-16 14:30:00', $zone);

        $today = DashboardPeriod::of('today', $zone, $now);
        $this->assertSame('2026-10-16T00:00:00+01:00', $today->from->format(DATE_ATOM));
        $this->assertSame('2026-10-15T00:00:00+01:00', $today->previousFrom->format(DATE_ATOM));
        $this->assertSame('2026-10-15T14:30:00+01:00', $today->previousTo->format(DATE_ATOM));
        $this->assertSame('2026-10-17T00:00:00+01:00', $today->tomorrowStart->format(DATE_ATOM));

        // Query ends move up to the next whole second (timestamps are stored to the second).
        $ends = DashboardPeriod::of('today', $zone, new DateTimeImmutable('2026-10-16 14:30:00.250', $zone))->kpiWindows();
        $this->assertSame('2026-10-16T00:00:00+01:00', $ends[0]->format(DATE_ATOM));
        $this->assertSame('2026-10-16 14:30:01.000000', $ends[1]->format('Y-m-d H:i:s.u'));
        $this->assertSame('2026-10-15T00:00:00+01:00', $ends[2]->format(DATE_ATOM));
        $this->assertSame('2026-10-15 14:30:01.000000', $ends[3]->format('Y-m-d H:i:s.u'));

        $week = DashboardPeriod::of('7d', $zone, $now);
        $this->assertSame('2026-10-10T00:00:00+01:00', $week->from->format(DATE_ATOM));
        $this->assertSame('2026-10-03T00:00:00+01:00', $week->previousFrom->format(DATE_ATOM));
        $this->assertSame('2026-10-09T14:30:00+01:00', $week->previousTo->format(DATE_ATOM));

        $month = DashboardPeriod::of('30d', $zone, $now);
        $this->assertSame('2026-09-17T00:00:00+01:00', $month->from->format(DATE_ATOM));
        $this->assertSame(30, $month->days());

        $bounds = $today->trendBounds();
        $this->assertCount(DashboardPeriod::TREND_DAYS + 1, $bounds);
        $this->assertSame('2026-09-17', $bounds[0]->format('Y-m-d'));
        $this->assertSame('2026-10-17T00:00:00+01:00', $bounds[DashboardPeriod::TREND_DAYS]->format(DATE_ATOM));

        // An unknown period falls back to today; parse() is strict.
        $this->assertSame('today', DashboardPeriod::of('bogus', $zone, $now)->period);
        $this->assertSame('7d', DashboardPeriod::parse(' 7D '));
        $this->assertNull(DashboardPeriod::parse('90d'));
    }

    public function testDaysStartAtLocalMidnightAcrossDaylightSaving(): void
    {
        $ny     = new DateTimeZone('America/New_York');
        $p      = DashboardPeriod::of('30d', $ny, new DateTimeImmutable('2026-11-10 09:00:00', $ny));
        $bounds = $p->trendBounds();

        foreach ($bounds as $b) {
            $this->assertSame('00:00', $b->format('H:i'));
        }
        // 2026-11-01 is 25 hours long in New York.
        $i = array_search('2026-11-01', array_map(static fn (DateTimeImmutable $d): string => $d->format('Y-m-d'), $bounds), true);
        $this->assertIsInt($i);
        $this->assertSame(25 * 3600, $bounds[$i + 1]->getTimestamp() - $bounds[$i]->getTimestamp());
    }

    public function testEachPartNeedsThePermissionItsPageNeeds(): void
    {
        $all = array_keys(AdminDashboardService::PARTS);

        $this->assertSame($all, AdminDashboardService::grantedParts(['super_admin'], []));
        $this->assertSame($all, AdminDashboardService::grantedParts(['admin'], self::ADMIN));

        // A doctor login carries appointments.view — but gets nothing here.
        $this->assertSame([], AdminDashboardService::grantedParts(['doctor'], ['appointments.view']));
        $this->assertSame([], AdminDashboardService::grantedParts([], []));

        // Read-only staff: only the "past consultations still open" queue.
        $this->assertSame(['attention.appointments'], AdminDashboardService::grantedParts(['staff'], ['appointments.view']));

        $this->assertSame(
            ['attention.support', 'attention.payments'],
            AdminDashboardService::grantedParts(['staff'], ['support.manage']),
        );
        $this->assertSame(
            ['kpis.money', 'attention.payouts', 'attention.payments', 'trends.revenue'],
            AdminDashboardService::grantedParts(['staff'], ['payouts.manage']),
        );
        $this->assertSame(
            ['kpis.doctors', 'attention.doctors', 'breakdowns.doctors'],
            AdminDashboardService::grantedParts(['staff'], ['specialists.manage']),
        );
        $this->assertSame(
            ['kpis.activity', 'kpis.money', 'kpis.doctors', 'live', 'trends.activity', 'trends.revenue', 'breakdowns.status', 'breakdowns.specialties', 'breakdowns.activity'],
            AdminDashboardService::grantedParts(['staff'], ['monitoring.view']),
        );
    }

    public function testChangeIsAgainstThePreviousPeriod(): void
    {
        $this->assertSame(50.0, AdminDashboardService::changePct(15, 10));
        $this->assertSame(-25.0, AdminDashboardService::changePct('750.00', '1000.00'));
        $this->assertNull(AdminDashboardService::changePct(5, 0));       // nothing to compare with
        $this->assertNull(AdminDashboardService::changePct(5, null));    // a snapshot
        $this->assertNull(AdminDashboardService::changePct(null, 4.5));  // no reviews now

        $this->assertSame('up', AdminDashboardService::trend(5, 0));
        $this->assertSame('down', AdminDashboardService::trend('10.00', '12.50'));
        $this->assertSame('flat', AdminDashboardService::trend(4.5, 4.5));
        $this->assertNull(AdminDashboardService::trend(3, null));

        $tile = AdminDashboardService::tile('refunds', 'Refunds issued', 'money', '200.00', '100.00', false, 2, 1);
        $this->assertSame(
            ['key', 'label', 'format', 'value', 'previous', 'change_pct', 'trend', 'higher_is_better', 'count', 'previous_count', 'breakdown'],
            array_keys($tile),
        );
        $this->assertSame(100.0, $tile['change_pct']);
        $this->assertFalse($tile['higher_is_better']);
    }

    public function testActivityReadsInPlainWords(): void
    {
        $this->assertSame('Doctor approved', AuditEventDescriber::label('specialist.approved'));
        $this->assertSame('Doctor approved · Dr. Grace Bell', AuditEventDescriber::summary('specialist.approved', ['doctor' => 'Dr. Grace Bell']));
        $this->assertSame('Brand new thing happened', AuditEventDescriber::label('brand_new.thing_happened'));
        $this->assertSame('Wallet top-up credited', AuditEventDescriber::summary('wallet.topup_credited', ['reference' => 'x']));

        // Reference-list changes name their list and item (as ReferenceDataService records them).
        $this->assertSame('Specialty list item added · Cardiology', AuditEventDescriber::summary('reference.created', ['category' => 'specialty', 'label' => 'Cardiology', 'code' => 'cardiology']));
        $this->assertSame('Specialty list item changed · Cardiology', AuditEventDescriber::summary('reference.updated', ['category' => 'specialty', 'label' => 'Cardiology', 'before' => ['active' => true], 'after' => ['active' => false]]));
        $this->assertSame('Specialty list item changed · Cardiology → Cardiovascular Medicine', AuditEventDescriber::summary('reference.updated', ['category' => 'specialty', 'label' => 'Cardiovascular Medicine', 'before' => ['label' => 'Cardiology'], 'after' => ['label' => 'Cardiovascular Medicine']]));
        $this->assertSame('Specialty list item deleted · Urology', AuditEventDescriber::summary('reference.deleted', ['category' => 'specialty', 'label' => 'Urology']));
        $this->assertSame('Specialty list reordered', AuditEventDescriber::summary('reference.reordered', ['category' => 'specialty', 'before' => ['A', 'B'], 'after' => ['B', 'A']]));
        $this->assertSame('Specialty list reordered', AuditEventDescriber::label('reference.reordered', ['category' => 'specialty']));
        $this->assertSame('Reference list item added', AuditEventDescriber::label('reference.created', ['category' => 'not-a-list']));
        // …and a back-office photo change says so.
        $this->assertSame('Doctor photo updated · Dr. Grace Bell', AuditEventDescriber::summary('specialist.updated', ['via' => 'photo_upload', 'doctor' => 'Dr. Grace Bell']));
        $this->assertSame('Doctor photo removed', AuditEventDescriber::label('specialist.updated', ['via' => 'photo_remove']));
        $this->assertSame('Doctor profile updated', AuditEventDescriber::label('specialist.updated', ['via' => 'something-else']));

        $id = '0a6c2b8e-4c1f-4c55-9d8b-2f0e8f1b7a10';
        $this->assertSame('/specialists/' . $id, AuditEventDescriber::link('specialist', $id, null)['path'] ?? null);
        $this->assertSame('/appointments/' . $id, AuditEventDescriber::link('prescription', 'rx-1', $id)['path'] ?? null);
        $this->assertNull(AuditEventDescriber::link('wallet_transaction', 'REF-1', null));
        $this->assertNull(AuditEventDescriber::link('specialist', '../../etc', null));

        foreach (AdminDashboardRepository::QUIET_AUDIT_ACTIONS as $action) {
            $this->assertMatchesRegularExpression('/^[a-z_]+\.[a-z_]+$/', $action);
        }
    }

    public function testDocumentSharingEventsReadInPlainWordsAndTheRoutineOnesStayQuiet(): void
    {
        $labels = [
            'document_access.granted'           => 'Documents shared with a doctor',
            'document_access.changed'           => 'Document sharing changed',
            'document_access.extended'          => 'Document sharing period changed',
            'document_access.revoked'           => 'Document sharing stopped',
            'document_access.restored'          => 'Document sharing restored',
            'document_access.document_removed'  => "Doctor's access to a document removed",
            'document_access.document_shown'    => 'Document shown to a doctor again',
            'document_access.expired'           => 'Document sharing ended',
            'document_access.requested'         => 'Doctor asked for document access',
            'document_access.request_approved'  => 'Document access request approved',
            'document_access.request_declined'  => 'Document access request declined',
            'document_access.request_cancelled' => 'Document access request withdrawn',
            'document_access.request_expired'   => 'Document access request closed',
            'document_access.requests_allowed'  => 'Patient allowed document requests again',
            'document.viewed'                   => 'Patient document opened by doctor',
            'document.list_viewed'              => 'Patient documents list opened by doctor',
        ];
        foreach ($labels as $action => $label) {
            $this->assertSame($label, AuditEventDescriber::label($action), $action);
        }
        $this->assertSame('Documents shared with a doctor · Dr. Grace Bell', AuditEventDescriber::summary('document_access.granted', ['doctor' => 'Dr. Grace Bell', 'patient_name' => 'Pat']));

        foreach (['document.viewed', 'document.list_viewed', 'document_access.expired', 'document_access.request_expired'] as $quiet) {
            $this->assertContains($quiet, AdminDashboardRepository::QUIET_AUDIT_ACTIONS);
        }
        $this->assertNotContains('document_access.granted', AdminDashboardRepository::QUIET_AUDIT_ACTIONS);
    }

    public function testRequestGuards(): void
    {
        $_ENV['DB_SERVER_VERSION'] = '16';
        DoctrineEntityManagerFactory::reset();
        $builder = new ContainerBuilder();
        $builder->addDefinitions(__DIR__ . '/../../config/container.php');
        /** @var AdminDashboardAction $action */
        $action = $builder->build()->get(AdminDashboardAction::class);

        $request = (new ServerRequestFactory())->createServerRequest('GET', '/api/admin/dashboard');

        $bad = $action($request->withQueryParams(['period' => '90d'])->withAttribute('user_roles', ['admin'])->withAttribute('user_permissions', self::ADMIN), new Response());
        $this->assertSame(422, $bad->getStatusCode());
        $this->assertStringContainsString('period', (string) $bad->getBody());

        $doctor = $action($request->withAttribute('user_roles', ['doctor'])->withAttribute('user_permissions', ['appointments.view']), new Response());
        $this->assertSame(403, $doctor->getStatusCode());
    }
}
