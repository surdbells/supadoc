import { firstValueFrom, of, throwError } from 'rxjs';
import type { SetTimeZoneInput } from '@supadoc/models';
import { timeZoneShortLabel } from './date-input';
import fixture from './time-zone-parity.fixture.json';
import {
  addDaysYmd,
  CLINIC_TIME_ZONE,
  detectTimeZone,
  dualTime,
  formatInZone,
  isDetectableTimeZone,
  isoToZonedLocal,
  isValidTimeZone,
  nowHmInZone,
  offsetsDiffer,
  syncDetectedTimeZone,
  timeLabel,
  todayInZone,
  whenLabel,
  ZONE_ABBR,
  zoneAbbr,
  zonedLocalToIso,
  zoneLongName,
  zoneOffsetMinutes,
  zoneOptionLabel,
} from './time-zone';

const real = Intl.DateTimeFormat.prototype.resolvedOptions;
/** U+202F (ICU 72+ before AM/PM) and U+00A0, built from code points so the source stays plain. */
const NON_ASCII_SPACES = new RegExp(`[${String.fromCharCode(0x202f, 0xa0)}]`);

/** Makes this device report `tz` as its zone. */
function deviceZone(tz: string) {
  return vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (
    this: Intl.DateTimeFormat,
  ) {
    return { ...real.call(this), timeZone: tz };
  });
}

describe('time-zone parity with the API (shared fixture)', () => {
  it.each(fixture.abbr)('$tz at $at is $abbr', ({ tz, at, abbr }) => {
    expect(zoneAbbr(tz, at)).toBe(abbr);
  });

  it.each(fixture.labels)('$fn($tz, $at) is "$text"', ({ tz, at, fn, text }) => {
    const out = fn === 'when' ? whenLabel(at, tz) : timeLabel(at, tz);
    expect(out).toBe(text);
    // Pure ASCII: never ICU's narrow no-break space before AM/PM, never "Sept".
    expect(out).not.toMatch(NON_ASCII_SPACES);
    expect(out).toMatch(/^[\x20-\x7E]+$/);
  });

  it('covers every zone of the shared table, with its aliases', () => {
    for (const alias of ['Asia/Calcutta', 'Europe/Kiev', 'Africa/Asmera', 'America/Indianapolis']) {
      expect(ZONE_ABBR[alias]).toBeDefined();
    }
    expect(ZONE_ABBR['America/Indianapolis']).toEqual(['EST', 'EDT']);
    expect(ZONE_ABBR['Africa/Asmera']).toEqual(['EAT', 'EAT']);
    expect(Object.isFrozen(ZONE_ABBR)).toBe(true);
    expect(CLINIC_TIME_ZONE).toBe('Africa/Lagos');
  });
});

describe('zone validity and detection', () => {
  afterEach(() => vi.restoreAllMocks());

  it('accepts IANA zones and their aliases; refuses offsets, junk and unknown names', () => {
    for (const tz of ['Africa/Lagos', 'America/Chicago', 'Asia/Calcutta', 'America/Indianapolis', 'Africa/Asmera', 'UTC', 'Etc/GMT+5', 'America/Argentina/Buenos_Aires']) {
      expect(isValidTimeZone(tz)).toBe(true);
    }
    for (const tz of ['+01:00', '', ' Africa/Lagos', 'Not/AZone', 'a'.repeat(65), 42, null, undefined]) {
      expect(isValidTimeZone(tz)).toBe(false);
    }
  });

  it('never auto-detects UTC-like zones or Reykjavik (they stay valid for a manual choice)', () => {
    for (const tz of ['UTC', 'GMT', 'Etc/UTC', 'Etc/GMT+1', 'Universal', 'Zulu', 'Atlantic/Reykjavik']) {
      expect(isDetectableTimeZone(tz)).toBe(false);
    }
    expect(isValidTimeZone('Atlantic/Reykjavik')).toBe(true);
    expect(isDetectableTimeZone('America/Chicago')).toBe(true);
  });

  it('detectTimeZone returns the device zone only when detectable', () => {
    deviceZone('UTC');
    expect(detectTimeZone()).toBeNull();
    vi.restoreAllMocks();
    deviceZone('Atlantic/Reykjavik');
    expect(detectTimeZone()).toBeNull();
    vi.restoreAllMocks();
    deviceZone('America/Chicago');
    expect(detectTimeZone()).toBe('America/Chicago');
  });
});

