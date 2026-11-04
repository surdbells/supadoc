import { catchError, map, type Observable, of } from 'rxjs';
import type { SetTimeZoneInput, TimeZoneSource } from '@supadoc/models';

/**
 * Time zones: abbreviations, labels and wall-clock arithmetic in any IANA zone.
 *
 * Every label here is built from NUMBERS (Intl `formatToParts` in en-US with
 * `hourCycle: 'h23'`) and fixed English arrays, never from locale month / day
 * names or Intl's AM/PM — en-GB writes "Sept", and ICU 72+ (Chrome 110+,
 * Node 20) puts U+202F before AM/PM. The API's `App\Domain\Settings\TimeZones`
 * builds the same text the same way, so emails, PDFs and the apps agree; the
 * parity fixture (`time-zone-parity.fixture.json`) is checked by both suites.
 */

/** The clinic's zone: a person who never set or detected one is on it. */
export const CLINIC_TIME_ZONE = 'Africa/Lagos';

/** One row of the shared abbreviation table: zones → [standard, daylight]. */
type AbbrRow = readonly [zones: readonly string[], std: string, dst: string];

const ABBR_ROWS: readonly AbbrRow[] = [
  [
    [
      'Africa/Lagos',
      'Africa/Porto-Novo',
      'Africa/Douala',
      'Africa/Niamey',
      'Africa/Ndjamena',
      'Africa/Malabo',
      'Africa/Libreville',
      'Africa/Luanda',
      'Africa/Kinshasa',
      'Africa/Brazzaville',
      'Africa/Bangui',
    ],
    'WAT',
    'WAT',
  ],
  [
    [
      'Africa/Accra',
      'Africa/Abidjan',
      'Africa/Dakar',
      'Africa/Freetown',
      'Africa/Monrovia',
      'Africa/Bamako',
      'Africa/Banjul',
      'Africa/Conakry',
      'Africa/Lome',
      'Africa/Ouagadougou',
      'Atlantic/Reykjavik',
    ],
    'GMT',
    'GMT',
  ],
  [['UTC', 'Etc/UTC'], 'UTC', 'UTC'],
  [
    [
      'Africa/Nairobi',
      'Africa/Addis_Ababa',
      'Africa/Dar_es_Salaam',
      'Africa/Kampala',
      'Africa/Mogadishu',
      'Africa/Djibouti',
      'Africa/Asmara',
      'Africa/Asmera',
    ],
    'EAT',
    'EAT',
  ],
  [
    [
      'Africa/Maputo',
      'Africa/Harare',
      'Africa/Lusaka',
      'Africa/Kigali',
      'Africa/Blantyre',
      'Africa/Gaborone',
      'Africa/Bujumbura',
      'Africa/Lubumbashi',
    ],
    'CAT',
    'CAT',
  ],
  [['Africa/Johannesburg', 'Africa/Maseru', 'Africa/Mbabane'], 'SAST', 'SAST'],
  [['Africa/Cairo', 'Europe/Athens', 'Europe/Helsinki', 'Europe/Kyiv', 'Europe/Kiev', 'Europe/Bucharest'], 'EET', 'EEST'],
  [['Europe/London'], 'GMT', 'BST'],
  [['Europe/Dublin'], 'GMT', 'IST'],
  [['Europe/Lisbon'], 'WET', 'WEST'],
  [
    [
      'Europe/Berlin',
      'Europe/Paris',
      'Europe/Madrid',
      'Europe/Rome',
      'Europe/Amsterdam',
      'Europe/Brussels',
      'Europe/Vienna',
      'Europe/Zurich',
      'Europe/Stockholm',
      'Europe/Oslo',
      'Europe/Copenhagen',
      'Europe/Warsaw',
      'Europe/Prague',
      'Europe/Budapest',
    ],
    'CET',
    'CEST',
  ],
  [['Asia/Kolkata', 'Asia/Calcutta'], 'IST', 'IST'],
  [
    ['America/New_York', 'America/Detroit', 'America/Toronto', 'America/Indiana/Indianapolis', 'America/Indianapolis'],
    'EST',
    'EDT',
  ],
  [['America/Chicago', 'America/Winnipeg'], 'CST', 'CDT'],
  [['America/Denver', 'America/Edmonton', 'America/Boise'], 'MST', 'MDT'],
  [['America/Phoenix'], 'MST', 'MST'],
  [['America/Los_Angeles', 'America/Vancouver'], 'PST', 'PDT'],
  [['America/Anchorage'], 'AKST', 'AKDT'],
  [['Pacific/Honolulu'], 'HST', 'HST'],
  [['America/Halifax'], 'AST', 'ADT'],
  [['America/St_Johns'], 'NST', 'NDT'],
];

