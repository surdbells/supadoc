import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import {
  AppointmentsApi,
  NotificationsApi,
  PatientApi,
} from '@supadoc/data-access';
import type { AppointmentDto } from '@supadoc/models';
import { ButtonComponent, IconComponent } from '@supadoc/ui';

interface QuickAction {
  readonly icon: string;
  readonly title: string;
  readonly subtitle: string;
  readonly tint: string;
  readonly link: string;
}

interface Notice {
  readonly id: string;
  readonly icon: string;
  readonly tint: string;
  readonly title: string;
  readonly body: string;
  readonly time: string;
  readonly unread: boolean;
}

const NOTIF_STYLE: Record<string, { icon: string; tint: string }> = {
  appointment: { icon: 'calendar-days', tint: 'bg-frost text-cerulean' },
  prescription: { icon: 'pill', tint: 'bg-teal/10 text-teal' },
  payment: { icon: 'banknote', tint: 'bg-sage/10 text-sage' },
  system: { icon: 'bell', tint: 'bg-sky/10 text-sky' },
};

interface UpcomingVm {
  readonly id: string;
  readonly name: string;
  readonly specialty: string;
  readonly date: string;
  readonly time: string;
  readonly typeLabel: string;
  readonly typeIcon: string;
  readonly statusLabel: string;
  readonly badgeClass: string;
}

const TYPE_ICON: Record<string, string> = {
  video: 'video',
  follow_up: 'refresh-cw',
  urgent: 'zap',
  routine: 'calendar-check',
};

const UPCOMING_BADGE: Record<string, string> = {
  confirmed: 'bg-sage',
  pending: 'bg-warning',
  rescheduled: 'bg-slate',
};