describe('offsets, abbreviations and names', () => {
  it('zoneOffsetMinutes is minutes ahead of UTC at the instant', () => {
    expect(zoneOffsetMinutes('2026-11-04T15:00:00Z', 'Africa/Lagos')).toBe(60);
    expect(zoneOffsetMinutes('2026-11-04T15:00:00Z', 'America/Chicago')).toBe(-360);
    expect(zoneOffsetMinutes(Date.UTC(2026, 6, 1), 'America/Chicago')).toBe(-300);
    expect(zoneOffsetMinutes(new Date('2026-07-01T00:00:00Z'), 'Asia/Kathmandu')).toBe(345);
    expect(zoneOffsetMinutes('not a date', 'UTC')).toBeNaN();
    expect(() => zoneOffsetMinutes(0, 'Not/AZone')).toThrow();
  });

  it('zoneAbbr never throws: an unknown zone comes back unchanged', () => {
    expect(zoneAbbr('Not/AZone')).toBe('Not/AZone');
    expect(timeZoneShortLabel('Not/AZone')).toBe('Not/AZone');
    expect(timeZoneShortLabel('Africa/Lagos', new Date('2026-10-16T10:00:00Z'))).toBe('WAT');
    expect(zoneAbbr('GMT', '2026-01-01T00:00:00Z')).toBe('GMT');
    expect(zoneAbbr('America/Chicago', '2026-11-01T06:30:00Z')).toBe('CDT'); // 01:30, first pass
    expect(zoneAbbr('America/Chicago', '2026-11-01T07:30:00Z')).toBe('CST'); // 01:30 again
  });

  it('offsetsDiffer compares the offsets at that instant (EU and US DST weeks differ)', () => {
    expect(offsetsDiffer('2026-11-04T15:00:00Z', 'America/Chicago', 'Africa/Lagos')).toBe(true);
    expect(offsetsDiffer('2026-11-04T15:00:00Z', 'Africa/Lagos', 'Africa/Douala')).toBe(false);
    // Lagos (+1 all year) and London: different in winter (GMT), the same in summer (BST).
    expect(offsetsDiffer('2027-01-15T12:00:00Z', 'Africa/Lagos', 'Europe/London')).toBe(true);
    expect(offsetsDiffer('2027-07-15T12:00:00Z', 'Africa/Lagos', 'Europe/London')).toBe(false);
    // 20 Mar 2027: New York is already on EDT (−4) while London is still on GMT: 4 h, not 5.
    expect(zoneOffsetMinutes('2027-03-20T12:00:00Z', 'America/New_York') - zoneOffsetMinutes('2027-03-20T12:00:00Z', 'Europe/London')).toBe(-240);
    expect(offsetsDiffer('2026-11-04T15:00:00Z', 'Africa/Lagos', 'Not/AZone')).toBe(false);
  });

  it('names zones in English, falling back to the IANA name', () => {
    const winter = new Date('2027-01-15T12:00:00Z');
    expect(zoneLongName('America/Chicago', winter)).toBe('Central Time');
    expect(zoneLongName('Africa/Lagos', winter)).toMatch(/West Africa/);
    expect(zoneLongName('UTC', winter)).toBe('Coordinated Universal Time');
    expect(zoneLongName('Not/AZone', winter)).toBe('Not/AZone');
    expect(zoneOptionLabel('America/Chicago', winter)).toBe('Central Time — America/Chicago (CST)');
  });
});

