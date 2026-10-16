import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import {
  catchError,
  debounceTime,
  distinctUntilChanged,
  of,
  switchMap,
  tap,
} from 'rxjs';
import { ActivatedRoute, Router } from '@angular/router';
import {
  apiErrorFields,
  apiErrorMessage,
  SpecialistsApi,
  type ListSpecialistsQuery,
} from '@supadoc/data-access';
import type { SpecialistDto } from '@supadoc/models';
import {
  ButtonComponent,
  EmptyStateComponent,
  IconComponent,
  SearchSelectComponent,
} from '@supadoc/ui';
import { AvailabilityFallback, type DirectoryFilters } from './availability-fallback';
import {
  ANY_WHEN,
  hasDateFilter,
  hasWhenFilter,
  whenDay,
  whenFromQuery,
  whenParams,
  whenQuery,
  whenText,
  type WhenFilter,
} from './booking-helpers';
import { SpecialistCard } from './specialist-card';
import { WhenFilterChips } from './when-filter';

interface Criteria {
  search: string;
  specialty: string;
  location: string;
  language: string;
  gender: string;
  mode: 'any' | 'online' | 'in_person';
  when: WhenFilter;
}

/** Doctors per page ("Show more" loads the next). */
const PER_PAGE = 24;

/**
 * Find a Specialist (Figma 311:4126) — wired to GET /api/portal/specialists.
 * Search, the specialty / location / language / gender / type filters and the
 * "When" + "Time of day" filters run server-side (debounced), always in the
 * patient's time zone, and are mirrored in the URL so a search can be shared
 * or deep-linked (`?specialty=&when=today|tomorrow|week|YYYY-MM-DD&time=`).
 * Every result carries when the doctor is free, so the cards need no requests
 * of their own. A day nobody (or hardly anybody) is free on offers the next
 * open day and similar doctors who are free.
 */
