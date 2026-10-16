import type { AdminDashboardKpi } from '@supadoc/models';
import { columnPath, niceScale, tickIndexes, yFor } from './dashboard-chart';
import {
  compactNumber,
  compareLabel,
  dayLabel,
  formatMoney,
  greeting,
  initials,
  kpiDelta,
  kpiExact,
  kpiInlineSub,
  kpiNote,
  kpiValue,
  parsePeriod,
  roleLabel,
  startsIn,
} from './dashboard-ui';
import { presenceOf } from './dashboard-live';
import { sharePct } from './dashboard-breakdowns';

function kpi(over: Partial<AdminDashboardKpi> = {}): AdminDashboardKpi {
  return {
    key: 'bookings',
    label: 'Bookings made',
    format: 'count',
    value: 12,
    previous: 8,
    change_pct: 50,
    trend: 'up',
    higher_is_better: true,
    count: null,
    previous_count: null,
    breakdown: null,
    ...over,
  };
}

describe('dashboard-ui', () => {
  it('reads the period from the URL, today by default', () => {
    expect(parsePeriod('7d')).toBe('7d');
    expect(parsePeriod('30d')).toBe('30d');
    expect(parsePeriod(null)).toBe('today');
    expect(parsePeriod('90d')).toBe('today');
    expect(compareLabel('today')).toBe('vs this time yesterday');
    expect(compareLabel('7d')).toBe('vs previous 7 days');
  });

  it('formats money in full, compact for tiles and axes, a dash for nothing', () => {
    expect(formatMoney('12500.00', 'NGN')).toBe('₦12,500');
    expect(formatMoney('12500.5', 'NGN')).toBe('₦12,500.50');
    expect(formatMoney('1250000', 'NGN', { compact: true })).toBe('₦1.25M');
    expect(formatMoney(5000, 'NGN', { compact: true })).toBe('₦5K');
    expect(formatMoney(-300, 'NGN')).toBe('−₦300');
    expect(formatMoney(10, 'USD')).toBe('USD 10');
    expect(formatMoney(null)).toBe('—');
    expect(compactNumber(950)).toBe('950');
    expect(compactNumber(1284)).toBe('1.3K');
    expect(compactNumber(250_000)).toBe('250K');
    // Rounding up into the next unit takes that unit.
    expect(compactNumber(999_999.5)).toBe('1M');
    expect(compactNumber(999_950)).toBe('1M');
    expect(compactNumber(999_999_999)).toBe('1B');
    expect(compactNumber(-120_400)).toBe('−120K');
  });

  it('keeps tile money short enough for a two-up tile on a phone; the exact amount stays in the title', () => {
    const money = (value: string | number) => kpi({ key: 'revenue', format: 'money', value });
    // Under ₦100K: whole naira (no kobo).
    expect(kpiValue(money('999.50'), 'NGN')).toBe('₦1,000');
    expect(kpiValue(money('99999.40'), 'NGN')).toBe('₦99,999');
    expect(kpiValue(money('-2500.60'), 'NGN')).toBe('−₦2,501');
    expect(kpiValue(money('0.30'), 'NGN')).toBe('₦0');
    // From ₦100K: compact.
    expect(kpiValue(money('100000'), 'NGN')).toBe('₦100K');
    expect(kpiValue(money('999999.50'), 'NGN')).toBe('₦1M');
    expect(kpiValue(money('-250000'), 'NGN')).toBe('−₦250K');
    expect(kpiValue(kpi({ format: 'money', value: null }), 'NGN')).toBe('—');
    expect(kpiExact(money('999999.50'), 'NGN')).toBe('₦999,999.50');
  });

  it('words a change with an arrow, and colours it by whether up is good', () => {
    const up = kpiDelta(kpi(), 'vs previous 7 days');
    expect(up?.text).toBe('Up 50%');
    expect(up?.icon).toBe('trending-up');
    expect(up?.tone).toBe('good');
    expect(up?.srText).toContain('vs previous 7 days');
    expect(up?.srText).toContain('was 8');
    expect(up?.srText).toContain('better');

    // More refunds is worse.
    const refunds = kpiDelta(
      kpi({ key: 'refunds', format: 'money', value: '3000.00', previous: '1000.00', change_pct: 200, higher_is_better: false }),
      'vs previous 7 days',
    );
    expect(refunds?.tone).toBe('bad');
    expect(refunds?.srText).toContain('was ₦1,000');

    const down = kpiDelta(kpi({ value: 6, previous: 8, change_pct: -25, trend: 'down' }), 'x');
    expect(down?.text).toBe('Down 25%');
    expect(down?.tone).toBe('bad');

    expect(kpiDelta(kpi({ value: 3, previous: 0, change_pct: null, trend: 'up' }), 'x')?.text).toBe('Up from 0');
    expect(kpiDelta(kpi({ value: 4, previous: 4, change_pct: 0, trend: 'flat' }), 'x')?.tone).toBe('neutral');
    // A snapshot (active doctors) or a rating with no reviews: nothing to compare.
    expect(kpiDelta(kpi({ key: 'active_doctors', previous: null, change_pct: null, trend: null }), 'x')).toBeNull();
    expect(kpiDelta(kpi({ key: 'average_rating', format: 'rating', value: null, previous: '4.50' }), 'x')).toBeNull();
  });

  it('shows tile values, counts and breakdowns in words', () => {
    expect(kpiValue(kpi({ format: 'money', value: '2500000.00' }), 'NGN')).toBe('₦2.5M');
    expect(kpiValue(kpi({ format: 'money', value: '25000.00' }), 'NGN')).toBe('₦25,000');
    expect(kpiValue(kpi({ format: 'rating', value: '4.8' }), 'NGN')).toBe('4.80');
    expect(kpiExact(kpi({ format: 'rating', value: null }), 'NGN')).toBe('no reviews');
    expect(kpiInlineSub(kpi({ key: 'average_rating', format: 'rating', count: 1 }))).toBe('1 review');
    expect(kpiInlineSub(kpi({ key: 'wallet_topups', count: 3 }))).toBe('3 top-ups');
    expect(kpiNote(kpi({ key: 'missed', breakdown: { patient: 3, doctor: 1, both: 0, unknown: 0 } }))).toBe(
      'No-show: Patient 3 · Doctor 1',
    );
    expect(kpiNote(kpi({ key: 'missed', breakdown: { patient: 0, doctor: 0, both: 0, unknown: 0 } }))).toBeNull();
    expect(kpiNote(kpi({ key: 'active_doctors', breakdown: { approved: 14, taking_bookings: 11 } }))).toBe('of 14 approved');
  });

  it('shows a trend day as written, whatever the viewer zone', () => {
    expect(dayLabel('2026-10-14')).toBe('Wed 14 Oct');
    expect(dayLabel('2026-12-31')).toBe('Thu 31 Dec');
    expect(dayLabel('nope')).toBe('nope');
  });

  it('words people, roles, times and presence', () => {
    expect(initials('Dr. Grace Bell')).toBe('GB');
    expect(initials('Ada')).toBe('A');
    expect(roleLabel('super_admin')).toBe('Super admin');
    expect(greeting('Ada Admin', 9)).toBe('Good morning, Ada');
    expect(greeting('', 20)).toBe('Good evening');
    const now = Date.parse('2026-10-16T10:00:00Z');
    expect(startsIn('2026-10-16T10:25:00Z', now)).toBe('in 25 min');
    expect(startsIn('2026-10-16T11:10:00Z', now)).toBe('in 1 h 10 min');
    expect(startsIn('2026-10-16T09:59:00Z', now)).toBe('now');

    const item = (in_call: { doctor: boolean; patient: boolean; guests: number } | null) =>
      ({
        id: 'a1',
        scheduled_at: '',
        ends_at: '',
        status: 'confirmed',
        status_label: 'Confirmed',
        type: 'video',
        patient_name: 'Ada Obi',
        specialist: { id: 's1', name: 'Dr Bayo', specialty: 'Cardiology', photo_url: null },
        in_call,
      }) as const;
    expect(presenceOf(item({ doctor: true, patient: true, guests: 1 }))?.text).toBe('Both in the call · +1 guest');
    expect(presenceOf(item({ doctor: false, patient: true, guests: 0 }))?.text).toBe('Patient waiting');
    expect(presenceOf(item(null))).toBeNull();
    expect(sharePct(1, 3)).toBe(33.3);
    expect(sharePct(0, 0)).toBe(0);
    expect(sharePct(0, 50)).toBe(0);
    // A tiny non-zero share never reads "0%".
    expect(sharePct(1, 5000)).toBe(0.1);
    expect(sharePct(1, 2000)).toBe(0.1);
  });
});