describe('labels in a zone', () => {
  const at = '2026-11-04T15:00:00Z'; // Wed 9:00 AM CST = 4:00 PM WAT

  it('formatInZone builds every style from numbers', () => {
    expect(formatInZone(at, 'America/Chicago', 'time')).toBe('9:00 AM');
    expect(formatInZone(at, 'America/Chicago', 'date')).toBe('Wed 4 Nov 2026');
    expect(formatInZone(at, 'America/Chicago', 'dayTime')).toBe('Wed 4 Nov, 9:00 AM');
    expect(formatInZone(at, 'America/Chicago', 'dateTime')).toBe('Wed 4 Nov 2026, 9:00 AM');
    expect(formatInZone(at, 'America/Chicago', 'ymd')).toBe('2026-11-04');
    expect(formatInZone(at, 'America/Chicago', 'hm')).toBe('09:00');
    expect(formatInZone('2026-09-08T14:05:00Z', 'Europe/London', 'date')).toBe('Tue 8 Sep 2026');
    expect(formatInZone('2026-11-04T23:30:00Z', 'Africa/Lagos', 'hm')).toBe('00:30');
    expect(formatInZone('nope', 'UTC', 'time')).toBe('');
  });

  it('dualTime adds the other zone only when the offsets differ, with its weekday when the date differs', () => {
    expect(dualTime(at, 'America/Chicago', 'Africa/Lagos')).toEqual({ primary: '9:00 AM CST', secondary: '4:00 PM WAT' });
    expect(dualTime(at, 'Africa/Lagos', 'America/Chicago', 'dayTime')).toEqual({
      primary: 'Wed 4 Nov, 4:00 PM WAT',
      secondary: '9:00 AM CST',
    });
    // 9:00 PM CST on Wednesday is Thursday 4:00 AM in Lagos.
    expect(dualTime('2026-11-05T03:00:00Z', 'America/Chicago', 'Africa/Lagos')).toEqual({
      primary: '9:00 PM CST',
      secondary: 'Thu 4:00 AM WAT',
    });
    expect(dualTime(at, 'Africa/Lagos', 'Africa/Douala').secondary).toBeNull();
    expect(dualTime(at, 'Africa/Lagos', null).secondary).toBeNull();
    expect(dualTime(at, 'Africa/Lagos', 'Not/AZone').secondary).toBeNull();
  });

  it('today and now on a zone clock', () => {
    const now = new Date('2026-11-05T03:30:00Z');
    expect(todayInZone('America/Chicago', now)).toBe('2026-11-04');
    expect(todayInZone('Africa/Lagos', now)).toBe('2026-11-05');
    expect(nowHmInZone('America/Chicago', now)).toBe('21:30');
    expect(nowHmInZone('Africa/Lagos', now)).toBe('04:30');
  });

  it('addDaysYmd is calendar arithmetic (for the 365-day maximum)', () => {
    expect(addDaysYmd('2026-11-04', 365)).toBe('2027-11-04');
    expect(addDaysYmd('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDaysYmd('2026-03-08', -1)).toBe('2026-03-07');
  });
});

describe('wall clock ↔ instant', () => {
  it('round-trips a wall time in America/Chicago', () => {
    const iso = zonedLocalToIso('2026-11-04T09:00', 'America/Chicago');
    expect(iso).toBe('2026-11-04T09:00:00-06:00');
    expect(new Date(iso as string).toISOString()).toBe('2026-11-04T15:00:00.000Z');
    expect(isoToZonedLocal(iso as string, 'America/Chicago')).toBe('2026-11-04T09:00');
    expect(zonedLocalToIso('2026-07-01T09:00', 'America/Chicago')).toBe('2026-07-01T09:00:00-05:00');
    expect(zonedLocalToIso('2026-11-04T16:00', 'Africa/Lagos')).toBe('2026-11-04T16:00:00+01:00');
  });

  it('rolls a spring-forward gap time forward and takes the first of a repeated hour', () => {
    // 14 Mar 2027 02:30 doesn't exist in Chicago: it becomes 03:30 CDT.
    expect(zonedLocalToIso('2027-03-14T02:30', 'America/Chicago')).toBe('2027-03-14T03:30:00-05:00');
    // 1 Nov 2026 01:30 happens twice: the first (CDT) one.
    expect(zonedLocalToIso('2026-11-01T01:30', 'America/Chicago')).toBe('2026-11-01T01:30:00-05:00');
  });

  it('refuses malformed input', () => {
    expect(zonedLocalToIso('2026-11-04 09:00', 'America/Chicago')).toBeNull();
    expect(zonedLocalToIso('2026-02-31T09:00', 'America/Chicago')).toBeNull();
    expect(zonedLocalToIso('2026-11-04T25:00', 'America/Chicago')).toBeNull();
    expect(zonedLocalToIso('2026-11-04T09:00', 'Not/AZone')).toBeNull();
    expect(isoToZonedLocal('nope', 'UTC')).toBe('');
  });
});

describe('syncDetectedTimeZone', () => {
  afterEach(() => vi.restoreAllMocks());

  it('saves the detected zone as auto only when none was ever set', async () => {
    deviceZone('America/Chicago');
    const put = vi.fn((body: SetTimeZoneInput) => of({ status: 'success', data: body }));
    expect(await firstValueFrom(syncDetectedTimeZone({ timezone_source: null }, put))).toBe('saved');
    expect(put).toHaveBeenCalledWith({ timezone: 'America/Chicago', source: 'auto' });

    put.mockClear();
    expect(await firstValueFrom(syncDetectedTimeZone({ timezone_source: 'auto' }, put))).toBe('skipped');
    expect(await firstValueFrom(syncDetectedTimeZone({ timezone_source: 'manual' }, put))).toBe('skipped');
    expect(await firstValueFrom(syncDetectedTimeZone(null, put))).toBe('skipped');
    // An older API without timezone_source: never written.
    expect(await firstValueFrom(syncDetectedTimeZone({}, put))).toBe('skipped');
    expect(put).not.toHaveBeenCalled();
  });

  it('says undetectable for a UTC device, and never throws on a failed save', async () => {
    const put = vi.fn(() => throwError(() => new Error('offline')));
    deviceZone('Etc/UTC');
    expect(await firstValueFrom(syncDetectedTimeZone({ timezone_source: null }, put))).toBe('undetectable');
    expect(put).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    deviceZone('Europe/Berlin');
    expect(await firstValueFrom(syncDetectedTimeZone({ timezone_source: null }, put))).toBe('skipped');
    expect(put).toHaveBeenCalledTimes(1);
  });
});
