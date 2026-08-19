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
import { Router } from '@angular/router';
import {
  catchError,
  debounceTime,
  distinctUntilChanged,
  of,
  switchMap,
  tap,
} from 'rxjs';
import { SpecialistsApi } from '@supadoc/data-access';
import type { SpecialistDto, SpecialtyCount } from '@supadoc/models';
import { IconComponent, SearchSelectComponent } from '@supadoc/ui';
import { FindDoctorQuiz } from './find-doctor-quiz';

interface DeptMeta {
  readonly tag: string;
  readonly icon: string;
}

// Tagline + icon per specialty (icon falls back to a stethoscope).
const DEPT: Record<string, DeptMeta> = {
  Cardiology: { tag: 'Heart & blood pressure', icon: 'heart-pulse' },
  Dentistry: { tag: 'Teeth & gums', icon: 'smile' },
  Dermatology: { tag: 'Skin, hair & nails', icon: 'sparkles' },
  'General Practice': { tag: 'Everyday health', icon: 'stethoscope' },
  Gynecology: { tag: "Women's health", icon: 'activity' },
  Neurology: { tag: 'Brain & nerves', icon: 'brain' },
  Ophthalmology: { tag: 'Eyes & vision', icon: 'eye' },
  Orthopedics: { tag: 'Bone & joints', icon: 'bone' },
  Pediatrics: { tag: "Children's health", icon: 'baby' },
  Psychiatry: { tag: 'Mental wellbeing', icon: 'brain' },
};

// A light symptom → specialty heuristic for the "we recommend" hint.
const SYMPTOMS: { keyword: string; specialty: string }[] = [
  { keyword: 'blood pressure', specialty: 'Cardiology' },
  { keyword: 'hypertension', specialty: 'Cardiology' },
  { keyword: 'chest pain', specialty: 'Cardiology' },
  { keyword: 'heart', specialty: 'Cardiology' },
  { keyword: 'palpitation', specialty: 'Cardiology' },
  { keyword: 'rash', specialty: 'Dermatology' },
  { keyword: 'acne', specialty: 'Dermatology' },
  { keyword: 'skin', specialty: 'Dermatology' },
  { keyword: 'eczema', specialty: 'Dermatology' },
  { keyword: 'anxiety', specialty: 'Psychiatry' },
  { keyword: 'depress', specialty: 'Psychiatry' },
  { keyword: 'stress', specialty: 'Psychiatry' },
  { keyword: 'headache', specialty: 'Neurology' },
  { keyword: 'migraine', specialty: 'Neurology' },
  { keyword: 'seizure', specialty: 'Neurology' },
  { keyword: 'child', specialty: 'Pediatrics' },
  { keyword: 'baby', specialty: 'Pediatrics' },
  { keyword: 'joint', specialty: 'Orthopedics' },
  { keyword: 'bone', specialty: 'Orthopedics' },
  { keyword: 'fracture', specialty: 'Orthopedics' },
  { keyword: 'vision', specialty: 'Ophthalmology' },
  { keyword: 'eye', specialty: 'Ophthalmology' },
  { keyword: 'tooth', specialty: 'Dentistry' },
  { keyword: 'teeth', specialty: 'Dentistry' },
  { keyword: 'diabetes', specialty: 'General Practice' },
  { keyword: 'pregnan', specialty: 'Gynecology' },
];

/**
 * Homepage search & discovery (Figma) — a "Care that starts with the right
 * specialist" section: an animated-placeholder search with live autocomplete
 * (public specialists + specialties), a symptom→specialty hint, popular quick
 * links, and a "browse by department" grid with real counts. Selecting anything
 * takes a signed-in patient into the filtered directory; a visitor to register.
 */
