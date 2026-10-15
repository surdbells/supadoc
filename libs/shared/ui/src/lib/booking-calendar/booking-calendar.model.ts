import type { AvailabilityDayDto, AvailabilityDayStatus, DaySlotDto, PartOfDay } from '@supadoc/models';
import { addDaysYmd, addMonths, periodOf } from '@supadoc/data-access';

/*
 * The booking calendar's pure rules — day states, accessible names, keyboard
 * moves and time grouping — kept apart from the component so they are easy to
 * read and to test. Every date is a 'YYYY-MM-DD' (or 'YYYY-MM') string on the
 * calendar of the zone the availability was asked for.
 */

/** One day cell of the month grid, everything the template needs. */
export interface BookingCalendarCell {
  date: string;
  /** Day of the month, 1–31. */
  day: number;
  /** In the month on show (the grid pads with the months either side). */
  inMonth: boolean;
  /** The server's status, else one inferred from today / min / max; null = unknown. */
  status: AvailabilityDayStatus | null;
  /** Open times that day (0 when unknown). */
  open: number;
  /** Can't be chosen: past, beyond the booking window, or the calendar is disabled. */
  disabled: boolean;
  /** Has open times — chosen, it lists them. A full / closed day can still be chosen, to offer alternatives. */
  bookable: boolean;
  today: boolean;
  selected: boolean;
  /** Accessible name, e.g. "Thursday 16 October, 12 times available". */
  label: string;
}

/** A Morning / Afternoon / Evening group of times. */
export interface BookingCalendarSlotGroup {
  period: PartOfDay;
  label: string;
  icon: string;
  slots: DaySlotDto[];
}

const PERIODS: readonly { period: PartOfDay; label: string; icon: string }[] = [
  { period: 'morning', label: 'Morning', icon: 'sunrise' },
  { period: 'afternoon', label: 'Afternoon', icon: 'sun' },
  { period: 'evening', label: 'Evening', icon: 'moon' },
];

// Dates are formatted as-is (as UTC midnights), never shifted into a zone.
const LONG_DAY = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const SHORT_DAY = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const MONTH_TITLE = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const WEEKDAY_SHORT = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' });
const WEEKDAY_LONG = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'UTC' });

function utc(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
}

/** "Thursday 16 October". */
export function longDayLabel(ymd: string): string {
  return LONG_DAY.format(utc(ymd));
}

/** "Thu 16 Oct". */
export function shortDayLabel(ymd: string): string {
  return SHORT_DAY.format(utc(ymd));
}

/** "October 2026" for a 'YYYY-MM'. */
export function monthTitle(ym: string): string {
  return MONTH_TITLE.format(utc(`${ym}-01`));
}

/** Column headers from `weekStartsOn` (0 = Sunday): `{ short: 'Mon', long: 'Monday' }`. */
export function weekdayHeaders(weekStartsOn: number): { short: string; long: string }[] {
  // 2026-10-11 is a Sunday; any known Sunday would do.
  return Array.from({ length: 7 }, (_, i) => {
    const d = utc(addDaysYmd('2026-10-11', (((weekStartsOn + i) % 7) + 7) % 7));
    return { short: WEEKDAY_SHORT.format(d), long: WEEKDAY_LONG.format(d) };
  });
}

/** The last day of a 'YYYY-MM'. */
export function lastDayOfMonth(ym: string): string {
  return addDaysYmd(`${addMonths(ym, 1)}-01`, -1);
}

/** A 'YYYY-MM-DD' moved by `n` months, keeping the day where it can (Jan 31 + 1 → Feb 28). */
export function addMonthsYmd(ymd: string, n: number): string {
  const ym = addMonths(ymd.slice(0, 7), n);
  const last = lastDayOfMonth(ym);
  const day = `${ym}-${ymd.slice(8, 10)}`;
  return day > last ? last : day;
}

/** Weekday of a 'YYYY-MM-DD', 0 = Sunday. */
function weekday(ymd: string): number {
  return utc(ymd).getUTCDay();
}

/** The navigable span: whole months from `min`'s to `max`'s (either may be open). */
export function navigableBounds(min: string | null, max: string | null): { lo: string | null; hi: string | null } {
  return {
    lo: min ? `${min.slice(0, 7)}-01` : null,
    hi: max ? lastDayOfMonth(max.slice(0, 7)) : null,
  };
}

/**
 * How long until the date next changes on `tz`'s clock, in ms (a second past
 * midnight) — capped at an hour, so a DST change or a sleeping device is caught
 * up with soon after.
 */
