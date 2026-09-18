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
import { StaffAuthService } from '@supadoc/auth';
import { DoctorApi, StaffNotificationsApi } from '@supadoc/data-access';
import type {
  DoctorAppointmentDto,
  DoctorDashboardDto,
  StaffNotificationDto,
} from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';

interface Stat {
  readonly label: string;
  readonly value: string | number;
  readonly icon: string;
  readonly tint: string;
  readonly hint?: string;
  readonly delta: number | null;
  readonly deltaPeriod?: string;
}

interface QuickAction {
  readonly label: string;
  readonly subtitle: string;
  readonly icon: string;
  readonly tint: string;
  readonly link: string;
}

const STATUS_CLASS: Record<string, string> = {
  pending: 'bg-warning/15 text-warning',
  confirmed: 'bg-sage/15 text-sage',
  rescheduled: 'bg-cloud text-slate',
  completed: 'bg-frost text-cerulean',
  cancelled: 'bg-alert/10 text-alert',
};

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
  imports: [RouterLink, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <header class="flex flex-col gap-1">
        <h1 class="font-heading text-h3 text-ink">{{ greeting() }} 👋</h1>
        <p class="font-sans text-body text-slate">Here's your activities for today.</p>
      </header>

      @if (loading()) {
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
          <a routerLink="/schedule" class="flex items-center gap-3 rounded-card border border-warning/30 bg-warning/5 px-5 py-4 transition-colors hover:bg-warning/10">
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
              <p class="font-heading text-h4 text-ink">{{ s.value }}</p>
              <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                @if (s.delta !== null) {
                  <span class="flex items-center gap-0.5 font-sans text-caption font-semibold" [class]="s.delta >= 0 ? 'text-sage' : 'text-alert'">
                    <sd-icon [name]="s.delta >= 0 ? 'trending-up' : 'trending-down'" [size]="13" />{{ absDelta(s.delta) }}%
                  </span>
                  <span class="font-sans text-caption text-slate">{{ s.deltaPeriod }}</span>
                } @else if (s.hint) {
                  <span class="font-sans text-caption text-slate">{{ s.hint }}</span>
                }
                @if (s.delta !== null && s.hint) {
                  <span class="font-sans text-caption text-slate">· {{ s.hint }}</span>
                }
              </div>
            </div>
          }
        </div>

        <!-- Today's Schedule + Notifications -->
        <div class="grid gap-6 lg:grid-cols-2">
          <section class="flex flex-col rounded-card border border-cloud bg-white">
            <div class="flex items-center gap-2 border-b border-cloud px-5 py-4">
              <sd-icon name="calendar-days" [size]="20" class="text-cerulean" />
              <h2 class="font-heading text-body-lg text-ink">Today's Schedule</h2>
            </div>
            @if (d.agenda.length === 0) {
              <div class="flex flex-1 flex-col items-center justify-center gap-2 px-5 py-12 text-center">
                <sd-icon name="calendar-off" [size]="28" class="text-slate" />
                <p class="font-sans text-body-sm text-slate">No consultations today.</p>
              </div>
            } @else {
              <ul class="flex flex-col divide-y divide-cloud">
                @for (a of d.agenda.slice(0, 4); track a.id) {
                  <li class="flex items-center gap-3 px-5 py-3.5">
                    <span class="flex size-10 shrink-0 items-center justify-center rounded-full bg-frost font-heading text-body-sm font-semibold text-cerulean">
                      {{ initialsFor(a.patient_name) }}
                    </span>
                    <div class="flex min-w-0 flex-1 flex-col">
                      <span class="truncate font-sans text-body-sm font-semibold text-ink">{{ a.patient_name }}</span>
                      <span class="truncate font-sans text-caption text-slate">{{ a.type_label }}</span>
                    </div>
                    <div class="flex flex-col items-end gap-1">
                      <span class="rounded-pill px-2 py-0.5 text-[10px] font-semibold" [class]="statusClass(a.status)">{{ a.status_label }}</span>
                      <span class="font-sans text-caption text-slate">{{ time(a.scheduled_at) }}</span>
                    </div>
                    <button type="button" class="ml-1 flex shrink-0 items-center gap-1 rounded-field bg-cerulean px-3 py-2 font-sans text-caption font-semibold text-white transition-colors hover:bg-ocean" (click)="join(a)">
                      <sd-icon name="video" [size]="14" />Join
                    </button>
                  </li>
                }
              </ul>
              <a routerLink="/schedule" class="mt-auto flex items-center justify-center gap-1 border-t border-cloud px-5 py-3.5 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:bg-frost/30">
                View all schedule <sd-icon name="arrow-right" [size]="16" />
              </a>
            }
          </section>

          <section class="flex flex-col rounded-card border border-cloud bg-white">
            <div class="flex items-center gap-2 border-b border-cloud px-5 py-4">
              <sd-icon name="bell" [size]="20" class="text-cerulean" />
              <h2 class="font-heading text-body-lg text-ink">Notifications</h2>
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
                    <span class="shrink-0 font-sans text-caption text-slate">{{ ago(n.created_at) }}</span>
                  </li>
                }
              </ul>
              <a routerLink="/notifications" class="mt-auto flex items-center justify-center gap-1 border-t border-cloud px-5 py-3.5 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:bg-frost/30">
                View all notifications <sd-icon name="arrow-right" [size]="16" />
              </a>
            }
          </section>
        </div>

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
              <p class="font-heading text-body-lg text-ink">Keep your availability updated</p>
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

  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly data = signal<DoctorDashboardDto | null>(null);
  protected readonly notifications = signal<StaffNotificationDto[]>([]);

  protected readonly greeting = computed(() => {
    const h = new Date().getHours();
    const part = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    const name = this.auth.displayName();
    return name ? `${part}, ${name}` : part;
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
        hint: `${d.today_completed} completed`,
        delta: d.today_delta,
        deltaPeriod: 'vs yesterday',
      },
      {
        label: 'Completed',
        value: d.completed_month,
        icon: 'circle-check',
        tint: 'bg-sage/15 text-sage',
        hint: 'this month',
        delta: d.completed_delta,
        deltaPeriod: 'vs last month',
      },
      {
        label: 'Patients',
        value: d.patients,
        icon: 'users',
        tint: 'bg-cerulean/10 text-cerulean',
        hint: `+${d.patients_week} this week`,
        delta: d.patients_delta,
        deltaPeriod: 'vs last week',
      },
      {
        label: 'Earnings',
        value: this.money(d.currency, d.earnings_month),
        icon: 'wallet',
        tint: 'bg-sage/15 text-sage',
        hint: 'this month',
        delta: d.earnings_delta,
        deltaPeriod: 'vs last month',
      },
      {
        label: 'Average Rating',
        value: d.rating,
        icon: 'star',
        tint: 'bg-warning/15 text-warning',
        hint: `${d.reviews_count} reviews`,
        delta: null,
      },
    ];
  });

  protected readonly quickActions: QuickAction[] = [
    { label: 'Patients', subtitle: 'View and manage your patient roster', icon: 'users', tint: 'bg-cerulean/10 text-cerulean', link: '/patients' },
    { label: 'History', subtitle: 'Review your past consultations', icon: 'history', tint: 'bg-sage/15 text-sage', link: '/appointments/history' },
    { label: 'Schedule', subtitle: 'View and manage your appointments', icon: 'calendar-days', tint: 'bg-cerulean/10 text-cerulean', link: '/schedule' },
    { label: 'Availability', subtitle: 'Manage your consultation hours', icon: 'calendar-clock', tint: 'bg-sage/15 text-sage', link: '/availability' },
  ];

  ngOnInit(): void {
    this.api
      .dashboard()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.data.set(res.data);
          this.loading.set(false);
        },
        error: () => {
          this.error.set('Could not load your dashboard.');
          this.loading.set(false);
        },
      });

    this.notificationsApi
      .list({ per_page: 5 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => this.notifications.set(res.data),
        error: () => undefined,
      });
  }

  protected join(a: DoctorAppointmentDto): void {
    const marker = '/call/join/';
    const idx = a.join_url.indexOf(marker);
    const token = idx >= 0 ? a.join_url.slice(idx + marker.length) : '';
    if (token) void this.router.navigate(['/call', token]);
    else window.location.href = a.join_url;
  }

  protected absDelta(delta: number): number {
    return Math.abs(delta);
  }
  protected statusClass(status: string): string {
    return STATUS_CLASS[status] ?? 'bg-cloud text-slate';
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
