<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Appointment\AppointmentLifecycle;
use App\Domain\Dashboard\AuditEventDescriber;
use App\Domain\Dashboard\DashboardPeriod;
use App\Domain\Entity\Appointment;
use App\Domain\Entity\AuditEvent;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Repository\AdminDashboardRepository;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\SupportTicketRepository;
use App\Domain\Settings\ClinicTime;
use DateTimeImmutable;
use DateTimeZone;
use Predis\Client as RedisClient;
use Psr\Log\LoggerInterface;

/**
 * Builds the back-office dashboard (GET /api/admin/dashboard).
 *
 * The payload is made of PARTS, each shown only to staff holding one of the
 * permissions the matching back-office page needs ({@see PARTS}) — money
 * figures need the analytics (`monitoring.view`) or payouts permission, doctor
 * queues `specialists.manage`, the support queue `support.manage`, and so on.
 * A doctor login (role `doctor`, which carries `appointments.view`) gets
 * nothing unless it also holds a back-office permission.
 *
 * Figures come from {@see AdminDashboardRepository} (aggregate SQL) and are
 * cached in Redis for a short while (CACHE_TTL; "live now" LIVE_TTL), shared by
 * every viewer with the same period and time zone; `$fresh` skips the cache.
 * Redis trouble just means no cache. A part whose queries fail is left out and
 * named in `unavailable` (and logged) — the rest of the dashboard still loads.
 */
final class AdminDashboardService
{
    public const CACHE_TTL = 60;
    public const LIVE_TTL = 20;

    /** "Starting soon" looks this far ahead. */
    public const STARTING_SOON_MINUTES = 120;

    /** Permissions only back-office staff hold (a doctor login has none of them). */
    public const BACK_OFFICE_PERMISSIONS = [
        'monitoring.view', 'specialists.manage', 'payouts.manage', 'support.manage',
        'staff.manage', 'settings.manage', 'appointments.update', 'appointments.create',
    ];

    /** Dashboard part => the permissions that unlock it (ANY of them). */
    public const PARTS = [
        'kpis.activity'          => ['monitoring.view'],
        'kpis.money'             => ['monitoring.view', 'payouts.manage'],
        'kpis.doctors'           => ['monitoring.view', 'specialists.manage'],
        'live'                   => ['monitoring.view'],
        'attention.appointments' => ['appointments.view'],
        'attention.doctors'      => ['specialists.manage'],
        'attention.payouts'      => ['payouts.manage'],
        'attention.support'      => ['support.manage'],
        'attention.payments'     => ['payouts.manage', 'support.manage'],
        'trends.activity'        => ['monitoring.view'],
        'trends.revenue'         => ['monitoring.view', 'payouts.manage'],
        'breakdowns.status'      => ['monitoring.view'],
        'breakdowns.specialties' => ['monitoring.view'],
        'breakdowns.doctors'     => ['specialists.manage'],
        'breakdowns.activity'    => ['monitoring.view'],
    ];

    private const CACHE_PREFIX = 'admin:dashboard:v1:';

    private bool $redisDown = false;

    public function __construct(
        private readonly AdminDashboardRepository $dashboard,
        private readonly AppointmentRepository $appointments,
        private readonly SpecialistRepository $specialists,
        private readonly SupportTicketRepository $tickets,
        private readonly CallPresence $presence,
        private readonly PricingService $pricing,
        private readonly RedisClient $redis,
        private readonly ?LoggerInterface $logger = null,
    ) {
    }

    /**
     * The dashboard parts a caller may see, in {@see PARTS} order. Everything
     * for `super_admin`; nothing for a doctor login without a back-office
     * permission.
     *
     * @param list<string> $roles
     * @param list<string> $permissions
     * @return list<string>
     */
    public static function grantedParts(array $roles, array $permissions): array
    {
        $roles       = array_values(array_map('strval', $roles));
        $permissions = array_values(array_map('strval', $permissions));
        if (in_array('super_admin', $roles, true)) {
            return array_keys(self::PARTS);
        }
        if (in_array('doctor', $roles, true) && array_intersect($permissions, self::BACK_OFFICE_PERMISSIONS) === []) {
            return [];
        }

        $granted = [];
        foreach (self::PARTS as $part => $needs) {
            if (array_intersect($needs, $permissions) !== []) {
                $granted[] = $part;
            }
        }

        return $granted;
    }

