import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  NgZone,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { catchError, distinctUntilChanged, map, of, Subject, switchMap } from 'rxjs';
import { StaffAuthService } from '@supadoc/auth';
import { AdminDashboardApi, apiErrorMessage, MonitoringApi, timeZoneShortLabel } from '@supadoc/data-access';
import type { AdminDashboardDto, AdminDashboardPeriod, AdminDashboardSection, MonitoringOverviewDto } from '@supadoc/models';
import { ButtonComponent, EmptyStateComponent, IconComponent } from '@supadoc/ui';
import { DashboardActivity } from './dashboard-activity';
import { DashboardAttention } from './dashboard-attention';
import { DashboardClinical } from './dashboard-clinical';
import { DashboardSpecialties, DashboardStatus } from './dashboard-breakdowns';
import { DashboardDoctors } from './dashboard-doctors';
import { DashboardKpis } from './dashboard-kpis';
import { DashboardLive } from './dashboard-live';
import { DashboardTrends } from './dashboard-trends';
import { DASHBOARD_PERIODS, greeting, parsePeriod, periodPhrase, plural, timeOf } from './dashboard-ui';
import {
  EMPTY_FRAME,
  HEADER_ACTIONS,
  NOTICE,
  NOTICE_ICON,
  NOTICE_TONE,
  PAGE,
  PAGE_HEADER,
  PAGE_HEADER_TEXT,
  PAGE_SUBTITLE,
  PAGE_TITLE,
  SECTION_GRID,
  SEGMENT,
  SEGMENT_OFF,
  SEGMENT_ON,
  SEGMENTED,
  STAT_GRID,
} from '../shared/layout';

/** While the tab is visible, figures refresh this often (the API caches for 60 s, live for 20 s). */
export const DASHBOARD_AUTO_REFRESH_MS = 60_000;
/** A timer tick skips the refresh when the last request is younger than this (e.g. one made on returning to the tab). */
export const DASHBOARD_TICK_MIN_AGE_MS = 30_000;
/** Returning to the tab refreshes when the figures are at least this old ("live now" is cached for 20 s). */
export const DASHBOARD_VISIBLE_MIN_AGE_MS = 20_000;

const SECTION_LABEL: Record<AdminDashboardSection, string> = {
  kpis: 'Key figures',
  live: 'Live now',
  attention: 'Needs your attention',
  trends: 'Trends',
  breakdowns: 'Breakdowns',
};

interface LoadRequest {
  readonly period: AdminDashboardPeriod;
  /** Skip the server cache (the Refresh button). */
  readonly refresh: boolean;
  /** An automatic refresh: a failure keeps the figures on screen without an error. */
  readonly silent: boolean;
}

type LoadResult =
  | { readonly ok: true; readonly data: AdminDashboardDto; readonly req: LoadRequest }
  | { readonly ok: false; readonly err: unknown; readonly req: LoadRequest };

/**
 * Back-office dashboard (route `/dashboard`, `?period=today|7d|30d`): KPI
 * tiles against the previous equal period, live consultations, the queues
 * that need someone, 30-day trends and the period's breakdowns — from
 * GET /api/admin/dashboard. Each section shows only when the API sent it
 * (the viewer's permissions decide). Switching period keeps the current
 * figures on screen, dimmed, until the new ones arrive. For monitoring.view
 * it also warns when consultations are being recorded right now (from
 * GET /api/admin/monitoring/overview), linking to /monitoring.
 */
