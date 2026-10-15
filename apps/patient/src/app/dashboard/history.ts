import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { apiErrorMessage, AppointmentsApi } from '@supadoc/data-access';
import type { AppointmentDisplayStatus, AppointmentDto } from '@supadoc/models';
import { ButtonComponent, EmptyStateComponent, IconComponent } from '@supadoc/ui';
import { detailsLink, StatusBadge, statusBadge } from './appointment-status';
import { isUntakenProposal } from './follow-up';

type Tab = 'all' | 'completed' | 'missed' | 'cancelled';

interface Consultation {
  readonly id: string;
  readonly name: string;
  readonly specialty: string;
  readonly date: string;
  readonly time: string;
  readonly typeIcon: string;
  readonly typeLabel: string;
  /** Its filter ('all' only: ended, being finalised). */
  readonly tab: Tab;
  readonly badge: StatusBadge;
  readonly link: string[];
}

/** Which filter each display status belongs to. */
const TAB_OF: Record<AppointmentDisplayStatus, Tab> = {
  completed: 'completed',
  missed: 'missed',
  cancelled: 'cancelled',
  not_confirmed: 'cancelled',
  expired: 'cancelled',
  finalising: 'all',
  live: 'all',
  upcoming: 'all',
};

const EMPTY_TAB: Record<Tab, string> = {
  all: 'No past consultations yet.',
  completed: 'No completed consultations yet.',
  missed: 'No missed consultations.',
  cancelled: 'No cancelled consultations.',
};

const TYPE_ICON: Record<string, string> = {
  video: 'video',
  follow_up: 'refresh-cw',
  urgent: 'zap',
  routine: 'calendar-check',
};

const PAGE_SIZE = 50;

/**
 * History is every consultation that is over — completed, cancelled, missed,
 * or ended and still being closed — whatever its status (`when=past`).
 */
/**
 * The consultations among a page of past bookings — a doctor's follow-up
 * proposal that was never taken up (expired, declined, withdrawn) or is still
 * a proposal was never a consultation: it shows on its visit's History page.
 */
function consultationsOf(list: readonly AppointmentDto[]): Consultation[] {
  return list.filter((a) => a.status !== 'proposed' && !isUntakenProposal(a)).map(toConsultation);
}

function toConsultation(a: AppointmentDto): Consultation {
  const when = new Date(a.scheduled_at);
  const badge = statusBadge(a);
  return {
    id: a.id,
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
    typeIcon: TYPE_ICON[a.type] ?? 'video',
    typeLabel: a.type_label,
    tab: TAB_OF[badge.key],
    badge,
    link: detailsLink(a),
  };
}

/**
 * Consultation History (Figma 497:7880) + inline empty state (808:13294):
 * `GET /api/portal/appointments?when=past`, newest first, with filters for
 * completed, missed and cancelled ones (a booking the doctor never confirmed
 * reads "Not confirmed", under Cancelled). Each row shows the server's label
 * and, where it helps, what happened ("Doctor didn't attend").
 */