    /**
     * The dashboard for `$parts` ({@see grantedParts()}) over `$period`.
     *
     * @param list<string> $parts
     * @param list<string> $permissions the caller's, for the links they can open
     * @return array<string,mixed>
     */
    public function build(DashboardPeriod $period, array $parts, array $permissions = [], bool $fresh = false): array
    {
        $has      = static fn (string ...$any): bool => array_intersect($any, $parts) !== [];
        $currency = $this->currency();
        $out      = [
            'period'       => $period->period,
            'timezone'     => $period->zone->getName(),
            'currency'     => $currency,
            'generated_at' => $period->now->format(DATE_ATOM),
            'range'        => $period->toArray(),
            'parts'        => array_values($parts),
            'sections'     => [],
            'unavailable'  => [],
        ];

        $sections = [
            'kpis'       => $has('kpis.activity', 'kpis.money', 'kpis.doctors')
                ? fn (): array => $this->kpis($period, $parts, $currency, $fresh) : null,
            'live'       => $has('live') ? fn (): array => $this->live($period, $fresh) : null,
            'attention'  => $has('attention.appointments', 'attention.doctors', 'attention.payouts', 'attention.support', 'attention.payments')
                ? fn (): array => $this->attention($period, $parts, $currency, $fresh) : null,
            'trends'     => $has('trends.activity', 'trends.revenue') ? fn (): array => $this->trends($period, $parts, $fresh) : null,
            'breakdowns' => $has('breakdowns.status', 'breakdowns.specialties', 'breakdowns.doctors', 'breakdowns.activity')
                ? fn (): array => $this->breakdowns($period, $parts, $permissions, $fresh) : null,
        ];

        foreach ($sections as $name => $compute) {
            if ($compute === null) {
                continue;
            }
            try {
                $out[$name]        = $compute();
                $out['sections'][] = $name;
            } catch (\Throwable $e) {
                $out['unavailable'][] = $name;
                $this->logger?->error('[dashboard] ' . $name . ' failed: ' . $e->getMessage(), ['exception' => $e]);
            }
        }

        return $out;
    }

    // ----- KPIs -----