/**
 * Zone → [standard, daylight] abbreviation. Identical to the API's
 * `TimeZones::ABBR` (same keys and values, fixture-tested); every other zone
 * is written "GMT±H[:MM]". Includes the ICU-canonical spellings browsers
 * report (Asia/Calcutta, Europe/Kiev, Africa/Asmera, America/Indianapolis).
 */
export const ZONE_ABBR: Readonly<Record<string, readonly [string, string]>> = Object.freeze(
  Object.fromEntries(
    ABBR_ROWS.flatMap(([zones, std, dst]) => zones.map((z) => [z, Object.freeze([std, dst] as const)] as const)),
  ),
);

/** Same as the API: area/location names (≤ 2 more segments), or "UTC". "+01:00" is not a zone. */
const ZONE_PATTERN = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$|^UTC$/;
/** Never auto-detected (privacy browsers and VPNs report these); all stay valid for a manual choice. */
const NOT_DETECTABLE = /^(UTC|GMT|Universal|Zulu|Factory|Etc\/.*|Atlantic\/Reykjavik)$/;

/** Fixed English names, the same arrays as the API's `TimeZones::DAYS` / `MONTHS`. */
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const pad2 = (n: number): string => String(n).padStart(2, '0');

/* ---------------------------------------------------------------------------
 * Wall clock of an instant in a zone (numbers only)
 * ------------------------------------------------------------------------- */

interface WallClock {
  readonly y: number;
  readonly m: number;
  readonly d: number;
  readonly H: number;
  readonly i: number;
  readonly s: number;
}

/** Formatters are costly to build: one per zone. A zone Intl rejects throws (RangeError) and is not cached. */
const partFormatters = new Map<string, Intl.DateTimeFormat>();
function partFormatter(tz: string): Intl.DateTimeFormat {
  let f = partFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    });
    partFormatters.set(tz, f);
  }
  return f;
}

/** The zone's wall clock at `ms` (throws for a zone Intl rejects). */
function wallClock(ms: number, tz: string): WallClock {
  let y = 1970;
  let m = 1;
  let d = 1;
  let H = 0;
  let i = 0;
  let s = 0;
  for (const p of partFormatter(tz).formatToParts(new Date(ms))) {
    const n = Number(p.value);
    switch (p.type) {
      case 'year':
        y = n;
        break;
      case 'month':
        m = n;
        break;
      case 'day':
        d = n;
        break;
      case 'hour':
        H = n % 24; // some engines say "24" at midnight
        break;
      case 'minute':
        i = n;
        break;
      case 'second':
        s = n;
        break;
    }
  }
  return { y, m, d, H, i, s };
}

function toMs(at: Date | string | number): number {
  if (at instanceof Date) return at.getTime();
  if (typeof at === 'number') return at;
  return new Date(at).getTime();
}

/** Weekday (0 = Sunday) of a calendar date — from the date itself, never an instant. */
function weekdayOf(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** `tz` when Intl knows it, else the device's zone, else UTC — so labels never throw. */
function usableZone(tz: string): string {
  if (isValidTimeZone(tz)) return tz;
  const device = deviceZone();
  return device && isValidTimeZone(device) ? device : 'UTC';
}

function deviceZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------------------
 * Validity and detection
 * ------------------------------------------------------------------------- */

const validity = new Map<string, boolean>();

/**
 * Whether `tz` is an IANA zone the API accepts: the API's pattern (so never an
 * offset like "+01:00"), at most 64 characters, and known to Intl. Aliases such
 * as Asia/Calcutta and America/Indianapolis are valid.
 */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64 || !ZONE_PATTERN.test(tz)) return false;
  let ok = validity.get(tz);
  if (ok === undefined) {
    try {
      partFormatter(tz);
      ok = true;
    } catch {
      ok = false;
    }
    validity.set(tz, ok);
  }
  return ok;
}

