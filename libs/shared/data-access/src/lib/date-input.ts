import type { DayAvailability, PartOfDay } from '@supadoc/models';

/**
 * Local-time values for native date / time pickers and slot labels.
 *
 * `<input type="date">` and `datetime-local` speak the viewer's wall clock, so
 * their `min` must too — `toISOString().slice(…)` is UTC and is hours (or a
 * whole day) off for most viewers. Slot labels are likewise built here from each
 * slot's ISO instant rather than shown as the server's UTC text, so the earliest
 * slots never read as times that have already gone by.
 */

const pad = (n: number): string => String(n).padStart(2, '0');

/** A Date as local 'YYYY-MM-DD'. */
function localYmd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const TIME_LABEL = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
const WEEKDAY_LABEL = new Intl.DateTimeFormat('en-US', { weekday: 'short' });

/**
 * Today on the viewer's calendar, 'YYYY-MM-DD' — for a date input's `[min]`.
 * `offsetDays` shifts it, e.g. `todayLocal(-7)` for a one-week backdate limit.
 */
export function todayLocal(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return localYmd(d);
}

/**
 * Now on the viewer's clock, 'YYYY-MM-DDTHH:mm' — for a datetime-local input's
 * `[min]`. Pass `roundUpMinutes` (e.g. 30) to round up to the next boundary:
 * the browser counts `step` from `min`, so a 30-minute step needs a :00/:30 min.
 */
export function nowLocalInput(roundUpMinutes = 1): string {
  const d = new Date();
  d.setSeconds(0, 0);
  const step = Math.max(1, Math.floor(roundUpMinutes));
  const over = d.getMinutes() % step;
  if (over !== 0) d.setMinutes(d.getMinutes() + step - over);
  return `${localYmd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A slot's start in the viewer's local time, e.g. "9:30 AM". */
export function slotLabel(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : TIME_LABEL.format(d);
}

/**
 * The slots endpoint's days (grouped by UTC date, with UTC labels) regrouped by
 * the viewer's LOCAL date, with local labels — and without any slot that has
 * started since the list was fetched. Same `DayAvailability` shape, so a
 * template that renders the server days renders these unchanged.
 */
export function localSlotDays(days: readonly DayAvailability[]): DayAvailability[] {
  const now = Date.now();
  const byDate = new Map<string, DayAvailability>();
  for (const day of days) {
    for (const slot of day.slots) {
      const at = new Date(slot.iso);
      if (isNaN(at.getTime()) || at.getTime() <= now) continue;
      const date = localYmd(at);
      let bucket = byDate.get(date);
      if (!bucket) {
        bucket = { date, weekday: WEEKDAY_LABEL.format(at), day: String(at.getDate()), slots: [] };
        byDate.set(date, bucket);
      }
      bucket.slots.push({ iso: slot.iso, label: TIME_LABEL.format(at), time: `${pad(at.getHours())}:${pad(at.getMinutes())}` });
    }
  }
  return [...byDate.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({ ...d, slots: d.slots.sort((a, b) => new Date(a.iso).getTime() - new Date(b.iso).getTime()) }));
}

/* ---------------------------------------------------------------------------
 * Calendar dates in a time zone.
 *
 * A booking calendar works in calendar days of one IANA zone (the viewer's,
 * by default), as 'YYYY-MM-DD' / 'YYYY-MM' strings. Day and month arithmetic
 * runs on those strings through UTC, so it never crosses a DST change or picks
 * up the browser's own offset; only `ymdInZone` / `periodOf` turn an instant
 * into a zone's wall clock.
 * ------------------------------------------------------------------------- */

/** The viewer's IANA time zone, e.g. "Africa/Lagos" ('UTC' when the browser won't say). */
export function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * A zone's short name as the viewer would write it right now, e.g. "WAT",
 * "GMT+1" or "EDT" (in the viewer's locale, so it follows DST). Defaults to the
 * viewer's own zone; an unknown zone comes back as given.
 */
export function timeZoneShortLabel(tz?: string, at: Date = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat(undefined, { timeZone: tz || undefined, timeZoneName: 'short' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName');
    return part?.value ?? tz ?? '';
  } catch {
    return tz ?? '';
  }
}

/** Formatters are costly to build — one per zone (and kind) is plenty. */
const zoneFormatters = new Map<string, Intl.DateTimeFormat>();
function zoneFormatter(kind: 'ymd' | 'hour', tz?: string): Intl.DateTimeFormat {
  const key = `${kind}|${tz ?? ''}`;
  let f = zoneFormatters.get(key);
  if (!f) {
    f =
      kind === 'ymd'
        ? new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit' })
        : new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, hour: 'numeric', hourCycle: 'h23' });
    zoneFormatters.set(key, f);
  }
  return f;
}

function toDate(at: Date | string | number): Date {
  return at instanceof Date ? at : new Date(at);
}

/**
 * The calendar date of an instant in a zone, 'YYYY-MM-DD' (the viewer's zone
 * by default) — e.g. `ymdInZone(new Date(), tz)` is today there. '' for an
 * invalid instant; an unknown zone falls back to the viewer's.
 */
export function ymdInZone(at: Date | string | number, tz?: string): string {
  const d = toDate(at);
  if (isNaN(d.getTime())) return '';
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = zoneFormatter('ymd', tz).formatToParts(d);
  } catch {
    parts = zoneFormatter('ymd').formatToParts(d);
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Which part of the day an instant falls in on a zone's clock: morning 05–12,
 * afternoon 12–17, evening from 17 — and the small hours (before 05) count as
 * evening too, as the tail of the night before.
 */
export function periodOf(at: Date | string | number, tz?: string): PartOfDay {
  const d = toDate(at);
  if (isNaN(d.getTime())) return 'morning';
  let hourPart: string | undefined;
  try {
    hourPart = zoneFormatter('hour', tz).formatToParts(d).find((p) => p.type === 'hour')?.value;
  } catch {
    hourPart = zoneFormatter('hour').formatToParts(d).find((p) => p.type === 'hour')?.value;
  }
  const h = Number(hourPart) % 24;
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'afternoon';
  return 'evening';
}

/** 'YYYY-MM-DD' → a UTC-midnight Date, so arithmetic on it is free of DST. */
function ymdUtc(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
}

function utcYmd(d: Date): string {
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** A 'YYYY-MM-DD' moved by `n` calendar days (negative goes back). */
export function addDaysYmd(ymd: string, n: number): string {
  const d = ymdUtc(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return utcYmd(d);
}

/** A 'YYYY-MM' moved by `n` months (negative goes back), e.g. ('2026-12', 1) → '2027-01'. */
export function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, (m || 1) - 1 + n, 1));
  return utcYmd(d).slice(0, 7);
}

/**
 * The 6-week month grid as 42 'YYYY-MM-DD' strings, row by row: the weeks that
 * hold `ym`, padded with the end of the month before and the start of the one
 * after. Weeks start on `weekStartsOn` (0 = Sunday … 6 = Saturday; Monday by
 * default). Always six rows, so the grid keeps its height month to month.
 */
export function monthGrid(ym: string, weekStartsOn = 1): string[] {
  const first = `${ym}-01`;
  const start = (((ymdUtc(first).getUTCDay() - weekStartsOn) % 7) + 7) % 7;
  const out: string[] = [];
  for (let i = 0; i < 42; i++) out.push(addDaysYmd(first, i - start));
  return out;
}
