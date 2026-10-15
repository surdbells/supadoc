import { computed, DestroyRef, inject, Injectable, Injector, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { Observable, Subscription } from 'rxjs';
import type {
  AvailabilityDayDto,
  AvailabilityRangeDto,
  DaySlotDto,
  DaySlotsDto,
  SuccessResponse,
} from '@supadoc/models';
import { apiErrorMessage } from './api-error.util';
import { addMonths, monthGrid, timeZoneShortLabel, viewerTimeZone, ymdInZone } from './date-input';
import { DoctorApi } from './doctor.api';
import { SpecialistsApi } from './specialists.api';

/** Day statuses that have times to show. */
const OPEN_STATUSES = new Set(['available', 'few']);

/**
 * Whose calendar endpoints a store reads:
 *   - 'public' (default) — a patient booking: GET /api/public/specialists/{id}/…,
 *     held to the patient booking horizon; a doctor switched off for bookings
 *     has no times.
 *   - 'doctor' — the signed-in doctor's own calendar (reschedule, follow-up
 *     planner): GET /api/doctor/calendar…; the id only keys the caches.
 *   - 'staff' — back office booking on a patient's behalf:
 *     GET /api/specialists/{id}/… (appointments.create or .book).
 * 'doctor' and 'staff' reach a year ahead and ignore the bookings switch, as
 * the booking guard lets doctors and staff.
 */
export type AvailabilityCalendarScope = 'public' | 'doctor' | 'staff';

/** Options for {@link AvailabilityCalendarStore.load}. */
export interface AvailabilityCalendarOptions {
  scope?: AvailabilityCalendarScope;
}

/**
 * One specialist's booking calendar, as signals — the data behind
 * `sd-booking-calendar` on every screen that picks a consultation time.
 * Provide it per component (`providers: [AvailabilityCalendarStore]`), then
 * `load(id)` and bind: `days`, `month`, `selectedDate`, `slots`, `loading`,
 * `slotsLoading`, `min`, `max`, `nextAvailable`, `timeZoneLabel`; wire the
 * calendar's `monthChange` to `setMonth` and `selectedDateChange` to
 * `selectDate`. Its `jumpToNext` needs no wiring (the calendar has already
 * selected the day) — if wired, pass the day: `cal.jumpToNext($event)`.
 *
 * Days are calendar days in `tz` (the viewer's zone by default). Each visible
 * 6-week grid is one request (GET …/availability), cached per month, and the
 * next month is prefetched; a day's times (GET …/slots?date=) are cached per
 * day and only asked for on a day that has some. After a booking is refused
 * because the time was just taken (422), call `refresh()`. Doctor and staff
 * screens load with `{ scope: 'doctor' | 'staff' }` ({@link AvailabilityCalendarScope}).
 */
@Injectable()
export class AvailabilityCalendarStore {
  private readonly api = inject(SpecialistsApi);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);

  /** First day of the grid's weeks (0 = Sunday … 6 = Saturday) — match the calendar's `weekStartsOn`. */
  readonly weekStartsOn = signal(1);

  /** The specialist being shown (null until `load`). */
  readonly specialistId = signal<string | null>(null);
  /** Whose endpoints are read (see {@link AvailabilityCalendarScope}). */
  readonly scope = signal<AvailabilityCalendarScope>('public');
  /**
   * The IANA zone the days are in — the one asked for, or the zone the server
   * actually used when it didn't know that one (it falls back to the clinic's).
   */
  readonly tz = signal<string>(viewerTimeZone());
  /** The visible month, 'YYYY-MM'. */
  readonly month = signal<string>(ymdInZone(new Date()).slice(0, 7));
  /** The visible grid's availability (null while it loads, or after an error). */
  readonly range = signal<AvailabilityRangeDto | null>(null);
  /** One entry per date of the visible 6-week grid (empty until loaded). */
  readonly days = computed<AvailabilityDayDto[]>(() => this.range()?.days ?? []);
  /** The picked date, 'YYYY-MM-DD'. */
  readonly selectedDate = signal<string | null>(null);
  /** The picked date's open times; [] when it has none; null before a date is picked. */
  readonly slots = signal<DaySlotDto[] | null>(null);
  readonly loading = signal(false);
  readonly slotsLoading = signal(false);
  /** A user-facing message when the calendar or a day's times could not be loaded. */
  readonly error = signal<string | null>(null);

  /** The last range shown — keeps `max` / `nextAvailable` steady while another month loads. */
  private readonly lastRange = signal<AvailabilityRangeDto | null>(null);

  /** Today in `tz` — the calendar's `min`. */
  readonly min = computed(() => this.range()?.today ?? ymdInZone(new Date(), this.tz()));
  /** The last bookable date — the calendar's `max` (null until first loaded). */
  readonly max = computed(() => (this.range() ?? this.lastRange())?.bookable_until ?? null);
  /** The next open time in the booking window, ISO UTC. */
  readonly nextAvailable = computed(() => (this.range() ?? this.lastRange())?.next_available ?? null);
  /** The zone's short name for the caption, e.g. "WAT". */
  readonly timeZoneLabel = computed(() => timeZoneShortLabel(this.tz()));
  /** The picked date's calendar entry, when it is in the visible grid. */
  readonly selectedDay = computed(() => {
    const date = this.selectedDate();
    return date ? (this.days().find((d) => d.date === date) ?? null) : null;
  });
  /**
   * The first open time after the picked day (ISO UTC) — never on or before
   * it: `nextAvailable` when that is later (the first opening at all, so the
   * first after it too), else the first open day after it in any month loaded
   * so far (the visible grid, the prefetched next month, months seen before).
   * Null with nothing picked, or when no later opening is known yet.
   */
  readonly nextAfterSelected = computed<string | null>(() => {
    const date = this.selectedDate();
    if (!date) return null;
    const tz = this.tz();
    const next = this.nextAvailable();
    if (next && ymdInZone(next, tz) > date) return next;
    this.cacheVersion();
    let best: AvailabilityDayDto | null = null;
    for (const range of [this.range(), ...this.months.values()]) {
      if (!range || range.tz !== tz) continue;
      for (const d of range.days) {
        if (d.date > date && d.first && OPEN_STATUSES.has(d.status) && (!best || d.date < best.date)) best = d;
      }
    }
    return best?.first ?? null;
  });

  private readonly months = new Map<string, AvailabilityRangeDto>();
  /** Bumped whenever `months` changes, so what is read from it stays live. */
  private readonly cacheVersion = signal(0);
  private readonly daySlotsCache = new Map<string, DaySlotDto[]>();
  private monthSub?: Subscription;
  private slotsSub?: Subscription;
  /** The zone `load` was asked for (`tz` may have become the server's). */
  private requestedZone: string | null = null;

  /**
   * Show `specialistId`'s calendar in `tz` (default: the viewer's zone), opening
   * on today's month with nothing picked; `options.scope` picks whose endpoints
   * (default 'public'). Loading the same doctor, zone and scope again keeps
   * what is there.
   */
  load(specialistId: string, tz?: string, options: AvailabilityCalendarOptions = {}): void {
    const zone = tz || viewerTimeZone();
    const scope = options.scope ?? 'public';
    if (
      specialistId === this.specialistId() &&
      zone === this.requestedZone &&
      scope === this.scope() &&
      this.range()
    ) {
      return;
    }
    this.clearCaches();
    this.lastRange.set(null);
    this.specialistId.set(specialistId);
    this.scope.set(scope);
    this.requestedZone = zone;
    this.tz.set(zone);
    this.selectedDate.set(null);
    this.slots.set(null);
    this.error.set(null);
    this.month.set(ymdInZone(new Date(), zone).slice(0, 7));
    this.fetchMonth(this.month());
  }

  /** Show another month, 'YYYY-MM' (cached months show at once). */
  setMonth(ym: string): void {
    if (!/^\d{4}-\d{2}$/.test(ym)) return;
    if (ym === this.month() && (this.range() || this.loading())) return;
    this.month.set(ym);
    this.fetchMonth(ym);
  }

  /**
   * Pick a date ('YYYY-MM-DD'; null clears): loads its open times — or sets []
   * straight away for a day the calendar already shows as having none. A date
   * outside the visible grid moves the calendar to its month.
   */
  selectDate(date: string | null): void {
    this.selectedDate.set(date);
    this.slotsSub?.unsubscribe();
    this.slotsLoading.set(false);
    if (!date) {
      this.slots.set(null);
      return;
    }
    const grid = monthGrid(this.month(), this.weekStartsOn());
    if (date < grid[0] || date > grid[grid.length - 1]) this.setMonth(date.slice(0, 7));
    this.fetchSlots(date);
  }

  /**
   * Move to `date` (the calendar's `jumpToNext` value), else to the day of
   * `nextAvailable`, and pick it — unless it is already the picked day.
   */
  jumpToNext(date?: string): void {
    const next = this.nextAvailable();
    const target = date ?? (next ? ymdInZone(next, this.tz()) : null);
    if (target && target !== this.selectedDate()) this.selectDate(target);
  }

  /**
   * Drop everything cached and reload the visible month and the picked day —
   * after a booking was refused because the time had just been taken.
   */
  refresh(): void {
    this.clearCaches();
    if (!this.specialistId()) return;
    this.fetchMonth(this.month());
    const date = this.selectedDate();
    if (date) this.fetchSlots(date, true);
  }

  // ----- Loading -----

  private gridRange(ym: string): { from: string; to: string } {
    const grid = monthGrid(ym, this.weekStartsOn());
    return { from: grid[0], to: grid[grid.length - 1] };
  }

  private monthKey(ym: string): string {
    const { from } = this.gridRange(ym);
    return `${this.specialistId()}|${this.tz()}|${from}`;
  }

  private fetchMonth(ym: string): void {
    const id = this.specialistId();
    if (!id) return;
    this.monthSub?.unsubscribe();
    const cached = this.months.get(this.monthKey(ym));
    if (cached) {
      this.range.set(cached);
      this.lastRange.set(cached);
      this.loading.set(false);
      this.error.set(null); // an earlier failure is not about this month
      this.afterMonth(ym, cached);
      return;
    }
    this.range.set(null);
    this.loading.set(true);
    this.error.set(null);
    this.monthSub = this.monthRequest(id, { ...this.gridRange(ym), tz: this.tz() })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.adoptZone(res.data.tz);
          this.months.set(this.monthKey(ym), res.data);
          this.cacheVersion.update((v) => v + 1);
          if (this.month() !== ym) return; // moved on meanwhile
          this.range.set(res.data);
          this.lastRange.set(res.data);
          this.loading.set(false);
          this.afterMonth(ym, res.data);
        },
        error: (err: unknown) => {
          this.loading.set(false);
          this.error.set(apiErrorMessage(err, "We couldn't load this doctor's calendar. Please try again."));
        },
      });
  }

  /** Once a month shows: a picked day it now says is empty gets [] times; prefetch the next month. */
  private afterMonth(ym: string, range: AvailabilityRangeDto): void {
    const date = this.selectedDate();
    if (date && this.slots() === null && !this.slotsLoading()) this.fetchSlots(date);
    const next = addMonths(ym, 1);
    if (`${next}-01` > range.bookable_until) return;
    const key = this.monthKey(next);
    const id = this.specialistId();
    if (!id || this.months.has(key)) return;
    this.monthRequest(id, { ...this.gridRange(next), tz: this.tz() })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.months.set(key, res.data);
          this.cacheVersion.update((v) => v + 1);
        },
        error: () => undefined, // a prefetch failing is not worth a message; the real load retries
      });
  }

  private fetchSlots(date: string, force = false): void {
    const id = this.specialistId();
    if (!id) return;
    // A new day (or a retry) drops an earlier day's failure; a month that failed keeps its message.
    if (this.range()) this.error.set(null);
    const key = `${id}|${this.tz()}|${date}`;
    const cached = force ? undefined : this.daySlotsCache.get(key);
    if (cached) {
      this.slots.set(cached);
      return;
    }
    // The calendar already says this day has no times: no request.
    const day = this.days().find((d) => d.date === date);
    if (day && !OPEN_STATUSES.has(day.status)) {
      this.slots.set([]);
      return;
    }
    this.slotsSub?.unsubscribe();
    this.slots.set(null);
    this.slotsLoading.set(true);
    this.slotsSub = this.slotsRequest(id, date, this.tz())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.adoptZone(res.data.tz);
          this.daySlotsCache.set(`${id}|${this.tz()}|${date}`, res.data.slots);
          this.slotsLoading.set(false);
          if (this.range()) this.error.set(null);
          if (this.selectedDate() === date) this.slots.set(res.data.slots);
        },
        error: (err: unknown) => {
          this.slotsLoading.set(false);
          if (this.selectedDate() === date) this.slots.set([]);
          this.error.set(apiErrorMessage(err, "We couldn't load the times for this day. Please try again."));
        },
      });
  }

  /** A grid's availability from the scope's endpoint. */
  private monthRequest(
    id: string,
    params: { from: string; to: string; tz: string },
  ): Observable<SuccessResponse<AvailabilityRangeDto>> {
    switch (this.scope()) {
      case 'doctor':
        return this.injector.get(DoctorApi).calendar(params);
      case 'staff':
        return this.api.staffAvailability(id, params);
      default:
        return this.api.availability(id, params);
    }
  }

  /** One day's open times from the scope's endpoint. */
  private slotsRequest(id: string, date: string, tz: string): Observable<SuccessResponse<DaySlotsDto>> {
    switch (this.scope()) {
      case 'doctor':
        return this.injector.get(DoctorApi).calendarSlots(date, tz);
      case 'staff':
        return this.api.staffDaySlots(id, date, tz);
      default:
        return this.api.daySlots(id, date, tz);
    }
  }

  /**
   * Days are grouped in the zone the server used — a zone it doesn't know
   * falls back to the clinic's — so take that one: the caption, `min` and
   * `jumpToNext` then agree with the times' labels.
   */
  private adoptZone(tz: string | undefined): void {
    if (tz && tz !== this.tz()) this.tz.set(tz);
  }

  private clearCaches(): void {
    this.months.clear();
    this.cacheVersion.update((v) => v + 1);
    this.daySlotsCache.clear();
    this.monthSub?.unsubscribe();
    this.slotsSub?.unsubscribe();
    this.loading.set(false);
    this.slotsLoading.set(false);
  }
}