export function msToNextDay(tz: string, now: Date = new Date()): number {
  const HOUR = 3_600_000;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz || undefined,
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(now);
  } catch {
    return HOUR;
  }
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const elapsed = ((get('hour') % 24) * 3600 + get('minute') * 60 + get('second')) * 1000 + now.getMilliseconds();
  return Math.min(Math.max(86_400_000 - elapsed, 0) + 1000, HOUR);
}

export function clampYmd(ymd: string, lo: string | null, hi: string | null): string {
  if (lo && ymd < lo) return lo;
  if (hi && ymd > hi) return hi;
  return ymd;
}

/**
 * Where a key moves the grid's focus from `date` (WAI-ARIA APG date picker):
 * arrows by a day / a week, Home / End to the week's first / last day,
 * PageUp / PageDown by a month (with Shift, a year). null = not a move key.
 * Clamp the result with {@link navigableBounds}.
 */
export function keyTarget(date: string, key: string, shift: boolean, weekStartsOn: number): string | null {
  const intoWeek = (((weekday(date) - weekStartsOn) % 7) + 7) % 7;
  switch (key) {
    case 'ArrowLeft':
      return addDaysYmd(date, -1);
    case 'ArrowRight':
      return addDaysYmd(date, 1);
    case 'ArrowUp':
      return addDaysYmd(date, -7);
    case 'ArrowDown':
      return addDaysYmd(date, 7);
    case 'Home':
      return addDaysYmd(date, -intoWeek);
    case 'End':
      return addDaysYmd(date, 6 - intoWeek);
    case 'PageUp':
      return addMonthsYmd(date, shift ? -12 : -1);
    case 'PageDown':
      return addMonthsYmd(date, shift ? 12 : 1);
    default:
      return null;
  }
}

export function isOpenStatus(status: AvailabilityDayStatus | null): boolean {
  return status === 'available' || status === 'few';
}

/**
 * A day's status and whether it can be chosen. A day before today is 'past'
 * whatever the (possibly day-old) data says; otherwise the server's status
 * wins, and a day it did not send is 'beyond' after `max`, else unknown. Past
 * and beyond days — and anything outside `min`..`max` — are disabled.
 */
export function dayState(
  date: string,
  day: AvailabilityDayDto | undefined,
  ctx: { today: string; min: string | null; max: string | null; disabled: boolean },
): { status: AvailabilityDayStatus | null; disabled: boolean; bookable: boolean } {
  const { today, min, max } = ctx;
  const outside = date < today || (!!min && date < min) || (!!max && date > max);
  const status: AvailabilityDayStatus | null =
    date < today ? 'past' : (day?.status ?? (max && date > max ? 'beyond' : outside ? 'past' : null));
  const disabled = ctx.disabled || outside || status === 'past' || status === 'beyond';
  return { status, disabled, bookable: !disabled && isOpenStatus(status) };
}

/** The accessible name of a day cell. */
export function dayAccessibleName(date: string, status: AvailabilityDayStatus | null, open: number): string {
  const name = longDayLabel(date);
  switch (status) {
    case 'available':
    case 'few': {
      const times = open > 0 ? `${open} ${open === 1 ? 'time' : 'times'} available` : 'times available';
      return `${name}, ${times}${status === 'few' ? ', few left' : ''}`;
    }
    case 'full':
      return `${name}, fully booked`;
    case 'closed':
      return `${name}, no hours`;
    case 'blocked':
      return `${name}, unavailable`;
    case 'past':
      return `${name}, unavailable, in the past`;
    case 'beyond':
      return `${name}, outside the booking window`;
    default:
      return name;
  }
}

/** "12 times" / "1 time". */
export function timesCount(n: number): string {
  return `${n} ${n === 1 ? 'time' : 'times'}`;
}

/**
 * A day's times in Morning / Afternoon / Evening groups (empty groups left
 * out), each in time order. Uses the server's `period`, else works it out on
 * the zone's clock.
 */
export function groupSlots(slots: readonly DaySlotDto[], tz?: string): BookingCalendarSlotGroup[] {
  const by = new Map<PartOfDay, DaySlotDto[]>();
  for (const s of slots) {
    const p = s.period ?? periodOf(s.iso, tz);
    const list = by.get(p) ?? [];
    list.push(s);
    by.set(p, list);
  }
  return PERIODS.filter((p) => by.has(p.period)).map((p) => ({
    ...p,
    slots: [...(by.get(p.period) ?? [])].sort((a, b) => Date.parse(a.iso) - Date.parse(b.iso)),
  }));
}
