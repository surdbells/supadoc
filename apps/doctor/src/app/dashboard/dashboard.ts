import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { EMPTY } from 'rxjs';
import { StaffAuthService } from '@supadoc/auth';
import {
  apiErrorMessage,
  DoctorApi,
  injectCallPresence,
  StaffNotificationsApi,
  todayLocal,
} from '@supadoc/data-access';
import type {
  DoctorAppointmentDto,
  DoctorDashboardDto,
  StaffNotificationDto,
} from '@supadoc/models';
import { CallPresenceComponent, IconComponent } from '@supadoc/ui';
import { isOpenBooking, isPast, statusLook } from '../appointment/appointment-status';
import { doctorStatusLabel } from '../appointment/follow-ups';
import { DoctorStandingStore } from '../standing/doctor-standing.store';
import { type StandingNotice, standingNotices } from '../standing/standing-rules';

interface Stat {
  readonly label: string;
  readonly value: string | number;
  readonly icon: string;
  readonly tint: string;
  /** Small muted text shown inline to the right of the value. */
  readonly inlineSub?: string;
  readonly delta: number | null;
  readonly deltaPeriod?: string;
}

/** A standing notice's card border/background, and its icon + call-to-action colour. */
const NOTICE_TONE: Record<StandingNotice['tone'], { card: string; accent: string }> = {
  alert: { card: 'border-alert/30 bg-alert/5 hover:bg-alert/10', accent: 'text-alert' },
  warning: { card: 'border-warning/30 bg-warning/5 hover:bg-warning/10', accent: 'text-warning' },
  info: { card: 'border-cerulean/20 bg-frost/50 hover:bg-frost', accent: 'text-cerulean' },
};

interface QuickAction {
  readonly label: string;
  readonly subtitle: string;
  readonly icon: string;
  readonly tint: string;
  readonly link: string;
}

const NOTE_ICON: Record<string, string> = {
  appointment: 'calendar-clock',
  message: 'message-square',
  review: 'star',
  payout: 'wallet',
  system: 'info',
};

