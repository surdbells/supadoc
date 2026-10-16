import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  catchError,
  debounceTime,
  distinctUntilChanged,
  of,
  switchMap,
  tap,
} from 'rxjs';
import {
  apiErrorFields,
  apiErrorMessage,
  SpecialistsApi,
  type PublicSpecialistSearchParams,
} from '@supadoc/data-access';
import type { SpecialistDto } from '@supadoc/models';
import {
  ButtonComponent,
  IconComponent,
  LogoComponent,
  SearchSelectComponent,
} from '@supadoc/ui';
import { AvailabilityFallback, type DirectoryFilters } from '../dashboard/availability-fallback';
import {
  ANY_WHEN,
  hasDateFilter,
  hasWhenFilter,
  whenDay,
  whenFromQuery,
  whenParams,
  whenText,
  type WhenFilter,
} from '../dashboard/booking-helpers';
import { SpecialistCard } from '../dashboard/specialist-card';
import { WhenFilterChips } from '../dashboard/when-filter';

type Mode = 'any' | 'online' | 'in_person';
type Sort = 'soonest' | 'rating' | 'fee_low' | 'experience';

/** Each sort as the API's `sort_by` / `sort_dir`. */
const SORTS: Record<Sort, Pick<PublicSpecialistSearchParams, 'sort_by' | 'sort_dir'>> = {
  soonest: { sort_by: 'soonest' },
  rating: { sort_by: 'rating', sort_dir: 'desc' },
  fee_low: { sort_by: 'consultation_fee', sort_dir: 'asc' },
  experience: { sort_by: 'years_experience', sort_dir: 'desc' },
};

/** Doctors per page (the public API's most). */
const PAGE_SIZE = 24;
/** The fee slider's range until the facets say otherwise. */
const FEE_RANGE = { min: 5000, max: 20000 };

// Light symptom → specialty hint (mirrors the homepage).
const SYMPTOMS: { keyword: string; specialty: string }[] = [
  { keyword: 'blood pressure', specialty: 'Cardiology' },
  { keyword: 'hypertension', specialty: 'Cardiology' },
  { keyword: 'chest pain', specialty: 'Cardiology' },
  { keyword: 'heart', specialty: 'Cardiology' },
  { keyword: 'rash', specialty: 'Dermatology' },
  { keyword: 'acne', specialty: 'Dermatology' },
  { keyword: 'skin', specialty: 'Dermatology' },
  { keyword: 'anxiety', specialty: 'Psychiatry' },
  { keyword: 'depress', specialty: 'Psychiatry' },
  { keyword: 'headache', specialty: 'Neurology' },
  { keyword: 'migraine', specialty: 'Neurology' },
  { keyword: 'child', specialty: 'Pediatrics' },
  { keyword: 'joint', specialty: 'Orthopedics' },
  { keyword: 'bone', specialty: 'Orthopedics' },
  { keyword: 'vision', specialty: 'Ophthalmology' },
  { keyword: 'eye', specialty: 'Ophthalmology' },
  { keyword: 'tooth', specialty: 'Dentistry' },
  { keyword: 'teeth', specialty: 'Dentistry' },
];

/**
 * Public specialist directory (Figma) — the full "Care that starts with the
 * right specialist" results page, no auth required to browse or filter. A
 * collapsible Filters sidebar (consultation type, when + time of day,
 * specialty, location, language, gender, fee, experience, rating) and the
 * sort all run on the server (GET /public/specialists, paged — "Show more"),
 * in the visitor's time zone; `?when=&time=` deep-link the "when" filters.
 * Every doctor carries when they are free. A day nobody is free on offers the
 * next open day and similar doctors. Booking a card sends a visitor to register.
 */
