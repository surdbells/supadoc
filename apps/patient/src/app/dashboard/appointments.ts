import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { map } from 'rxjs';
import { AppointmentsApi } from '@supadoc/data-access';
import type { AppointmentDto } from '@supadoc/models';
import { ButtonComponent, EmptyStateComponent, IconComponent } from '@supadoc/ui';

type Status =
  'confirmed' | 'pending' | 'completed' | 'cancelled' | 'rescheduled';
type Tab = 'all' | 'upcoming' | 'completed' | 'cancelled' | 'rescheduled';

interface Appointment {
  readonly id: string;
  readonly photo: string;
  readonly name: string;
  readonly specialty: string;
  readonly date: string;
  readonly time: string;
  readonly typeIcon: string;
  readonly typeLabel: string;
  readonly status: Status;
}

const STATUS: Record<Status, { label: string; class: string }> = {
  confirmed: { label: 'Confirmed', class: 'bg-sage/15 text-sage' },
  pending: { label: 'Pending', class: 'bg-warning/15 text-warning' },
  completed: { label: 'Completed', class: 'bg-frost text-cerulean' },
  cancelled: { label: 'Cancelled', class: 'bg-alert/10 text-alert' },
  rescheduled: { label: 'Rescheduled', class: 'bg-cloud text-slate' },
};

const TAB_OF: Record<Status, Tab> = {
  confirmed: 'upcoming',
  pending: 'upcoming',
  rescheduled: 'rescheduled',
  completed: 'completed',
  cancelled: 'cancelled',
};

const TYPE_ICON: Record<string, string> = {
  video: 'video',
  follow_up: 'refresh-cw',
  urgent: 'zap',
  routine: 'calendar-check',
};

