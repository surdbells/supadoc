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
import { RouterLink } from '@angular/router';
import { debounceTime, Subject, type Subscription } from 'rxjs';
import { apiErrorMessage, DoctorApi } from '@supadoc/data-access';
import type { DoctorPatientListItemDto } from '@supadoc/models';
import { ButtonComponent, EmptyStateComponent, IconComponent } from '@supadoc/ui';

const PER_PAGE = 20;

/** Search as the doctor types, once they pause for this long. */
const SEARCH_DEBOUNCE_MS = 350;

/**
 * Desktop (md+) column template, shared by the header row and every patient
 * row so the columns line up: Patient | Visits | Last visit | actions.
 */
const COLUMNS =
  'md:grid-cols-[minmax(0,1fr)_7.5rem_10rem_4.5rem] xl:grid-cols-[minmax(0,1fr)_8rem_11rem_9.5rem]';

/** On md+ the rows sit inside one bordered card (a table-like list). */
const LIST_FRAME =
  'md:overflow-hidden md:rounded-card md:border md:border-cloud md:bg-white md:shadow-[0_1px_2px_rgba(10,22,40,0.04)]';

/** Below md each row is its own card; on md+ it is a divided table row. */
const ROW =
  'rounded-card border border-cloud bg-white p-5 shadow-[0_1px_2px_rgba(10,22,40,0.04)] md:grid md:items-center md:gap-4 md:rounded-none md:border-0 md:px-5 md:py-4 md:shadow-none';