@Component({
  selector: 'pat-find-specialist',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AvailabilityFallback,
    ButtonComponent,
    EmptyStateComponent,
    IconComponent,
    SearchSelectComponent,
    SpecialistCard,
    WhenFilterChips,
  ],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <!-- Title + search -->
      <div
        class="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between"
      >
        <div class="flex flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">Find a Specialist</h1>
          <p class="font-sans text-body text-slate">
            The right doctor, on your schedule.
          </p>
        </div>
        <div class="flex items-center gap-3 lg:w-[560px]">
          <span
            class="flex flex-1 items-center gap-2 rounded-field border border-haze bg-white px-4 py-3 shadow-control hover:border-cerulean/30"
          >
            <sd-icon name="search" [size]="20" class="text-slate" />
            <input
              type="search"
              [value]="query()"
              (input)="query.set($any($event.target).value)"
              placeholder="Search by name, speciality or condition..."
              aria-label="Search specialists"
              class="w-full bg-transparent font-sans text-body text-ink placeholder:text-slate/70 focus:outline-none"
            />
          </span>
          <button
            type="button"
            class="relative flex size-12 shrink-0 items-center justify-center rounded-field border bg-white shadow-control transition hover:bg-glacier active:shadow-none disabled:shadow-none"
            [class]="
              filtersOpen() || activeFilterCount() > 0
                ? 'border-cerulean text-cerulean'
                : 'border-haze text-ink'
            "
            [attr.aria-expanded]="filtersOpen()"
            aria-controls="specialist-filters"
            (click)="filtersOpen.set(!filtersOpen())"
            aria-label="Filter"
          >
            <sd-icon name="filter" [size]="20" />
            @if (activeFilterCount() > 0) {
              <span
                class="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-cerulean text-[10px] font-semibold text-white"
                >{{ activeFilterCount() }}</span
              >
            }
          </button>
        </div>
      </div>

      <!-- Filter panel -->
      @if (filtersOpen()) {
        <div
          id="specialist-filters"
          class="flex flex-col gap-5 rounded-card border border-haze bg-white p-5 shadow-card"
        >
          <div class="flex flex-col gap-2">
            <span class="font-sans text-body-sm font-semibold text-ink"
              >Specialty</span
            >
            <div class="flex flex-wrap gap-2">
              <button
                type="button"
                class="rounded-pill border px-4 py-1.5 font-sans text-body-sm transition-colors"
                [class]="
                  specialty() === ''
                    ? 'border-cerulean bg-frost text-cerulean-dark shadow-control'
                    : 'border-haze bg-white text-slate shadow-control hover:text-ink'
                "
                [attr.aria-pressed]="specialty() === ''"
                (click)="specialty.set('')"
              >
                All
              </button>
              @for (s of specialties(); track s) {
                <button
                  type="button"
                  class="rounded-pill border px-4 py-1.5 font-sans text-body-sm transition-colors"
                  [class]="
                    specialty() === s
                      ? 'border-cerulean bg-frost text-cerulean-dark shadow-control'
                      : 'border-haze bg-white text-slate shadow-control hover:text-ink'
                  "
                  [attr.aria-pressed]="specialty() === s"
                  (click)="specialty.set(s)"
                >
                  {{ s }}
                </button>
              }
            </div>
          </div>

          <!-- When + time of day (the patient's own calendar and clock) -->
          <pat-when-filter [(value)]="when" />

          <div class="flex flex-col gap-2">
            <span class="font-sans text-body-sm font-semibold text-ink"
              >Consultation type</span
            >
            <div
              class="flex w-fit rounded-field border border-haze bg-glacier p-1"
            >
              @for (t of consultTypes; track t.value) {
                <button
                  type="button"
                  class="flex items-center gap-1.5 whitespace-nowrap rounded-pill px-4 py-1.5 font-sans text-body-sm transition-colors"
                  [class]="
                    mode() === t.value
                      ? 'bg-frost font-medium text-cerulean-dark shadow-control'
                      : 'text-slate hover:text-ink'
                  "
                  [attr.aria-pressed]="mode() === t.value"
                  (click)="mode.set(t.value)"
                >
                  <sd-icon [name]="t.icon" [size]="16" />{{ t.label }}
                </button>
              }
            </div>
          </div>

          <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div class="flex flex-col gap-2">
              <span class="font-sans text-body-sm font-semibold text-ink"
                >Location</span
              >
              <sd-search-select
                placeholder="Any location"
                [options]="locations()"
                [value]="location()"
                (valueChange)="location.set($event)"
              />
            </div>
            <div class="flex flex-col gap-2">
              <span class="font-sans text-body-sm font-semibold text-ink"
                >Language</span
              >
              <sd-search-select
                placeholder="Any language"
                [options]="languages()"
                [value]="language()"
                (valueChange)="language.set($event)"
              />
            </div>
            <div class="flex flex-col gap-2">
              <span class="font-sans text-body-sm font-semibold text-ink"
                >Gender</span
              >
              <sd-search-select
                placeholder="Any gender"
                [options]="genderOptions"
                [value]="gender()"
                (valueChange)="gender.set($event)"
              />
            </div>
          </div>

          @if (activeFilterCount() > 0) {
            <div class="flex justify-end">
              <button
                type="button"
                class="inline-flex min-h-11 items-center gap-1.5 font-sans text-body-sm font-semibold text-slate transition-colors hover:text-ink"
                (click)="clearFilters()"
              >
                <sd-icon name="x" [size]="16" />
                Clear filters
              </button>
            </div>
          }
        </div>
      }

      <!-- Always rendered (the views below are recreated by every search), so each result is announced -->
      <p class="sr-only" aria-live="polite" aria-atomic="true">{{ resultsAnnouncement() }}</p>

      @switch (viewState()) {
        @case ('loading') {
          <div class="grid grid-cols-1 gap-6 xl:grid-cols-2" aria-busy="true">
            @for (n of [1, 2, 3, 4]; track n) {
              <div
                class="h-72 sd-shimmer rounded-card"
              ></div>
            }
          </div>
        }
        @case ('error') {
          <sd-empty-state
            tone="error"
            [icon]="dateRefused() ? 'calendar-off' : 'wifi-off'"
            [title]="dateRefused() ? 'That day can’t be searched' : 'Unable to load specialists'"
            [message]="loadError() || 'Check your connection and try again.'"
          >
            @if (dateRefused()) {
              <sd-button (click)="anyDay()">Show any day</sd-button>
            } @else {
              <sd-button (click)="reload()">Try Again</sd-button>
            }
          </sd-empty-state>
        }
        @case ('empty') {
          @if (dateFiltered()) {
            <!-- Nobody free then: the next open day + similar doctors who are -->
            <pat-availability-fallback
              [filters]="fallbackFilters()"
              [when]="when()"
              [count]="0"
              (tryDay)="tryDay($event)"
              (anyDay)="anyDay()"
            />
          } @else {
            <sd-empty-state
              icon="user-x"
              title="No specialist match your result"
              message="Try broadening your filters — clear a specialty, expand availability, or search a related condition"
            >
              <sd-button (click)="reset()">Reset Filter</sd-button>
            </sd-empty-state>
          }
        }
        @default {
          <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <p class="font-sans text-body font-semibold text-ink">{{ countText() }}</p>
            @if (whenSummary()) {
              <button
                type="button"
                class="inline-flex min-h-11 items-center gap-1.5 font-sans text-body-sm font-semibold text-cerulean hover:underline"
                (click)="when.set(anyWhen)"
              >
                <sd-icon name="x" [size]="16" />Any day or time
              </button>
            }
          </div>

          <div class="grid grid-cols-1 items-stretch gap-6 xl:grid-cols-2">
            @for (s of all(); track s.id) {
              <pat-specialist-card [specialist]="s" [date]="filterDay()" />
            }
          </div>

          @if (all().length < total()) {
            <div class="flex flex-col items-center gap-2">
              <sd-button variant="outline" [disabled]="loadingMore()" (click)="loadMore()">
                {{ loadingMore() ? 'Loading…' : 'Show more specialists' }}
              </sd-button>
              <p class="font-sans text-caption text-slate">Showing {{ all().length }} of {{ total() }}</p>
              @if (moreError()) {
                <p class="font-sans text-caption text-alert" role="alert">{{ moreError() }}</p>
              }
            </div>
          }

          <!-- Hardly anybody free then: more options -->
          @if (dateFiltered() && total() < 3) {
            <pat-availability-fallback
              [filters]="fallbackFilters()"
              [when]="when()"
              [count]="total()"
              [excludeIds]="listedIds()"
              (tryDay)="tryDay($event)"
              (anyDay)="anyDay()"
            />
          }
        }
      }
    </div>
  `,
})
export class FindSpecialist {
  private readonly specialists = inject(SpecialistsApi);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly anyWhen = ANY_WHEN;
  protected readonly query = signal('');
  protected readonly specialty = signal('');
  protected readonly when = signal<WhenFilter>(ANY_WHEN);
  protected readonly location = signal('');
  protected readonly language = signal('');
  protected readonly gender = signal('');
  protected readonly mode = signal<'any' | 'online' | 'in_person'>('any');
  protected readonly filtersOpen = signal(false);
  protected readonly specialties = signal<string[]>([]);
  protected readonly locations = signal<string[]>([]);
  protected readonly languages = signal<string[]>([]);
  protected readonly consultTypes = [
    { value: 'any' as const, label: 'Any', icon: 'sparkles' },
    { value: 'online' as const, label: 'Online', icon: 'video' },
    { value: 'in_person' as const, label: 'In-person', icon: 'building-2' },
  ];
  protected readonly genderOptions = [
    { value: 'female', label: 'Female' },
    { value: 'male', label: 'Male' },
  ];

  protected readonly all = signal<SpecialistDto[]>([]);
  /** How many doctors match in all (meta.total), not just this page. */
  protected readonly total = signal(0);
  private readonly loading = signal(true);
  /** Why the search failed ('' when it didn't). */
  protected readonly loadError = signal('');
  /** The API refused the day searched (outside the booking window). */
  protected readonly dateRefused = signal(false);
  private readonly reloadTick = signal(0);
  private page = 1;
  protected readonly loadingMore = signal(false);
  protected readonly moreError = signal('');

  private readonly criteria = computed<Criteria>(() => ({
    search: this.query().trim(),
    specialty: this.specialty(),
    location: this.location(),
    language: this.language(),
    gender: this.gender(),
    mode: this.mode(),
    when: this.when(),
  }));

  protected readonly dateFiltered = computed(() => hasDateFilter(this.when()));
  /** The one day searched (today / tomorrow / a picked date), for the cards. */
  protected readonly filterDay = computed(() => whenDay(this.when()));
  protected readonly whenSummary = computed(() => (hasWhenFilter(this.when()) ? whenText(this.when()) : ''));
  protected readonly listedIds = computed(() => this.all().map((s) => s.id));
  protected readonly fallbackFilters = computed<DirectoryFilters>(() => {
    const c = this.criteria();
    return {
      search: c.search || undefined,
      specialty: c.specialty || undefined,
      location: c.location || undefined,
      language: c.language || undefined,
      gender: c.gender || undefined,
      mode: c.mode === 'in_person' ? 'in_person' : undefined,
    };
  });

  constructor() {
    // Deep links (the homepage discovery section, a patient's rebook link, a
    // shared search) pre-fill the filters, e.g.
    // /dashboard/specialists?specialty=Cardiology&gender=female&when=tomorrow&time=morning.
    const qp = this.route.snapshot.queryParamMap;
    const sp = qp.get('specialty');
    if (sp) this.specialty.set(sp);
    const q = qp.get('q');
    if (q) this.query.set(q);
    const loc = qp.get('location');
    if (loc) this.location.set(loc);
    const lang = qp.get('language');
    if (lang) this.language.set(lang);
    const gen = qp.get('gender');
    if (gen) this.gender.set(gen);
    const md = qp.get('mode');
    if (md === 'online' || md === 'in_person') this.mode.set(md);
    this.when.set(whenFromQuery(qp));

    // Populate the filter dropdown options once (public facets endpoint).
    this.specialists
      .publicFacets()
      .pipe(takeUntilDestroyed())
      .subscribe({
        next: (res) => {
          this.specialties.set(res.data.specialties.map((s) => s.name));
          this.locations.set(res.data.locations);
          this.languages.set(res.data.languages);
        },
      });

    // Debounced, server-side search + filters. `reloadTick` lets the error
    // "Try Again" button re-run the current criteria.
    toObservable(
      computed(() => ({ ...this.criteria(), tick: this.reloadTick() })),
    )
      .pipe(
        debounceTime(250),
        distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b)),
        tap((c) => {
          this.loading.set(true);
          this.loadError.set('');
          this.dateRefused.set(false);
          this.moreError.set('');
          this.page = 1;
          this.syncUrl(c);
        }),
        switchMap((c) =>
          this.specialists.list(this.listQuery(c, 1)).pipe(
            catchError((err: unknown) => {
              const fields = apiErrorFields(err);
              this.dateRefused.set(!!(fields['available_on'] || fields['available_within']));
              this.loadError.set(
                apiErrorMessage(err, 'Check your connection and try again.'),
              );
              return of(null);
            }),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((res) => {
        if (res) {
          this.all.set(res.data);
          this.total.set(res.meta?.total ?? res.data.length);
        }
        this.loading.set(false);
      });
  }

  /** The API query for these criteria (soonest first once a day is filtered on). */
  private listQuery(c: Criteria, page: number): ListSpecialistsQuery {
    const dated = hasWhenFilter(c.when);
    return {
      page,
      per_page: PER_PAGE,
      sort_by: dated ? 'soonest' : 'name',
      sort_dir: 'asc',
      search: c.search || undefined,
      specialty: c.specialty || undefined,
      location: c.location || undefined,
      language: c.language || undefined,
      gender: c.gender || undefined,
      mode: c.mode === 'any' ? undefined : c.mode,
      ...whenParams(c.when),
    };
  }

  /** The next page, appended (dropped if the search changed meanwhile). */
  protected loadMore(): void {
    if (this.loadingMore()) return;
    const c = this.criteria();
    const page = this.page + 1;
    this.loadingMore.set(true);
    this.moreError.set('');
    this.specialists
      .list(this.listQuery(c, page))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.loadingMore.set(false);
          if (JSON.stringify(c) !== JSON.stringify(this.criteria())) return;
          this.page = page;
          const seen = new Set(this.all().map((s) => s.id));
          this.all.update((list) => [...list, ...res.data.filter((s) => !seen.has(s.id))]);
          this.total.set(res.meta?.total ?? this.total());
        },
        error: (err: unknown) => {
          this.loadingMore.set(false);
          this.moreError.set(apiErrorMessage(err, 'Could not load more specialists. Please try again.'));
        },
      });
  }

  /** Mirror the search in the URL (replacing the entry), so it can be shared or reloaded. */
  private syncUrl(c: Criteria): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      replaceUrl: true,
      queryParams: {
        q: c.search || undefined,
        specialty: c.specialty || undefined,
        location: c.location || undefined,
        language: c.language || undefined,
        gender: c.gender || undefined,
        mode: c.mode === 'any' ? undefined : c.mode,
        ...whenQuery(c.when),
      },
    });
  }

  /** "Try {day}" from the fallback: search that day, keeping the time of day. */
  protected tryDay(date: string): void {
    this.when.update((w) => ({ ...w, when: 'date', date }));
  }

  /** "Show any day": drop the day only, keeping the time of day. */
  protected anyDay(): void {
    this.when.update((w) => ({ ...ANY_WHEN, time: w.time }));
  }

  /** "12 specialists free tomorrow" / "12 specialists found". */
  protected readonly countText = computed(() => {
    const n = this.total();
    const summary = this.whenSummary();
    return `${n} ${n === 1 ? 'specialist' : 'specialists'} ${summary ? `free ${summary}` : 'found'}`;
  });

  /** What screen readers hear once a search settles ('' while it runs). */
  protected readonly resultsAnnouncement = computed(() => {
    switch (this.viewState()) {
      case 'loading':
        return '';
      case 'error':
        return this.loadError();
      case 'empty':
        return this.dateFiltered()
          ? `No specialists free ${whenText(this.when())}`
          : 'No specialists match your filters';
      default:
        return this.countText();
    }
  });

  protected readonly activeFilterCount = computed(
    () =>
      (this.specialty() !== '' ? 1 : 0) +
      (hasDateFilter(this.when()) ? 1 : 0) +
      (this.when().time !== 'any' ? 1 : 0) +
      (this.location() !== '' ? 1 : 0) +
      (this.language() !== '' ? 1 : 0) +
      (this.gender() !== '' ? 1 : 0) +
      (this.mode() !== 'any' ? 1 : 0),
  );

  protected clearFilters(): void {
    this.specialty.set('');
    this.when.set(ANY_WHEN);
    this.location.set('');
    this.language.set('');
    this.gender.set('');
    this.mode.set('any');
  }

  /** Full reset from the empty state — clears the search box too. */
  protected reset(): void {
    this.query.set('');
    this.clearFilters();
  }

  protected reload(): void {
    this.reloadTick.update((n) => n + 1);
  }

  protected readonly viewState = computed<
    'loading' | 'list' | 'empty' | 'error'
  >(() => {
    if (this.loadError()) return 'error';
    if (this.loading()) return 'loading';
    return this.all().length === 0 ? 'empty' : 'list';
  });
}