@Component({
  selector: 'pat-home-discovery',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, SearchSelectComponent, FindDoctorQuiz],
  host: { class: 'block' },
  styles: [
    `
      @keyframes phIn {
        from {
          opacity: 0;
          transform: translateY(6px);
        }
        to {
          opacity: 1;
          transform: none;
        }
      }
      .ph-anim {
        animation: phIn 0.45s ease;
      }
    `,
  ],
  template: `
    <section class="bg-gradient-to-b from-glacier to-white">
      <div class="mx-auto max-w-[1280px] px-5 py-16 md:px-8">
        <div class="flex flex-col items-center gap-4 text-center">
          <span
            class="inline-flex items-center gap-2 font-sans text-body font-semibold text-cerulean"
          >
            <sd-icon name="shield-check" [size]="18" />
            Verified Specialist
          </span>
          <h2 class="font-heading text-h2 text-abyss">
            Care that starts with the right specialist
          </h2>
          <p class="max-w-2xl font-sans text-body-lg text-slate">
            Search by specialty, department, location or condition — then book a
            secure online visit in minutes.
          </p>
        </div>

        <!-- Search + "find me a doctor" -->
        <div
          class="mx-auto mt-8 flex max-w-3xl flex-col gap-3 sm:flex-row sm:items-stretch"
        >
          <div class="relative min-w-0 flex-1">
          <div
            class="flex h-full items-center gap-3 rounded-field border border-cloud bg-white px-5 py-4 shadow-[0_4px_24px_rgba(10,22,40,0.06)]"
          >
            <sd-icon name="search" [size]="22" class="shrink-0 text-slate" />
            <div class="relative min-w-0 flex-1">
              <input
                type="search"
                [value]="query()"
                (input)="query.set($any($event.target).value)"
                (focus)="focused.set(true)"
                (blur)="onBlur()"
                (keydown.enter)="submit()"
                class="w-full bg-transparent font-sans text-body text-ink focus:outline-none"
                aria-label="Search specialists"
              />
              @if (query() === '') {
                @for (p of [placeholder()]; track p) {
                  <span
                    class="ph-anim pointer-events-none absolute inset-y-0 left-0 flex items-center font-sans text-body text-slate/70"
                  >
                    {{ p }}
                  </span>
                }
              }
            </div>
            @if (query()) {
              <button
                type="button"
                class="shrink-0 text-slate transition-colors hover:text-ink"
                aria-label="Clear"
                (click)="clear()"
              >
                <sd-icon name="x" [size]="20" />
              </button>
            }
          </div>

          <!-- Autocomplete -->
          @if (open()) {
            <div
              class="absolute left-0 right-0 top-full z-20 mt-2 overflow-hidden rounded-card border border-cloud bg-white shadow-xl"
            >
              @if (searching()) {
                <div
                  class="flex items-center gap-3 px-5 py-4 font-sans text-body-sm text-slate"
                >
                  <span
                    class="size-4 animate-spin rounded-full border-2 border-cloud border-t-cerulean"
                  ></span>
                  Searching…
                </div>
              } @else if (doctors().length === 0 && specialties().length === 0) {
                <div
                  class="flex items-center justify-between gap-3 px-5 py-4 font-sans text-body-sm text-slate"
                >
                  <span
                    >No matches for “{{ query() }}”. Press
                    <span class="font-semibold text-ink">search</span> to see the
                    closest specialists.</span
                  >
                  <button
                    type="button"
                    class="shrink-0 font-sans text-body-sm font-semibold text-cerulean"
                    (mousedown)="submit()"
                  >
                    Search
                  </button>
                </div>
              } @else {
                @for (d of doctors(); track d.id) {
                  <button
                    type="button"
                    class="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-glacier"
                    (mousedown)="selectDoctor(d)"
                  >
                    <span
                      class="flex size-9 shrink-0 items-center justify-center rounded-full bg-frost/60 text-cerulean"
                    >
                      <sd-icon name="user-round" [size]="18" />
                    </span>
                    <span class="flex min-w-0 flex-1 flex-col">
                      <span
                        class="truncate font-sans text-body-sm font-semibold text-ink"
                        >{{ d.name }}</span
                      >
                      <span class="truncate font-sans text-caption text-slate"
                        >{{ d.specialty }}
                        @if (d.location) {
                          · {{ d.location }}
                        }</span
                      >
                    </span>
                    <span
                      class="shrink-0 rounded-pill bg-frost/60 px-2.5 py-0.5 font-sans text-[10px] font-medium text-cerulean"
                      >Doctor</span
                    >
                  </button>
                }
                @for (s of specialties(); track s.name) {
                  <button
                    type="button"
                    class="flex w-full items-center gap-3 border-t border-cloud px-5 py-3 text-left transition-colors hover:bg-glacier"
                    (mousedown)="selectSpecialty(s.name)"
                  >
                    <span
                      class="flex size-9 shrink-0 items-center justify-center rounded-full bg-frost/60 text-cerulean"
                    >
                      <sd-icon [name]="meta(s.name).icon" [size]="18" />
                    </span>
                    <span class="flex min-w-0 flex-1 flex-col">
                      <span
                        class="truncate font-sans text-body-sm font-semibold text-ink"
                        >{{ s.name }}</span
                      >
                      <span class="font-sans text-caption text-slate"
                        >{{ s.count }}
                        {{ s.count === 1 ? 'specialist' : 'specialists' }}</span
                      >
                    </span>
                    <span
                      class="shrink-0 rounded-pill bg-sage/15 px-2.5 py-0.5 font-sans text-[10px] font-medium text-sage"
                      >Specialty</span
                    >
                  </button>
                }
              }
            </div>
          }
          </div>

          <button
            type="button"
            class="flex shrink-0 items-center justify-center gap-2 rounded-field bg-cerulean px-6 py-4 font-sans text-body font-semibold text-white transition-colors hover:bg-ocean"
            (click)="quizOpen.set(true)"
          >
            <sd-icon name="sparkles" [size]="20" />Find a doctor for me
          </button>
        </div>

        <pat-find-doctor-quiz [(open)]="quizOpen" />

        <!-- Filter chips (single row on desktop) -->
        <div
          class="mx-auto mt-4 flex max-w-5xl flex-wrap items-center justify-center gap-3 lg:flex-nowrap"
        >
          <div
            class="flex shrink-0 rounded-field border border-cloud bg-white p-1"
          >
            @for (t of consultTypes; track t.value) {
              <button
                type="button"
                class="flex items-center gap-1.5 whitespace-nowrap rounded-pill px-3 py-1.5 font-sans text-body-sm transition-colors"
                [class]="
                  consultationType() === t.value
                    ? 'bg-frost font-medium text-cerulean'
                    : 'text-slate hover:text-ink'
                "
                (click)="consultationType.set(t.value)"
              >
                <sd-icon [name]="t.icon" [size]="16" />{{ t.label }}
              </button>
            }
          </div>

          <sd-search-select
            class="w-40 lg:min-w-0 lg:flex-1"
            icon="stethoscope"
            placeholder="Speciality"
            [options]="specialtyNames()"
            [value]="specialty()"
            (valueChange)="specialty.set($event)"
          />
          <sd-search-select
            class="w-40 lg:min-w-0 lg:flex-1"
            icon="map-pin"
            placeholder="Location"
            [options]="locations()"
            [value]="location()"
            (valueChange)="location.set($event)"
          />
          <sd-search-select
            class="w-40 lg:min-w-0 lg:flex-1"
            icon="languages"
            placeholder="Language"
            [options]="languages()"
            [value]="language()"
            (valueChange)="language.set($event)"
          />
          <sd-search-select
            class="w-40 lg:min-w-0 lg:flex-1"
            icon="user-round"
            placeholder="Gender"
            [options]="genderOptions"
            [value]="gender()"
            (valueChange)="gender.set($event)"
          />

          @if (hasFilters()) {
            <button
              type="button"
              class="inline-flex shrink-0 items-center gap-1 font-sans text-body-sm font-semibold text-slate transition-colors hover:text-ink"
              (click)="clearFilters()"
            >
              <sd-icon name="x" [size]="14" />Clear
            </button>
          }
        </div>

        <!-- Symptom hint -->
        @if (recommendation(); as rec) {
          <div class="mx-auto mt-4 max-w-3xl">
            <button
              type="button"
              class="flex w-full items-center gap-3 rounded-card border border-cerulean/20 bg-frost/40 px-5 py-3 text-left transition-colors hover:bg-frost/70"
              (click)="selectSpecialty(rec)"
            >
              <sd-icon
                name="heart-pulse"
                [size]="20"
                class="shrink-0 text-cerulean"
              />
              <span class="font-sans text-body-sm text-ink">
                Based on “{{ query() }}”, we recommend
                <span class="font-semibold text-cerulean">{{ rec }}</span
                >.
              </span>
              <sd-icon
                name="arrow-right"
                [size]="18"
                class="ml-auto shrink-0 text-cerulean"
              />
            </button>
          </div>
        }

        <!-- Popular -->
        <p class="mt-4 text-center font-sans text-body-sm text-slate">
          Popular right now:
          @for (p of popular(); track p; let last = $last) {
            <button
              type="button"
              class="font-semibold text-cerulean hover:underline"
              (click)="selectSpecialty(p)"
            >
              {{ p }} </button
            >{{ last ? '' : ' · ' }}
          }
        </p>

        <!-- Departments -->
        <div class="mt-14 flex items-end justify-between gap-4">
          <div class="flex flex-col gap-1">
            <span class="font-sans text-body font-semibold text-cerulean"
              >Popular specialties</span
            >
            <h3 class="font-heading text-h4 text-abyss">
              Browse care by department
            </h3>
          </div>
          <button
            type="button"
            class="inline-flex shrink-0 items-center gap-1 font-sans text-body-sm font-semibold text-cerulean hover:underline"
            (click)="viewAll()"
          >
            View all specialists <sd-icon name="arrow-right" [size]="16" />
          </button>
        </div>

        @if (loadingDepts()) {
          <div class="mt-6 grid grid-cols-2 gap-5 lg:grid-cols-4">
            @for (n of [1, 2, 3, 4, 5, 6, 7, 8]; track n) {
              <div
                class="h-44 animate-pulse rounded-card border border-cloud bg-cloud/40"
              ></div>
            }
          </div>
        } @else {
          <div class="mt-6 grid grid-cols-2 gap-5 lg:grid-cols-4">
            @for (d of departments(); track d.name) {
              <button
                type="button"
                class="flex flex-col items-center gap-3 rounded-card border border-cloud bg-white p-6 text-center transition-all hover:-translate-y-0.5 hover:border-cerulean/40 hover:shadow-md"
                (click)="selectSpecialty(d.name)"
              >
                <span
                  class="flex size-14 items-center justify-center rounded-full bg-frost/50 text-cerulean"
                >
                  <sd-icon [name]="meta(d.name).icon" [size]="26" />
                </span>
                <span class="font-heading text-h5 text-ink">{{ d.name }}</span>
                <span class="font-sans text-caption text-slate">{{
                  meta(d.name).tag
                }}</span>
                <span
                  class="mt-1 inline-flex items-center gap-1 font-sans text-body-sm font-semibold text-cerulean"
                >
                  {{ d.count }} {{ d.count === 1 ? 'Specialist' : 'Specialists' }}
                  <sd-icon name="arrow-right" [size]="16" />
                </span>
              </button>
            }
          </div>
        }
      </div>
    </section>
  `,
})
export class HomeDiscovery implements OnInit {
  private readonly specialistsApi = inject(SpecialistsApi);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly query = signal('');
  protected readonly quizOpen = signal(false);
  protected readonly focused = signal(false);
  protected readonly searching = signal(false);
  protected readonly doctors = signal<SpecialistDto[]>([]);
  protected readonly departments = signal<SpecialtyCount[]>([]);
  protected readonly locations = signal<string[]>([]);
  protected readonly languages = signal<string[]>([]);
  protected readonly loadingDepts = signal(true);

