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
import {
  catchError,
  distinctUntilChanged,
  forkJoin,
  map,
  of,
  switchMap,
  tap,
} from 'rxjs';
import {
  addDaysYmd,
  SpecialistsApi,
  todayLocal,
  viewerTimeZone,
  type PublicSpecialistSearchParams,
  type SpecialistSuggestionParams,
} from '@supadoc/data-access';
import { IconComponent, shortDayLabel } from '@supadoc/ui';
import {
  hasDateFilter,
  lastSearchDay,
  whenDay,
  whenLastDay,
  whenText,
  type WhenFilter,
} from './booking-helpers';
import { SimilarDoctors } from './similar-doctors';

let nextId = 0;

/** The directory filters the fallback searches with (everything but the "when" ones and paging). */
export type DirectoryFilters = Pick<
  PublicSpecialistSearchParams,
  | 'search'
  | 'specialty'
  | 'location'
  | 'language'
  | 'gender'
  | 'mode'
  | 'fee_max'
  | 'min_rating'
  | 'min_years'
>;

/** How many days after the filtered one to look for openings. */
const PROBE_DAYS = 3;

/**
 * What a directory search filtered by day shows when nobody (or hardly anybody)
 * is free then: "No Cardiology specialists free on Thu 16 Oct", a "Try Fri 17
 * Oct" chip for the next of the following days on which the same search finds
 * doctors (a one-result probe per day), and — with a specialty — similar
 * doctors free that day (one filter relaxed, or free soon after). `count` is
 * how many the search did list (their ids in `excludeIds`).
 */
@Component({
  selector: 'pat-availability-fallback',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, SimilarDoctors],
  host: { class: 'block' },
  template: `
    <section
      class="flex flex-col gap-4 rounded-card border border-haze bg-white p-4 shadow-card sm:p-6"
      [attr.aria-labelledby]="headingId"
    >
      <div class="flex flex-col gap-1">
        <h2
          [id]="headingId"
          class="flex items-start gap-2 font-heading text-h5 text-ink"
        >
          <sd-icon
            [name]="count() === 0 ? 'calendar-off' : 'calendar-plus'"
            [size]="22"
            class="mt-0.5 shrink-0 text-cerulean"
          />
          {{ title() }}
        </h2>
        <p class="font-sans text-body-sm text-slate">{{ subtitle() }}</p>
      </div>

      <div class="flex flex-wrap items-center gap-2" aria-live="polite">
        @if (probing()) {
          <span
            class="inline-flex min-h-11 items-center gap-2 font-sans text-caption text-slate"
          >
            <sd-icon
              name="loader-circle"
              [size]="14"
              class="animate-spin"
            />Looking for the next open day…
          </span>
        } @else if (next(); as n) {
          <button
            type="button"
            class="inline-flex min-h-11 items-center gap-2 rounded-pill border border-cerulean bg-frost/40 px-4 font-sans text-body-sm font-semibold text-cerulean-dark transition-colors hover:bg-frost/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
            (click)="tryDay.emit(n.date)"
          >
            <sd-icon name="calendar-check" [size]="16" />
            Try {{ n.label }} · {{ n.count }} free
          </button>
        } @else if (probed()) {
          <span class="font-sans text-caption text-slate"
            >Nobody matching is free in the {{ probeDays }} days after
            either.</span
          >
        }
        @if (count() === 0) {
          <button
            type="button"
            class="inline-flex min-h-11 items-center gap-2 rounded-pill border border-cloud px-4 font-sans text-body-sm font-medium text-slate transition-colors hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
            (click)="anyDay.emit()"
          >
            <sd-icon name="calendar-days" [size]="16" />
            Show any day
          </button>
        }
      </div>

      @if (similarParams(); as p) {
        <pat-similar-doctors
          [params]="p"
          [max]="4"
          [excludeIds]="excludeIds()"
          [heading]="similarHeading()"
          emptyText="No similar doctors are free around then either."
        />
      }
    </section>
  `,
})
export class AvailabilityFallback {
  private readonly api = inject(SpecialistsApi);

