import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { map } from 'rxjs';
import { ButtonComponent, IconComponent } from '@supadoc/ui';

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

/**
 * My Appointments (Figma 497:7793) with inline empty (826:12182) and error
 * (826:12960) states — states are the same page, toggled by `?view=empty|error`
 * (until the API is wired). Row → appointment details route.
 */
@Component({
  selector: 'pat-appointments',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent],
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
        <sd-button size="sm">
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
        @case ('error') {
          <div class="flex flex-col items-center gap-5 py-24 text-center">
            <span
              class="flex size-20 items-center justify-center rounded-full bg-alert/10 text-alert"
            >
              <sd-icon name="wifi-off" [size]="36" />
            </span>
            <div class="flex max-w-sm flex-col gap-2">
              <h2 class="font-heading text-h5 text-ink">
                Unable to load appointments
              </h2>
              <p class="font-sans text-body-sm text-slate">
                We couldn't retrieve your appointments. Check your connection
                and try again.
              </p>
            </div>
            <button
              type="button"
              class="inline-flex items-center justify-center rounded-field border border-alert px-5 py-2.5 font-sans text-body-sm font-semibold text-alert transition-colors hover:bg-alert/5"
            >
              Try Again
            </button>
          </div>
        }
        @case ('empty') {
          <div class="flex flex-col items-center gap-5 py-24 text-center">
            <span
              class="flex size-20 items-center justify-center rounded-full bg-cloud text-slate"
            >
              <sd-icon name="calendar-off" [size]="36" />
            </span>
            <div class="flex max-w-sm flex-col gap-2">
              <h2 class="font-heading text-h5 text-ink">
                You have no appointment history
              </h2>
              <p class="font-sans text-body-sm text-slate">
                Book a consultation with our healthcare professionals to get
                started
              </p>
            </div>
            <sd-button>
              <sd-icon name="calendar-days" [size]="18" />
              Book a Consultation
            </sd-button>
          </div>
        }
        @default {
          <div class="flex flex-col gap-4">
            @for (a of filtered(); track a.id) {
              <button
                type="button"
                class="flex items-center gap-4 rounded-card border border-cloud bg-white p-4 text-left transition-colors hover:border-cerulean/50"
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
            <button
              type="button"
              class="mt-2 flex items-center justify-center gap-2 font-sans text-body font-semibold text-cerulean hover:underline"
            >
              Load More
              <sd-icon name="chevron-down" [size]="18" />
            </button>
          </div>
        }
      }
    </div>
  `,
})
export class Appointments {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly activeTab = signal<Tab>('all');
  protected readonly tabs: { key: Tab; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'upcoming', label: 'Upcoming' },
    { key: 'completed', label: 'Completed' },
    { key: 'cancelled', label: 'Cancelled' },
    { key: 'rescheduled', label: 'Rescheduled' },
  ];

  private readonly view = toSignal(
    this.route.queryParamMap.pipe(map((p) => p.get('view'))),
    { initialValue: null },
  );

  protected status(a: Appointment) {
    return STATUS[a.status];
  }

  protected open(a: Appointment): void {
    void this.router.navigate(['/dashboard/appointments', a.id]);
  }

  // TODO: source from the appointments API once available.
  private readonly all: Appointment[] = [
    this.make(
      'a1',
      '/dashboard/avatar-james.png',
      'Dr. Ibrahim Musa',
      'Cardiologist',
      'video',
      'Video Consultation',
      'confirmed',
    ),
    this.make(
      'a2',
      '/home/doc4.png',
      'Dr. Adaeze Uche',
      'Clinical Therapist',
      'refresh-cw',
      'Patient Follow-up',
      'pending',
    ),
    this.make(
      'a3',
      '/home/doc3.png',
      'Dr. Chinedu Okafor',
      'Cardiologist',
      'zap',
      'Urgent Care',
      'completed',
    ),
    this.make(
      'a4',
      '/home/doc4.png',
      'Dr. Adaeze Uche',
      'Clinical Therapist',
      'calendar-check',
      'Routine Checkup',
      'cancelled',
    ),
    this.make(
      'a5',
      '/home/doc4.png',
      'Dr. Adaeze Uche',
      'Clinical Therapist',
      'calendar-check',
      'Routine Checkup',
      'rescheduled',
    ),
  ];

  protected readonly upcomingCount = computed(
    () => this.all.filter((a) => TAB_OF[a.status] === 'upcoming').length,
  );

  protected readonly filtered = computed(() => {
    const tab = this.activeTab();
    if (tab === 'all') return this.all;
    return this.all.filter((a) => TAB_OF[a.status] === tab);
  });

  protected readonly viewState = computed<'list' | 'empty' | 'error'>(() => {
    if (this.view() === 'error') return 'error';
    if (this.view() === 'empty' || this.filtered().length === 0) return 'empty';
    return 'list';
  });

  private make(
    id: string,
    photo: string,
    name: string,
    specialty: string,
    typeIcon: string,
    typeLabel: string,
    status: Status,
  ): Appointment {
    return {
      id,
      photo,
      name,
      specialty,
      date: 'Tue, 21 July 2026',
      time: '10:00 AM',
      typeIcon,
      typeLabel,
      status,
    };
  }
}