    /**
     * @param list<string> $parts
     * @return list<array<string,mixed>>
     */
    private function kpis(DashboardPeriod $p, array $parts, string $currency, bool $fresh): array
    {
        $activity = in_array('kpis.activity', $parts, true);
        $money    = in_array('kpis.money', $parts, true);
        $doctors  = in_array('kpis.doctors', $parts, true);
        $w        = $p->kpiWindows();
        $suffix   = $this->periodKey($p);
        $tiles    = [];

        $bookings = ($activity || $money)
            ? $this->remember('bookings:' . $suffix, self::CACHE_TTL, $fresh, fn (): array => $this->dashboard->bookingTotals(...$w))
            : null;
        $closed = $activity
            ? $this->remember('closed:' . $suffix, self::CACHE_TTL, $fresh, fn (): array => $this->dashboard->closedTotals(...$w))
            : null;

        if ($bookings !== null && $activity) {
            $tiles[] = self::tile('bookings', 'Bookings made', 'count', $bookings['bookings_cur'], $bookings['bookings_prev'], true);
        }
        if ($closed !== null) {
            $tiles[] = self::tile('consultations_completed', 'Consultations completed', 'count', $closed['completed_cur'], $closed['completed_prev'], true);
        }
        if ($money && $bookings !== null) {
            $tiles[] = self::tile('revenue', 'Revenue', 'money', $bookings['revenue_cur'], $bookings['revenue_prev'], true, $bookings['paid_cur'], $bookings['paid_prev']);
        }
        if ($money) {
            $wallet  = $this->remember('wallet:' . $suffix . ':' . $currency, self::CACHE_TTL, $fresh, fn (): array => $this->dashboard->walletTotals(...[...$w, $currency]));
            $tiles[] = self::tile('wallet_topups', 'Wallet top-ups', 'money', $wallet['topup_sum_cur'], $wallet['topup_sum_prev'], true, $wallet['topup_count_cur'], $wallet['topup_count_prev']);
            $tiles[] = self::tile('refunds', 'Refunds issued', 'money', $wallet['refund_sum_cur'], $wallet['refund_sum_prev'], false, $wallet['refund_count_cur'], $wallet['refund_count_prev']);
        }
        if ($activity) {
            $patients = $this->remember('patients:' . $suffix, self::CACHE_TTL, $fresh, fn (): array => $this->dashboard->newPatients(...$w));
            $tiles[]  = self::tile('new_patients', 'New patients', 'count', $patients['cur'], $patients['prev'], true);
        }
        if ($doctors) {
            $active  = $this->remember('doctors', self::CACHE_TTL, $fresh, fn (): array => $this->dashboard->activeDoctors());
            $tile    = self::tile('active_doctors', 'Active doctors', 'count', $active['taking_bookings'], null, true);
            $tiles[] = ['breakdown' => ['approved' => $active['approved'], 'taking_bookings' => $active['taking_bookings']]] + $tile;
        }
        if ($closed !== null) {
            $tiles[]  = self::tile('cancellations', 'Cancellations', 'count', $closed['cancelled_cur'], $closed['cancelled_prev'], false);
            $missed   = self::tile('missed', 'Missed consultations', 'count', $closed['missed_cur'], $closed['missed_prev'], false);
            $tiles[]  = ['breakdown' => [
                'patient' => $closed['missed_patient'],
                'doctor'  => $closed['missed_doctor'],
                'both'    => $closed['missed_both'],
                'unknown' => max(0, $closed['missed_cur'] - $closed['missed_patient'] - $closed['missed_doctor'] - $closed['missed_both']),
            ]] + $missed;

            $ratings = $this->remember('ratings:' . $suffix, self::CACHE_TTL, $fresh, fn (): array => $this->dashboard->ratings(...$w));
            $cur     = $ratings['count_cur'] > 0 ? round($ratings['sum_cur'] / $ratings['count_cur'], 2) : null;
            $prev    = $ratings['count_prev'] > 0 ? round($ratings['sum_prev'] / $ratings['count_prev'], 2) : null;
            $tiles[] = self::tile('average_rating', 'Average rating', 'rating', $cur, $prev, true, $ratings['count_cur'], $ratings['count_prev']);
        }

        // The tile order the dashboard shows (whatever was computed first).
        $order = array_flip(['bookings', 'consultations_completed', 'revenue', 'wallet_topups', 'refunds', 'new_patients', 'active_doctors', 'cancellations', 'missed', 'average_rating']);
        usort($tiles, static fn (array $a, array $b): int => $order[$a['key']] <=> $order[$b['key']]);

        return $tiles;
    }

    /**
     * One KPI tile. Money values are strings (scale 2), counts ints, a rating a
     * float (null with no reviews). `previous` null: no comparison (a
     * snapshot). `change_pct` is null when there is nothing to compare with
     * (previous null or zero).
     *
     * @return array<string,mixed>
     */
    public static function tile(
        string $key,
        string $label,
        string $format,
        int|float|string|null $value,
        int|float|string|null $previous,
        bool $higherIsBetter,
        ?int $count = null,
        ?int $previousCount = null,
    ): array {
        return [
            'key'              => $key,
            'label'            => $label,
            'format'           => $format,
            'value'            => $value,
            'previous'         => $previous,
            'change_pct'       => self::changePct($value, $previous),
            'trend'            => self::trend($value, $previous),
            'higher_is_better' => $higherIsBetter,
            'count'            => $count,
            'previous_count'   => $previousCount,
            'breakdown'        => null,
        ];
    }

    /** Percentage change from `$previous` to `$value` (1 dp), or null when it isn't defined. */
    public static function changePct(int|float|string|null $value, int|float|string|null $previous): ?float
    {
        if ($value === null || $previous === null || (float) $previous === 0.0) {
            return null;
        }

        return round(((float) $value - (float) $previous) / abs((float) $previous) * 100, 1);
    }