/** Doctor home (route `/dashboard`) — stats, today's schedule, notifications. */
@Component({
  selector: 'doc-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, CallPresenceComponent, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <header class="flex flex-col gap-1">
        <h1 class="font-heading text-h3 text-ink">{{ greeting() }} 👋</h1>
        <p class="font-sans text-body text-slate">Here's your Activities for today.</p>
      </header>

      <!-- The account: onboarding until approved; then a suspension, the terms, the licence,
           documents owed and a change request waiting for review. -->
      @for (b of notices(); track b.key) {
        <a
          [routerLink]="b.link"
          class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-card border px-5 py-4 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
          [class]="tone(b).card"
        >
          <span class="flex size-10 shrink-0 items-center justify-center rounded-full bg-white shadow-sm" [class]="tone(b).accent">
            <sd-icon [name]="b.icon" [size]="20" />
          </span>
          <span class="flex min-w-0 flex-1 basis-48 flex-col">
            <span class="font-sans text-body-sm font-semibold text-ink">{{ b.title }}</span>
            <span class="break-words font-sans text-caption text-slate">{{ b.text }}</span>
          </span>
          <span class="ml-auto flex shrink-0 items-center gap-1 font-sans text-body-sm font-semibold" [class]="tone(b).accent">
            {{ b.cta }}<sd-icon name="chevron-right" [size]="18" />
          </span>
        </a>
      }

      @if (suspended()) {
        <!-- A suspended doctor's dashboard: no schedule or patients — what still works. -->
        <section class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-5 sm:p-6" aria-labelledby="suspended-title">
          <div class="flex flex-col gap-1">
            <h2 id="suspended-title" class="font-heading text-body-lg text-ink">While your account is suspended</h2>
            <p class="font-sans text-body-sm text-slate">You can still see your earnings and payout history, keep your profile up to date and upload your documents.</p>
          </div>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
            @for (q of suspendedLinks; track q.link) {
              <a [routerLink]="q.link" class="group flex min-h-11 items-center gap-3 rounded-card border border-cloud p-4 transition-colors hover:border-cerulean/50">
                <span class="flex size-10 shrink-0 items-center justify-center rounded-full" [class]="q.tint"><sd-icon [name]="q.icon" [size]="20" /></span>
                <span class="flex min-w-0 flex-col">
                  <span class="font-sans text-body-sm font-semibold text-ink">{{ q.label }}</span>
                  <span class="font-sans text-caption text-slate">{{ q.subtitle }}</span>
                </span>
              </a>
            }
          </div>
        </section>
      } @else if (loading()) {
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
          @for (i of [1,2,3,4,5]; track i) { <div class="sd-shimmer h-28 rounded-card"></div> }
        </div>
        <div class="grid gap-6 lg:grid-cols-2">
          <div class="sd-shimmer h-80 rounded-card"></div>
          <div class="sd-shimmer h-80 rounded-card"></div>
        </div>
      } @else if (error()) {
        <div class="flex flex-col items-center gap-3 rounded-card border border-cloud bg-white py-16 text-center">
          <sd-icon name="wifi-off" [size]="32" class="text-alert" />
          <p class="font-sans text-body-sm text-slate">{{ error() }}</p>
        </div>
      } @else if (data(); as d) {
        @if (d.pending > 0) {
          <a routerLink="/schedule" [queryParams]="{ tab: 'pending' }" class="flex items-center gap-3 rounded-card border border-warning/30 bg-warning/5 px-5 py-4 transition-colors hover:bg-warning/10">
            <sd-icon name="triangle-alert" [size]="20" class="text-warning" />
            <span class="font-sans text-body-sm font-semibold text-warning">{{ d.pending }} booking{{ d.pending === 1 ? '' : 's' }} awaiting your confirmation</span>
            <sd-icon name="chevron-right" [size]="18" class="ml-auto text-warning" />
          </a>
        }

        <!-- Stat cards -->
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
          @for (s of stats(); track s.label) {
            <div class="flex flex-col gap-2 rounded-card border border-cloud bg-white p-4 shadow-[0_1px_2px_rgba(10,22,40,0.04)]">
              <div class="flex items-start justify-between gap-2">
                <span class="font-sans text-caption text-slate">{{ s.label }}</span>
                <span class="flex size-8 shrink-0 items-center justify-center rounded-lg" [class]="s.tint">
                  <sd-icon [name]="s.icon" [size]="16" />
                </span>
              </div>
              <p class="flex items-baseline gap-2">
                <span class="font-heading text-h4 text-ink">{{ s.value }}</span>
                @if (s.inlineSub) {
                  <span class="font-sans text-caption font-medium text-slate">{{ s.inlineSub }}</span>
                }
              </p>
              @if (s.delta !== null) {
                <div class="flex flex-wrap items-center gap-x-1.5">
                  <span class="flex items-center gap-0.5 font-sans text-caption font-semibold" [class]="s.delta >= 0 ? 'text-sage' : 'text-alert'">
                    <sd-icon [name]="s.delta >= 0 ? 'trending-up' : 'trending-down'" [size]="13" />{{ absDelta(s.delta) }}%
                  </span>
                  <span class="font-sans text-caption text-slate">{{ s.deltaPeriod }}</span>
                </div>
              }
            </div>
          }
        </div>

        <!-- Today's Schedule + Notifications -->
        @if (scheduleOpen() || notificationsOpen()) {
        <div class="grid gap-6 lg:grid-cols-2">
          @if (scheduleOpen()) {
          <section class="flex flex-col rounded-card border border-cloud bg-white">
            <div class="flex items-center justify-between gap-2 border-b border-cloud px-5 py-4">
              <div class="flex items-center gap-2">
                <sd-icon name="calendar-days" [size]="20" class="text-cerulean" />
                <h2 class="font-heading text-body-lg text-ink">Today's Schedule</h2>
              </div>
              <button type="button" class="text-slate transition-colors hover:text-ink" aria-label="Dismiss" (click)="scheduleOpen.set(false)"><sd-icon name="x" [size]="18" /></button>
            </div>
            @if (d.agenda.length === 0) {
              <div class="flex flex-1 flex-col items-center justify-center gap-2 px-5 py-12 text-center">
                <sd-icon name="calendar-off" [size]="28" class="text-slate" />
                <p class="font-sans text-body-sm text-slate">No consultations today.</p>
              </div>
            } @else {
              <ul class="flex flex-col divide-y divide-cloud">
                @for (a of d.agenda.slice(0, 4); track a.id; let i = $index) {
                  <li class="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-5 py-3.5">
                    <span class="flex size-10 shrink-0 items-center justify-center rounded-full bg-frost font-heading text-body-sm font-semibold text-cerulean">
                      {{ initialsFor(a.patient_name) }}
                    </span>
                    <div class="flex min-w-0 flex-1 flex-col">
                      <span class="truncate font-sans text-body-sm font-semibold text-ink">{{ a.patient_name }}</span>
                      <span class="truncate font-sans text-caption text-slate">{{ a.type_label }}</span>
                    </div>
                    <div class="flex flex-col items-end gap-0.5">
                      <span class="font-sans text-caption font-semibold" [class]="statusText(a)">{{ statusLabel(a) }}</span>
                      <span class="font-sans text-caption text-slate">{{ time(a.scheduled_at) }}</span>
                    </div>
                    <!-- Join the first consultation, and any whose patient is already waiting in the call
                         (never a follow-up proposal: no call until the patient accepts it). -->
                    @if ((i === firstJoinable() || patientWaiting(a.id)) && joinable(a)) {
                      <button type="button" class="ml-1 flex shrink-0 items-center gap-1 rounded-field bg-cerulean px-4 py-2 font-sans text-caption font-semibold text-white transition-colors hover:bg-ocean" (click)="join(a)">Join</button>
                    } @else {
                      <a [routerLink]="['/appointments', a.id]" class="ml-1 flex shrink-0 items-center rounded-field border border-cloud px-4 py-2 font-sans text-caption font-semibold text-cerulean transition-colors hover:border-cerulean">View</a>
                    }
                    <!-- Who is in the call: its own line under the status, so a narrow card never squeezes the name. -->
                    @if (presence()[a.id]; as p) {
                      <div class="flex min-w-0 basis-full justify-end">
                        <sd-call-presence [presence]="p" viewer="doctor" />
                      </div>
                    }
                  </li>
                }
              </ul>
              <a routerLink="/schedule" class="mt-auto flex items-center justify-center gap-1 border-t border-cloud px-5 py-3.5 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:bg-frost/30">
                View All Schedule <sd-icon name="arrow-right" [size]="16" />
              </a>
            }
          </section>
          }

          @if (notificationsOpen()) {
          <section class="flex flex-col rounded-card border border-cloud bg-white">
            <div class="flex items-center justify-between gap-2 border-b border-cloud px-5 py-4">
              <div class="flex items-center gap-2">
                <sd-icon name="bell" [size]="20" class="text-cerulean" />
                <h2 class="font-heading text-body-lg text-ink">Notifications</h2>
              </div>
              <button type="button" class="text-slate transition-colors hover:text-ink" aria-label="Dismiss" (click)="notificationsOpen.set(false)"><sd-icon name="x" [size]="18" /></button>
            </div>
            @if (notifications().length === 0) {
              <div class="flex flex-1 flex-col items-center justify-center gap-2 px-5 py-12 text-center">
                <sd-icon name="bell-off" [size]="28" class="text-slate" />
                <p class="font-sans text-body-sm text-slate">You're all caught up.</p>
              </div>
            } @else {
              <ul class="flex flex-col divide-y divide-cloud">
                @for (n of notifications().slice(0, 4); track n.id) {
                  <li class="flex items-start gap-3 px-5 py-3.5">
                    <span class="flex size-9 shrink-0 items-center justify-center rounded-full bg-frost text-cerulean">
                      <sd-icon [name]="noteIcon(n.type)" [size]="18" />
                    </span>
                    <div class="flex min-w-0 flex-1 flex-col">
                      <span class="font-sans text-body-sm font-semibold text-ink">{{ n.title }}</span>
                      @if (n.body) { <span class="truncate font-sans text-caption text-slate">{{ n.body }}</span> }
                    </div>
                    <div class="flex shrink-0 items-center gap-2">
                      <span class="font-sans text-caption text-slate">{{ ago(n.created_at) }}</span>
                      @if (!n.read) { <span class="size-2 rounded-full bg-cerulean" aria-label="Unread"></span> }
                    </div>
                  </li>
                }
              </ul>
              <a routerLink="/notifications" class="mt-auto flex items-center justify-center gap-1 border-t border-cloud px-5 py-3.5 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:bg-frost/30">
                View All Notifications <sd-icon name="arrow-right" [size]="16" />
              </a>
            }
          </section>
          }
        </div>
        }

        <!-- Quick actions -->
        <section class="flex flex-col gap-4">
          <h2 class="font-heading text-body-lg text-ink">Quick Actions</h2>
          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            @for (q of quickActions; track q.link) {
              <a [routerLink]="q.link" class="group flex flex-col items-center gap-2 rounded-card border border-cloud bg-white p-6 text-center transition-colors hover:border-cerulean/50">
                <span class="flex size-12 items-center justify-center rounded-full" [class]="q.tint">
                  <sd-icon [name]="q.icon" [size]="24" />
                </span>
                <p class="font-heading text-h5 text-ink">{{ q.label }}</p>
                <p class="font-sans text-caption text-slate">{{ q.subtitle }}</p>
                <sd-icon name="arrow-right" [size]="18" class="mt-1 text-slate transition-colors group-hover:text-cerulean" />
              </a>
            }
          </div>
        </section>

        <!-- Availability CTA -->
        <section class="flex flex-col gap-4 rounded-card bg-frost/60 px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
          <div class="flex items-center gap-3">
            <span class="flex size-11 shrink-0 items-center justify-center rounded-full bg-white text-cerulean shadow-sm">
              <sd-icon name="shield" [size]="22" />
            </span>
            <div class="flex flex-col">
              <p class="font-heading text-body-lg text-ink">Set next week's availability</p>
              <p class="font-sans text-body-sm text-slate">Doctors who keep their schedule updated get up to 3x more bookings.</p>
            </div>
          </div>
          <a routerLink="/availability" class="flex shrink-0 items-center justify-center gap-2 rounded-field bg-cerulean px-5 py-3 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean">
            <sd-icon name="calendar-clock" [size]="18" />Manage Availability
          </a>
        </section>
      }
    </div>
  `,
})
export class DoctorDashboard implements OnInit {
  private readonly api = inject(DoctorApi);
  private readonly notificationsApi = inject(StaffNotificationsApi);
  private readonly auth = inject(StaffAuthService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly standing = inject(DoctorStandingStore);

  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly data = signal<DoctorDashboardDto | null>(null);
  protected readonly notifications = signal<StaffNotificationDto[]>([]);
  // The two summary cards are dismissable (matches the design's ✕ affordance).
  protected readonly scheduleOpen = signal(true);
  protected readonly notificationsOpen = signal(true);
  /** Who is in each consultation's call right now (polled; not while clinical work is closed to them). */
  protected readonly presence = injectCallPresence(() => (this.standing.blocked() ? EMPTY : this.api.presence()));

  /** What needs the doctor's attention about their account (see `standingNotices`). */
  protected readonly notices = computed<StandingNotice[]>(() => {
    const o = this.standing.onboarding();
    return o ? standingNotices(o, todayLocal()) : [];
  });
  /** Suspended: no dashboard figures (the API refuses them) — what still works instead. */
  protected readonly suspended = computed(() => this.standing.code() === 'doctor_suspended');
  protected readonly suspendedLinks: QuickAction[] = [
    { label: 'Earnings', subtitle: 'What you have earned', icon: 'banknote', tint: 'bg-sage/15 text-sage', link: '/earnings' },
    { label: 'Payout history', subtitle: 'Payouts and your account', icon: 'wallet', tint: 'bg-cerulean/10 text-cerulean', link: '/payouts' },
    { label: 'Licensing documents', subtitle: 'Upload or renew', icon: 'file-check', tint: 'bg-warning/15 text-warning', link: '/onboarding/credentials' },
  ];

  protected readonly greeting = computed(() => {
    const h = new Date().getHours();
    const part = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    const first = this.auth.displayName().split(/\s+/).filter(Boolean)[0] ?? '';
    return first ? `${part}, Dr ${first}` : part;
  });

  protected readonly stats = computed<Stat[]>(() => {
    const d = this.data();
    if (!d) return [];
    return [
      {
        label: "Today's Appointments",
        value: d.today,
        icon: 'calendar-days',
        tint: 'bg-frost text-cerulean',
        inlineSub: `${d.today_completed} completed`,
        delta: d.today_delta,
        deltaPeriod: 'vs. yesterday',
      },
      {
        label: 'Completed Consultation',
        value: d.completed_month,
        icon: 'circle-check',
        tint: 'bg-sage/15 text-sage',
        delta: d.completed_delta,
        deltaPeriod: 'vs last month',
      },
      {
        // All-time distinct patients (a cumulative total), so no week-over-week
        // delta is attached — that basis mismatch made a returning-patient week
        // read as a drop. The subtext states patients SEEN this week, not added.
        label: 'Patients',
        value: d.patients,
        icon: 'users',
        tint: 'bg-cerulean/10 text-cerulean',
        inlineSub: `${d.patients_week} seen this week`,
        delta: null,
      },
      {
        label: 'Earnings',
        value: this.money(d.currency, d.earnings_month),
        icon: 'wallet',
        tint: 'bg-sage/15 text-sage',
        delta: d.earnings_delta,
        deltaPeriod: 'vs last month',
      },
      {
        label: 'Average Rating',
        value: d.rating,
        icon: 'star',
        tint: 'bg-warning/15 text-warning',
        inlineSub: `${d.reviews_count} reviews`,
        delta: null,
      },
    ];
  });

  protected readonly quickActions: QuickAction[] = [
    { label: 'Patients', subtitle: 'View and manage your patient roster', icon: 'users', tint: 'bg-cerulean/10 text-cerulean', link: '/patients' },
    { label: 'Consultation History', subtitle: 'Review your past consultations', icon: 'calendar-clock', tint: 'bg-sage/15 text-sage', link: '/appointments/history' },
    { label: 'My Appointments', subtitle: 'View and manage your appointments', icon: 'calendar-days', tint: 'bg-cerulean/10 text-cerulean', link: '/schedule' },
    { label: 'Reviews', subtitle: 'See what your patients are saying', icon: 'star', tint: 'bg-warning/15 text-warning', link: '/reviews' },
  ];

  ngOnInit(): void {
    // The standing first (fresh: the banners are read here): a suspended doctor's
    // figures are refused, so they aren't asked for. Unreadable → load anyway.
    void this.standing.load(true).then((o) => {
      if (o?.status === 'suspended') {
        this.loading.set(false);
        return;
      }
      this.loadDashboard();
    });

    this.notificationsApi
      .list({ per_page: 5 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => this.notifications.set(res.data),
        error: () => undefined,
      });
  }

  private loadDashboard(): void {
    this.api
      .dashboard()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.data.set(res.data);
          this.loading.set(false);
        },
        error: (err: unknown) => {
          this.error.set(apiErrorMessage(err, 'Could not load your dashboard.'));
          this.loading.set(false);
        },
      });
  }

  protected tone(n: StandingNotice): { card: string; accent: string } {
    return NOTICE_TONE[n.tone];
  }

  protected join(a: DoctorAppointmentDto): void {
    // The API decides per consultation: owing the terms blocks one that hasn't
    // started (accept them first), never one already under way.
    if (a.join_blocked) {
      void this.router.navigateByUrl(a.join_blocked.code === 'terms_required' ? '/onboarding/terms' : '/account-status');
      return;
    }
    // No link on an unaccepted follow-up proposal — there is no call to join yet.
    const url = a.join_url;
    if (!url) return;
    const marker = '/call/join/';
    const idx = url.indexOf(marker);
    const token = idx >= 0 ? url.slice(idx + marker.length) : '';
    if (token) void this.router.navigate(['/call', token]);
    else window.location.href = url;
  }

  /** The patient has joined this consultation's call and is waiting for the doctor. */
  protected patientWaiting(id: string): boolean {
    return this.presence()[id]?.patient === true;
  }
  protected absDelta(delta: number): number {
    return Math.abs(delta);
  }
  /** The agenda's status colour, from the lifecycle (In progress, Being finalised, Missed…). */
  protected statusText(a: DoctorAppointmentDto): string {
    return statusLook(a).text;
  }
  /** A booking still to come or under way — not a proposal, nor one that is over. */
  protected joinable(a: DoctorAppointmentDto): boolean {
    return isOpenBooking(a) && !isPast(a);
  }
  /** The agenda row that gets the Join button: the first still joinable one. */
  protected readonly firstJoinable = computed(() => (this.data()?.agenda ?? []).findIndex((a) => this.joinable(a)));
  /** "Awaiting patient" for a follow-up proposal (the API leaves them off the agenda), else the lifecycle label. */
  protected statusLabel(a: DoctorAppointmentDto): string {
    return doctorStatusLabel(a);
  }
  protected noteIcon(type: string): string {
    return NOTE_ICON[type] ?? 'bell';
  }
  protected initialsFor(name: string): string {
    return name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase();
  }
  protected time(iso: string): string {
    return new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  }
  protected ago(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.round(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}min${mins === 1 ? '' : 's'} ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}hr${hrs === 1 ? '' : 's'} ago`;
    const days = Math.round(hrs / 24);
    return `${days}d ago`;
  }
  private money(currency: string, amount: string): string {
    const n = Number(amount);
    return (currency || '₦') + (isNaN(n) ? '0' : n.toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 0 }));
  }
}
