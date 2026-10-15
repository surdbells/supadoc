import type { DayAvailability } from '@supadoc/models';
import {
  addDaysYmd,
  addMonths,
  localSlotDays,
  monthGrid,
  nowLocalInput,
  periodOf,
  slotLabel,
  timeZoneShortLabel,
  todayLocal,
  viewerTimeZone,
  ymdInZone,
} from './date-input';

/** Local wall-clock instants, so every expectation holds in any test timezone. */
const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s);
const iso = (d: Date) => d.toISOString();

describe('date-input', () => {
  afterEach(() => vi.useRealTimers());

  it('todayLocal is the local calendar date, with an optional offset', () => {
    vi.useFakeTimers();
    vi.setSystemTime(local(2026, 10, 14, 0, 30));
    expect(todayLocal()).toBe('2026-10-14');
    expect(todayLocal(-7)).toBe('2026-10-07');
    expect(todayLocal(1)).toBe('2026-10-15');
  });

  it('nowLocalInput is local YYYY-MM-DDTHH:mm, optionally rounded up', () => {
    vi.useFakeTimers();
    vi.setSystemTime(local(2026, 10, 14, 9, 7, 30));
    expect(nowLocalInput()).toBe('2026-10-14T09:07');
    expect(nowLocalInput(30)).toBe('2026-10-14T09:30');

    vi.setSystemTime(local(2026, 10, 14, 23, 45));
    expect(nowLocalInput(30)).toBe('2026-10-15T00:00');

    vi.setSystemTime(local(2026, 10, 14, 10, 30, 59));
    expect(nowLocalInput(30)).toBe('2026-10-14T10:30');
  });

  it('slotLabel formats the instant in local time', () => {
    expect(slotLabel(iso(local(2026, 10, 14, 9, 30)))).toMatch(/^9:30\sAM$/);
    expect(slotLabel(iso(local(2026, 10, 14, 14, 0)))).toMatch(/^2:00\sPM$/);
    expect(slotLabel('not a date')).toBe('');
  });

  it('localSlotDays regroups by local date, relabels, and drops slots already started', () => {
    vi.useFakeTimers();
    vi.setSystemTime(local(2026, 10, 14, 8, 0));
    const gone = iso(local(2026, 10, 14, 7, 30));
    const morning = iso(local(2026, 10, 14, 9, 0));
    const evening = iso(local(2026, 10, 14, 21, 30));
    const tomorrow = iso(local(2026, 10, 15, 10, 30));
    // The server groups by UTC date with UTC labels — deliberately scrambled here.
    const server: DayAvailability[] = [
      { date: '2026-10-13', weekday: 'Tue', day: '13', slots: [{ iso: gone, label: 'x', time: 'x' }, { iso: evening, label: 'x', time: 'x' }] },
      { date: '2026-10-14', weekday: 'Wed', day: '14', slots: [{ iso: tomorrow, label: 'x', time: 'x' }, { iso: morning, label: 'x', time: 'x' }] },
    ];

    const days = localSlotDays(server);

    expect(days.map((d) => d.date)).toEqual(['2026-10-14', '2026-10-15']);
    expect(days[0].weekday).toBe('Wed');
    expect(days[0].day).toBe('14');
    expect(days[0].slots.map((s) => s.iso)).toEqual([morning, evening]);
    expect(days[0].slots[0].label).toMatch(/^9:00\sAM$/);
    expect(days[0].slots[1].time).toBe('21:30');
    expect(days[1].slots.map((s) => s.iso)).toEqual([tomorrow]);
  });
});