@Component({
  selector: 'pat-public-specialists',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    AvailabilityFallback,
    IconComponent,
    ButtonComponent,
    LogoComponent,
    SearchSelectComponent,
    SpecialistCard,
    WhenFilterChips,
  ],
  host: { class: 'block min-h-screen bg-glacier' },
  template: `
    <!-- Header -->
    <header
      class="sticky top-0 z-30 border-b border-cloud/70 bg-white/90 backdrop-blur"
    >
      <div
        class="mx-auto flex h-16 max-w-[1280px] items-center justify-between gap-4 px-5 md:px-8"
      >
        <a routerLink="/"><sd-logo [size]="30" /></a>
        <div class="flex items-center gap-3">
          <sd-button variant="ghost" size="sm" routerLink="/auth/login"
            >Login</sd-button
          >
          <sd-button size="sm" routerLink="/auth/register">Register</sd-button>
        </div>
      </div>
    </header>

    <div class="mx-auto max-w-[1280px] px-5 py-10 md:px-8">
      <!-- Hero -->
      <div class="flex flex-col items-center gap-3 text-center">
        <span
          class="inline-flex items-center gap-2 font-sans text-body font-semibold text-cerulean"
        >
          <sd-icon name="shield-check" [size]="18" />
          Verified Specialist
        </span>
        <h1 class="font-heading text-h2 text-abyss">
          Care that starts with the right specialist
        </h1>
        <p class="max-w-2xl font-sans text-body text-slate">
          Browse verified specialists — filter by specialty, location, language,
          gender or consultation type, then book in minutes.
        </p>
      </div>

      <!-- Search -->
      <div
        class="mx-auto mt-6 flex max-w-3xl items-center gap-3 rounded-field border border-cloud bg-white px-5 py-4 shadow-[0_4px_24px_rgba(10,22,40,0.06)]"
      >
        <sd-icon name="search" [size]="22" class="shrink-0 text-slate" />
        <input
          type="search"
          [value]="query()"
          (input)="query.set($any($event.target).value)"
          placeholder="Search by doctor's name, specialty or condition…"
          class="w-full bg-transparent font-sans text-body text-ink focus:outline-none"
          aria-label="Search specialists"
        />
        @if (query()) {
          <button
            type="button"
            class="shrink-0 text-slate hover:text-ink"
            aria-label="Clear"
            (click)="query.set('')"
          >
            <sd-icon name="x" [size]="20" />
          </button>
        }
      </div>

      <!-- Symptom hint -->
      @if (recommendation(); as rec) {
        <div class="mx-auto mt-4 max-w-3xl">
          <button
            type="button"
            class="flex w-full items-center gap-3 rounded-card border border-cerulean/20 bg-frost/40 px-5 py-3 text-left transition-colors hover:bg-frost/70"
            (click)="specialty.set(rec)"
          >
            <sd-icon name="heart-pulse" [size]="20" class="shrink-0 text-cerulean" />
            <span class="font-sans text-body-sm text-ink"
              >Based on “{{ query() }}”, we recommend
              <span class="font-semibold text-cerulean">{{ rec }}</span>.</span
            >
            <sd-icon
              name="arrow-right"
              [size]="18"
              class="ml-auto shrink-0 text-cerulean"
            />
          </button>
        </div>
      }

      <!-- Toolbar -->
      <div class="mt-8 flex flex-wrap items-center justify-between gap-3">
        <div class="flex items-center gap-3">
          <button
            type="button"
            class="inline-flex items-center gap-2 rounded-field border border-cloud bg-white px-4 py-2.5 font-sans text-body-sm font-medium text-ink transition-colors hover:border-cerulean/50"
            (click)="sidebarOpen.set(!sidebarOpen())"
          >
            <sd-icon name="filter" [size]="18" />
            {{ sidebarOpen() ? 'Hide filters' : 'Filters' }}
            @if (activeFilterCount() > 0) {
              <span
                class="flex size-5 items-center justify-center rounded-full bg-cerulean text-[10px] font-semibold text-white"
                >{{ activeFilterCount() }}</span
              >
            }
          </button>
          <p class="font-sans text-body font-semibold text-ink" aria-live="polite">
            {{ total() }} {{ total() === 1 ? 'specialist' : 'specialists' }}
            {{ whenSummary() ? 'free ' + whenSummary() : 'found' }}
          </p>
        </div>
        <div class="flex items-center gap-3">
          @if (activeFilterCount() > 0) {
            <button
              type="button"
              class="font-sans text-body-sm font-semibold text-cerulean hover:underline"
              (click)="reset()"
            >
              clear all
            </button>
          }
          <div class="flex items-center gap-2">
            <span class="shrink-0 font-sans text-body-sm text-slate">Sort:</span>
            <sd-search-select
              class="w-48"
              [options]="sortOptions"
              [clearable]="false"
              [value]="sortBy()"
              (valueChange)="sortBy.set($any($event) || 'soonest')"
            />
          </div>
        </div>
      </div>

      <div class="mt-6 flex flex-col gap-6 lg:flex-row lg:items-start">
        <!-- Sidebar -->
        @if (sidebarOpen()) {
          <aside
            class="flex shrink-0 flex-col gap-6 rounded-card border border-haze bg-white p-6 shadow-card lg:sticky lg:top-24 lg:w-72"
          >
            <div class="flex items-center justify-between">
              <span
                class="flex items-center gap-2 font-heading text-h5 text-ink"
              >
                <sd-icon name="filter" [size]="18" class="text-cerulean" />Filters
              </span>
              <button
                type="button"
                class="font-sans text-body-sm font-semibold text-cerulean hover:underline"
                (click)="reset()"
              >
                Reset
              </button>
            </div>

            <div class="flex flex-col gap-2">
              <span class="font-sans text-caption font-semibold text-slate"
                >Consultation type</span
              >
              <div class="flex rounded-field border border-haze bg-glacier p-1">
                @for (t of consultTypes; track t.value) {
                  <button
                    type="button"
                    class="flex flex-1 items-center justify-center gap-1 whitespace-nowrap rounded-pill px-2 py-1.5 font-sans text-caption transition-colors"
                    [class]="
                      mode() === t.value
                        ? 'bg-frost font-medium text-cerulean-dark shadow-control'
                        : 'text-slate hover:text-ink'
                    "
                    (click)="mode.set(t.value)"
                  >
                    <sd-icon [name]="t.icon" [size]="14" />{{ t.label }}
                  </button>
                }
              </div>
            </div>

            <!-- When + time of day (the visitor's own calendar and clock) -->
            <pat-when-filter [(value)]="when" [compact]="true" />

            <div class="flex flex-col gap-2">
              <span class="font-sans text-caption font-semibold text-slate"
                >Speciality</span
              >
              <sd-search-select
                placeholder="Any"
                [options]="specialties()"
                [value]="specialty()"
                (valueChange)="specialty.set($event)"
              />
            </div>

            <div class="flex flex-col gap-2">
              <span class="font-sans text-caption font-semibold text-slate"
                >Location</span
              >
              <sd-search-select
                placeholder="Any"
                [options]="locations()"
                [value]="location()"
                (valueChange)="location.set($event)"
              />
            </div>

            <div class="flex flex-col gap-2">
              <span class="font-sans text-caption font-semibold text-slate"
                >Language</span
              >
              <sd-search-select
                placeholder="Any"
                [options]="languages()"
                [value]="language()"
                (valueChange)="language.set($event)"
              />
            </div>

            <div class="flex flex-col gap-2">
              <span class="font-sans text-caption font-semibold text-slate"
                >Gender</span
              >
              <sd-search-select
                placeholder="Both"
                [options]="genderOptions"
                [value]="gender()"
                (valueChange)="gender.set($event)"
              />
            </div>

            <div class="flex flex-col gap-2">
              <div class="flex items-center justify-between">
                <span class="font-sans text-caption font-semibold text-slate"
                  >Consultation fee</span
                >
                <span class="font-sans text-caption font-medium text-ink">{{
                  feeLabel()
                }}</span>
              </div>
              <input
                type="range"
                [min]="feeRange().min"
                [max]="feeRange().max"
                step="500"
                [value]="feeMax()"
                (input)="feeMax.set(+$any($event.target).value)"
                aria-label="Maximum consultation fee"
                [attr.aria-valuetext]="feeLabel()"
                class="w-full accent-cerulean"
              />
            </div>

            <div class="flex flex-col gap-2">
              <span class="font-sans text-caption font-semibold text-slate"
                >Years of experience</span
              >
              <sd-search-select
                placeholder="Any"
                [options]="yearsOptions"
                [value]="minYears() ? minYears() + '' : ''"
                (valueChange)="minYears.set($event ? +$event : 0)"
              />
            </div>

            <div class="flex flex-col gap-2">
              <span class="font-sans text-caption font-semibold text-slate"
                >Rating</span
              >
              <sd-search-select
                placeholder="Any"
                [options]="ratingOptions"
                [value]="minRating() ? minRating() + '' : ''"
                (valueChange)="minRating.set($event ? +$event : 0)"
              />
            </div>
          </aside>
        }

        <!-- Results -->
        <div class="min-w-0 flex-1">
          @if (loading()) {
            <div class="grid grid-cols-1 gap-6 xl:grid-cols-2">
              @for (n of [1, 2, 3, 4]; track n) {
                <div
                  class="h-72 animate-pulse rounded-card border border-cloud bg-cloud/40"
                ></div>
              }
            </div>
          } @else if (loadError()) {
            <div class="flex flex-col items-center gap-5 py-20 text-center">
              <sd-icon [name]="dateRefused() ? 'calendar-off' : 'wifi-off'" [size]="40" class="text-alert" />
              <p class="font-sans text-body-sm text-slate">
                {{ loadError() }}
              </p>
              @if (dateRefused()) {
                <sd-button (click)="anyDay()">Show any day</sd-button>
              } @else {
                <sd-button (click)="reload()">Try Again</sd-button>
              }
            </div>
          } @else if (all().length === 0 && dateFiltered()) {
            <!-- Nobody free then: the next open day + similar doctors who are -->
            <pat-availability-fallback
              [filters]="fallbackFilters()"
              [when]="when()"
              [count]="0"
              (tryDay)="tryDay($event)"
              (anyDay)="anyDay()"
            />
          } @else if (all().length === 0) {
            <div class="flex flex-col items-center gap-5 py-20 text-center">
              <span
                class="flex size-24 items-center justify-center rounded-full bg-cloud text-slate"
              >
                <sd-icon name="user-x" [size]="40" />
              </span>
              <div class="flex max-w-md flex-col gap-2">
                <h2 class="font-heading text-h5 text-ink">
                  No specialist matches your filters
                </h2>
                <p class="font-sans text-body-sm text-slate">
                  Try clearing a filter or widening your fee, rating or
                  experience range.
                </p>
              </div>
              <sd-button (click)="reset()">Reset filters</sd-button>
            </div>
          } @else {
            <div class="grid grid-cols-1 items-stretch gap-6 xl:grid-cols-2">
              @for (s of all(); track s.id) {
                <pat-specialist-card [specialist]="s" [date]="filterDay()" />
              }
            </div>
            @if (all().length < total()) {
              <div class="mt-6 flex flex-col items-center gap-2">
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
                class="mt-6"
                [filters]="fallbackFilters()"
                [when]="when()"
                [count]="total()"
                [excludeIds]="listedIds()"
                (tryDay)="tryDay($event)"
                (anyDay)="anyDay()"
              />
            }
          }
        </div>
      </div>
    </div>
  `,
})
export class PublicSpecialists implements OnInit {
  private readonly specialistsApi = inject(SpecialistsApi);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly query = signal('');
  protected readonly specialty = signal('');
  protected readonly location = signal('');
  protected readonly language = signal('');
  protected readonly gender = signal('');
  protected readonly mode = signal<Mode>('any');
  protected readonly when = signal<WhenFilter>(ANY_WHEN);
  /** The slider's bounds: the cheapest and dearest listed fee (rounded out), once known. */
  protected readonly feeRange = signal(FEE_RANGE);
  /** At the slider's top there is no cap. */
  protected readonly feeMax = signal(FEE_RANGE.max);
  protected readonly minYears = signal(0);
  protected readonly minRating = signal(0);
  protected readonly sortBy = signal<Sort>('soonest');
  protected readonly sidebarOpen = signal(true);