/** Maps a backend appointment onto the row shape this screen renders. */
export function toAppointmentRow(a: AppointmentDto): Appointment {
  const when = new Date(a.scheduled_at);
  return {
    id: a.id,
    // The API has no avatar yet — use the placeholder portrait.
    photo: '/dashboard/avatar-james.png',
    name: a.specialist.name,
    specialty: a.specialist.specialty ?? '',
    date: new Intl.DateTimeFormat('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(when),
    time: new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(when),
    typeIcon: TYPE_ICON[a.type] ?? 'calendar-check',
    typeLabel: a.type_label,
    status: a.status,
  };
}

/**
 * My Appointments (Figma 497:7793) with inline loading, empty (826:12182) and
 * error (826:12960) states. Data comes from `GET /api/portal/appointments`;
 * `?view=empty|error` still forces a state for design QA. Row → details route.
 */
@Component({
  selector: 'pat-appointments',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, EmptyStateComponent, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <!-- Header -->
      <div class="flex items-start justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">My Appointments</h1>
          <p class="font-sans text-body text-slate">
            View and manage your scheduled consultations
          </p>
        </div>
        <sd-button size="sm" (click)="book()">
          <sd-icon name="plus" [size]="18" />
          Book Consultation
        </sd-button>
      </div>

      <!-- Tabs -->
      <div
        class="flex items-center gap-1 overflow-x-auto rounded-pill border border-cloud bg-white p-2"
      >
        @for (t of tabs; track t.key) {
          <button
            type="button"
            class="flex shrink-0 items-center gap-2 rounded-pill px-4 py-1.5 font-sans text-body-sm transition-colors"
            [class]="
              activeTab() === t.key
                ? 'bg-frost font-medium text-cerulean'
                : 'text-slate hover:text-ink'
            "
            (click)="activeTab.set(t.key)"
          >
            {{ t.label }}
            @if (t.key === 'upcoming' && upcomingCount() > 0) {
              <span
                class="flex size-4 items-center justify-center rounded-full bg-cerulean text-[10px] font-semibold text-white"
                >{{ upcomingCount() }}</span
              >
            }
          </button>
        }
      </div>

      @switch (viewState()) {
        @case ('loading') {
          <div class="flex flex-col gap-4">
            @for (n of [1, 2, 3]; track n) {
              <div
                class="flex items-center gap-4 rounded-card border border-cloud bg-white p-4"
              >
                <div
                  class="size-14 shrink-0 animate-pulse rounded-full bg-cloud"
                ></div>
                <div class="flex flex-1 flex-col gap-2">
                  <div class="h-3 w-40 animate-pulse rounded bg-cloud"></div>
                  <div class="h-3 w-24 animate-pulse rounded bg-cloud"></div>
                </div>
              </div>
            }
          </div>
        }
        @case ('error') {
          <sd-empty-state
            tone="error"
            icon="wifi-off"
            title="Unable to load appointments"
            message="We couldn't retrieve your appointments. Check your connection and try again."
          >
            <sd-button variant="outline" (click)="reload()">Try Again</sd-button>
          </sd-empty-state>
        }
        @case ('empty') {
          <sd-empty-state
            icon="calendar-off"
            title="You have no appointment history"
            message="Book a consultation with our healthcare professionals to get started"
          >
            <sd-button (click)="book()">
              <sd-icon name="calendar-days" [size]="18" />
              Book a Consultation
            </sd-button>
          </sd-empty-state>
        }
        @default {
          <div class="flex flex-col gap-4">
            @for (a of filtered(); track a.id) {
              <button
                type="button"
                class="sd-card-hover flex items-center gap-4 rounded-card border border-cloud bg-white p-4 text-left hover:border-cerulean/50"
                (click)="open(a)"
              >
                <img
                  [src]="a.photo"
                  alt=""
                  width="56"
                  height="56"
                  class="size-14 shrink-0 rounded-full object-cover"
                />
                <div class="flex min-w-0 flex-1 flex-col">
                  <p
                    class="truncate font-sans text-body font-semibold text-ink"
                  >
                    {{ a.name }}
                  </p>
                  <p class="truncate font-sans text-caption text-slate">
                    {{ a.specialty }}
                  </p>
                  <!-- Compact meta for mobile (date + status) -->
                  <div
                    class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 sm:hidden"
                  >
                    <span
                      class="flex items-center gap-1 font-sans text-caption text-slate"
                    >
                      <sd-icon name="calendar-days" [size]="14" />{{ a.date }}
                    </span>
                    <span
                      class="rounded-lg px-2.5 py-0.5 font-sans text-[10px] font-medium"
                      [class]="status(a).class"
                      >{{ status(a).label }}</span
                    >
                  </div>
                </div>
                <div
                  class="hidden flex-col gap-1 font-sans text-caption text-slate sm:flex"
                >
                  <span class="flex items-center gap-2">
                    <sd-icon name="calendar-days" [size]="16" />{{ a.date }}
                  </span>
                  <span class="flex items-center gap-2">
                    <sd-icon name="clock" [size]="16" />{{ a.time }}
                  </span>
                </div>
                <div class="hidden flex-col items-start gap-2 md:flex">
                  <span
                    class="flex items-center gap-2 font-sans text-caption text-slate"
                  >
                    <sd-icon [name]="a.typeIcon" [size]="16" />{{ a.typeLabel }}
                  </span>
                  <span
                    class="rounded-lg px-4 py-1 font-sans text-caption font-medium"
                    [class]="status(a).class"
                    >{{ status(a).label }}</span
                  >
                </div>
                <sd-icon
                  name="chevron-right"
                  [size]="20"
                  class="shrink-0 text-cerulean"
                />
              </button>
            }
          </div>
        }
      }
    </div>
  `,
})
export class Appointments {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly appointments = inject(AppointmentsApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly activeTab = signal<Tab>('all');
  protected readonly tabs: { key: Tab; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'upcoming', label: 'Upcoming' },
    { key: 'completed', label: 'Completed' },
    { key: 'cancelled', label: 'Cancelled' },
    { key: 'rescheduled', label: 'Rescheduled' },
  ];

  private readonly all = signal<Appointment[]>([]);
  private readonly loading = signal(true);
  private readonly loadError = signal(false);

  private readonly view = toSignal(
    this.route.queryParamMap.pipe(map((p) => p.get('view'))),
    { initialValue: null },
  );

  constructor() {
    this.load();
  }

  protected status(a: Appointment) {
    return STATUS[a.status];
  }

  protected open(a: Appointment): void {
    void this.router.navigate(['/dashboard/appointments', a.id]);
  }

  /** Booking starts at the specialist directory (same as the dashboard CTA). */
  protected book(): void {
    void this.router.navigate(['/dashboard/specialists']);
  }

  protected reload(): void {
    this.load();
  }

  protected readonly upcomingCount = computed(
    () => this.all().filter((a) => TAB_OF[a.status] === 'upcoming').length,
  );

  protected readonly filtered = computed(() => {
    const tab = this.activeTab();
    const all = this.all();
    if (tab === 'all') return all;
    return all.filter((a) => TAB_OF[a.status] === tab);
  });

  protected readonly viewState = computed<
    'loading' | 'list' | 'empty' | 'error'
  >(() => {
    if (this.view() === 'error' || this.loadError()) return 'error';
    if (this.loading()) return 'loading';
    if (this.view() === 'empty' || this.filtered().length === 0) return 'empty';
    return 'list';
  });

  private load(): void {
    this.loading.set(true);
    this.loadError.set(false);
    this.appointments
      .listMine({ per_page: 100, sort_by: 'scheduled_at', sort_dir: 'asc' })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.all.set(res.data.map(toAppointmentRow));
          this.loading.set(false);
        },
        error: () => {
          this.loadError.set(true);
          this.loading.set(false);
        },
      });
  }
}
