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
import { ButtonComponent, IconComponent } from '@supadoc/ui';

type Status = 'completed' | 'cancelled' | 'followup';
type Tab = 'all' | 'completed' | 'cancelled' | 'followup';

interface Consultation {
  readonly id: string;
  readonly photo: string;
  readonly name: string;
  readonly specialty: string;
  readonly date: string;
  readonly time: string;
  readonly status: Status;
}

const STATUS: Record<Status, { label: string; class: string }> = {
  completed: { label: 'Completed', class: 'bg-sage/15 text-sage' },
  cancelled: { label: 'Cancelled', class: 'bg-alert/10 text-alert' },
  followup: {
    label: 'Follow-up Required',
    class: 'bg-warning/15 text-warning',
  },
};

/** History is the terminal appointments — the ones that have already happened. */
function toConsultation(a: AppointmentDto): Consultation | null {
  if (a.status !== 'completed' && a.status !== 'cancelled') return null;
  const when = new Date(a.scheduled_at);
  return {
    id: a.id,
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
    status: a.status,
  };
}

/** Consultation History (Figma 497:7880) + inline empty state (808:13294). */
@Component({
  selector: 'pat-history',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <div class="flex flex-col gap-1">
        <h1 class="font-heading text-h3 text-ink">Consultation History</h1>
        <p class="font-sans text-body text-slate">
          View your consultation in one place.
        </p>
      </div>

      <!-- Tabs -->
      <div
        class="flex items-center gap-1 overflow-x-auto rounded-pill border border-cloud bg-white p-2"
      >
        @for (t of tabs; track t.key) {
          <button
            type="button"
            class="shrink-0 rounded-pill px-4 py-1.5 font-sans text-body-sm transition-colors"
            [class]="
              activeTab() === t.key
                ? 'bg-frost font-medium text-cerulean'
                : 'text-slate hover:text-ink'
            "
            (click)="activeTab.set(t.key)"
          >
            {{ t.label }}
          </button>
        }
        <button
          type="button"
          class="ml-auto shrink-0 px-3 font-sans text-body-sm text-cerulean hover:underline"
          (click)="activeTab.set('all')"
        >
          Clear all
        </button>
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
          <div class="flex flex-col items-center gap-5 py-24 text-center">
            <span
              class="flex size-20 items-center justify-center rounded-full bg-alert/10 text-alert"
            >
              <sd-icon name="wifi-off" [size]="36" />
            </span>
            <div class="flex max-w-sm flex-col gap-2">
              <h2 class="font-heading text-h5 text-ink">
                Unable to load history
              </h2>
              <p class="font-sans text-body-sm text-slate">
                We couldn't retrieve your consultation history. Check your
                connection and try again.
              </p>
            </div>
            <button
              type="button"
              class="inline-flex items-center justify-center rounded-field border border-alert px-5 py-2.5 font-sans text-body-sm font-semibold text-alert transition-colors hover:bg-alert/5"
              (click)="reload()"
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
                No consultation history yet
              </h2>
              <p class="font-sans text-body-sm text-slate">
                You haven't completed any consultations yet. Once you do, they'll
                show up here.
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
            @for (c of filtered(); track c.id) {
              <button
                type="button"
                class="flex items-center gap-4 rounded-card border border-cloud bg-white p-4 text-left transition-colors hover:border-cerulean/50"
                (click)="open(c)"
              >
                <img
                  [src]="c.photo"
                  alt=""
                  width="56"
                  height="56"
                  class="size-14 shrink-0 rounded-full object-cover"
                />
                <div class="flex min-w-0 flex-1 flex-col">
                  <p class="truncate font-sans text-body font-semibold text-ink">
                    {{ c.name }}
                  </p>
                  <p class="truncate font-sans text-caption text-slate">
                    {{ c.specialty }}
                  </p>
                  <!-- Compact meta for mobile (date + status) -->
                  <div
                    class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 sm:hidden"
                  >
                    <span
                      class="flex items-center gap-1 font-sans text-caption text-slate"
                    >
                      <sd-icon name="calendar-days" [size]="14" />{{ c.date }}
                    </span>
                    <span
                      class="rounded-lg px-2.5 py-0.5 font-sans text-[10px] font-medium"
                      [class]="status(c).class"
                      >{{ status(c).label }}</span
                    >
                  </div>
                </div>
                <div
                  class="hidden flex-col gap-1 font-sans text-caption text-slate sm:flex"
                >
                  <span class="flex items-center gap-2">
                    <sd-icon name="calendar-days" [size]="16" />{{ c.date }}
                  </span>
                  <span class="flex items-center gap-2">
                    <sd-icon name="clock" [size]="16" />{{ c.time }}
                  </span>
                </div>
                <div class="hidden flex-col items-start gap-2 md:flex">
                  <span
                    class="flex items-center gap-2 font-sans text-caption text-slate"
                  >
                    <sd-icon name="video" [size]="16" />Video Consultation
                  </span>
                  <span
                    class="rounded-lg px-4 py-1 font-sans text-caption font-medium"
                    [class]="status(c).class"
                    >{{ status(c).label }}</span
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
export class History {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly appointments = inject(AppointmentsApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly activeTab = signal<Tab>('all');
  protected readonly tabs: { key: Tab; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'completed', label: 'Completed' },
    { key: 'cancelled', label: 'Cancelled' },
    { key: 'followup', label: 'Follow - up Required' },
  ];

  private readonly all = signal<Consultation[]>([]);
  private readonly loading = signal(true);
  private readonly loadError = signal(false);

  private readonly view = toSignal(
    this.route.queryParamMap.pipe(map((p) => p.get('view'))),
    { initialValue: null },
  );

  constructor() {
    this.load();
  }

  protected status(c: Consultation) {
    return STATUS[c.status];
  }

  protected open(c: Consultation): void {
    void this.router.navigate(['/dashboard/history', c.id]);
  }

  protected reload(): void {
    this.load();
  }

  protected readonly filtered = computed(() => {
    const tab = this.activeTab();
    const all = this.all();
    if (tab === 'all') return all;
    return all.filter((c) => c.status === tab);
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
      .listMine({ per_page: 100, sort_by: 'scheduled_at', sort_dir: 'desc' })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.all.set(
            res.data
              .map(toConsultation)
              .filter((c): c is Consultation => c !== null),
          );
          this.loading.set(false);
        },
        error: () => {
          this.loadError.set(true);
          this.loading.set(false);
        },
      });
  }
}