  protected readonly specialties = signal<string[]>([]);
  protected readonly locations = signal<string[]>([]);
  protected readonly languages = signal<string[]>([]);

  protected readonly all = signal<SpecialistDto[]>([]);
  /** How many doctors match in all (meta.total), not just the pages shown. */
  protected readonly total = signal(0);
  protected readonly loading = signal(true);
  /** Why the search failed ('' when it didn't). */
  protected readonly loadError = signal('');
  /** The API refused the day searched (outside the booking window). */
  protected readonly dateRefused = signal(false);
  private readonly reloadTick = signal(0);
  private page = 1;
  protected readonly loadingMore = signal(false);
  protected readonly moreError = signal('');

  protected readonly consultTypes = [
    { value: 'any' as const, label: 'Any', icon: 'sparkles' },
    { value: 'online' as const, label: 'Online', icon: 'video' },
    { value: 'in_person' as const, label: 'In-person', icon: 'building-2' },
  ];
  protected readonly genderOptions = [
    { value: 'female', label: 'Female' },
    { value: 'male', label: 'Male' },
  ];
  protected readonly sortOptions = [
    { value: 'soonest', label: 'Soonest available' },
    { value: 'rating', label: 'Top rated' },
    { value: 'fee_low', label: 'Fee: low to high' },
    { value: 'experience', label: 'Most experienced' },
  ];
  protected readonly yearsOptions = [
    { value: '5', label: '5+ years' },
    { value: '10', label: '10+ years' },
    { value: '15', label: '15+ years' },
  ];
  protected readonly ratingOptions = [
    { value: '4', label: '4.0+' },
    { value: '4.5', label: '4.5+' },
    { value: '4.8', label: '4.8+' },
  ];