@Component({
  selector: 'pat-history',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, ButtonComponent, EmptyStateComponent, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <div class="flex flex-col gap-1">
        <h1 class="font-heading text-h3 text-ink">Consultation History</h1>
        <p class="font-sans text-body text-slate">
          Your past consultations in one place.
        </p>
      </div>

      <!-- Consultation History › Consultations | Prescriptions -->
      <nav
        aria-label="Consultation history sections"
        class="flex w-full items-center gap-1 rounded-pill border border-cloud bg-white p-1 sm:w-fit"
      >
        <a
          routerLink="/dashboard/history"
          aria-current="page"
          class="flex flex-1 items-center justify-center gap-2 rounded-pill bg-cerulean px-4 py-2 font-sans text-body-sm font-medium text-white sm:flex-none"
        >
          <sd-icon name="history" [size]="16" />
          Consultations
        </a>
        <a
          routerLink="/dashboard/prescriptions"
          class="flex flex-1 items-center justify-center gap-2 rounded-pill px-4 py-2 font-sans text-body-sm text-slate transition-colors hover:text-ink sm:flex-none"
        >
          <sd-icon name="pill" [size]="16" />
          Prescriptions
        </a>
      </nav>

      <!-- Filters -->
      <div
        class="flex items-center gap-1 overflow-x-auto rounded-pill border border-cloud bg-white p-2"
        role="group"
        aria-label="Filter consultations"
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
            [attr.aria-pressed]="activeTab() === t.key"
            (click)="activeTab.set(t.key)"
          >
            {{ t.label }}
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
                <div class="sd-shimmer size-14 shrink-0 rounded-full"></div>
                <div class="flex flex-1 flex-col gap-2">
                  <div class="sd-shimmer h-3 w-40 rounded"></div>
                  <div class="sd-shimmer h-3 w-24 rounded"></div>
                </div>
              </div>
            }
          </div>
        }
        @case ('error') {
          <sd-empty-state
            tone="error"
            icon="wifi-off"
            title="Unable to load history"
            [message]="loadError() || loadErrorFallback"
          >
            <sd-button variant="outline" (click)="reload()">Try Again</sd-button>
          </sd-empty-state>
        }
        @case ('empty') {
          <sd-empty-state
            icon="calendar-off"
            title="No consultation history yet"
            message="Consultations show up here once they're over. Upcoming ones are in My Appointments."
          >
            <div class="flex flex-col gap-3 sm:flex-row">
              <sd-button (click)="book()">
                <sd-icon name="calendar-days" [size]="18" />
                Book a Consultation
              </sd-button>
              <sd-button variant="outline" routerLink="/dashboard/appointments">
                My Appointments
              </sd-button>
            </div>
          </sd-empty-state>
        }
        @default {
          <div class="flex flex-col gap-4">
            @if (filtered().length === 0) {
              <p class="rounded-card border border-cloud bg-white p-6 text-center font-sans text-body-sm text-slate">
                {{ emptyTabText() }}
              </p>
            }
            @for (c of filtered(); track c.id) {
              <button
                type="button"
                class="sd-card-hover flex items-center gap-4 rounded-card border border-cloud bg-white p-4 text-left hover:border-cerulean/50"
                (click)="open(c)"
              >
                <span
                  class="flex size-14 shrink-0 items-center justify-center rounded-full bg-cerulean/15 font-heading text-body-lg font-semibold text-cerulean"
                  >{{ initials(c.name) }}</span
                >
                <div class="flex min-w-0 flex-1 flex-col">
                  <p class="truncate font-sans text-body font-semibold text-ink">
                    {{ c.name }}
                  </p>
                  <p class="truncate font-sans text-caption text-slate">
                    {{ c.specialty }}
                  </p>
                  <!-- Compact meta for narrow screens (date + status) -->
                  <div
                    class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 md:hidden"
                  >
                    <span
                      class="flex items-center gap-1 font-sans text-caption text-slate sm:hidden"
                    >
                      <sd-icon name="calendar-days" [size]="14" />{{ c.date }}
                    </span>
                    <span
                      class="inline-flex items-center gap-1 rounded-lg px-2.5 py-0.5 font-sans text-[10px] font-medium"
                      [class]="c.badge.class"
                      ><sd-icon [name]="c.badge.icon" [size]="12" />{{ c.badge.label }}</span
                    >
                  </div>
                  @if (c.badge.detail) {
                    <p class="mt-1 font-sans text-caption text-slate md:hidden">{{ c.badge.detail }}</p>
                  }
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
                    <sd-icon [name]="c.typeIcon" [size]="16" />{{ c.typeLabel }}
                  </span>
                  <span
                    class="inline-flex items-center gap-1.5 rounded-lg px-4 py-1 font-sans text-caption font-medium"
                    [class]="c.badge.class"
                    ><sd-icon [name]="c.badge.icon" [size]="14" />{{ c.badge.label }}</span
                  >
                  @if (c.badge.detail) {
                    <span class="max-w-[12rem] font-sans text-caption text-slate">{{ c.badge.detail }}</span>
                  }
                </div>
                <sd-icon
                  name="chevron-right"
                  [size]="20"
                  class="shrink-0 text-cerulean"
                />
              </button>
            }
            @if (hasMore()) {
              <sd-button
                variant="outline"
                class="self-center"
                [disabled]="loadingMore()"
                (click)="loadMore()"
              >
                @if (loadingMore()) {
                  <sd-icon name="loader-circle" [size]="18" class="animate-spin" />
                }
                {{ loadingMore() ? 'Loading…' : 'Show older consultations' }}
              </sd-button>
            }
            @if (moreError()) {
              <p class="text-center font-sans text-caption text-alert" role="alert">{{ moreError() }}</p>
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
    { key: 'missed', label: 'Missed' },
    { key: 'cancelled', label: 'Cancelled' },
  ];

  private readonly all = signal<Consultation[]>([]);
  private readonly loading = signal(true);
  /** The API's reason the list failed to load ('' when it hasn't). */
  protected readonly loadError = signal('');
  protected readonly loadErrorFallback =
    "We couldn't retrieve your consultation history. Check your connection and try again.";

  // "Show older consultations" — the next page of the newest-first list.
  private readonly page = signal(1);
  private readonly totalPages = signal(1);
  protected readonly loadingMore = signal(false);
  protected readonly moreError = signal('');
  protected readonly hasMore = computed(() => this.page() < this.totalPages());

  private readonly view = toSignal(
    this.route.queryParamMap.pipe(map((p) => p.get('view'))),
    { initialValue: null },
  );

  constructor() {
    this.load();
  }

  protected open(c: Consultation): void {
    void this.router.navigate(c.link);
  }

  protected initials(name: string): string {
    return (name ?? '')
      .replace(/^(dr|prof|mr|mrs|ms)\.?\s+/i, '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase() || '?';
  }

  /** Booking starts at the specialist directory (same as the dashboard CTA). */
  protected book(): void {
    void this.router.navigate(['/dashboard/specialists']);
  }

  protected reload(): void {
    this.load();
  }

  protected readonly filtered = computed(() => {
    const tab = this.activeTab();
    const all = this.all();
    if (tab === 'all') return all;
    return all.filter((c) => c.tab === tab);
  });

  protected readonly emptyTabText = computed(() => EMPTY_TAB[this.activeTab()]);

  protected readonly viewState = computed<
    'loading' | 'list' | 'empty' | 'error'
  >(() => {
    if (this.view() === 'error' || this.loadError()) return 'error';
    // Still paging past untaken proposals for a first consultation to show.
    if (this.loading() || (this.all().length === 0 && this.loadingMore())) return 'loading';
    if (this.view() === 'empty' || this.all().length === 0) return 'empty';
    return 'list';
  });

  /** Everything over (`when=past`), newest first. */
  private load(): void {
    this.loading.set(true);
    this.loadError.set('');
    this.moreError.set('');
    this.page.set(1);
    this.appointments
      .listMine({ when: 'past', per_page: PAGE_SIZE, page: 1 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.all.set(consultationsOf(res.data));
          this.totalPages.set(res.meta?.total_pages ?? 1);
          this.loading.set(false);
          // A first page of nothing but untaken proposals: fetch on rather than say "none yet".
          if (this.all().length === 0 && this.hasMore()) this.loadMore();
        },
        error: (err: unknown) => {
          this.loadError.set(apiErrorMessage(err, this.loadErrorFallback));
          this.loading.set(false);
        },
      });
  }

  protected loadMore(): void {
    if (this.loadingMore() || !this.hasMore()) return;
    const next = this.page() + 1;
    this.loadingMore.set(true);
    this.moreError.set('');
    this.appointments
      .listMine({ when: 'past', per_page: PAGE_SIZE, page: next })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.page.set(next);
          this.totalPages.set(res.meta?.total_pages ?? next);
          // A visit that ended meanwhile shifts the pages by one: never list it twice.
          const seen = new Set(this.all().map((c) => c.id));
          this.all.update((list) => [...list, ...consultationsOf(res.data.filter((a) => !seen.has(a.id)))]);
          this.loadingMore.set(false);
          if (this.all().length === 0 && this.hasMore()) this.loadMore();
        },
        error: (err: unknown) => {
          // Nothing listed yet: the whole page failed, not just the older ones.
          if (this.all().length === 0) this.loadError.set(apiErrorMessage(err, this.loadErrorFallback));
          else this.moreError.set(apiErrorMessage(err, 'Could not load older consultations. Please try again.'));
          this.loadingMore.set(false);
        },
      });
  }
}
