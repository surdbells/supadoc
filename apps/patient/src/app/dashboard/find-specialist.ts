import {
  ChangeDetectionStrategy,
  Component,
  computed,
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
import { ActivatedRoute } from '@angular/router';
import { SpecialistsApi } from '@supadoc/data-access';
import type { SpecialistDto } from '@supadoc/models';
import {
  ButtonComponent,
  EmptyStateComponent,
  IconComponent,
  SearchSelectComponent,
} from '@supadoc/ui';
import { SpecialistCard } from './specialist-card';

interface Criteria {
  search: string;
  specialty: string;
  available: boolean;
  location: string;
  language: string;
  gender: string;
  mode: 'any' | 'online' | 'in_person';
}

/**
 * Find a Specialist (Figma 311:4126) — wired to GET /api/portal/specialists.
 * Search and the specialty/availability filters run server-side (debounced),
 * with loading, empty and error states. Each result is a `pat-specialist-card`
 * that books inline.
 */
@Component({
  selector: 'pat-find-specialist',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ButtonComponent,
    EmptyStateComponent,
    IconComponent,
    SearchSelectComponent,
    SpecialistCard,
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
            class="flex flex-1 items-center gap-2 rounded-field border border-cloud bg-white px-4 py-3"
          >
            <sd-icon name="search" [size]="20" class="text-slate" />
            <input
              type="search"
              [value]="query()"
              (input)="query.set($any($event.target).value)"
              placeholder="Search by name, speciality or condition..."
              class="w-full bg-transparent font-sans text-body text-ink placeholder:text-slate/70 focus:outline-none"
            />
          </span>
          <button
            type="button"
            class="relative flex size-12 shrink-0 items-center justify-center rounded-field border bg-white text-ink transition-colors hover:bg-glacier"
            [class]="
              filtersOpen() || activeFilterCount() > 0
                ? 'border-cerulean text-cerulean'
                : 'border-cloud'
            "
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
          class="flex flex-col gap-5 rounded-card border border-cloud bg-white p-5"
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
                    ? 'border-cerulean bg-frost text-cerulean'
                    : 'border-cloud text-slate hover:text-ink'
                "
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
                      ? 'border-cerulean bg-frost text-cerulean'
                      : 'border-cloud text-slate hover:text-ink'
                  "
                  (click)="specialty.set(s)"
                >
                  {{ s }}
                </button>
              }
            </div>
          </div>

          <div class="flex flex-col gap-2">
            <span class="font-sans text-body-sm font-semibold text-ink"
              >Availability</span
            >
            <div class="flex flex-wrap gap-2">
              <button
                type="button"
                class="rounded-pill border px-4 py-1.5 font-sans text-body-sm transition-colors"
                [class]="
                  !availableOnly()
                    ? 'border-cerulean bg-frost text-cerulean'
                    : 'border-cloud text-slate hover:text-ink'
                "
                (click)="availableOnly.set(false)"
              >
                Any time
              </button>
              <button
                type="button"
                class="rounded-pill border px-4 py-1.5 font-sans text-body-sm transition-colors"
                [class]="
                  availableOnly()
                    ? 'border-cerulean bg-frost text-cerulean'
                    : 'border-cloud text-slate hover:text-ink'
                "
                (click)="availableOnly.set(true)"
              >
                Available today
              </button>
            </div>
          </div>

          <div class="flex flex-col gap-2">
            <span class="font-sans text-body-sm font-semibold text-ink"
              >Consultation type</span
            >
            <div
              class="flex w-fit rounded-field border border-cloud bg-white p-1"
            >
              @for (t of consultTypes; track t.value) {
                <button
                  type="button"
                  class="flex items-center gap-1.5 whitespace-nowrap rounded-pill px-4 py-1.5 font-sans text-body-sm transition-colors"
                  [class]="
                    mode() === t.value
                      ? 'bg-frost font-medium text-cerulean'
                      : 'text-slate hover:text-ink'
                  "
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
                class="inline-flex items-center gap-1.5 font-sans text-body-sm font-semibold text-slate transition-colors hover:text-ink"
                (click)="clearFilters()"
              >
                <sd-icon name="x" [size]="16" />
                Clear filters
              </button>
            </div>
          }
        </div>
      }

      @switch (viewState()) {
        @case ('loading') {
          <div class="grid grid-cols-1 gap-6 xl:grid-cols-2">
            @for (n of [1, 2, 3, 4]; track n) {
              <div
                class="h-72 animate-pulse rounded-card border border-cloud bg-cloud/40"
              ></div>
            }
          </div>
        }
        @case ('error') {
          <sd-empty-state
            tone="error"
            icon="wifi-off"
            title="Unable to load specialists"
            message="Check your connection and try again."
          >
            <sd-button (click)="reload()">Try Again</sd-button>
          </sd-empty-state>
        }
        @case ('empty') {
          <sd-empty-state
            icon="user-x"
            title="No specialist match your result"
            message="Try broadening your filters — clear a specialty, expand availability, or search a related condition"
          >
            <sd-button (click)="reset()">Reset Filter</sd-button>
          </sd-empty-state>
        }
        @default {
          <div class="flex items-center justify-between">
            <p class="font-sans text-body font-semibold text-ink">
              {{ all().length }} Specialist found
            </p>
          </div>

          <div class="grid grid-cols-1 items-stretch gap-6 xl:grid-cols-2">
            @for (s of all(); track s.id) {
              <pat-specialist-card [specialist]="s" />
            }
          </div>
        }
      }
    </div>
  `,
})
export class FindSpecialist {
  private readonly specialists = inject(SpecialistsApi);
  private readonly route = inject(ActivatedRoute);

  protected readonly query = signal('');
  protected readonly specialty = signal('');
  protected readonly availableOnly = signal(false);
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
  private readonly loading = signal(true);
  private readonly loadError = signal(false);
  private readonly reloadTick = signal(0);

  private readonly criteria = computed<Criteria>(() => ({
    search: this.query().trim(),
    specialty: this.specialty(),
    available: this.availableOnly(),
    location: this.location(),
    language: this.language(),
    gender: this.gender(),
    mode: this.mode(),
  }));

  constructor() {
    // Deep links from the homepage discovery section pre-fill the filters
    // (e.g. /dashboard/specialists?specialty=Cardiology&gender=female).
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
        tap(() => {
          this.loading.set(true);
          this.loadError.set(false);
        }),
        switchMap((c) =>
          this.specialists
            .list({
              per_page: 100,
              sort_by: 'name',
              sort_dir: 'asc',
              search: c.search || undefined,
              specialty: c.specialty || undefined,
              available: c.available || undefined,
              location: c.location || undefined,
              language: c.language || undefined,
              gender: c.gender || undefined,
              mode: c.mode === 'any' ? undefined : c.mode,
            })
            .pipe(
              catchError(() => {
                this.loadError.set(true);
                return of(null);
              }),
            ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((res) => {
        if (res) this.all.set(res.data);
        this.loading.set(false);
      });
  }

  protected readonly activeFilterCount = computed(
    () =>
      (this.specialty() !== '' ? 1 : 0) +
      (this.availableOnly() ? 1 : 0) +
      (this.location() !== '' ? 1 : 0) +
      (this.language() !== '' ? 1 : 0) +
      (this.gender() !== '' ? 1 : 0) +
      (this.mode() !== 'any' ? 1 : 0),
  );

  protected clearFilters(): void {
    this.specialty.set('');
    this.availableOnly.set(false);
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