  // Staged filter chips — applied on the next search/browse action.
  protected readonly consultationType = signal<'any' | 'online' | 'in_person'>(
    'any',
  );
  protected readonly specialty = signal('');
  protected readonly location = signal('');
  protected readonly language = signal('');
  protected readonly gender = signal('');

  protected readonly consultTypes = [
    { value: 'any' as const, label: 'Any', icon: 'sparkles' },
    { value: 'online' as const, label: 'Online', icon: 'video' },
    { value: 'in_person' as const, label: 'In-person', icon: 'building-2' },
  ];
  protected readonly genderOptions = [
    { value: 'female', label: 'Female' },
    { value: 'male', label: 'Male' },
  ];
  protected readonly specialtyNames = computed(() =>
    this.departments().map((d) => d.name),
  );

  private readonly placeholders = [
    "Search by doctor's name — e.g Dr Grace Bell",
    'Search by specialty — e.g Cardiology',
    'Search by condition — e.g high blood pressure',
    'Search by location — e.g Lagos',
  ];
  private readonly phIndex = signal(0);
  protected readonly placeholder = computed(
    () => this.placeholders[this.phIndex() % this.placeholders.length],
  );

  constructor() {
    // Cycle the animated placeholder.
    const id = setInterval(() => this.phIndex.update((n) => n + 1), 3500);
    this.destroyRef.onDestroy(() => clearInterval(id));

    // Debounced public autocomplete.
    toObservable(this.query)
      .pipe(
        debounceTime(220),
        distinctUntilChanged(),
        tap((q) => this.searching.set(q.trim() !== '')),
        switchMap((q) =>
          q.trim() === ''
            ? of(null)
            : this.specialistsApi
                .publicSearch({ search: q.trim(), limit: 5 })
                .pipe(catchError(() => of(null))),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((res) => {
        this.doctors.set(res?.data ?? []);
        this.searching.set(false);
      });
  }

  ngOnInit(): void {
    this.specialistsApi
      .publicFacets()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.departments.set(res.data.specialties);
          this.locations.set(res.data.locations);
          this.languages.set(res.data.languages);
          this.loadingDepts.set(false);
        },
        error: () => this.loadingDepts.set(false),
      });
  }

  protected meta(name: string): DeptMeta {
    return DEPT[name] ?? { tag: 'Specialist care', icon: 'stethoscope' };
  }

  /** Specialty rows in the dropdown that match the query. */
  protected readonly specialties = computed(() => {
    const q = this.query().trim().toLowerCase();
    if (q === '') return [];
    return this.departments()
      .filter((d) => d.name.toLowerCase().includes(q))
      .slice(0, 4);
  });

  protected readonly open = computed(
    () => this.focused() && this.query().trim() !== '',
  );

  protected readonly popular = computed(() =>
    this.departments()
      .slice()
      .sort((a, b) => b.count - a.count)
      .slice(0, 3)
      .map((d) => d.name),
  );

  protected readonly recommendation = computed<string | null>(() => {
    const q = this.query().trim().toLowerCase();
    if (q.length < 3) return null;
    const known = new Set(this.departments().map((d) => d.name));
    const hit = SYMPTOMS.find(
      (s) => q.includes(s.keyword) && known.has(s.specialty),
    );
    return hit ? hit.specialty : null;
  });

  protected readonly hasFilters = computed(
    () =>
      this.consultationType() !== 'any' ||
      this.specialty() !== '' ||
      this.location() !== '' ||
      this.language() !== '' ||
      this.gender() !== '',
  );

  protected clearFilters(): void {
    this.consultationType.set('any');
    this.specialty.set('');
    this.location.set('');
    this.language.set('');
    this.gender.set('');
  }

  protected clear(): void {
    this.query.set('');
  }

  protected onBlur(): void {
    // Delay so a click on a result (mousedown) is registered first.
    setTimeout(() => this.focused.set(false), 150);
  }

  protected selectDoctor(d: SpecialistDto): void {
    this.enter({ q: d.name });
  }

  protected selectSpecialty(name: string): void {
    this.enter({ specialty: name });
  }

  protected submit(): void {
    const q = this.query().trim();
    if (q) this.enter({ q });
  }

  protected viewAll(): void {
    this.enter({});
  }

  /** Everyone lands on the public directory with the search + staged chips. */
  private enter(params: { specialty?: string; q?: string } = {}): void {
    const mode = this.consultationType();
    void this.router.navigate(['/specialists'], {
      queryParams: {
        specialty: (params.specialty ?? this.specialty()) || null,
        q: (params.q ?? '') || null,
        location: this.location() || null,
        language: this.language() || null,
        gender: this.gender() || null,
        mode: mode === 'any' ? null : mode,
      },
    });
  }
}