describe('dashboard-chart', () => {
  it('scales from zero on nice whole steps for counts', () => {
    const s = niceScale(0, 7, 4, true);
    expect(s.ticks).toEqual([0, 2, 4, 6, 8]);
    expect(niceScale(0, 3, 4, true).ticks).toEqual([0, 1, 2, 3]);
    // Nothing yet: still a 0…1 axis, never a divide by zero.
    expect(niceScale(0, 0, 4, true).ticks).toEqual([0, 1]);
  });

  it('scales money on 1 / 2 / 2.5 / 5 steps, and below zero when needed', () => {
    expect(niceScale(0, 180_000).ticks).toEqual([0, 50_000, 100_000, 150_000, 200_000]);
    const neg = niceScale(-1500, 4000);
    expect(neg.min).toBeLessThanOrEqual(-1500);
    expect(neg.ticks).toContain(0);
  });

  it('draws to scale: the top tick at the top, zero at the bottom', () => {
    const s = niceScale(0, 10, 4, true);
    expect(yFor(s.max, s, 10, 100)).toBe(10);
    expect(yFor(0, s, 10, 100)).toBe(110);
    expect(yFor(s.max / 2, s, 10, 100)).toBe(60);
  });

  it('rounds only the data end of a column, and draws nothing for zero', () => {
    expect(columnPath(0, 0, 10, 0)).toBe('');
    const d = columnPath(10, 20, 8, 50, 4);
    expect(d.startsWith('M10,70V24A4,4')).toBe(true);
    // A short column caps the radius at its height.
    expect(columnPath(0, 0, 8, 2, 4)).toContain('A2,2');
  });

  it('labels today and every week back (every fortnight on a phone)', () => {
    expect(tickIndexes(30, 600)).toEqual([1, 8, 15, 22, 29]);
    expect(tickIndexes(30, 250)).toEqual([1, 15, 29]);
    expect(tickIndexes(0, 600)).toEqual([]);
  });
});