/** Doctor's patients (route `/patients`) — directory with search. */
@Component({
  selector: 'doc-patients',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, ButtonComponent, EmptyStateComponent, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <header class="flex flex-col gap-1">
        <div class="flex flex-wrap items-center gap-3">
          <h1 class="font-heading text-h3 text-ink">Patients</h1>
          @if (allTotal(); as n) {
            <span class="inline-flex items-center gap-1.5 rounded-pill bg-cerulean/10 px-3 py-1 font-sans text-caption font-semibold text-cerulean">
              <sd-icon name="users" [size]="14" />{{ countLabel(n, 'patient') }}
            </span>
          }
        </div>
        <p class="font-sans text-body text-slate">Everyone you've consulted with.</p>
      </header>

      <!-- Search -->
      <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div role="search" class="w-full sm:max-w-md">
          <label for="patients-search" class="sr-only">Search patients by name or email</label>
          <div class="group flex items-center gap-2 rounded-field border border-cloud bg-white px-4 shadow-[0_1px_2px_rgba(10,22,40,0.04)] transition-all duration-200 focus-within:border-cerulean focus-within:shadow-[0_2px_10px_rgba(21,101,192,0.08)] focus-within:ring-2 focus-within:ring-cerulean/20">
            <sd-icon name="search" [size]="20" class="shrink-0 text-slate transition-colors group-focus-within:text-cerulean" />
            <input
              id="patients-search"
              type="search"
              autocomplete="off"
              spellcheck="false"
              enterkeyhint="search"
              class="min-w-0 flex-1 bg-transparent py-3 font-sans text-body-sm text-ink placeholder:text-slate/60 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
              placeholder="Search by name or email…"
              [value]="search()"
              (input)="onSearchInput($any($event.target).value)"
              (keydown.enter)="apply()"
              (keydown.escape)="clearSearch()"
            />
            @if (search()) {
              <button
                type="button"
                class="-mr-1.5 flex size-8 shrink-0 items-center justify-center rounded-full text-slate transition-colors hover:bg-cloud hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
                aria-label="Clear search"
                (click)="clearSearch()"
              >
                <sd-icon name="x" [size]="16" />
              </button>
            }
          </div>
        </div>

        @if (appliedSearch() && items().length > 0) {
          <p class="font-sans text-body-sm text-slate">
            <span class="font-semibold text-ink">{{ formatCount(total() ?? items().length) }}</span>
            {{ (total() ?? items().length) === 1 ? 'result' : 'results' }} for “{{ appliedSearch() }}”
          </p>
        }
      </div>

      <!-- Announces result changes from the debounced search to screen readers. -->
      <p class="sr-only" aria-live="polite">{{ statusMessage() }}</p>

      @if (loading() && items().length === 0) {
        <!-- Skeleton rows -->
        <div class="${LIST_FRAME}" aria-busy="true">
          <span class="sr-only">Loading your patients…</span>
          <div class="hidden border-b border-cloud px-5 py-3 md:grid md:gap-4 ${COLUMNS}" aria-hidden="true">
            <div class="sd-shimmer h-3 w-16 rounded-pill"></div>
            <div class="sd-shimmer h-3 w-12 rounded-pill"></div>
            <div class="sd-shimmer h-3 w-16 rounded-pill"></div>
          </div>
          <ul class="flex flex-col gap-3 md:gap-0 md:divide-y md:divide-cloud" aria-hidden="true">
            @for (i of skeletonRows; track i) {
              <li class="flex flex-col gap-3 ${ROW} ${COLUMNS}">
                <div class="flex min-w-0 items-center gap-3">
                  <div class="sd-shimmer size-12 shrink-0 rounded-full"></div>
                  <div class="flex min-w-0 flex-1 flex-col gap-2">
                    <div class="sd-shimmer h-4 w-36 max-w-full rounded-pill"></div>
                    <div class="sd-shimmer h-3 w-52 max-w-full rounded-pill"></div>
                  </div>
                </div>
                <div class="flex items-center gap-4 md:contents">
                  <div class="sd-shimmer h-7 w-24 rounded-pill"></div>
                  <div class="sd-shimmer h-4 w-32 rounded-pill md:w-28"></div>
                </div>
                <div class="flex items-center justify-between gap-3 md:justify-end">
                  <div class="sd-shimmer h-9 w-28 rounded-field md:w-9 xl:w-28"></div>
                  <div class="sd-shimmer h-4 w-24 rounded-pill md:hidden"></div>
                </div>
              </li>
            }
          </ul>
        </div>
      } @else if (error() && items().length === 0) {
        <div class="rounded-card border border-cloud bg-white px-4" role="alert">
          <sd-empty-state icon="wifi-off" tone="error" title="Couldn't load your patients" [message]="error()">
            <sd-button variant="secondary" size="sm" (click)="apply()">
              <sd-icon name="refresh-cw" [size]="16" />Try again
            </sd-button>
          </sd-empty-state>
        </div>
      } @else if (items().length === 0) {
        @if (appliedSearch()) {
          <sd-empty-state icon="search" [title]="'No patients match “' + appliedSearch() + '”'" message="Check the spelling, or try searching by email address.">
            <sd-button variant="secondary" size="sm" (click)="clearSearch()">
              <sd-icon name="x" [size]="16" />Clear search
            </sd-button>
          </sd-empty-state>
        } @else {
          <sd-empty-state icon="users" tone="brand" title="No patients yet" message="Patients appear here after their first consultation with you." />
        }
      } @else {
        <section class="${LIST_FRAME}" aria-label="Your patients">
          <div class="hidden border-b border-cloud px-5 py-3 font-sans text-caption font-semibold text-slate md:grid md:items-center md:gap-4 ${COLUMNS}" aria-hidden="true">
            <span>Patient</span>
            <span>Visits</span>
            <span>Last visit</span>
            <span></span>
          </div>
          <ul class="flex flex-col gap-3 md:gap-0 md:divide-y md:divide-cloud">
            @for (p of items(); track p.patient_id) {
              <li class="group relative flex flex-col gap-3 transition-colors hover:border-cerulean/40 md:hover:bg-glacier ${ROW} ${COLUMNS}">
                <!-- The row's link: its ::after stretches over the whole row, so
                     the entire row opens the patient and shows the focus ring. -->
                <a
                  [routerLink]="['/patients', p.patient_id]"
                  class="flex min-w-0 items-center gap-3 after:absolute after:inset-0 after:rounded-card focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-cerulean md:after:rounded-none"
                >
                  <span class="flex size-12 shrink-0 items-center justify-center rounded-full bg-frost font-heading text-body-sm font-semibold text-cerulean" aria-hidden="true">{{ initials(p) }}</span>
                  <span class="flex min-w-0 flex-col">
                    <span class="truncate font-heading text-body-lg text-ink transition-colors group-hover:text-cerulean">{{ fullName(p) }}</span>
                    <span class="truncate font-sans text-body-sm text-slate">{{ p.email }}</span>
                  </span>
                </a>

                <div class="flex flex-wrap items-center gap-x-4 gap-y-2 md:contents">
                  <span class="inline-flex w-fit items-center gap-1.5 rounded-pill bg-frost/60 px-3 py-1 font-sans text-caption font-semibold text-cerulean">
                    <sd-icon name="stethoscope" [size]="14" />{{ visitsLabel(p.visit_count) }}
                  </span>
                  <span class="flex min-w-0 items-center gap-2 font-sans text-body-sm text-ink">
                    <sd-icon name="calendar-days" [size]="16" class="shrink-0 text-slate" />
                    <span class="min-w-0">
                      <span class="text-slate md:sr-only">Last visit </span>
                      @if (p.last_visit) {
                        {{ date(p.last_visit) }}
                      } @else {
                        <span class="text-slate" aria-hidden="true">—</span><span class="sr-only">not recorded</span>
                      }
                    </span>
                  </span>
                </div>

                <div class="flex items-center justify-between gap-3 border-t border-cloud pt-3 md:justify-end md:border-0 md:pt-0">
                  <a
                    routerLink="/prescriptions/new"
                    [queryParams]="{ patientId: p.patient_id }"
                    class="relative z-10 inline-flex items-center justify-center gap-1.5 rounded-field border border-cloud bg-white px-3 py-2 font-sans text-caption font-semibold text-cerulean transition-colors hover:border-cerulean focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 md:size-9 md:p-0 xl:size-auto xl:px-3 xl:py-2"
                    [attr.aria-label]="'Write a prescription for ' + fullName(p)"
                    title="Write prescription"
                  >
                    <sd-icon name="pill" [size]="16" /><span class="md:hidden xl:inline">Prescribe</span>
                  </a>
                  <span class="flex items-center gap-1 font-sans text-body-sm font-semibold text-cerulean" aria-hidden="true">
                    <span class="md:hidden">View patient</span>
                    <sd-icon name="chevron-right" [size]="20" class="md:text-slate md:transition-colors md:group-hover:text-cerulean" />
                  </span>
                </div>
              </li>
            }
          </ul>
        </section>

        <div class="flex flex-col items-center gap-3">
          @if (error()) {
            <p class="flex items-center gap-2 rounded-field bg-alert/10 px-4 py-2.5 font-sans text-caption text-alert" role="alert">
              <sd-icon name="circle-alert" [size]="16" class="shrink-0" />{{ error() }}
            </p>
          }
          @if (hasMore()) {
            @if (total(); as t) {
              <p class="font-sans text-caption text-slate">Showing {{ formatCount(items().length) }} of {{ formatCount(t) }}</p>
            }
            <sd-button variant="secondary" size="sm" [disabled]="loading()" (click)="loadMore()">
              @if (loading()) {
                <sd-icon name="loader-circle" [size]="16" class="animate-spin" />Loading…
              } @else {
                <sd-icon name="chevron-down" [size]="16" />Load more
              }
            </sd-button>
          }
        </div>
      }
    </div>
  `,
})
export class DoctorPatients implements OnInit {
  private readonly api = inject(DoctorApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly items = signal<DoctorPatientListItemDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly hasMore = signal(false);
  protected readonly error = signal('');
  /** The search box's current text. */
  protected readonly search = signal('');
  /** The (trimmed) term the listed results were fetched for. */
  protected readonly appliedSearch = signal('');
  /** `meta.total` for the listed results (matches, when searching). */
  protected readonly total = signal<number | null>(null);
  /** `meta.total` of the last unfiltered load — the header's patient count. */
  protected readonly allTotal = signal<number | null>(null);
  protected readonly skeletonRows = [1, 2, 3, 4, 5];

  protected readonly statusMessage = computed(() => {
    if (this.loading() || this.error()) return '';
    const total = this.total() ?? this.items().length;
    const term = this.appliedSearch();
    if (term) return `${this.countLabel(total, 'patient')} found for “${term}”.`;
    return total === 0 ? 'No patients yet.' : `Showing ${this.items().length} of ${this.countLabel(total, 'patient')}.`;
  });

  private page = 1;
  /** The trimmed term of the latest first-page request (in flight or done). */
  private requestedTerm = '';
  private fetchSub: Subscription | null = null;
  private readonly searchInput$ = new Subject<void>();

  ngOnInit(): void {
    this.searchInput$
      .pipe(debounceTime(SEARCH_DEBOUNCE_MS), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.applyIfChanged());
    this.fetch();
  }

  protected onSearchInput(value: string): void {
    this.search.set(value);
    this.searchInput$.next();
  }

  protected clearSearch(): void {
    if (!this.search()) return;
    this.search.set('');
    this.applyIfChanged();
  }

  protected apply(): void {
    this.page = 1;
    this.items.set([]);
    this.fetch();
  }

  protected loadMore(): void {
    // sd-button's disabled state is visual; guard against a click while loading.
    if (this.loading()) return;
    this.page += 1;
    this.fetch();
  }

  /** Re-run the search only if the term differs from the one last requested. */
  private applyIfChanged(): void {
    if (this.search().trim() !== this.requestedTerm) this.apply();
  }

  private fetch(): void {
    // A newer request supersedes one still in flight (e.g. typing while a search loads).
    this.fetchSub?.unsubscribe();
    const page = this.page;
    if (page === 1) this.requestedTerm = this.search().trim();
    const term = this.requestedTerm;
    this.loading.set(true);
    this.error.set('');
    this.fetchSub = this.api
      .patients({ page, per_page: PER_PAGE, search: term || undefined })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.items.update((list) => (page === 1 ? res.data : [...list, ...res.data]));
          this.hasMore.set(res.meta.page < res.meta.total_pages);
          this.total.set(res.meta.total);
          if (page === 1) this.appliedSearch.set(term);
          if (!term) this.allTotal.set(res.meta.total);
          this.loading.set(false);
        },
        error: (err: unknown) => {
          // Roll back a load-more page bump so the next click re-fetches this page.
          if (this.page > 1) this.page -= 1;
          this.error.set(apiErrorMessage(err, 'Could not load your patients. Please try again.'));
          this.loading.set(false);
        },
      });
  }

  protected fullName(p: DoctorPatientListItemDto): string {
    return [p.first_name, p.last_name].filter(Boolean).join(' ') || p.email;
  }

  protected initials(p: DoctorPatientListItemDto): string {
    const fromName = `${p.first_name?.[0] ?? ''}${p.last_name?.[0] ?? ''}`;
    return (fromName || p.email?.[0] || '?').toUpperCase();
  }

  protected visitsLabel(count: number): string {
    return count > 0 ? this.countLabel(count, 'visit') : 'No visits';
  }

  protected countLabel(count: number, noun: string): string {
    return `${this.formatCount(count)} ${noun}${count === 1 ? '' : 's'}`;
  }

  protected formatCount(count: number): string {
    return count.toLocaleString('en-GB');
  }

  protected date(iso: string): string {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '—' : new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
  }
}