/**
 * Whether a zone may be saved by auto-detection: valid, and not one a privacy
 * browser or VPN reports (UTC, GMT, Etc/*, Universal, Zulu, Factory,
 * Atlantic/Reykjavik). Those stay choosable by hand.
 */
export function isDetectableTimeZone(tz: unknown): tz is string {
  return isValidTimeZone(tz) && !NOT_DETECTABLE.test(tz);
}

/** This device's zone when it is valid and detectable (mirrors the API's `isDetectable`), else null. */
export function detectTimeZone(): string | null {
  const tz = deviceZone();
  return isDetectableTimeZone(tz) ? tz : null;
}

/* ---------------------------------------------------------------------------
 * Offsets and abbreviations
 * ------------------------------------------------------------------------- */

/**
 * Minutes `tz` is ahead of UTC at an instant (Africa/Lagos: +60,
 * America/Chicago in winter: −360). NaN for an invalid instant; throws a
 * RangeError for a zone Intl doesn't know.
 */
export function zoneOffsetMinutes(at: Date | string | number, tz: string): number {
  const ms = toMs(at);
  if (!Number.isFinite(ms)) return NaN;
  const w = wallClock(ms, tz);
  const wall = Date.UTC(w.y, w.m - 1, w.d, w.H, w.i, w.s);
  return Math.round((wall - Math.floor(ms / 1000) * 1000) / 60_000);
}

/**
 * The zone's abbreviation at an instant (default now), e.g. "WAT", "CDT",
 * "GMT+4", "GMT+5:45". Table zones ({@link ZONE_ABBR}) say daylight when the
 * offset is above the smaller of that year's 15 Jan / 15 Jul offsets; every
 * other zone is "GMT" (offset 0) or "GMT±H[:MM]". Identical to the API's
 * `TimeZones::abbr`. Never throws: a zone Intl rejects comes back unchanged.
 */
export function zoneAbbr(tz: string, at: Date | string | number = new Date()): string {
  try {
    let ms = toMs(at);
    if (!Number.isFinite(ms)) ms = Date.now();
    const off = zoneOffsetMinutes(ms, tz);
    const pair = ZONE_ABBR[tz];
    if (pair) {
      const y = wallClock(ms, tz).y;
      const jan = zoneOffsetMinutes(Date.UTC(y, 0, 15, 12), tz);
      const jul = zoneOffsetMinutes(Date.UTC(y, 6, 15, 12), tz);
      return off > Math.min(jan, jul) ? pair[1] : pair[0];
    }
    if (off === 0) return 'GMT';
    const abs = Math.abs(off);
    const h = Math.floor(abs / 60);
    const mm = abs % 60;
    return `GMT${off < 0 ? '-' : '+'}${h}${mm ? `:${pad2(mm)}` : ''}`;
  } catch {
    return tz;
  }
}

/** Whether two zones are on different UTC offsets at that instant (false when either is unknown). */
export function offsetsDiffer(at: Date | string | number, a: string, b: string): boolean {
  try {
    const x = zoneOffsetMinutes(at, a);
    const y = zoneOffsetMinutes(at, b);
    return Number.isFinite(x) && Number.isFinite(y) && x !== y;
  } catch {
    return false;
  }
}

const longNames = new Map<string, string>();

function intlZoneName(tz: string, at: Date, timeZoneName: 'longGeneric' | 'long'): string | null {
  try {
    return (
      new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName })
        .formatToParts(at)
        .find((p) => p.type === 'timeZoneName')?.value || null
    );
  } catch {
    return null; // an unknown zone, or an engine without `longGeneric`
  }
}

/** An Intl zone "name" that is only an offset ("GMT+00:00", "GMT-05:00"). */
const OFFSET_NAME = /^(GMT|UTC)([-+−]\d|$)/;

/**
 * The zone's English generic name, e.g. "Central Time", "West Africa Time"
 * (Intl `longGeneric`, en-US); the long specific name where that is only an
 * offset or unsupported (UTC → "Coordinated Universal Time"); `tz` itself when
 * Intl knows neither.
 */
export function zoneLongName(tz: string, at: Date = new Date()): string {
  const cached = longNames.get(tz);
  if (cached) return cached;
  const generic = intlZoneName(tz, at, 'longGeneric');
  if (generic && !OFFSET_NAME.test(generic)) {
    longNames.set(tz, generic); // a generic name doesn't change with DST
    return generic;
  }
  const specific = intlZoneName(tz, at, 'long');
  if (specific && !OFFSET_NAME.test(specific)) return specific;
  return generic ?? specific ?? tz;
}