  readonly filters = input.required<DirectoryFilters>();
  readonly when = input.required<WhenFilter>();
  /** How many doctors the search listed (0 = nobody). */
  readonly count = input(0);
  readonly excludeIds = input<readonly string[]>([]);

  /** "Try {day}": search that day instead. */
  readonly tryDay = output<string>();
  /** "Show any day": drop the day filter. */
  readonly anyDay = output<void>();

  protected readonly headingId = `pat-fallback-${++nextId}`;
  protected readonly probeDays = PROBE_DAYS;
  protected readonly probing = signal(false);
  protected readonly probed = signal(false);
  protected readonly next = signal<{
    date: string;
    label: string;
    count: number;
  } | null>(null);

  protected readonly title = computed(() => {
    if (this.count() > 0) return 'Also available';
    const specialty = this.filters().specialty;
    return `No ${specialty ? `${specialty} ` : ''}specialists free ${whenText(this.when())}`;
  });

  protected readonly subtitle = computed(() => {
    const n = this.count();
    if (n > 0) {
      return `Only ${n} ${n === 1 ? 'specialist is' : 'specialists are'} free ${whenText(this.when())}. Here are more options.`;
    }
    return this.filters().specialty
      ? 'Try another day, or book a similar doctor who is free.'
      : 'Try another day, or choose a specialty to see similar doctors who are free.';
  });

  /** Similar doctors need a specialty (the API compares like with like). */
  protected readonly similarParams =
    computed<SpecialistSuggestionParams | null>(() => {
      const f = this.filters();
      const w = this.when();
      if (!f.specialty || !hasDateFilter(w)) return null;
      return {
        specialty: f.specialty,
        date: whenDay(w) ?? todayLocal(),
        part_of_day: w.time === 'any' ? undefined : w.time,
        tz: viewerTimeZone(),
        language: f.language,
        gender: f.gender,
        location: f.location,
        mode: f.mode,
        fee_max: f.fee_max,
        // Room for the doctors already listed, which come back too.
        limit: Math.min(8, 4 + this.excludeIds().length),
      };
    });

  /** "This week" has no one day: its suggestions are asked for today, and say so. */
  protected readonly similarHeading = computed(() => {
    if (this.count() > 0) return 'Similar doctors with openings';
    return whenDay(this.when()) ? 'Similar doctors free that day' : 'Similar doctors free today';
  });

  constructor() {
    // The next of the following days the same search finds doctors on.
    toObservable(
      computed(() => ({ filters: this.filters(), when: this.when() })),
    )
      .pipe(
        distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b)),
        tap(() => {
          this.probing.set(true);
          this.probed.set(false);
          this.next.set(null);
        }),
        switchMap(({ filters, when }) => {
          const last = whenLastDay(when);
          const days = last
            ? Array.from({ length: PROBE_DAYS }, (_, i) =>
                addDaysYmd(last, i + 1),
              ).filter((d) => d <= lastSearchDay())
            : [];
          if (!hasDateFilter(when) || days.length === 0)
            return of([] as { date: string; count: number }[]);
          return forkJoin(
            days.map((date) =>
              this.api
                .publicSearch({
                  ...filters,
                  available_on: date,
                  part_of_day: when.time === 'any' ? undefined : when.time,
                  tz: viewerTimeZone(),
                  limit: 1,
                })
                .pipe(
                  map((res) => ({
                    date,
                    count: res.meta?.total ?? res.data.length,
                  })),
                  // A day the API won't search (past the booking window) just isn't offered.
                  catchError(() => of({ date, count: 0 })),
                ),
            ),
          );
        }),
        takeUntilDestroyed(),
      )
      .subscribe((results) => {
        const hit = results.find((r) => r.count > 0);
        this.next.set(hit ? { ...hit, label: shortDayLabel(hit.date) } : null);
        this.probing.set(false);
        this.probed.set(results.length > 0);
      });
  }
}
