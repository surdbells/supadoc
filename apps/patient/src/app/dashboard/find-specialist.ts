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
  firstValueFrom,
  of,
  switchMap,
  tap,
} from 'rxjs';
import { Router } from '@angular/router';
import { AppointmentsApi, SpecialistsApi } from '@supadoc/data-access';
import type { SpecialistDto } from '@supadoc/models';
import { ButtonComponent, IconComponent } from '@supadoc/ui';

type Availability = 'today' | 'week' | 'next';

interface Specialist {
  readonly id: string;
  readonly photo: string;
  readonly name: string;
  readonly specialty: string;
  readonly location: string;
  readonly languages: string;
  readonly experience: string;
  readonly rating: string;
  readonly reviews: string;
  readonly price: string;
  readonly availability: Availability;
}

const AVAILABILITY: Record<Availability, { label: string; class: string }> = {
  today: { label: 'Available Today', class: 'bg-sage/15 text-sage' },
  week: { label: 'This week', class: 'bg-frost text-cerulean' },
  next: { label: 'Next week', class: 'bg-cloud text-slate' },
};

// The backend has no avatar/languages/experience — cycle placeholder portraits.
const PHOTOS = [
  '/dashboard/avatar-james.png',
  '/home/doc2.png',
  '/home/doc3.png',
  '/home/doc4.png',
  '/home/doc1.png',
];

function toSpecialistCard(s: SpecialistDto, i: number): Specialist {
  return {
    id: s.id,
    photo: PHOTOS[i % PHOTOS.length],
    name: s.name,
    specialty: s.specialty,
    location: s.location ?? '—',
    languages: 'English',
    experience: 'Verified specialist',
    rating: Number(s.rating).toFixed(1),
    reviews: `${s.reviews_count} reviews`,
    price: `$${s.consultation_fee}`,
    availability: s.available ? 'today' : 'next',
  };
}

interface Criteria {
  search: string;
  specialty: string;
  available: boolean;
}

/**
 * Find a Specialist (Figma 311:4126) — wired to GET /api/portal/specialists.
 * Search and the specialty/availability filters run server-side (debounced),
 * with loading, empty and error states.
 */