    /** 'up' | 'down' | 'flat', or null when there is nothing to compare. */
    public static function trend(int|float|string|null $value, int|float|string|null $previous): ?string
    {
        if ($value === null || $previous === null) {
            return null;
        }
        $diff = (float) $value - (float) $previous;

        return abs($diff) < 0.005 ? 'flat' : ($diff > 0 ? 'up' : 'down');
    }

    // ----- Live now -----

    /** @return array<string,mixed> */
    private function live(DashboardPeriod $p, bool $fresh): array
    {
        $zone = $p->zone;

        return $this->remember('live:' . $zone->getName(), self::LIVE_TTL, $fresh, function () use ($p, $zone): array {
            $now   = $p->now;
            $until = $now->modify('+' . self::STARTING_SOON_MINUTES . ' minutes');

            $inProgress = [];
            $liveIds    = [];
            foreach ($this->inCall($now) as ['appointment' => $a, 'presence' => $presence]) {
                $inProgress[] = self::liveItem($a, $presence, $zone);
                $liveIds[]    = $a->getId();
            }
            // A booking a few minutes away whose call has already started is
            // "in progress" only — never in both lists or both counts.
            $soon = array_map(
                static fn (Appointment $a): array => self::liveItem($a, null, $zone),
                $this->dashboard->startingSoon($now, $until, 10, $liveIds),
            );

            return [
                'in_progress'         => $inProgress,
                'in_progress_count'   => count($inProgress),
                'starting_soon'       => $soon,
                'starting_soon_count' => $this->dashboard->countStartingSoon($now, $until, $liveIds),
                'window_minutes'      => self::STARTING_SOON_MINUTES,
            ];
        });
    }

    /**
     * Open bookings someone is in the call of right now (CallPresence), with
     * who is there — the most recently scheduled first (the candidates come
     * newest first, so old bookings never closed can't crowd out a call that
     * is running now).
     *
     * @return list<array{appointment: Appointment, presence: array{doctor: bool, patient: bool, guests: list<string>}}>
     */
    private function inCall(DateTimeImmutable $now): array
    {
        $out = [];
        foreach ($this->dashboard->liveCandidates($now) as $a) {
            $presence = $this->presence->tryForAppointment($a);
            if ($presence === null) {
                break; // Redis can't say — nobody reads as live rather than stalling on every row
            }
            if ($presence['doctor'] || $presence['patient'] || $presence['guests'] !== []) {
                $out[] = ['appointment' => $a, 'presence' => $presence];
            }
        }

        return $out;
    }

    /**
     * @param array{doctor: bool, patient: bool, guests: list<string>}|null $presence
     * @return array<string,mixed>
     */
    private static function liveItem(Appointment $a, ?array $presence, DateTimeZone $zone): array
    {
        $s = $a->getSpecialist();

        return [
            'id'           => $a->getId(),
            'scheduled_at' => $a->getScheduledAt()->setTimezone($zone)->format(DATE_ATOM),
            'ends_at'      => AppointmentLifecycle::endsAt($a)->setTimezone($zone)->format(DATE_ATOM),
            'status'       => $a->getStatus()->value,
            'status_label' => $a->getStatus()->label(),
            'type'         => $a->getType()->value,
            'patient_name' => $a->getPatient()->getFullName(),
            'specialist'   => [
                'id'        => $s->getId(),
                'name'      => $s->getName(),
                'specialty' => $s->getSpecialty(),
                'photo_url' => $s->getPhotoUrl(),
            ],
            'in_call'      => $presence === null ? null : [
                'doctor'  => $presence['doctor'],
                'patient' => $presence['patient'],
                'guests'  => count($presence['guests']),
            ],
        ];
    }

    // ----- Needs your attention -----