/** Patient dashboard home (Figma 666:9342). */
@Component({
  selector: 'pat-dashboard-home',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, ButtonComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <!-- Welcome banner -->
      <section
        class="relative flex items-center justify-between overflow-hidden rounded-card bg-sky/10 px-6 py-4"
      >
        <div class="flex flex-col gap-2.5">
          <h1 class="font-heading text-h2 text-ocean">
            Good morning, {{ firstName() }} 👋
          </h1>
          <p class="font-sans text-h5 text-ink">
            Here's your health summary for today.
          </p>
        </div>
        <div class="hidden shrink-0 sm:block" aria-hidden="true">
          <img
            src="/dashboard/hero.png"
            alt=""
            width="315"
            height="224"
            class="h-[149px] w-auto object-contain"
          />
        </div>
        <div
          class="absolute bottom-0 left-6 rounded-t-card bg-sky px-4 py-1 font-sans text-caption text-white"
        >
          Stay on top of your health. You're doing great!
        </div>
      </section>

      <!-- Widgets -->
      <section class="flex flex-col gap-4">
        <h2 class="font-sans text-h5 text-ink">Widgets</h2>
        <div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <!-- Profile Summary -->
          <article
            class="flex flex-col gap-6 rounded-card border-[0.5px] border-ash px-6 py-4"
          >
            <header class="flex items-center gap-2">
              <sd-icon name="user" [size]="20" class="text-ink" />
              <h3 class="font-sans text-body font-semibold text-ink">
                Profile Summary
              </h3>
            </header>
            <div class="flex items-center gap-2">
              @if (avatarSrc()) {
                <img
                  [src]="avatarSrc()"
                  alt="Profile photo"
                  width="40"
                  height="40"
                  class="size-10 shrink-0 rounded-full object-cover"
                />
              } @else {
                <span
                  class="flex size-10 shrink-0 items-center justify-center rounded-full bg-cerulean/15 font-heading text-body-sm font-semibold text-cerulean"
                >
                  @if (initials()) {
                    {{ initials() }}
                  } @else {
                    <sd-icon name="user" [size]="18" />
                  }
                </span>
              }
              <div class="flex min-w-0 flex-col">
                <p class="truncate font-sans text-body font-semibold text-ink">
                  {{ fullName() }}
                </p>
                <p class="truncate font-sans text-caption text-slate">
                  {{ email() }}
                </p>
              </div>
            </div>
            @if (profileComplete() < 100) {
              <div class="flex flex-col gap-1">
                <div
                  class="h-1.5 w-full overflow-hidden rounded-full bg-frost"
                  role="progressbar"
                  aria-label="Profile completion"
                  [attr.aria-valuenow]="profileComplete()"
                  aria-valuemin="0"
                  aria-valuemax="100"
                >
                  <div
                    class="h-full rounded-full bg-cerulean"
                    [style.width.%]="profileComplete()"
                  ></div>
                </div>
                <div class="flex items-center justify-between">
                  <span class="font-sans text-caption text-slate"
                    >Profile complete</span
                  >
                  <span class="font-sans text-body font-semibold text-sage"
                    >{{ profileComplete() }}%</span
                  >
                </div>
              </div>
              <sd-button
                variant="outline"
                size="sm"
                [full]="true"
                (click)="viewProfile()"
                >Complete Profile</sd-button
              >
            } @else {
              <sd-button
                variant="outline"
                size="sm"
                [full]="true"
                (click)="viewProfile()"
                >View Profile</sd-button
              >
            }
          </article>

          <!-- Upcoming Appointment -->
          <article
            class="relative flex flex-col gap-6 rounded-card border-[0.5px] border-ash px-6 py-4"
          >
            <button
              type="button"
              class="absolute right-4 top-4 text-slate transition-colors hover:text-ink"
              aria-label="Dismiss upcoming appointment"
            >
              <sd-icon name="x" [size]="16" />
            </button>
            <header class="flex items-center gap-2">
              <sd-icon name="calendar-days" [size]="20" class="text-ink" />
              <h3 class="font-sans text-body font-semibold text-ink">
                Upcoming Appointment
              </h3>
            </header>
            @if (loadingUpcoming()) {
              <div class="flex flex-col gap-3">
                <div class="h-10 animate-pulse rounded bg-cloud"></div>
                <div class="h-3 w-2/3 animate-pulse rounded bg-cloud"></div>
              </div>
            } @else if (upcoming(); as u) {
              <div class="flex items-center justify-between gap-2">
                <div class="flex items-center gap-2">
                  <img
                    src="/dashboard/avatar-james.png"
                    alt=""
                    width="40"
                    height="40"
                    class="size-10 shrink-0 rounded-full object-cover"
                  />
                  <div class="flex flex-col">
                    <p class="font-sans text-body font-semibold text-ink">
                      {{ u.name }}
                    </p>
                    <p class="font-sans text-caption text-slate">
                      {{ u.specialty }}
                    </p>
                  </div>
                </div>
                <span
                  class="rounded-lg px-4 py-1 font-sans text-[10px] font-medium leading-4 text-white"
                  [class]="u.badgeClass"
                  >{{ u.statusLabel }}</span
                >
              </div>
              <div class="flex flex-col gap-2">
                <div class="flex items-center justify-between">
                  <span class="flex items-center gap-2 text-slate">
                    <sd-icon name="calendar-days" [size]="16" />
                    <span class="font-sans text-caption">{{ u.date }}</span>
                  </span>
                  <span class="flex items-center gap-2 text-slate">
                    <sd-icon [name]="u.typeIcon" [size]="16" />
                    <span class="font-sans text-caption">{{ u.typeLabel }}</span>
                  </span>
                </div>
                <span class="flex items-center gap-2 text-slate">
                  <sd-icon name="clock" [size]="16" />
                  <span class="font-sans text-caption">{{ u.time }}</span>
                </span>
              </div>
              <div class="flex gap-6">
                <sd-button
                  variant="outline"
                  size="sm"
                  [full]="true"
                  (click)="viewAppointments()"
                  >View All</sd-button
                >
                <sd-button size="sm" [full]="true" (click)="joinCall(u.id)">
                  <sd-icon name="video" [size]="18" />
                  Join Call
                </sd-button>
              </div>
            } @else {
              <div
                class="flex flex-1 flex-col items-center justify-center gap-3 py-6 text-center"
              >
                <sd-icon name="calendar-off" [size]="28" class="text-slate" />
                <p class="font-sans text-caption text-slate">
                  No upcoming appointments
                </p>
                <sd-button
                  variant="outline"
                  size="sm"
                  (click)="viewAppointments()"
                  >View All</sd-button
                >
              </div>
            }
          </article>

          <!-- Wallet -->
          <article
            class="relative flex flex-col gap-4 rounded-card border-[0.5px] border-ash px-6 py-4"
          >
            <header class="flex items-center gap-2">
              <sd-icon name="wallet" [size]="20" class="text-ink" />
              <h3 class="font-sans text-body font-semibold text-ink">Wallet</h3>
            </header>
            <div
              class="flex flex-1 flex-col items-center justify-center gap-2 py-8 text-center"
            >
              <span
                class="flex size-12 items-center justify-center rounded-full bg-cloud text-slate"
              >
                <sd-icon name="wallet" [size]="24" />
              </span>
              <p class="font-sans text-body-sm font-medium text-ink">
                Coming soon
              </p>
              <p class="font-sans text-caption text-slate">
                Manage payments and transactions here.
              </p>
            </div>
          </article>
        </div>
      </section>

      <!-- Notifications + Quick Actions -->
      <section class="flex flex-col gap-6 xl:flex-row">
        <!-- Notifications -->
        <article
          class="relative flex shrink-0 flex-col gap-6 rounded-card border-[0.5px] border-ash px-6 py-4 xl:w-[360px]"
        >
          <header class="flex items-center gap-2">
            <sd-icon name="bell" [size]="20" class="text-ink" />
            <h3 class="flex-1 font-sans text-body font-semibold text-ink">
              Notifications
            </h3>
            <button
              type="button"
              class="font-sans text-caption text-cerulean hover:underline"
              (click)="viewNotifications()"
            >
              View all
            </button>
          </header>
          @if (notifications().length === 0) {
            <p class="py-6 text-center font-sans text-body-sm text-slate">
              You're all caught up.
            </p>
          } @else {
          <ul class="flex flex-col gap-6">
            @for (n of notifications(); track n.id) {
              <li class="flex items-start gap-2">
                <span
                  class="flex size-8 shrink-0 items-center justify-center rounded-full"
                  [class]="n.tint"
                >
                  <sd-icon [name]="n.icon" [size]="16" />
                </span>
                <div class="flex min-w-0 flex-1 flex-col gap-1">
                  <div class="flex items-center justify-between gap-2">
                    <p class="font-sans text-body-sm font-medium text-ink">
                      {{ n.title }}
                    </p>
                    <span class="shrink-0 font-sans text-caption text-slate">{{
                      n.time
                    }}</span>
                  </div>
                  <p class="font-sans text-caption text-slate">{{ n.body }}</p>
                </div>
                @if (n.unread) {
                  <span
                    class="mt-1.5 size-2 shrink-0 rounded-full bg-cerulean"
                    aria-label="Unread"
                  ></span>
                }
              </li>
            }
          </ul>
          }
        </article>

        <!-- Quick Actions -->
        <div class="flex min-w-0 flex-1 flex-col gap-4">
          <h2 class="font-sans text-h5 text-ink">Quick Actions</h2>
          <div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
            @for (a of quickActions; track a.title) {
              <button
                type="button"
                class="flex flex-col items-center gap-4 rounded-card border-[0.5px] border-ash bg-glacier px-2 py-4 text-center transition-colors hover:border-cerulean"
                (click)="go(a.link)"
              >
                <span
                  class="flex items-center justify-center rounded-full p-2"
                  [class]="a.tint"
                >
                  <sd-icon [name]="a.icon" [size]="24" />
                </span>
                <span class="flex flex-col gap-2">
                  <span class="font-sans text-body font-semibold text-ink">{{
                    a.title
                  }}</span>
                  <span class="font-sans text-caption text-slate">{{
                    a.subtitle
                  }}</span>
                </span>
                <sd-icon name="arrow-right" [size]="16" class="text-ink" />
              </button>
            }
          </div>
        </div>
      </section>

      <!-- Health Tip -->
      <section
        class="flex items-center justify-between gap-6 rounded-card bg-gradient-to-r from-frost to-mist p-6"
      >
        <div class="flex items-center gap-6">
          <sd-icon name="shield-check" [size]="32" class="shrink-0 text-teal" />
          <div class="flex flex-col gap-2">
            <h3 class="font-sans text-body font-semibold text-abyss">
              Health Tip of the day
            </h3>
            <p class="font-sans text-body-sm text-slate">
              Stay hydrated and get enough sleep to keep your heart healthy
            </p>
          </div>
        </div>
        <sd-button size="sm" class="shrink-0">Learn more</sd-button>
      </section>
    </div>
  `,
})
export class DashboardHome {
  private readonly appointments = inject(AppointmentsApi);
  private readonly patient = inject(PatientApi);
  private readonly notificationsApi = inject(NotificationsApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);

  // Name/email come from GET /api/portal/me; neutral until it resolves.
  protected readonly firstName = signal('there');
  protected readonly fullName = signal('');
  protected readonly email = signal('');

  protected readonly initials = computed(() =>
    this.fullName()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase(),
  );
  protected readonly avatarPath = signal<string | null>(null);
  protected readonly avatarSrc = computed(() =>
    this.patient.assetUrl(this.avatarPath()),
  );
  // Profile completeness from the fields the backend actually stores.
  protected readonly profileComplete = signal(0);

  // Upcoming Appointment widget — wired to GET /api/portal/appointments.
  protected readonly upcoming = signal<UpcomingVm | null>(null);
  protected readonly loadingUpcoming = signal(true);

  // Notifications widget — the most recent few from GET /api/portal/notifications.
  protected readonly notifications = signal<Notice[]>([]);

  constructor() {
    this.notificationsApi
      .list({ per_page: 4 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) =>
          this.notifications.set(
            res.data.map((n) => ({
              id: n.id,
              icon: NOTIF_STYLE[n.type]?.icon ?? 'bell',
              tint: NOTIF_STYLE[n.type]?.tint ?? 'bg-cloud text-slate',
              title: n.title,
              body: n.body,
              time: this.relative(n.created_at),
              unread: !n.read,
            })),
          ),
        error: () => {
          /* leave the widget empty on failure */
        },
      });

    this.appointments
      .listMine({ per_page: 100, sort_by: 'scheduled_at', sort_dir: 'asc' })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.upcoming.set(this.pickUpcoming(res.data));
          this.loadingUpcoming.set(false);
        },
        error: () => this.loadingUpcoming.set(false),
      });

    this.patient
      .me()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          const p = res.data;
          if (p.first_name) this.firstName.set(p.first_name);
          const full = `${p.first_name} ${p.last_name}`.trim();
          if (full) this.fullName.set(full);
          if (p.email) this.email.set(p.email);
          this.avatarPath.set(p.avatar_url ?? null);

          const filled =
            (p.first_name && p.last_name ? 1 : 0) +
            (p.email ? 1 : 0) +
            (p.phone ? 1 : 0) +
            (p.date_of_birth ? 1 : 0);
          this.profileComplete.set(Math.round((filled / 4) * 100));
        },
        error: () => {
          /* keep placeholders on failure */
        },
      });
  }

  protected viewAppointments(): void {
    void this.router.navigate(['/dashboard/appointments']);
  }

  protected joinCall(id: string): void {
    void this.router.navigate(['/dashboard/call', id]);
  }

  /** The soonest appointment still in an upcoming (non-terminal) state. */
  private pickUpcoming(list: AppointmentDto[]): UpcomingVm | null {
    const next = list.find(
      (a) =>
        a.status === 'pending' ||
        a.status === 'confirmed' ||
        a.status === 'rescheduled',
    );
    if (!next) return null;
    const when = new Date(next.scheduled_at);
    return {
      id: next.id,
      name: next.specialist.name,
      specialty: next.specialist.specialty ?? '',
      date: new Intl.DateTimeFormat('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }).format(when),
      time: new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }).format(when),
      typeLabel: next.type_label,
      typeIcon: TYPE_ICON[next.type] ?? 'video',
      statusLabel: next.status_label,
      badgeClass: UPCOMING_BADGE[next.status] ?? 'bg-slate',
    };
  }

  protected viewNotifications(): void {
    void this.router.navigate(['/dashboard/notifications']);
  }

  private relative(iso: string): string {
    const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    if (min < 1) return 'Just now';
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    return `${Math.round(hr / 24)}d ago`;
  }

  protected go(link: string): void {
    void this.router.navigate([link]);
  }

  protected viewProfile(): void {
    void this.router.navigate(['/dashboard/profile']);
  }

  protected readonly quickActions: QuickAction[] = [
    {
      icon: 'stethoscope',
      title: 'Find a Specialist',
      subtitle: 'Search and connect with trusted specialist',
      tint: 'bg-cerulean/10 text-cerulean',
      link: '/dashboard/specialists',
    },
    {
      icon: 'calendar-clock',
      title: 'Book Consultation',
      subtitle: 'Book an appointment with a doctor',
      tint: 'bg-teal/10 text-teal',
      link: '/dashboard/specialists',
    },
    {
      icon: 'calendar-days',
      title: 'My Appointments',
      subtitle: 'View and manage your appointments',
      tint: 'bg-sky/10 text-sky',
      link: '/dashboard/appointments',
    },
    {
      icon: 'history',
      title: 'History',
      subtitle: 'View your past consultation',
      tint: 'bg-sage/10 text-sage',
      link: '/dashboard/history',
    },
  ];
}