@Component({
  selector: 'pat-find-specialist',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent],
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
                class="h-48 animate-pulse rounded-card border border-cloud bg-cloud/40"
              ></div>
            }
          </div>
        }
        @case ('error') {
          <div class="flex flex-col items-center gap-5 py-20 text-center">
            <span
              class="flex size-24 items-center justify-center rounded-full bg-alert/10 text-alert"
            >
              <sd-icon name="wifi-off" [size]="40" />
            </span>
            <div class="flex max-w-md flex-col gap-2">
              <h2 class="font-heading text-h5 text-ink">
                Unable to load specialists
              </h2>
              <p class="font-sans text-body-sm text-slate">
                Check your connection and try again.
              </p>
            </div>
            <sd-button class="mt-2" (click)="reload()">Try Again</sd-button>
          </div>
        }
        @case ('empty') {
          <div class="flex flex-col items-center gap-5 py-20 text-center">
            <span
              class="flex size-24 items-center justify-center rounded-full bg-cloud text-slate"
            >
              <sd-icon name="user-x" [size]="40" />
            </span>
            <div class="flex max-w-md flex-col gap-2">
              <h2 class="font-heading text-h5 text-ink">
                No specialist match your result
              </h2>
              <p class="font-sans text-body-sm text-slate">
                Try broadening your filters — clear a specialty, expand
                availability, or search a related condition
              </p>
            </div>
            <sd-button class="mt-2" (click)="reset()">Reset Filter</sd-button>
          </div>
        }
        @default {
          <!-- Count -->
          <div class="flex items-center justify-between">
            <p class="font-sans text-body font-semibold text-ink">
              {{ all().length }} Specialist found
            </p>
          </div>

          <!-- Results -->
          <div class="grid grid-cols-1 gap-6 xl:grid-cols-2">
            @for (s of all(); track $index) {
              <article
                class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6 shadow-[0_1px_3px_rgba(10,22,40,0.06)]"
              >
                <div class="flex items-start justify-between gap-3">
                  <div class="flex items-center gap-3">
                    <img
                      [src]="s.photo"
                      alt=""
                      width="44"
                      height="44"
                      class="size-11 shrink-0 rounded-full object-cover"
                    />
                    <div class="flex flex-col">
                      <p class="font-sans text-body font-semibold text-ink">
                        {{ s.name }}
                      </p>
                      <p class="font-sans text-caption text-slate">
                        {{ s.specialty }}
                      </p>
                    </div>
                  </div>
                  <span
                    class="shrink-0 rounded-pill px-3 py-1 font-sans text-[10px] font-medium"
                    [class]="availability(s).class"
                  >
                    {{ availability(s).label }}
                  </span>
                </div>

                <div class="flex flex-col gap-2">
                  <div
                    class="flex items-center justify-between gap-2 font-sans text-caption text-slate"
                  >
                    <span class="flex items-center gap-1.5">
                      <sd-icon name="map-pin" [size]="16" />{{ s.location }}
                    </span>
                    <span class="flex items-center gap-1.5">
                      <sd-icon name="briefcase" [size]="16" />{{ s.experience }}
                    </span>
                  </div>
                  <div
                    class="flex items-center justify-between gap-2 font-sans text-caption text-slate"
                  >
                    <span class="flex items-center gap-1.5">
                      <sd-icon name="languages" [size]="16" />{{ s.languages }}
                    </span>
                    <span class="flex items-center gap-1.5">
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="#f2a900"
                      >
                        <path
                          d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
                        />
                      </svg>
                      {{ s.rating }} ({{ s.reviews }})
                    </span>
                  </div>
                </div>

                <hr class="border-t border-cloud" />

                <div class="flex items-center gap-1.5 text-cerulean">
                  <sd-icon name="info" [size]="16" />
                  <span class="font-sans text-body-sm font-medium">
                    {{ s.price }} / Consultation
                  </span>
                </div>

                <div class="flex gap-3">
                  <sd-button
                    variant="outline"
                    size="sm"
                    [full]="true"
                    (click)="openBooking(s)"
                    >View Profile</sd-button
                  >
                  <sd-button size="sm" [full]="true" (click)="openBooking(s)">
                    <sd-icon name="video" [size]="18" />
                    Book Consultation
                  </sd-button>
                </div>
              </article>
            }
          </div>
        }
      }

      <!-- Booking modal -->
      @if (bookingFor(); as s) {
        <div
          class="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-4 sm:items-center"
        >
          <div
            class="flex w-full max-w-md flex-col gap-5 rounded-card bg-white p-6 shadow-xl"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="flex min-w-0 flex-col">
                <h2 class="font-heading text-h5 text-ink">Book Consultation</h2>
                <p class="truncate font-sans text-body-sm text-slate">
                  {{ s.name }} · {{ s.specialty }}
                </p>
              </div>
              <button
                type="button"
                class="shrink-0 text-slate transition-colors hover:text-ink"
                aria-label="Close"
                (click)="closeBooking()"
              >
                <sd-icon name="x" [size]="20" />
              </button>
            </div>

            <label class="flex flex-col gap-2">
              <span class="font-sans text-caption text-slate">Date &amp; time</span>
              <input
                type="datetime-local"
                [min]="minDateTime"
                [value]="when()"
                (input)="when.set($any($event.target).value)"
                class="rounded-field border border-cloud bg-white px-4 py-3 font-sans text-body text-ink focus:border-cerulean focus:outline-none focus:ring-2 focus:ring-cerulean/15"
              />
            </label>

            <label class="flex flex-col gap-2">
              <span class="font-sans text-caption text-slate"
                >Consultation type</span
              >
              <select
                [value]="type()"
                (change)="type.set($any($event.target).value)"
                class="rounded-field border border-cloud bg-white px-4 py-3 font-sans text-body text-ink focus:border-cerulean focus:outline-none focus:ring-2 focus:ring-cerulean/15"
              >
                <option value="video">Video Consultation</option>
                <option value="follow_up">Patient Follow-up</option>
                <option value="urgent">Urgent Care</option>
                <option value="routine">Routine Checkup</option>
              </select>
            </label>

            <div
              class="flex items-center justify-between rounded-field bg-glacier px-4 py-3"
            >
              <span class="font-sans text-body-sm text-slate">Consultation fee</span>
              <span class="font-heading text-h5 text-ink">{{ s.price }}</span>
            </div>

            @if (bookingError()) {
              <p
                class="rounded-field bg-alert/10 px-4 py-3 font-label text-caption text-alert"
              >
                {{ bookingError() }}
              </p>
            }

            <div class="flex gap-3">
              <sd-button
                variant="outline"
                [full]="true"
                (click)="closeBooking()"
                >Cancel</sd-button
              >
              <sd-button
                [full]="true"
                [disabled]="booking() || !when()"
                (click)="confirmBooking()"
              >
                {{ booking() ? 'Booking…' : 'Confirm Booking' }}
              </sd-button>
            </div>
          </div>
        </div>
      }
    </div>
  `,
})
export class FindSpecialist {
  private readonly specialists = inject(SpecialistsApi);
  private readonly appointmentsApi = inject(AppointmentsApi);
  private readonly router = inject(Router);

  // ----- Booking modal -----
  protected readonly bookingFor = signal<Specialist | null>(null);
  protected readonly when = signal('');
  protected readonly type = signal('video');
  protected readonly booking = signal(false);
  protected readonly bookingError = signal('');
  // Earliest bookable slot: one hour from now, as a datetime-local value.
  protected readonly minDateTime = ((): string => {
    const d = new Date(Date.now() + 60 * 60 * 1000);
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
      d.getDate(),
    )}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  })();

  protected openBooking(s: Specialist): void {
    this.bookingFor.set(s);
    this.when.set('');
    this.type.set('video');
    this.bookingError.set('');
  }

  protected closeBooking(): void {
    if (!this.booking()) this.bookingFor.set(null);
  }

  protected async confirmBooking(): Promise<void> {
    const s = this.bookingFor();
    if (!s || !this.when()) return;
    this.booking.set(true);
    this.bookingError.set('');
    try {
      await firstValueFrom(
        this.appointmentsApi.book({
          specialist_id: s.id,
          scheduled_at: new Date(this.when()).toISOString(),
          type: this.type(),
        }),
      );
      this.bookingFor.set(null);
      await this.router.navigate(['/dashboard/appointments']);
    } catch (err) {
      this.bookingError.set(
        (err as { message?: string })?.message ??
          'Could not book this consultation. Try again.',
      );
    } finally {
      this.booking.set(false);
    }
  }

  protected readonly query = signal('');
  protected readonly specialty = signal('');
  protected readonly availableOnly = signal(false);
  protected readonly filtersOpen = signal(false);
  protected readonly specialties = signal<string[]>([]);

  protected readonly all = signal<Specialist[]>([]);
  private readonly loading = signal(true);
  private readonly loadError = signal(false);
  private readonly reloadTick = signal(0);

  private readonly criteria = computed<Criteria>(() => ({
    search: this.query().trim(),
    specialty: this.specialty(),
    available: this.availableOnly(),
  }));

  constructor() {
    // Populate the specialty filter's options once.
    this.specialists
      .specialties()
      .pipe(takeUntilDestroyed())
      .subscribe({ next: (res) => this.specialties.set(res.data) });

    // Debounced, server-side search + filters. `reloadTick` lets the error
    // "Try Again" button re-run the current criteria.
    toObservable(
      computed(() => ({ ...this.criteria(), tick: this.reloadTick() })),
    )
      .pipe(
        debounceTime(250),
        distinctUntilChanged(
          (a, b) => JSON.stringify(a) === JSON.stringify(b),
        ),
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
        if (res) this.all.set(res.data.map(toSpecialistCard));
        this.loading.set(false);
      });
  }

  protected availability(s: Specialist) {
    return AVAILABILITY[s.availability];
  }

  protected readonly activeFilterCount = computed(
    () => (this.specialty() !== '' ? 1 : 0) + (this.availableOnly() ? 1 : 0),
  );

  protected clearFilters(): void {
    this.specialty.set('');
    this.availableOnly.set(false);
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