/** A picker option: "Central Time — America/Chicago (CST)". */
export function zoneOptionLabel(tz: string, at: Date = new Date()): string {
  return `${zoneLongName(tz, at)} — ${tz} (${zoneAbbr(tz, at)})`;
}

/* ---------------------------------------------------------------------------
 * Labels in a zone
 * ------------------------------------------------------------------------- */

/**
 * time "9:00 AM" · date "Wed 4 Nov 2026" · dayTime "Wed 4 Nov, 9:00 AM" ·
 * dateTime "Wed 4 Nov 2026, 9:00 AM" · ymd "2026-11-04" · hm "09:00".
 */
export type ZoneStyle = 'time' | 'date' | 'dayTime' | 'dateTime' | 'ymd' | 'hm';

function formatWall(w: WallClock, style: ZoneStyle): string {
  const time = `${w.H % 12 || 12}:${pad2(w.i)} ${w.H < 12 ? 'AM' : 'PM'}`;
  const day = `${DAYS[weekdayOf(w.y, w.m, w.d)]} ${w.d} ${MONTHS[w.m - 1]}`;
  switch (style) {
    case 'time':
      return time;
    case 'date':
      return `${day} ${w.y}`;
    case 'dayTime':
      return `${day}, ${time}`;
    case 'dateTime':
      return `${day} ${w.y}, ${time}`;
    case 'ymd':
      return `${String(w.y).padStart(4, '0')}-${pad2(w.m)}-${pad2(w.d)}`;
    case 'hm':
      return `${pad2(w.H)}:${pad2(w.i)}`;
  }
}

/**
 * An instant on a zone's clock (see {@link ZoneStyle}), built from numbers and
 * fixed English names only — pure ASCII, the same text as the API's. '' for an
 * invalid instant; a zone Intl doesn't know falls back to the device's.
 */
export function formatInZone(at: Date | string | number, tz: string, style: ZoneStyle): string {
  const ms = toMs(at);
  if (!Number.isFinite(ms)) return '';
  return formatWall(wallClock(ms, usableZone(tz)), style);
}

/** "9:00 AM CST" (= the API's `TimeZones::time`). */
export function timeLabel(at: Date | string | number, tz: string): string {
  const zone = usableZone(tz);
  const text = formatInZone(at, zone, 'time');
  return text && `${text} ${zoneAbbr(zone, at)}`;
}

/** "Wed 4 Nov, 9:00 AM CST" (= the API's `TimeZones::when`). */
export function whenLabel(at: Date | string | number, tz: string): string {
  const zone = usableZone(tz);
  const text = formatInZone(at, zone, 'dayTime');
  return text && `${text} ${zoneAbbr(zone, at)}`;
}

/**
 * An instant for one person, plus the other party's time only when their UTC
 * offsets differ at that instant: `{ primary: "9:00 AM CST", secondary:
 * "4:00 PM WAT" }`, with the weekday when the other's date differs ("Thu 4:00
 * AM WAT" for 9:00 PM CST on Wednesday); `secondary` null otherwise (or when
 * `otherTz` is null or unknown). `style` picks the primary's format.
 */
export function dualTime(
  at: Date | string | number,
  primaryTz: string,
  otherTz: string | null,
  style: 'time' | 'dayTime' = 'time',
): { primary: string; secondary: string | null } {
  const zone = usableZone(primaryTz);
  const primary = style === 'dayTime' ? whenLabel(at, zone) : timeLabel(at, zone);
  if (!primary || !otherTz || !isValidTimeZone(otherTz) || !offsetsDiffer(at, zone, otherTz)) {
    return { primary, secondary: null };
  }
  const ms = toMs(at);
  const mine = wallClock(ms, zone);
  const theirs = wallClock(ms, otherTz);
  const other = `${formatWall(theirs, 'time')} ${zoneAbbr(otherTz, ms)}`;
  const sameDate = mine.y === theirs.y && mine.m === theirs.m && mine.d === theirs.d;
  return { primary, secondary: sameDate ? other : `${DAYS[weekdayOf(theirs.y, theirs.m, theirs.d)]} ${other}` };
}