  /** Everything the search sends but the page (each change starts again at page 1). */
  private readonly searchParams = computed<PublicSpecialistSearchParams>(() => ({
    ...this.fallbackFilters(),
    ...whenParams(this.when()),
    ...SORTS[this.sortBy()],
    limit: PAGE_SIZE,
  }));

  /** The profile filters (no "when", no paging) — also what the fallback searches with. */
  protected readonly fallbackFilters = computed<DirectoryFilters>(() => {
    const capped = this.feeMax() < this.feeRange().max;
    return {
      search: this.query().trim() || undefined,
      specialty: this.specialty() || undefined,
      location: this.location() || undefined,
      language: this.language() || undefined,
      gender: this.gender() || undefined,
      mode: this.mode() === 'in_person' ? 'in_person' : undefined,
      fee_max: capped ? this.feeMax() : undefined,
      min_years: this.minYears() > 0 ? this.minYears() : undefined,
      min_rating: this.minRating() > 0 ? this.minRating() : undefined,
    };
  });

  protected readonly dateFiltered = computed(() => hasDateFilter(this.when()));
  /** The one day searched (today / tomorrow / a picked date), for the cards. */
  protected readonly filterDay = computed(() => whenDay(this.when()));
  protected readonly whenSummary = computed(() => (hasWhenFilter(this.when()) ? whenText(this.when()) : ''));
  protected readonly listedIds = computed(() => this.all().map((s) => s.id));

