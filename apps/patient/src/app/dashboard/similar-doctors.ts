import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import {
  catchError,
  distinctUntilChanged,
  map,
  of,
  switchMap,
  tap,
} from 'rxjs';
import {
  apiErrorMessage,
  slotLabel,
  SpecialistsApi,
  todayLocal,
  ymdInZone,
  type SpecialistSuggestionParams,
} from '@supadoc/data-access';
import type {
  SpecialistSuggestionDto,
  SpecialistSuggestionsDto,
} from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import { whenLabel } from './follow-up';

let nextId = 0;

/** One suggested doctor, ready to render. */
interface SuggestionVm {
  readonly id: string;
  readonly name: string;
  readonly specialty: string;
  readonly verified: boolean;
  readonly photo: string | null;
  readonly initials: string;
  readonly fee: string;
  readonly rating: string;
  readonly reason: string;
  /** The day "See all times" opens the doctor's calendar on. */
  readonly date: string | null;
  readonly times: readonly { iso: string; label: string; aria: string }[];
}

const FEE = new Intl.NumberFormat('en-NG', { maximumFractionDigits: 0 });

/**
 * "Similar doctors free that day" — up to `max` doctors of the same specialty
 * from GET /public/specialists/suggestions (`like` a doctor, or a specialty +
 * the directory's filters), each with why it was suggested and up to three
 * open times that go straight to that doctor's booking (`?slot=`). Shown where
 * a patient's pick has no openings: an unavailable day in booking, an empty
 * directory search, a card not free on the filtered day. Emits `loaded` with
 * the response (its `requested.next_available_at` is the `like` doctor's next
 * opening on or after the date).
 */
@Component({
  selector: 'pat-similar-doctors',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent],
  // A size container: the cards go two / three abreast as room allows.
  host: { class: '@container block' },
  template: `
    <section
      class="flex flex-col gap-3"
      [attr.aria-labelledby]="headingId"
      [attr.aria-busy]="loading() || null"
    >
      <h3
        [id]="headingId"
        class="flex items-center gap-2 font-sans text-body-sm font-semibold text-ink"
      >
        <sd-icon name="users" [size]="16" class="shrink-0 text-cerulean" />{{
          heading()
        }}
      </h3>
      <p class="sr-only" aria-live="polite" aria-atomic="true">
        {{ liveText() }}
      </p>

      @if (loading()) {
        <div
          class="grid gap-3 @xl:grid-cols-2 @4xl:grid-cols-3"
          aria-hidden="true"
        >
          <div class="sd-shimmer h-40 rounded-card"></div>
          <div class="sd-shimmer hidden h-40 rounded-card @xl:block"></div>
        </div>
      } @else if (error()) {
        <div
          class="flex flex-wrap items-center gap-3 font-sans text-caption text-slate"
        >
          <span class="min-w-0 flex-1">{{ error() }}</span>
          <button
            type="button"
            class="inline-flex min-h-11 items-center rounded-field border border-haze bg-white px-4 font-semibold text-cerulean shadow-control transition hover:border-cerulean active:shadow-none disabled:shadow-none focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
            (click)="retry()"
          >
            Try again
          </button>
        </div>
      } @else if (items().length === 0) {
        <p class="font-sans text-caption text-slate">{{ emptyText() }}</p>
      } @else {
        <ul class="grid gap-3 @xl:grid-cols-2 @4xl:grid-cols-3">
          @for (s of items(); track s.id) {
            <li
              class="flex min-w-0 flex-col gap-3 rounded-card border border-cloud bg-white p-4"
            >
              <div class="flex min-w-0 items-center gap-3">
                @if (s.photo) {
                  <img
                    [src]="s.photo"
                    alt=""
                    class="size-10 shrink-0 rounded-full object-cover"
                  />
                } @else {
                  <span
                    class="flex size-10 shrink-0 items-center justify-center rounded-full bg-cerulean/15 font-heading text-caption font-semibold text-cerulean-dark"
                    aria-hidden="true"
                    >{{ s.initials }}</span
                  >
                }
                <div class="flex min-w-0 flex-col">
                  <p
                    class="flex min-w-0 items-center gap-1 font-sans text-body-sm font-semibold text-ink"
                  >
                    <span class="truncate">{{ s.name }}</span>
                    @if (s.verified) {
                      <sd-icon
                        name="circle-check"
                        [size]="14"
                        class="shrink-0 text-cerulean"
                      />
                    }
                  </p>
                  <p
                    class="flex min-w-0 items-center gap-1 font-sans text-caption text-slate"
                  >
                    <span class="truncate"
                      >{{ s.specialty }} · {{ s.fee }}</span
                    >
                    <sd-icon
                      name="star"
                      [size]="12"
                      class="shrink-0 text-warning"
                    />
                    <span class="shrink-0">{{ s.rating }}</span>
                  </p>
                </div>
              </div>
              <p
                class="flex items-start gap-1.5 font-sans text-caption text-slate"
              >
                <sd-icon
                  name="sparkles"
                  [size]="14"
                  class="mt-0.5 shrink-0 text-cerulean"
                />
                <span class="min-w-0">{{ s.reason }}</span>
              </p>
              @if (s.times.length) {
                <div
                  class="flex flex-wrap gap-2"
                  role="group"
                  [attr.aria-label]="'Open times with ' + s.name"
                >
                  @for (t of s.times; track t.iso) {
                    <a
                      [routerLink]="['/dashboard/appointments/book', s.id]"
                      [queryParams]="{ slot: t.iso }"
                      class="inline-flex min-h-11 items-center rounded-field border border-cloud bg-white px-3 font-sans text-caption font-semibold text-cerulean transition-colors hover:border-cerulean focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
                      [attr.aria-label]="'Book ' + s.name + ', ' + t.aria"
                      >{{ t.label }}</a
                    >
                  }
                </div>
              }
              <a
                [routerLink]="['/dashboard/appointments/book', s.id]"
                [queryParams]="s.date ? { date: s.date } : {}"
                class="mt-auto inline-flex min-h-11 items-center gap-1 self-start font-sans text-caption font-semibold text-cerulean hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
                [attr.aria-label]="'See all times with ' + s.name"
              >
                See all times <sd-icon name="arrow-right" [size]="14" />
              </a>
            </li>
          }
        </ul>
      }
    </section>
  `,
})
export class SimilarDoctors {
  private readonly api = inject(SpecialistsApi);

