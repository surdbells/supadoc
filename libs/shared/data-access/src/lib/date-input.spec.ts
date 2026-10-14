import type { DayAvailability } from '@supadoc/models';
import { localSlotDays, nowLocalInput, slotLabel, todayLocal } from './date-input';

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