    /**
     * Every queue the caller can work on, as a count (and a money total where
     * it is money), with the already-filtered back-office page it opens.
     * Items are listed even at 0 so the dashboard can say "all clear".
     *
     * @param list<string> $parts
     * @return list<array<string,mixed>>
     */
    private function attention(DashboardPeriod $p, array $parts, string $currency, bool $fresh): array
    {
        $items = [];
        $part  = static fn (string $name): bool => in_array($name, $parts, true);

        if ($part('attention.appointments')) {
            // The same filter as the list it links to (GET /appointments?when=attention,
            // which does not leave out bookings with someone still in the call),
            // so the count and the page agree.
            $count   = $this->remember('attention:appointments', self::LIVE_TTL, $fresh, function () use ($p): array {
                $n = (int) $this->appointments
                    ->paginatedBuilder(null, null, 'attention', $this->processNow($p->now))
                    ->select('COUNT(e.id)')
                    ->getQuery()
                    ->getSingleScalarResult();

                return ['n' => $n];
            });
            $items[] = self::item('appointments_attention', 'Past consultations still open', 'They ended but are still pending, confirmed or rescheduled — settle them.', $count['n'], null, 'warning', '/appointments', ['when' => 'attention']);
        }

        if ($part('attention.doctors')) {
            $d = $this->remember('attention:doctors', self::CACHE_TTL, $fresh, function (): array {
                $today = ClinicTime::today();

                return [
                    'review'      => $this->specialists->countPendingReview(),
                    'credentials' => $this->specialists->countAdminFilter('credentials_pending', $today),
                    'changes'     => $this->specialists->countAdminFilter('changes', $today),
                    'expiring'    => $this->specialists->countAdminFilter('licence_expiring', $today),
                    'expired'     => $this->specialists->countAdminFilter('licence_expired', $today),
                ];
            });
            $items[] = self::item('doctor_reviews_pending', 'Doctors waiting for review', 'Profiles submitted for approval.', $d['review'], null, 'info', '/specialists', ['filter' => 'review']);
            $items[] = self::item('credentials_to_verify', 'Doctor documents to verify', 'Doctors with uploaded documents waiting for verification.', $d['credentials'], null, 'info', '/specialists', ['filter' => 'credentials_pending']);
            $items[] = self::item('profile_change_requests', 'Profile change requests', 'Approved doctors asking to change locked profile fields.', $d['changes'], null, 'info', '/specialists', ['filter' => 'changes']);
            $items[] = self::item('licences_expiring', 'Licences expiring in 30 days', 'Live doctors whose practising licence runs out soon.', $d['expiring'], null, 'warning', '/specialists', ['filter' => 'licence_expiring']);
            $items[] = self::item('licences_expired', 'Licences expired', 'Doctors whose practising licence has run out.', $d['expired'], null, 'alert', '/specialists', ['filter' => 'licence_expired']);
        }

        if ($part('attention.payouts')) {
            $payouts = $this->remember('attention:payouts:' . $currency, self::CACHE_TTL, $fresh, fn (): array => $this->dashboard->pendingPayouts($currency));
            $items[] = self::item('payouts_awaiting_approval', 'Payouts awaiting approval', 'Doctor payout requests to approve or reject.', $payouts['count'], $payouts['amount'], 'info', '/payouts', ['status' => 'pending']);
        }

        if ($part('attention.support')) {
            $open    = $this->remember('attention:support', self::CACHE_TTL, $fresh, fn (): array => ['n' => $this->tickets->openCount()]);
            $items[] = self::item('support_open', 'Open support tickets', 'Tickets waiting for a reply from support.', $open['n'], null, 'info', '/support', ['status' => 'open']);
        }

        if ($part('attention.payments')) {
            $held    = $this->remember('attention:payments:' . $currency, self::CACHE_TTL, $fresh, fn (): array => [
                'topups' => $this->dashboard->heldTopups($currency),
                'cards'  => $this->dashboard->cardPaymentsInReview($currency),
            ]);
            // No back-office list exists for these yet (support settles them) — no link.
            $items[] = self::item('topups_held', 'Wallet top-ups held for review', 'Paid, but the amount or currency did not match — not credited yet.', $held['topups']['count'], $held['topups']['amount'], 'alert', null, []);
            $items[] = self::item('card_payments_review', 'Card payments held for review', 'Paid, but could not be used or credited automatically.', $held['cards']['count'], $held['cards']['amount'], 'alert', null, []);
        }

        return $items;
    }