/* ---------------------------------------------------------------------------
 * Wall clock ↔ instant
 * ------------------------------------------------------------------------- */

const LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * A wall-clock time in `tz` ("YYYY-MM-DDTHH:MM", e.g. a datetime-local value)
 * as ISO 8601 with that zone's offset for the date, e.g. ("2026-11-04T09:00",
 * "America/Chicago") → "2026-11-04T09:00:00-06:00". Like the API: a time in a
 * spring-forward gap rolls forward (02:30 → 03:30 CDT), an ambiguous fall-back
 * time takes the first occurrence. Null when malformed or the zone is unknown.
 */
export function zonedLocalToIso(local: string, tz: string): string | null {
  const m = LOCAL_PATTERN.exec((local ?? '').trim());
  if (!m || !isValidTimeZone(tz)) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(wall);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null; // e.g. 31 Feb

  // The offsets either side of this wall time (a day before / after covers any transition).
  const before = zoneOffsetMinutes(wall - 86_400_000, tz);
  const after = zoneOffsetMinutes(wall + 86_400_000, tz);
  let instant: number;
  if (before === after) {
    instant = wall - before * 60_000;
  } else {
    const candidates = [before, after]
      .map((off) => wall - off * 60_000)
      .filter((c, k) => zoneOffsetMinutes(c, tz) === [before, after][k]);
    // Both fit: the fall-back hour, first occurrence. None fit: the spring-forward
    // gap, read with the offset before the change (rolls forward, as PHP does).
    instant = candidates.length ? Math.min(...candidates) : wall - before * 60_000;
  }
  const w = wallClock(instant, tz);
  const off = zoneOffsetMinutes(instant, tz);
  const abs = Math.abs(off);
  return (
    `${formatWall(w, 'ymd')}T${pad2(w.H)}:${pad2(w.i)}:${pad2(w.s)}` +
    `${off < 0 ? '-' : '+'}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  );
}

/** An instant as "YYYY-MM-DDTHH:MM" on `tz`'s clock (a datetime-local value); '' when invalid. */
export function isoToZonedLocal(iso: string, tz: string): string {
  const ms = toMs(iso ?? '');
  if (!Number.isFinite(ms)) return '';
  const w = wallClock(ms, usableZone(tz));
  return `${formatWall(w, 'ymd')}T${formatWall(w, 'hm')}`;
}

/** Today on `tz`'s calendar, 'YYYY-MM-DD'. */
export function todayInZone(tz: string, now: Date = new Date()): string {
  return formatInZone(now, tz, 'ymd');
}

/** Now on `tz`'s clock, "HH:MM". */
export function nowHmInZone(tz: string, now: Date = new Date()): string {
  return formatInZone(now, tz, 'hm');
}

/**
 * A 'YYYY-MM-DD' moved by `days` calendar days (negative goes back) — string
 * arithmetic through UTC, free of DST and the browser's own offset.
 */
export function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const at = new Date(Date.UTC(y, (m || 1) - 1, d || 1, 12));
  at.setUTCDate(at.getUTCDate() + days);
  return `${String(at.getUTCFullYear()).padStart(4, '0')}-${pad2(at.getUTCMonth() + 1)}-${pad2(at.getUTCDate())}`;
}

/* ---------------------------------------------------------------------------
 * Saving the detected zone
 * ------------------------------------------------------------------------- */

/**
 * Saves this device's zone as `auto` — once per session, after the profile
 * loads — only while the person never had one (`timezone_source` null). A set
 * zone is never overwritten, so a second device can't flip it.
 *
 * Emits once: `saved`; `skipped` (no profile, a zone already set, an older API
 * without `timezone_source`, or the save failed — it never errors); or
 * `undetectable` (the device reports no usable zone, e.g. UTC behind a VPN —
 * suggest choosing one).
 */
export function syncDetectedTimeZone(
  state: { timezone_source?: TimeZoneSource | null } | null,
  put: (body: SetTimeZoneInput) => Observable<unknown>,
): Observable<'saved' | 'skipped' | 'undetectable'> {
  if (!state || state.timezone_source !== null) return of('skipped' as const);
  const tz = detectTimeZone();
  if (!tz) return of('undetectable' as const);
  return put({ timezone: tz, source: 'auto' }).pipe(
    map(() => 'saved' as const),
    catchError(() => of('skipped' as const)),
  );
}