@Component({
  selector: 'bo-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    ButtonComponent,
    EmptyStateComponent,
    IconComponent,
    DashboardKpis,
    DashboardLive,
    DashboardAttention,
    DashboardClinical,
    DashboardTrends,
    DashboardStatus,
    DashboardSpecialties,
    DashboardDoctors,
    DashboardActivity,
  ],
  host: { class: 'block' },
  template: `
    <div class="${PAGE}">
      <header class="${PAGE_HEADER}">
        <div class="${PAGE_HEADER_TEXT}">
          <h1 class="${PAGE_TITLE}">{{ greeting() }}</h1>
          <p class="${PAGE_SUBTITLE}">Here's what's happening across VideoMed {{ phrase() }}.</p>
          @if (updated(); as u) {
            <p class="font-sans text-caption text-slate">{{ u }}</p>
          }
        </div>
        <div class="${HEADER_ACTIONS}">
          <div class="${SEGMENTED}" role="group" aria-label="Period">
            @for (p of periods; track p.key) {
              <button
                type="button"
                class="${SEGMENT}"
                [class]="period() === p.key ? '${SEGMENT_ON}' : '${SEGMENT_OFF}'"
                [attr.aria-pressed]="period() === p.key"
                (click)="setPeriod(p.key)"
              >{{ p.label }}</button>
            }
          </div>
          <sd-button variant="secondary" size="sm" [disabled]="busy()" (click)="refresh()">
            <sd-icon name="refresh-cw" [size]="16" class="inline-flex motion-reduce:animate-none" [class.animate-spin]="busy()" /><span class="sr-only sm:not-sr-only">{{ busy() ? 'Updating…' : 'Refresh' }}</span>
          </sd-button>
        </div>
      </header>

      <p class="sr-only" aria-live="polite">{{ announce() }}</p>

      @if (recordingNow() > 0) {
        <!-- Consultations being recorded right now (monitoring.view), as the old overview warned. -->
        <a routerLink="/monitoring" class="${NOTICE} ${NOTICE_TONE.alert.card}">
          <span class="${NOTICE_ICON}" aria-hidden="true">
            <span class="size-2.5 animate-pulse rounded-full bg-alert motion-reduce:animate-none"></span>
          </span>
          <span class="flex min-w-0 flex-1 basis-48 flex-col">
            <span class="font-sans text-body-sm font-semibold text-ink">{{ recordingText() }}</span>
            <span class="break-words font-sans text-caption text-slate">See who is being recorded in monitoring.</span>
          </span>
          <span class="ml-auto flex shrink-0 items-center gap-1 font-sans text-body-sm font-semibold ${NOTICE_TONE.alert.accent}">
            Monitoring<sd-icon name="chevron-right" [size]="18" />
          </span>
        </a>
      }

      @if (!data()) {
        @if (error()) {
          <div class="${EMPTY_FRAME}">
            <sd-empty-state icon="wifi-off" tone="error" title="Couldn't load the dashboard" [message]="error()">
              <sd-button variant="secondary" size="sm" (click)="refresh()"><sd-icon name="refresh-cw" [size]="16" />Try again</sd-button>
            </sd-empty-state>
          </div>
        } @else {
          <div class="flex flex-col gap-6" aria-busy="true">
            <span class="sr-only">Loading the dashboard…</span>
            <div class="${STAT_GRID}" aria-hidden="true">
              @for (i of tiles; track i) { <div class="sd-shimmer h-32 rounded-card"></div> }
            </div>
            <div class="${SECTION_GRID}" aria-hidden="true">
              <div class="sd-shimmer h-80 rounded-card"></div>
              <div class="sd-shimmer h-80 rounded-card"></div>
            </div>
            <div class="grid gap-6 xl:grid-cols-2" aria-hidden="true">
              <div class="sd-shimmer h-72 rounded-card"></div>
              <div class="sd-shimmer h-72 rounded-card"></div>
            </div>
          </div>
        }
      } @else {
        @let d = data()!;
        @if (error()) {
          <div class="${NOTICE} border-alert/30 bg-alert/5" role="alert">
            <sd-icon name="wifi-off" [size]="20" class="shrink-0 text-alert" />
            <span class="min-w-0 flex-1 font-sans text-body-sm text-ink">{{ error() }} Showing the figures from {{ shownAt() }}.</span>
            <sd-button variant="secondary" size="sm" (click)="refresh()">Try again</sd-button>
          </div>
        }
        @if (unavailable().length > 0) {
          <div class="${NOTICE} border-warning/30 bg-warning/5" role="status">
            <sd-icon name="triangle-alert" [size]="20" class="shrink-0 text-warning" />
            <span class="min-w-0 flex-1 font-sans text-body-sm text-ink">Some sections couldn't load just now: {{ unavailable().join(', ') }}.</span>
            <sd-button variant="secondary" size="sm" [disabled]="busy()" (click)="refresh()">Try again</sd-button>
          </div>
        }

        <div class="flex flex-col gap-6 transition-opacity duration-200" [class.opacity-60]="busy()" [attr.aria-busy]="busy()">
          @if (d.kpis?.length) {
            <bo-dash-kpis [kpis]="d.kpis!" [period]="d.period" [currency]="d.currency" />
          }

          @if (overview(); as o) {
            <bo-dash-clinical [overview]="o" />
          }

          @if (d.live || d.attention?.length) {
            <div [class]="d.live && d.attention?.length ? '${SECTION_GRID}' : 'grid gap-6'">
              @if (d.attention?.length) {
                <bo-dash-attention [items]="d.attention!" [currency]="d.currency" />
              }
              @if (d.live) {
                <bo-dash-live [live]="d.live" [canOpenAppointments]="canOpenAppointments" />
              }
            </div>
          }

          @if (d.trends) {
            <bo-dash-trends [trends]="d.trends" [currency]="d.currency" />
          }

          @if (d.breakdowns; as b) {
            @if (b.by_status || b.top_specialties) {
              <div [class]="b.by_status && b.top_specialties ? '${SECTION_GRID}' : 'grid gap-6'">
                @if (b.by_status) {
                  <bo-dash-status [statuses]="b.by_status" [period]="d.period" [canOpenAppointments]="canOpenAppointments" />
                }
                @if (b.top_specialties) {
                  <bo-dash-specialties [specialties]="b.top_specialties" [period]="d.period" [currency]="d.currency" />
                }
              </div>
            }
            @if (b.top_doctors || b.recent_activity) {
              <div class="grid gap-6">
                @if (b.top_doctors) {
                  <bo-dash-doctors [doctors]="b.top_doctors" [period]="d.period" [currency]="d.currency" />
                }
                @if (b.recent_activity) {
                  <bo-dash-activity [items]="b.recent_activity" [showAuditLink]="canOpenAudit" />
                }
              </div>
            }
          }

          @if (nothingToShow()) {
            <div class="${EMPTY_FRAME}">
              <sd-empty-state icon="layout-dashboard" tone="brand" title="Nothing to show here yet" message="Your role doesn't include any dashboard sections. Use the menu to open the pages you work on." />
            </div>
          }
        </div>
      }
    </div>
  `,
})
export class AdminDashboard {
  private readonly api = inject(AdminDashboardApi);
  private readonly monitoring = inject(MonitoringApi);
  private readonly auth = inject(StaffAuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly periods = DASHBOARD_PERIODS;
  protected readonly tiles = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  /** The selected period (from `?period=`). */
  protected readonly period = signal<AdminDashboardPeriod>('today');
  protected readonly data = signal<AdminDashboardDto | null>(null);
  /** A request is on its way (the figures on screen are dimmed, not replaced). */
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly announce = signal('');

  /** Rows open the appointment page (its route needs appointments.view), else monitoring. */
  protected readonly canOpenAppointments = this.auth.hasPermission('appointments.view');
  /** /audit and /monitoring (and its overview read) need monitoring.view. */
  protected readonly canOpenAudit = this.auth.hasPermission('monitoring.view');

  /**
   * Consultations being recorded right now, from GET /api/admin/monitoring/overview
   * (monitoring.view only; 0 until known). Read with every dashboard load; a
   * failed read keeps the last count.
   */
  protected readonly recordingNow = signal(0);
  /** Platform-wide clinical totals (monitoring.view), from the monitoring overview. */
  protected readonly overview = signal<MonitoringOverviewDto | null>(null);
  protected readonly recordingText = computed(() => `${plural(this.recordingNow(), 'consultation')} recording now`);

  protected readonly greeting = computed(() => greeting(this.auth.displayName()));
  /** Wording follows the figures on screen (the old ones while a new period loads). */
  protected readonly phrase = computed(() => periodPhrase(this.data()?.period ?? this.period()));
  protected readonly shownAt = computed(() => timeOf(this.data()?.generated_at) || 'earlier');
  protected readonly updated = computed(() => {
    const d = this.data();
    if (!d) return '';
    const at = timeOf(d.generated_at);
    const zone = d.timezone ? timeZoneShortLabel(d.timezone) : '';
    return at ? `Updated ${at}${zone ? ` · times in ${zone}` : ''}` : '';
  });
  protected readonly unavailable = computed(() => (this.data()?.unavailable ?? []).map((s) => SECTION_LABEL[s] ?? s));
  protected readonly nothingToShow = computed(() => {
    const d = this.data();
    if (!d) return false;
    const b = d.breakdowns;
    const anyBreakdown = !!b && !!(b.by_status || b.top_specialties || b.top_doctors || b.recent_activity);
    return !d.kpis?.length && !d.live && !d.attention?.length && !d.trends && !anyBreakdown && d.unavailable.length === 0;
  });

  private readonly requests = new Subject<LoadRequest>();
  private readonly recordingChecks = new Subject<void>();
  /** When the last dashboard request went out (Date.now()); 0 before the first. */
  private lastRequestAt = 0;

  constructor() {
    this.recordingChecks
      .pipe(
        switchMap(() =>
          this.monitoring.overview().pipe(
            map((res) => res.data ?? null),
            catchError(() => of(null)),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((o) => {
        if (o === null) return;
        this.overview.set(o);
        this.recordingNow.set(Math.max(0, Number(o.recordings?.active) || 0));
      });

    this.requests
      .pipe(
        switchMap((req) => {
          // An automatic refresh is quiet: no dimming, no error unless nothing is on screen.
          if (!req.silent) {
            this.busy.set(true);
            this.error.set('');
          }
          return this.api.get(req.period, { refresh: req.refresh }).pipe(
            map((res): LoadResult => ({ ok: true, data: res.data, req })),
            catchError((err: unknown) => of<LoadResult>({ ok: false, err, req })),
          );
        }),
        takeUntilDestroyed(),
      )
      .subscribe((r) => this.settle(r));

    this.route.queryParamMap
      .pipe(
        map((q) => parsePeriod(q.get('period'))),
        distinctUntilChanged(),
        takeUntilDestroyed(),
      )
      .subscribe((p) => {
        this.period.set(p);
        this.load(false, false);
      });

    // Keep "Live now" and the queues current while the page is open and visible:
    // a quiet refresh every minute, and one on returning to the tab (the timer
    // skips hidden tabs, so the figures may be stale by then). The timer and the
    // listener run outside Angular (they never hold the app "unstable"); the
    // request runs inside it.
    const zone = inject(NgZone);
    const destroyRef = inject(DestroyRef);
    const doc = inject(DOCUMENT);
    const quietRefresh = (minAgeMs: number) => {
      if (doc.visibilityState === 'hidden' || this.busy()) return;
      if (Date.now() - this.lastRequestAt < minAgeMs) return;
      zone.run(() => this.load(false, true));
    };
    zone.runOutsideAngular(() => {
      const timer = setInterval(() => quietRefresh(DASHBOARD_TICK_MIN_AGE_MS), DASHBOARD_AUTO_REFRESH_MS);
      const onVisibility = () => {
        if (doc.visibilityState === 'visible') quietRefresh(DASHBOARD_VISIBLE_MIN_AGE_MS);
      };
      doc.addEventListener('visibilitychange', onVisibility);
      destroyRef.onDestroy(() => {
        clearInterval(timer);
        doc.removeEventListener('visibilitychange', onVisibility);
      });
    });
  }

  protected setPeriod(p: AdminDashboardPeriod): void {
    if (p === this.period()) return;
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { period: p === 'today' ? null : p },
      queryParamsHandling: 'merge',
    });
  }

  /** The Refresh / Try again buttons: fresh figures, past the server's short cache. */
  protected refresh(): void {
    this.load(true, false);
  }

  private load(refresh: boolean, silent: boolean): void {
    this.lastRequestAt = Date.now();
    this.requests.next({ period: this.period(), refresh, silent });
    if (this.canOpenAudit) this.recordingChecks.next();
  }

  private settle(r: LoadResult): void {
    this.busy.set(false);
    if (r.ok) {
      this.data.set(r.data);
      this.error.set('');
      if (!r.req.silent) this.announce.set(`Dashboard updated: ${periodPhrase(r.data.period)}.`);
      return;
    }
    // An automatic refresh that fails keeps the figures quietly; the next one tries again.
    if (r.req.silent && this.data()) return;
    const msg = apiErrorMessage(r.err, 'Could not load the dashboard.');
    this.error.set(/[.!?]$/.test(msg) ? msg : `${msg}.`);
    this.announce.set(this.error());
  }
}