  /** What to suggest for: `like` a doctor, or a `specialty` (+ filters); `date` defaults to today. */
  readonly params = input.required<SpecialistSuggestionParams>();
  /** How many doctors to show (ask for more in `params.limit` when some get excluded). */
  readonly max = input(3);
  /** Doctors already on screen, left out. */
  readonly excludeIds = input<readonly string[]>([]);
  readonly heading = input('Similar doctors free that day');
  readonly emptyText = input('No similar doctors are free around then.');

  readonly loaded = output<SpecialistSuggestionsDto>();

  protected readonly headingId = `pat-similar-${++nextId}`;
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  private readonly result = signal<SpecialistSuggestionsDto | null>(null);
  private readonly tick = signal(0);

  protected readonly items = computed<SuggestionVm[]>(() => {
    const skip = new Set(this.excludeIds());
    const day = this.params().date || todayLocal();
    return (this.result()?.suggestions ?? [])
      .filter((s) => !skip.has(s.specialist.id))
      .slice(0, this.max())
      .map((s) => this.toVm(s, day));
  });

  protected readonly liveText = computed(() => {
    if (this.loading() || this.error()) return '';
    const n = this.items().length;
    return n === 0
      ? this.emptyText()
      : `${n} similar ${n === 1 ? 'doctor' : 'doctors'} found.`;
  });

  constructor() {
    toObservable(
      computed(() => ({
        params: this.params(),
        max: this.max(),
        tick: this.tick(),
      })),
    )
      .pipe(
        distinctUntilChanged(
          (a, b) =>
            a.tick === b.tick &&
            a.max === b.max &&
            JSON.stringify(a.params) === JSON.stringify(b.params),
        ),
        tap(() => {
          this.loading.set(true);
          this.error.set('');
        }),
        switchMap(({ params, max }) =>
          this.api.suggestions({ ...params, limit: params.limit ?? max }).pipe(
            map((res) => res.data),
            catchError((err: unknown) => {
              this.error.set(
                apiErrorMessage(err, "We couldn't load similar doctors."),
              );
              return of(null);
            }),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((data) => {
        this.result.set(data);
        this.loading.set(false);
        if (data) this.loaded.emit(data);
      });
  }

  protected retry(): void {
    this.tick.update((n) => n + 1);
  }

  private toVm(s: SpecialistSuggestionDto, day: string): SuggestionVm {
    const d = s.specialist;
    const tz = this.params().tz;
    return {
      id: d.id,
      name: d.name,
      specialty: d.specialty,
      verified: d.verified,
      photo: this.api.assetUrl(d.photo_url),
      initials:
        d.name
          .replace(/^(dr|prof|mr|mrs|ms)\.?\s+/i, '')
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
          .map((w) => w[0])
          .join('')
          .toUpperCase() || '?',
      fee:
        Number(d.consultation_fee) > 0
          ? `₦${FEE.format(Number(d.consultation_fee))}`
          : 'Free',
      rating: Number(d.rating || 0).toFixed(1),
      reason: s.match.reason,
      date: s.availability.date,
      // Times on the asked-about day read "9:30 AM"; on another day (free in
      // the days after) they carry the day too.
      times: s.availability.slots_preview.slice(0, 3).map((iso) => ({
        iso,
        label: ymdInZone(iso, tz) === day ? slotLabel(iso) : whenLabel(iso),
        aria: whenLabel(iso),
      })),
    };
  }
}