    /**
     * @param array<string,string> $query
     * @return array<string,mixed>
     */
    private static function item(string $key, string $label, string $description, int $count, ?string $amount, string $tone, ?string $path, array $query): array
    {
        return [
            'key'         => $key,
            'label'       => $label,
            'description' => $description,
            'count'       => $count,
            'amount'      => $amount,
            'tone'        => $tone,
            'link'        => $path === null ? null : ['path' => $path, 'query' => (object) $query],
        ];
    }

    // ----- Trends -----

    /**
     * @param list<string> $parts
     * @return array<string,mixed>
     */
    private function trends(DashboardPeriod $p, array $parts, bool $fresh): array
    {
        $activity = in_array('trends.activity', $parts, true);
        $revenue  = in_array('trends.revenue', $parts, true);
        $bounds   = $p->trendBounds();

        $data = $this->remember('trends:' . $p->zone->getName() . ':' . $p->todayStart->format('Y-m-d'), self::CACHE_TTL, $fresh, fn (): array => [
            'bookings'  => $this->dashboard->dailyBookings($bounds),
            'completed' => $this->dashboard->dailyCompleted($bounds),
        ]);

        $days   = [];
        $totals = ['bookings' => 0, 'completed' => 0, 'revenue' => '0.00'];
        foreach (array_slice($bounds, 0, -1) as $i => $day) {
            $b = $data['bookings'][$i] ?? ['bookings' => 0, 'revenue' => '0.00'];
            $c = (int) ($data['completed'][$i] ?? 0);
            $days[] = [
                'date'      => $day->format('Y-m-d'),
                'bookings'  => $activity ? (int) $b['bookings'] : null,
                'completed' => $activity ? $c : null,
                'revenue'   => $revenue ? (string) $b['revenue'] : null,
            ];
            $totals['bookings'] += (int) $b['bookings'];
            $totals['completed'] += $c;
            $totals['revenue'] = bcadd($totals['revenue'], (string) $b['revenue'], 2);
        }

        return [
            'from'   => $bounds[0]->format(DATE_ATOM),
            'to'     => $bounds[count($bounds) - 1]->format(DATE_ATOM),
            'series' => array_values(array_filter([
                $activity ? 'bookings' : null,
                $activity ? 'completed' : null,
                $revenue ? 'revenue' : null,
            ])),
            'days'   => $days,
            'totals' => [
                'bookings'  => $activity ? $totals['bookings'] : null,
                'completed' => $activity ? $totals['completed'] : null,
                'revenue'   => $revenue ? $totals['revenue'] : null,
            ],
        ];
    }

    // ----- Breakdowns -----