describe('calendar dates in a time zone', () => {
  it('viewerTimeZone names an IANA zone; timeZoneShortLabel names a zone briefly', () => {
    expect(viewerTimeZone()).toMatch(/\S/);
    expect(timeZoneShortLabel('UTC')).toBe('UTC');
    expect(timeZoneShortLabel('Africa/Lagos', new Date('2026-10-16T10:00:00Z'))).toMatch(/^(WAT|GMT\+1|UTC\+1)$/);
    expect(timeZoneShortLabel()).toMatch(/\S/);
    expect(timeZoneShortLabel('Not/AZone')).toBe('Not/AZone');
  });

  it('ymdInZone is the calendar date in that zone, whatever the viewer zone', () => {
    // 23:30 UTC on the 15th is already the 16th in Lagos (UTC+1) …
    expect(ymdInZone('2026-10-15T23:30:00Z', 'Africa/Lagos')).toBe('2026-10-16');
    expect(ymdInZone('2026-10-15T23:30:00Z', 'UTC')).toBe('2026-10-15');
    // … and still the 15th in New York (UTC-4 in October).
    expect(ymdInZone(new Date('2026-10-16T03:00:00Z'), 'America/New_York')).toBe('2026-10-15');
    expect(ymdInZone(Date.UTC(2026, 0, 1, 12), 'Asia/Tokyo')).toBe('2026-01-01');
    expect(ymdInZone('nope', 'UTC')).toBe('');
  });

  it('periodOf buckets by the zone clock: morning 05-12, afternoon 12-17, evening otherwise', () => {
    const lagos = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 16, h - 1, m)); // UTC+1
    expect(periodOf(lagos(5), 'Africa/Lagos')).toBe('morning');
    expect(periodOf(lagos(11, 59), 'Africa/Lagos')).toBe('morning');
    expect(periodOf(lagos(12), 'Africa/Lagos')).toBe('afternoon');
    expect(periodOf(lagos(16, 30), 'Africa/Lagos')).toBe('afternoon');
    expect(periodOf(lagos(17), 'Africa/Lagos')).toBe('evening');
    expect(periodOf(lagos(23), 'Africa/Lagos')).toBe('evening');
    expect(periodOf('2026-10-16T01:30:00Z', 'Africa/Lagos')).toBe('evening'); // 02:30 local
    // The same instant is morning in Lagos, afternoon in Dubai (UTC+4).
    expect(periodOf('2026-10-16T09:00:00Z', 'Africa/Lagos')).toBe('morning');
    expect(periodOf('2026-10-16T09:00:00Z', 'Asia/Dubai')).toBe('afternoon');
  });

  it('addDaysYmd and addMonths cross month, year and DST edges cleanly', () => {
    expect(addDaysYmd('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDaysYmd('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDaysYmd('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDaysYmd('2026-12-31', 1)).toBe('2027-01-01');
    // Europe's and America's DST switches — no lost or doubled day.
    expect(addDaysYmd('2026-03-28', 2)).toBe('2026-03-30');
    expect(addDaysYmd('2026-11-01', 1)).toBe('2026-11-02');
    expect(addDaysYmd('2026-10-16', -42)).toBe('2026-09-04');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-10', 14)).toBe('2027-12');
    expect(addMonths('2026-10', 0)).toBe('2026-10');
  });

  it('monthGrid is six whole weeks from the chosen first weekday', () => {
    // October 2026 begins on a Thursday.
    const mon = monthGrid('2026-10');
    expect(mon).toHaveLength(42);
    expect(mon[0]).toBe('2026-09-28'); // a Monday
    expect(mon[3]).toBe('2026-10-01');
    expect(mon[41]).toBe('2026-11-08');
    expect(new Set(mon).size).toBe(42);

    const sun = monthGrid('2026-10', 0);
    expect(sun[0]).toBe('2026-09-27'); // a Sunday
    expect(sun[4]).toBe('2026-10-01');

    // A month starting on the week's first day starts the grid itself.
    expect(monthGrid('2026-06')[0]).toBe('2026-06-01'); // June 1st 2026 is a Monday
    expect(monthGrid('2026-02', 0)[0]).toBe('2026-02-01'); // Feb 1st 2026 is a Sunday
    // Consecutive days throughout.
    for (let i = 1; i < 42; i++) expect(mon[i]).toBe(addDaysYmd(mon[i - 1], 1));
  });
});
