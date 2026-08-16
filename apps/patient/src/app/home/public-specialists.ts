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
import { SpecialistsApi } from '@supadoc/data-access';
import type { SpecialistDto } from '@supadoc/models';
import {
  ButtonComponent,
  IconComponent,
  LogoComponent,
  SearchSelectComponent,
} from '@supadoc/ui';
import { SpecialistCard } from '../dashboard/specialist-card';

type Mode = 'any' | 'online' | 'in_person';

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
 * collapsible Filters sidebar (consultation type, specialty, location,
 * language, gender, fee, experience, rating) drives the public search; the
 * server handles the facet filters and fee/experience/rating refine client-side.
 * Booking a card sends a visitor to register.
 */
@Component({
  selector: 'pat-public-specialists',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    IconComponent,
    ButtonComponent,
    LogoComponent,
    SearchSelectComponent,
    SpecialistCard,
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
          <p class="font-sans text-body font-semibold text-ink">
            {{ filtered().length }} Specialist found
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
              (valueChange)="sortBy.set($any($event))"
            />
          </div>
        </div>
      </div>

      <div class="mt-6 flex flex-col gap-6 lg:flex-row lg:items-start">
        <!-- Sidebar -->
        @if (sidebarOpen()) {
          <aside
            class="flex shrink-0 flex-col gap-6 rounded-card border border-cloud bg-white p-6 lg:sticky lg:top-24 lg:w-72"
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
              <div class="flex rounded-field border border-cloud p-1">
                @for (t of consultTypes; track t.value) {
                  <button
                    type="button"
                    class="flex flex-1 items-center justify-center gap-1 whitespace-nowrap rounded-pill px-2 py-1.5 font-sans text-caption transition-colors"
                    [class]="
                      mode() === t.value
                        ? 'bg-frost font-medium text-cerulean'
                        : 'text-slate hover:text-ink'
                    "
                    (click)="mode.set(t.value)"
                  >
                    <sd-icon [name]="t.icon" [size]="14" />{{ t.label }}
                  </button>
                }
              </div>
            </div>

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
                min="5000"
                max="20000"
                step="1000"
                [value]="feeMax()"
                (input)="feeMax.set(+$any($event.target).value)"
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
              <sd-icon name="wifi-off" [size]="40" class="text-alert" />
              <p class="font-sans text-body-sm text-slate">
                Unable to load specialists.
              </p>
              <sd-button (click)="reload()">Try Again</sd-button>
            </div>
          } @else if (filtered().length === 0) {
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
              @for (s of filtered(); track s.id) {
                <pat-specialist-card [specialist]="s" />
              }
            </div>
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
  protected readonly feeMax = signal(20000);
  protected readonly minYears = signal(0);
  protected readonly minRating = signal(0);
  protected readonly sortBy = signal<
    'recommended' | 'rating' | 'fee_low' | 'experience'
  >('recommended');
  protected readonly sidebarOpen = signal(true);

  protected readonly specialties = signal<string[]>([]);
  protected readonly locations = signal<string[]>([]);
  protected readonly languages = signal<string[]>([]);

  private readonly all = signal<SpecialistDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly loadError = signal(false);
  private readonly reloadTick = signal(0);

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
    { value: 'recommended', label: 'Recommended' },
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

  constructor() {
    // Server-side facet filters (debounced).
    toObservable(
      computed(() => ({
        search: this.query().trim(),
        specialty: this.specialty(),
        location: this.location(),
        language: this.language(),
        gender: this.gender(),
        mode: this.mode(),
        tick: this.reloadTick(),
      })),
    )
      .pipe(
        debounceTime(220),
        distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b)),
        tap(() => {
          this.loading.set(true);
          this.loadError.set(false);
        }),
        switchMap((c) =>
          this.specialistsApi
            .publicSearch({
              search: c.search || undefined,
              specialty: c.specialty || undefined,
              location: c.location || undefined,
              language: c.language || undefined,
              gender: c.gender || undefined,
              mode: c.mode === 'any' ? undefined : c.mode,
              limit: 24,
            })
            .pipe(
              catchError(() => {
                this.loadError.set(true);
                return of(null);
              }),
            ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        if (res) this.all.set(res.data);
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

    this.specialistsApi
      .publicFacets()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.specialties.set(res.data.specialties.map((s) => s.name));
          this.locations.set(res.data.locations);
          this.languages.set(res.data.languages);
        },
      });
  }

  /** Client-side fee/experience/rating refine + sort over the server results. */
  protected readonly filtered = computed(() => {
    const feeCap = this.feeMax();
    const years = this.minYears();
    const rating = this.minRating();
    const list = this.all().filter((s) => {
      if (feeCap < 20000 && Number(s.consultation_fee) > feeCap) return false;
      if (years > 0 && (s.years_experience ?? 0) < years) return false;
      if (rating > 0 && Number(s.rating) < rating) return false;
      return true;
    });
    const sorted = [...list];
    switch (this.sortBy()) {
      case 'fee_low':
        sorted.sort(
          (a, b) => Number(a.consultation_fee) - Number(b.consultation_fee),
        );
        break;
      case 'experience':
        sorted.sort(
          (a, b) => (b.years_experience ?? 0) - (a.years_experience ?? 0),
        );
        break;
      case 'rating':
      case 'recommended':
      default:
        sorted.sort((a, b) => Number(b.rating) - Number(a.rating));
    }
    return sorted;
  });

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
    this.feeMax() >= 20000
      ? 'Up to ₦20,000+'
      : `Up to ₦${this.feeFmt.format(this.feeMax())}`,
  );

  protected readonly activeFilterCount = computed(
    () =>
      (this.specialty() !== '' ? 1 : 0) +
      (this.location() !== '' ? 1 : 0) +
      (this.language() !== '' ? 1 : 0) +
      (this.gender() !== '' ? 1 : 0) +
      (this.mode() !== 'any' ? 1 : 0) +
      (this.feeMax() < 20000 ? 1 : 0) +
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
    this.feeMax.set(20000);
    this.minYears.set(0);
    this.minRating.set(0);
  }

  protected reload(): void {
    this.reloadTick.update((n) => n + 1);
  }
}