  constructor() {
    // Every filter and the sort run on the server (debounced).
    toObservable(computed(() => ({ params: this.searchParams(), tick: this.reloadTick() })))
      .pipe(
        debounceTime(220),
        distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b)),
        tap(() => {
          this.loading.set(true);
          this.loadError.set('');
          this.dateRefused.set(false);
          this.moreError.set('');
          this.page = 1;
        }),
        switchMap(({ params }) =>
          this.specialistsApi.publicSearch({ ...params, page: 1 }).pipe(
            catchError((err: unknown) => {
              const fields = apiErrorFields(err);
              this.dateRefused.set(!!(fields['available_on'] || fields['available_within']));
              this.loadError.set(apiErrorMessage(err, 'Unable to load specialists.'));
              return of(null);
            }),
          ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        if (res) {
          this.all.set(res.data);
          this.total.set(res.meta?.total ?? res.data.length);
        }
        this.loading.set(false);
      });
  }

  ngOnInit(): void {
    const qp = this.route.snapshot.queryParamMap;
    const set = (key: string, sig: { set: (v: string) => void }): void => {
      const v = qp.get(key);
      if (v) sig.set(v);
    };
    set('q', this.query);
    set('specialty', this.specialty);
    set('location', this.location);
    set('language', this.language);
    set('gender', this.gender);
    const md = qp.get('mode');
    if (md === 'online' || md === 'in_person') this.mode.set(md);
    this.when.set(whenFromQuery(qp));

    this.specialistsApi
      .publicFacets()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.specialties.set(res.data.specialties.map((s) => s.name));
          this.locations.set(res.data.locations);
          this.languages.set(res.data.languages);
          // The slider spans the listed fees; an untouched slider stays "no cap".
          const fees = res.data.fee_range;
          if (fees) {
            const min = Math.floor(Number(fees.min) / 1000) * 1000;
            const max = Math.max(min + 1000, Math.ceil(Number(fees.max) / 1000) * 1000);
            const uncapped = this.feeMax() >= this.feeRange().max;
            this.feeRange.set({ min, max });
            this.feeMax.set(uncapped ? max : Math.min(max, Math.max(min, this.feeMax())));
          }
        },
      });
  }

  /** The next page, appended (dropped if the search changed meanwhile). */
  protected loadMore(): void {
    if (this.loadingMore()) return;
    const params = this.searchParams();
    const page = this.page + 1;
    this.loadingMore.set(true);
    this.moreError.set('');
    this.specialistsApi
      .publicSearch({ ...params, page })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.loadingMore.set(false);
          if (JSON.stringify(params) !== JSON.stringify(this.searchParams())) return;
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

  /** "Try {day}" from the fallback: search that day, keeping the time of day. */
  protected tryDay(date: string): void {
    this.when.update((w) => ({ ...w, when: 'date', date }));
  }

  /** "Show any day": drop the day only, keeping the time of day. */
  protected anyDay(): void {
    this.when.update((w) => ({ ...ANY_WHEN, time: w.time }));
  }

  protected readonly recommendation = computed<string | null>(() => {
    const q = this.query().trim().toLowerCase();
    if (q.length < 3) return null;
    const known = new Set(this.specialties());
    const hit = SYMPTOMS.find(
      (s) => q.includes(s.keyword) && known.has(s.specialty),
    );
    return hit ? hit.specialty : null;
  });

  private readonly feeFmt = new Intl.NumberFormat('en-NG', {
    maximumFractionDigits: 0,
  });
  protected readonly feeLabel = computed(() =>
    this.feeMax() >= this.feeRange().max
      ? `Up to ₦${this.feeFmt.format(this.feeRange().max)}+`
      : `Up to ₦${this.feeFmt.format(this.feeMax())}`,
  );

  protected readonly activeFilterCount = computed(
    () =>
      (this.specialty() !== '' ? 1 : 0) +
      (this.location() !== '' ? 1 : 0) +
      (this.language() !== '' ? 1 : 0) +
      (this.gender() !== '' ? 1 : 0) +
      (this.mode() !== 'any' ? 1 : 0) +
      (hasDateFilter(this.when()) ? 1 : 0) +
      (this.when().time !== 'any' ? 1 : 0) +
      (this.feeMax() < this.feeRange().max ? 1 : 0) +
      (this.minYears() > 0 ? 1 : 0) +
      (this.minRating() > 0 ? 1 : 0),
  );

  protected reset(): void {
    this.query.set('');
    this.specialty.set('');
    this.location.set('');
    this.language.set('');
    this.gender.set('');
    this.mode.set('any');
    this.when.set(ANY_WHEN);
    this.feeMax.set(this.feeRange().max);
    this.minYears.set(0);
    this.minRating.set(0);
  }

  protected reload(): void {
    this.reloadTick.update((n) => n + 1);
  }
}
