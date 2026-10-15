import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import type { AvailabilityDayDto, DaySlotDto } from '@supadoc/models';
import { provideSupadocIcons } from '../icons/icons';
import { BookingCalendarComponent } from './booking-calendar';
import {
  addMonthsYmd,
  clampYmd,
  dayAccessibleName,
  dayState,
  groupSlots,
  keyTarget,
  msToNextDay,
  navigableBounds,
  weekdayHeaders,
} from './booking-calendar.model';

const TZ = 'Africa/Lagos'; // UTC+1, no DST

/** A slot at a Lagos wall-clock time on a date. */
function slot(date: string, hhmm: string, period?: DaySlotDto['period']): DaySlotDto {
  const [h, m] = hhmm.split(':').map(Number);
  const [y, mo, d] = date.split('-').map(Number);
  const iso = new Date(Date.UTC(y, mo - 1, d, h - 1, m)).toISOString();
  const label = `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  return { iso, time: hhmm, label, period: period ?? (h >= 5 && h < 12 ? 'morning' : h >= 12 && h < 17 ? 'afternoon' : 'evening') };
}

describe('booking calendar rules', () => {
  it('keyTarget follows the APG date-picker keys', () => {
    // 2026-10-16 is a Friday.
    expect(keyTarget('2026-10-16', 'ArrowLeft', false, 1)).toBe('2026-10-15');
    expect(keyTarget('2026-10-31', 'ArrowRight', false, 1)).toBe('2026-11-01');
    expect(keyTarget('2026-10-16', 'ArrowUp', false, 1)).toBe('2026-10-09');
    expect(keyTarget('2026-10-30', 'ArrowDown', false, 1)).toBe('2026-11-06');
    expect(keyTarget('2026-10-16', 'Home', false, 1)).toBe('2026-10-12'); // Monday
    expect(keyTarget('2026-10-16', 'End', false, 1)).toBe('2026-10-18'); // Sunday
    expect(keyTarget('2026-10-16', 'Home', false, 0)).toBe('2026-10-11'); // Sunday-first week
    expect(keyTarget('2026-10-16', 'End', false, 0)).toBe('2026-10-17'); // Saturday
    expect(keyTarget('2026-10-12', 'Home', false, 1)).toBe('2026-10-12'); // already there
    expect(keyTarget('2026-10-16', 'PageDown', false, 1)).toBe('2026-11-16');
    expect(keyTarget('2026-10-16', 'PageUp', false, 1)).toBe('2026-09-16');
    expect(keyTarget('2026-10-16', 'PageDown', true, 1)).toBe('2027-10-16');
    expect(keyTarget('2026-10-16', 'PageUp', true, 1)).toBe('2025-10-16');
    expect(keyTarget('2026-10-16', 'a', false, 1)).toBeNull();
    expect(keyTarget('2026-10-16', 'Tab', false, 1)).toBeNull();
  });

  it('month moves keep the day where the month allows', () => {
    expect(addMonthsYmd('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsYmd('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonthsYmd('2026-03-31', -1)).toBe('2026-02-28');
    expect(addMonthsYmd('2026-12-15', 1)).toBe('2027-01-15');
  });

  it('navigation is clamped to the months of min..max', () => {
    const { lo, hi } = navigableBounds('2026-10-15', '2026-12-13');
    expect([lo, hi]).toEqual(['2026-10-01', '2026-12-31']);
    expect(clampYmd('2026-09-20', lo, hi)).toBe('2026-10-01');
    expect(clampYmd('2027-01-04', lo, hi)).toBe('2026-12-31');
    expect(clampYmd('2026-11-04', lo, hi)).toBe('2026-11-04');
    expect(navigableBounds(null, null)).toEqual({ lo: null, hi: null });
  });

  it('dayState disables past and beyond days, but full / closed days stay choosable', () => {
    const ctx = { today: '2026-10-15', min: '2026-10-15', max: '2026-12-13', disabled: false };
    const day = (date: string, status: AvailabilityDayDto['status'], open = 0): AvailabilityDayDto => ({ date, status, open, first: null });

    expect(dayState('2026-10-16', day('2026-10-16', 'available', 12), ctx)).toEqual({ status: 'available', disabled: false, bookable: true });
    expect(dayState('2026-10-17', day('2026-10-17', 'few', 2), ctx)).toEqual({ status: 'few', disabled: false, bookable: true });
    expect(dayState('2026-10-18', day('2026-10-18', 'full'), ctx)).toEqual({ status: 'full', disabled: false, bookable: false });
    expect(dayState('2026-10-19', day('2026-10-19', 'closed'), ctx)).toEqual({ status: 'closed', disabled: false, bookable: false });
    expect(dayState('2026-10-20', day('2026-10-20', 'blocked'), ctx)).toEqual({ status: 'blocked', disabled: false, bookable: false });
    expect(dayState('2026-10-14', day('2026-10-14', 'past'), ctx).disabled).toBe(true);
    expect(dayState('2026-12-20', day('2026-12-20', 'beyond'), ctx).disabled).toBe(true);
    // No data: inferred from today / max.
    expect(dayState('2026-10-01', undefined, ctx)).toEqual({ status: 'past', disabled: true, bookable: false });
    expect(dayState('2026-12-14', undefined, ctx)).toEqual({ status: 'beyond', disabled: true, bookable: false });
    expect(dayState('2026-11-02', undefined, ctx)).toEqual({ status: null, disabled: false, bookable: false });
    // Outside min..max is never choosable, whatever the data says.
    expect(dayState('2026-12-14', day('2026-12-14', 'available', 3), ctx).disabled).toBe(true);
    // A disabled calendar disables everything.
    expect(dayState('2026-10-16', day('2026-10-16', 'available', 12), { ...ctx, disabled: true })).toEqual({
      status: 'available',
      disabled: true,
      bookable: false,
    });
    // Past midnight, yesterday is past even if the (day-old) data still says open.
    expect(dayState('2026-10-15', day('2026-10-15', 'available', 8), { ...ctx, today: '2026-10-16' })).toEqual({
      status: 'past',
      disabled: true,
      bookable: false,
    });
  });

  it('msToNextDay counts to the zone\'s next midnight, checking at least hourly', () => {
    // 22:30 UTC is 23:30 in Lagos: half an hour (and a second) to go.
    expect(msToNextDay(TZ, new Date('2026-10-15T22:30:00Z'))).toBe(30 * 60_000 + 1000);
    expect(msToNextDay('UTC', new Date('2026-10-15T23:59:30Z'))).toBe(31_000);
    expect(msToNextDay(TZ, new Date('2026-10-15T09:00:00Z'))).toBe(3_600_000);
    expect(msToNextDay('Not/AZone', new Date('2026-10-15T09:00:00Z'))).toBe(3_600_000);
  });

  it('names each day for assistive tech', () => {
    expect(dayAccessibleName('2026-10-16', 'available', 12)).toBe('Friday 16 October, 12 times available');
    expect(dayAccessibleName('2026-10-16', 'available', 1)).toBe('Friday 16 October, 1 time available');
    expect(dayAccessibleName('2026-10-16', 'few', 2)).toBe('Friday 16 October, 2 times available, few left');
    expect(dayAccessibleName('2026-10-16', 'full', 0)).toBe('Friday 16 October, fully booked');
    expect(dayAccessibleName('2026-10-16', 'closed', 0)).toBe('Friday 16 October, no hours');
    expect(dayAccessibleName('2026-10-16', 'blocked', 0)).toBe('Friday 16 October, unavailable');
    expect(dayAccessibleName('2026-12-20', 'beyond', 0)).toBe('Sunday 20 December, outside the booking window');
    expect(dayAccessibleName('2026-10-16', null, 0)).toBe('Friday 16 October');
  });

  it('weekday headers follow weekStartsOn', () => {
    expect(weekdayHeaders(1).map((w) => w.short)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    expect(weekdayHeaders(0)[0]).toEqual({ short: 'Sun', long: 'Sunday' });
  });

  it('groups times Morning / Afternoon / Evening, in order, skipping empty groups', () => {
    const d = '2026-10-16';
    const groups = groupSlots([slot(d, '18:00'), slot(d, '09:30'), slot(d, '08:00'), slot(d, '19:30')], TZ);
    expect(groups.map((g) => g.label)).toEqual(['Morning', 'Evening']);
    expect(groups[0].slots.map((s) => s.time)).toEqual(['08:00', '09:30']);
    expect(groups[1].slots.map((s) => s.time)).toEqual(['18:00', '19:30']);

    // Without the server's period, it is worked out on the zone's clock.
    const bare = { ...slot(d, '13:00'), period: undefined } as unknown as DaySlotDto;
    expect(groupSlots([bare], TZ).map((g) => g.period)).toEqual(['afternoon']);
    expect(groupSlots([], TZ)).toEqual([]);
  });
});

@Component({
  imports: [BookingCalendarComponent],
  template: `
    <sd-booking-calendar
      [days]="days()"
      [month]="month()"
      (monthChange)="month.set($event)"
      [selectedDate]="selected()"
      (selectedDateChange)="selected.set($event)"
      [slots]="slots()"
      [(value)]="value"
      [loading]="loading()"
      [slotsLoading]="slotsLoading()"
      [min]="min()"
      [max]="max()"
      [nextAvailable]="next()"
      [nextOnEmptyDay]="nextOnEmpty()"
      [disabled]="disabled()"
      timeZone="Africa/Lagos"
      timeZoneLabel="WAT"
      (jumpToNext)="jumps.push($event)"
    >
      <p calendarEmpty class="alt">Other doctors are free that day</p>
    </sd-booking-calendar>
  `,
})
class HostComponent {
  readonly days = signal<AvailabilityDayDto[]>([]);
  readonly month = signal('2026-10');
  readonly selected = signal<string | null>(null);
  readonly slots = signal<DaySlotDto[] | null>(null);
  readonly value = signal<string | null>(null);
  readonly loading = signal(false);
  readonly slotsLoading = signal(false);
  readonly min = signal<string | null>('2026-10-15');
  readonly max = signal<string | null>('2026-11-25');
  readonly next = signal<string | null>(null);
  readonly nextOnEmpty = signal(true);
  readonly disabled = signal(false);
  readonly jumps: string[] = [];
}

/** October 2026 as the API would send it, today being Thursday the 15th. */
function octoberDays(): AvailabilityDayDto[] {
  const out: AvailabilityDayDto[] = [];
  for (let d = 1; d <= 31; d++) {
    const date = `2026-10-${String(d).padStart(2, '0')}`;
    let status: AvailabilityDayDto['status'] = 'available';
    let open = 8;
    if (d < 15) [status, open] = ['past', 0];
    else if (d === 16) [status, open] = ['full', 0];
    else if (d === 17) [status, open] = ['few', 2];
    else if (d === 18 || d === 25) [status, open] = ['closed', 0];
    out.push({ date, status, open, first: null });
  }
  return out;
}

describe('BookingCalendarComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;
  let el: HTMLElement;

  /** The one element matching `selector` (fails the test when there is none). */
  const q = <T extends Element = HTMLElement>(selector: string): T => {
    const found = el.querySelector<T>(selector);
    if (!found) throw new Error(`No ${selector}`);
    return found;
  };
  const cell = (date: string) => q(`td[data-date="${date}"]`);
  const buttonWith = (text: string): HTMLButtonElement => {
    const found = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
    if (!found) throw new Error(`No "${text}" button`);
    return found;
  };
  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const key = async (target: HTMLElement, k: string, shiftKey = false) => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true, cancelable: true }));
    await render();
  };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T09:00:00Z'));
    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [provideSupadocIcons()],
    }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    el = fixture.nativeElement;
    document.body.appendChild(el);
    host.days.set(octoberDays());
    await render();
  });

  afterEach(() => {
    el.remove();
    vi.useRealTimers();
  });

  it('renders an APG grid: labelled by the live month heading, weekday headers with abbr', () => {
    const grid = q('table[role="grid"]');
    const heading = q(`#${grid.getAttribute('aria-labelledby')}`);
    expect(heading.textContent?.trim()).toBe('October 2026');
    expect(heading.getAttribute('aria-live')).toBe('polite');
    const ths = [...el.querySelectorAll('th[scope="col"]')];
    expect(ths.map((t) => t.textContent?.trim())).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    expect(ths[0].getAttribute('abbr')).toBe('Monday');
    expect(el.querySelectorAll('tbody tr')).toHaveLength(6);
    expect(el.querySelectorAll('td[role="gridcell"][data-date]')).toHaveLength(31);
  });

  it('marks today, names days and disables past ones', () => {
    expect(cell('2026-10-15').getAttribute('aria-current')).toBe('date');
    expect(cell('2026-10-14').getAttribute('aria-current')).toBeNull();
    expect(cell('2026-10-14').getAttribute('aria-disabled')).toBe('true');
    expect(cell('2026-10-15').getAttribute('aria-disabled')).toBeNull();
    expect(cell('2026-10-15').getAttribute('aria-label')).toBe('Thursday 15 October, 8 times available');
    expect(cell('2026-10-16').getAttribute('aria-label')).toBe('Friday 16 October, fully booked');
    expect(cell('2026-10-17').textContent).toContain('few left');
    expect(cell('2026-10-16').textContent).toContain('full');
  });

  it('has one tab stop: the first open day, then the chosen one', async () => {
    const tabbable = () => [...el.querySelectorAll<HTMLElement>('td[data-date]')].filter((td) => td.tabIndex === 0);
    expect(tabbable().map((td) => td.dataset['date'])).toEqual(['2026-10-15']);
    host.selected.set('2026-10-20');
    await render();
    expect(tabbable().map((td) => td.dataset['date'])).toEqual(['2026-10-20']);
    expect(cell('2026-10-20').getAttribute('aria-selected')).toBe('true');
    expect(cell('2026-10-21').getAttribute('aria-selected')).toBe('false');
  });

  it('chooses a day by click / Enter / Space, never a disabled one', async () => {
    cell('2026-10-10').click();
    await render();
    expect(host.selected()).toBeNull();

    cell('2026-10-19').click();
    await render();
    expect(host.selected()).toBe('2026-10-19');

    await key(cell('2026-10-20'), 'Enter');
    expect(host.selected()).toBe('2026-10-20');
    await key(cell('2026-10-21'), ' ');
    expect(host.selected()).toBe('2026-10-21');
    await key(cell('2026-10-12'), 'Enter');
    expect(host.selected()).toBe('2026-10-21');
  });

  it('moves focus with the arrow keys, Home and End', async () => {
    cell('2026-10-15').focus();
    await key(cell('2026-10-15'), 'ArrowRight');
    expect(document.activeElement).toBe(cell('2026-10-16'));
    await key(cell('2026-10-16'), 'ArrowDown');
    expect(document.activeElement).toBe(cell('2026-10-23'));
    await key(cell('2026-10-23'), 'Home');
    expect(document.activeElement).toBe(cell('2026-10-19'));
    await key(cell('2026-10-19'), 'End');
    expect(document.activeElement).toBe(cell('2026-10-25'));
    expect(cell('2026-10-25').tabIndex).toBe(0);
    // Focus can rest on a past day (it is only not choosable).
    await key(cell('2026-10-25'), 'ArrowUp');
    await key(cell('2026-10-18'), 'ArrowUp');
    expect(document.activeElement).toBe(cell('2026-10-11'));
  });

  it('crosses into the next month by keyboard, keeping focus, and stops at max', async () => {
    cell('2026-10-29').focus();
    await key(cell('2026-10-29'), 'ArrowDown');
    expect(host.month()).toBe('2026-11');
    expect(q('h3').textContent?.trim()).toBe('November 2026');
    expect(document.activeElement).toBe(cell('2026-11-05'));

    // PageDown would leave November (the last month up to max) — clamped to its end.
    await key(cell('2026-11-05'), 'PageDown');
    expect(host.month()).toBe('2026-11');
    expect(document.activeElement).toBe(cell('2026-11-30'));

    // Shift+PageUp (a year back) is clamped to the first month (min's).
    await key(cell('2026-11-30'), 'PageUp', true);
    expect(host.month()).toBe('2026-10');
    expect(document.activeElement).toBe(cell('2026-10-01'));
  });

  it('disables the month arrows outside min..max', async () => {
    const prev = q<HTMLButtonElement>('button[aria-label="Previous month"]');
    const next = q<HTMLButtonElement>('button[aria-label="Next month"]');
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);
    next.click();
    await render();
    expect(host.month()).toBe('2026-11');
    expect(next.disabled).toBe(true);
    expect(prev.disabled).toBe(false);
  });

  it('lists times as radios grouped in fieldsets, with a live summary', async () => {
    const d = '2026-10-20';
    host.selected.set(d);
    host.slots.set([slot(d, '09:00'), slot(d, '09:30'), slot(d, '14:00'), slot(d, '18:30')]);
    await render();

    const legends = [...el.querySelectorAll('fieldset legend')].map((l) => l.textContent?.replace(/\s+/g, ' ').trim());
    expect(legends).toEqual(['Morning · 2', 'Afternoon · 1', 'Evening · 1']);
    const radios = [...el.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios).toHaveLength(4);
    expect(new Set(radios.map((r) => r.name)).size).toBe(1);
    expect(radios.every((r) => r.closest('label'))).toBe(true);
    expect(q('[aria-live="polite"][aria-atomic="true"]').textContent?.trim()).toBe('4 times on Tue 20 Oct');
    expect(el.textContent).toContain('Times in WAT');

    radios[2].click();
    await render();
    expect(host.value()).toBe(slot(d, '14:00').iso);
    expect(radios[2].checked).toBe(true);

    // Choosing another day drops a time chosen on this one.
    cell('2026-10-21').click();
    await render();
    expect(host.value()).toBeNull();
  });

  it('shows skeletons while loading', async () => {
    host.selected.set('2026-10-20');
    host.slotsLoading.set(true);
    host.loading.set(true);
    host.days.set([]);
    await render();
    expect(q('table').getAttribute('aria-busy')).toBe('true');
    expect(el.querySelectorAll('td .sd-shimmer').length).toBeGreaterThan(0);
    expect(el.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    expect(el.textContent).toContain('Loading times for Tue 20 Oct');
  });

  it('a day with no times shows the projected alternatives and jumps to the next open day', async () => {
    expect(el.querySelector('.alt')).toBeNull();
    host.selected.set('2026-10-16');
    host.slots.set([]);
    await render();

    expect(el.textContent).toContain('Fully booked on Fri 16 Oct');
    expect(el.querySelector('.alt')?.textContent).toContain('Other doctors');
    const jump = buttonWith('Next available');
    expect(jump.textContent).toContain('Sat 17 Oct');

    jump.click();
    await render();
    expect(host.jumps).toEqual(['2026-10-17']);
    expect(host.selected()).toBe('2026-10-17');
    expect(document.activeElement).toBe(cell('2026-10-17'));
  });

  it('"Next available" prefers the range\'s next opening, as the store does', async () => {
    host.selected.set('2026-10-16');
    host.slots.set([]);
    host.next.set('2026-10-22T07:30:00Z');
    await render();
    expect(buttonWith('Next available').textContent).toContain('Thu 22 Oct');

    // …unless that is the chosen day itself: then the next open day after it.
    host.next.set('2026-10-16T07:30:00Z');
    await render();
    expect(buttonWith('Next available').textContent).toContain('Sat 17 Oct');
  });

  it('never offers a day before the chosen empty one', async () => {
    // The first opening at all is today (Thu 15); Sun 18 is chosen and closed.
    host.next.set('2026-10-15T09:30:00Z');
    host.selected.set('2026-10-18');
    host.slots.set([]);
    await render();
    expect(el.textContent).toContain('No hours on Sun 18 Oct');
    expect(buttonWith('Next available').textContent).toContain('Mon 19 Oct');
    expect(el.textContent).not.toContain('Thu 15 Oct');

    // Nothing open after it is loaded: no offer rather than an earlier day.
    host.days.set(octoberDays().map((d) => (d.date > '2026-10-18' ? { ...d, status: 'closed', open: 0 } : d)));
    await render();
    expect([...el.querySelectorAll('button')].some((b) => b.textContent?.includes('Next available'))).toBe(false);
  });

  it('leaves the next opening to projected content that offers its own', async () => {
    host.nextOnEmpty.set(false);
    host.next.set('2026-10-22T07:30:00Z');
    host.selected.set('2026-10-16');
    host.slots.set([]);
    await render();
    expect(el.textContent).toContain('Fully booked on Fri 16 Oct');
    expect(el.querySelector('.alt')).not.toBeNull();
    expect([...el.querySelectorAll('button')].some((b) => b.textContent?.includes('Next available'))).toBe(false);
  });

  it('says when a month has no openings and offers the next one', async () => {
    host.days.set(octoberDays().map((d) => (d.status === 'past' ? d : { ...d, status: 'full', open: 0 })));
    host.next.set('2026-11-03T08:00:00Z');
    await render();
    expect(el.textContent).toContain('No openings this month');
    const jump = buttonWith('Next available');
    expect(jump.textContent).toContain('Tue 3 Nov');
    jump.click();
    await render();
    expect(host.month()).toBe('2026-11');
    expect(host.selected()).toBe('2026-11-03');
    expect(host.jumps).toEqual(['2026-11-03']);
  });

  it('disabled locks every control', async () => {
    host.selected.set('2026-10-20');
    host.slots.set([slot('2026-10-20', '09:00')]);
    host.disabled.set(true);
    await render();
    expect(cell('2026-10-20').getAttribute('aria-disabled')).toBe('true');
    cell('2026-10-21').click();
    await render();
    expect(host.selected()).toBe('2026-10-20');
    expect(q<HTMLFieldSetElement>('fieldset').disabled).toBe(true);
    expect(q<HTMLButtonElement>('button[aria-label="Next month"]').disabled).toBe(true);
  });

  it('while disabled, keys move focus only within the month on show', async () => {
    host.disabled.set(true);
    await render();
    cell('2026-10-29').focus();
    await key(cell('2026-10-29'), 'ArrowDown');
    expect(host.month()).toBe('2026-10');
    expect(document.activeElement).toBe(cell('2026-10-31'));
    await key(cell('2026-10-31'), 'PageDown');
    expect(host.month()).toBe('2026-10');
    await key(cell('2026-10-31'), 'PageUp', true);
    expect(host.month()).toBe('2026-10');
    expect(document.activeElement).toBe(cell('2026-10-01'));
  });

  it('a chosen day that cannot be chosen now still shows as chosen', async () => {
    host.selected.set('2026-10-10'); // past, e.g. the date a reschedule starts from
    await render();
    expect(cell('2026-10-10').getAttribute('aria-selected')).toBe('true');
    expect(cell('2026-10-10').getAttribute('aria-disabled')).toBe('true');
    expect(q('td[data-date="2026-10-10"] .sd-cal-cell').className).toContain('ring-2');
  });

  it('moves "today" on when the date changes while the page is open', async () => {
    vi.setSystemTime(new Date('2026-10-16T09:00:00Z'));
    document.dispatchEvent(new Event('visibilitychange'));
    await render();
    expect(cell('2026-10-16').getAttribute('aria-current')).toBe('date');
    expect(cell('2026-10-15').getAttribute('aria-current')).toBeNull();
    // Yesterday is past now, though the range (and min) still say otherwise.
    expect(cell('2026-10-15').getAttribute('aria-disabled')).toBe('true');
  });

  it('holds paging forward while a range with no known end loads', async () => {
    const next = q<HTMLButtonElement>('button[aria-label="Next month"]');
    host.max.set(null);
    host.loading.set(true);
    await render();
    expect(next.disabled).toBe(true);
    cell('2026-10-29').focus();
    await key(cell('2026-10-29'), 'PageDown');
    expect(host.month()).toBe('2026-10');

    host.loading.set(false);
    await render();
    expect(next.disabled).toBe(false);
  });
});
