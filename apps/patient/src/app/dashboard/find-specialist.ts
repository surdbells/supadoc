import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SpecialistsApi } from '@supadoc/data-access';
import type { SpecialistDto } from '@supadoc/models';
import { ButtonComponent, IconComponent } from '@supadoc/ui';

type Availability = 'today' | 'week' | 'next';

interface Specialist {
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

/** Find a Specialist (Figma 311:4126) — wired to GET /api/portal/specialists. */
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
            class="flex size-12 shrink-0 items-center justify-center rounded-field border border-cloud bg-white text-ink transition-colors hover:bg-glacier"
            aria-label="Filter"
          >
            <sd-icon name="filter" [size]="20" />
          </button>
        </div>
      </div>

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
              {{ filtered().length }} Specialist found
            </p>
          </div>

          <!-- Results -->
          <div class="grid grid-cols-1 gap-6 xl:grid-cols-2">
            @for (s of filtered(); track $index) {
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
                  <sd-button variant="outline" size="sm" [full]="true"
                    >View Profile</sd-button
                  >
                  <sd-button size="sm" [full]="true">
                    <sd-icon name="video" [size]="18" />
                    Book Consultation
                  </sd-button>
                </div>
              </article>
            }
          </div>
        }
      }
    </div>
  `,
})
export class FindSpecialist {
  private readonly specialists = inject(SpecialistsApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly query = signal('');
  private readonly all = signal<Specialist[]>([]);
  private readonly loading = signal(true);
  private readonly loadError = signal(false);

  constructor() {
    this.load();
  }

  protected availability(s: Specialist) {
    return AVAILABILITY[s.availability];
  }

  protected reset(): void {
    this.query.set('');
  }

  protected reload(): void {
    this.load();
  }

  protected readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    const all = this.all();
    if (!q) return all;
    return all.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.specialty.toLowerCase().includes(q),
    );
  });

  protected readonly viewState = computed<
    'loading' | 'list' | 'empty' | 'error'
  >(() => {
    if (this.loadError()) return 'error';
    if (this.loading()) return 'loading';
    return this.filtered().length === 0 ? 'empty' : 'list';
  });

  private load(): void {
    this.loading.set(true);
    this.loadError.set(false);
    this.specialists
      .list({ per_page: 100, sort_by: 'name', sort_dir: 'asc' })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.all.set(res.data.map(toSpecialistCard));
          this.loading.set(false);
        },
        error: () => {
          this.loadError.set(true);
          this.loading.set(false);
        },
      });
  }
}