    /**
     * @param list<string> $parts
     * @param list<string> $permissions
     * @return array<string,mixed>
     */
    private function breakdowns(DashboardPeriod $p, array $parts, array $permissions, bool $fresh): array
    {
        $part   = static fn (string $name): bool => in_array($name, $parts, true);
        $money  = $part('kpis.money');
        $from   = $p->from;
        $to     = $p->tomorrowStart;
        $suffix = $this->periodKey($p);
        $out    = ['from' => $from->format(DATE_ATOM), 'to' => $to->format(DATE_ATOM)];

        if ($part('breakdowns.status')) {
            $counts = $this->remember('status:' . $suffix, self::CACHE_TTL, $fresh, fn (): array => $this->dashboard->statusBreakdown($from, $to));
            $out['by_status'] = array_map(static fn (AppointmentStatus $s): array => [
                'status' => $s->value,
                'label'  => $s->label(),
                'count'  => (int) ($counts[$s->value] ?? 0),
            ], [
                AppointmentStatus::PENDING, AppointmentStatus::CONFIRMED, AppointmentStatus::RESCHEDULED,
                AppointmentStatus::COMPLETED, AppointmentStatus::MISSED, AppointmentStatus::CANCELLED,
            ]);
        }

        if ($part('breakdowns.specialties')) {
            $rows = $this->remember('specialties:' . $suffix, self::CACHE_TTL, $fresh, fn (): array => $this->dashboard->topSpecialties($from, $to, 6));
            $out['top_specialties'] = array_map(
                static fn (array $r): array => ['revenue' => $money ? $r['revenue'] : null] + $r,
                $rows,
            );
        }

        if ($part('breakdowns.doctors')) {
            $rows = $this->remember('doctors:' . $suffix, self::CACHE_TTL, $fresh, fn (): array => $this->dashboard->topDoctors($from, $to, 5));
            $out['top_doctors'] = array_map(
                static fn (array $r): array => ['revenue' => $money ? $r['revenue'] : null] + $r,
                $rows,
            );
        }

        if ($part('breakdowns.activity')) {
            $rows = $this->remember('activity:' . $p->zone->getName(), self::LIVE_TTL, $fresh, fn (): array => array_map(
                static fn (AuditEvent $e): array => self::activityItem($e, $p->zone),
                $this->dashboard->recentActivity(8),
            ));
            $out['recent_activity'] = array_map(static function (array $r) use ($permissions): array {
                $link = $r['link'];
                if ($link !== null && !in_array($link['permission'], $permissions, true)) {
                    $link = null; // they couldn't open that page
                }
                $r['link'] = $link === null ? null : ['path' => $link['path'], 'query' => (object) []];

                return $r;
            }, $rows);
        }

        return $out;
    }

    /** @return array<string,mixed> */
    private static function activityItem(AuditEvent $e, DateTimeZone $zone): array
    {
        $a        = $e->toArray();
        $metadata = is_array($a['metadata']) ? $a['metadata'] : [];

        return [
            'id'          => $a['id'],
            'action'      => $a['action'],
            'label'       => AuditEventDescriber::label((string) $a['action'], $metadata),
            'summary'     => AuditEventDescriber::summary((string) $a['action'], $metadata),
            'actor_name'  => $a['actor_name'],
            'actor_role'  => $a['actor_role'],
            'created_at'  => (new DateTimeImmutable((string) $a['created_at']))->setTimezone($zone)->format(DATE_ATOM),
            'link'        => AuditEventDescriber::link($a['resource_type'], $a['resource_id'], $a['appointment_id']),
        ];
    }

    // ----- plumbing -----

    private function currency(): string
    {
        try {
            return strtoupper($this->pricing->currency());
        } catch (\Throwable) {
            return 'NGN';
        }
    }

    /** Cache-key part for a period: its name, zone and current day. */
    private function periodKey(DashboardPeriod $p): string
    {
        return $p->period . ':' . $p->zone->getName() . ':' . $p->todayStart->format('Y-m-d');
    }

    /** `$instant` in the process zone (what the repositories compare naive timestamps with). */
    private function processNow(DateTimeImmutable $instant): DateTimeImmutable
    {
        return $instant->setTimezone(new DateTimeZone(date_default_timezone_get()));
    }

    /**
     * A cached array, computed on a miss. Values are JSON in Redis; any Redis
     * failure turns caching off for the rest of the request (no repeated
     * connection timeouts).
     *
     * @param callable(): array<mixed> $compute
     * @return array<mixed>
     */
    private function remember(string $key, int $ttl, bool $fresh, callable $compute): array
    {
        $key = self::CACHE_PREFIX . $key;
        if (!$fresh && !$this->redisDown) {
            try {
                $hit = $this->redis->get($key);
                if (is_string($hit)) {
                    $value = json_decode($hit, true);
                    if (is_array($value)) {
                        return $value;
                    }
                }
            } catch (\Throwable $e) {
                $this->redisFailed($e);
            }
        }

        $value = $compute();
        if (!$this->redisDown) {
            try {
                $this->redis->setex($key, $ttl, json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES));
            } catch (\Throwable $e) {
                $this->redisFailed($e);
            }
        }

        return $value;
    }

    private function redisFailed(\Throwable $e): void
    {
        $this->redisDown = true;
        $this->logger?->warning('[dashboard] cache unavailable: ' . $e->getMessage());
    }
}
