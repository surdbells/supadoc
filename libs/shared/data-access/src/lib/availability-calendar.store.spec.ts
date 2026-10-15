import { TestBed } from '@angular/core/testing';
import { NEVER, of, throwError } from 'rxjs';
import type { AvailabilityDayStatus, AvailabilityRangeDto, DaySlotsDto } from '@supadoc/models';
import { AvailabilityCalendarStore } from './availability-calendar.store';
import { addDaysYmd, monthGrid } from './date-input';
import { DoctorApi } from './doctor.api';
import { SpecialistsApi } from './specialists.api';

const TZ = 'Africa/Lagos';

/** A range response for a grid, with chosen statuses (everything else closed). */
function range(from: string, to: string, statuses: Record<string, AvailabilityDayStatus> = {}): AvailabilityRangeDto {
  const days = [];
  for (let d = from; d <= to; d = addDaysYmd(d, 1)) {
    const status = statuses[d] ?? 'closed';
    const open = status === 'available' ? 8 : status === 'few' ? 2 : 0;
    days.push({ date: d, status, open, first: open ? `${d}T08:00:00+00:00` : null });
  }
  return {
    tz: TZ,
    today: '2026-10-15',
    bookable_from: '2026-10-15',
    bookable_until: '2026-12-14',
    horizon_days: 60,
    slot_minutes: 30,
    next_available: '2026-10-16T08:00:00+00:00',
    days,
  };
}

function setup(statuses: Record<string, AvailabilityDayStatus> = {}) {
  const availability = vi.fn((_id: string, p: { from: string; to: string; tz?: string }) =>
    of({ status: 'success', message: 'OK', data: range(p.from, p.to, statuses) }),
  );
  const daySlots = vi.fn((_id: string, date: string) =>
    of({
      status: 'success',
      message: 'OK',
      data: { date, tz: TZ, slots: [{ iso: `${date}T08:00:00+00:00`, time: '09:00', label: '9:00 AM', period: 'morning' }] } as DaySlotsDto,
    }),
  );
  TestBed.configureTestingModule({
    providers: [AvailabilityCalendarStore, { provide: SpecialistsApi, useValue: { availability, daySlots } }],
  });
  return { store: TestBed.inject(AvailabilityCalendarStore), availability, daySlots };
}

describe('AvailabilityCalendarStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T09:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('loads the visible 6-week grid in the zone and prefetches the next month', () => {
    const { store, availability } = setup();
    store.load('doc-1', TZ);

    const grid = monthGrid('2026-10', 1);
    expect(store.month()).toBe('2026-10');
    expect(availability).toHaveBeenCalledWith('doc-1', { from: grid[0], to: grid[41], tz: TZ });
    expect(store.days().length).toBe(42);
    expect(store.min()).toBe('2026-10-15');
    expect(store.max()).toBe('2026-12-14');
    expect(store.nextAvailable()).toBe('2026-10-16T08:00:00+00:00');

    const next = monthGrid('2026-11', 1);
    expect(availability).toHaveBeenCalledWith('doc-1', { from: next[0], to: next[41], tz: TZ });
    expect(availability).toHaveBeenCalledTimes(2);

    // The prefetched month shows without another request.
    store.setMonth('2026-11');
    expect(store.range()?.days[0].date).toBe(next[0]);
    expect(availability).toHaveBeenCalledTimes(3); // only December's prefetch
  });

  it('asks for a day’s times only when the calendar says it has some', () => {
    const { store, daySlots } = setup({ '2026-10-16': 'available' });
    store.load('doc-1', TZ);

    store.selectDate('2026-10-17'); // closed
    expect(store.slots()).toEqual([]);
    expect(daySlots).not.toHaveBeenCalled();

    store.selectDate('2026-10-16');
    expect(daySlots).toHaveBeenCalledWith('doc-1', '2026-10-16', TZ);
    expect(store.slots()?.map((s) => s.time)).toEqual(['09:00']);

    // Cached the second time.
    store.selectDate('2026-10-16');
    expect(daySlots).toHaveBeenCalledTimes(1);
  });

  it('jumps to the next opening, and refresh() reloads after a time was taken', () => {
    const { store, availability, daySlots } = setup({ '2026-10-16': 'few' });
    store.load('doc-1', TZ);
    store.jumpToNext();
    expect(store.selectedDate()).toBe('2026-10-16');
    expect(daySlots).toHaveBeenCalledTimes(1);

    const calls = availability.mock.calls.length;
    store.refresh();
    expect(availability.mock.calls.length).toBeGreaterThan(calls);
    expect(daySlots).toHaveBeenCalledTimes(2);
    expect(store.slots()?.length).toBe(1);
  });

  it('jumpToNext(day) from the calendar never re-picks the day already picked', () => {
    const { store, daySlots } = setup({ '2026-10-16': 'few' });
    store.load('doc-1', TZ);
    store.selectDate('2026-10-16');
    expect(daySlots).toHaveBeenCalledTimes(1);

    store.jumpToNext('2026-10-16'); // the calendar already moved there
    store.jumpToNext(); // nextAvailable is that same day
    expect(daySlots).toHaveBeenCalledTimes(1);

    store.jumpToNext('2026-10-20');
    expect(store.selectedDate()).toBe('2026-10-20');
  });

  it('knows the first opening after a picked day — never one before it', () => {
    const { store } = setup({ '2026-10-16': 'available', '2026-10-20': 'few', '2026-11-20': 'available' });
    store.load('doc-1', TZ);
    expect(store.nextAfterSelected()).toBeNull(); // nothing picked

    store.selectDate('2026-10-15');
    expect(store.nextAfterSelected()).toBe('2026-10-16T08:00:00+00:00'); // the first opening at all
    store.selectDate('2026-10-17');
    expect(store.nextAfterSelected()).toBe('2026-10-20T08:00:00+00:00'); // not Fri 16, before it
    store.selectDate('2026-11-05');
    expect(store.nextAfterSelected()).toBe('2026-11-20T08:00:00+00:00'); // from the prefetched month
    store.selectDate('2026-11-25');
    expect(store.nextAfterSelected()).toBeNull(); // none known later
  });

  it('keeps max and nextAvailable while another month loads', () => {
    const { store, availability } = setup();
    store.load('doc-1', TZ);
    availability.mockImplementation(() => NEVER);
    store.setMonth('2027-02');
    expect(store.loading()).toBe(true);
    expect(store.range()).toBeNull();
    expect(store.max()).toBe('2026-12-14');
    expect(store.nextAvailable()).toBe('2026-10-16T08:00:00+00:00');
  });

  it('a date outside the grid moves the calendar to its month', () => {
    const { store } = setup();
    store.load('doc-1', TZ);
    store.selectDate('2026-12-03');
    expect(store.month()).toBe('2026-12');
  });

  it('shows a message when the calendar cannot load', () => {
    TestBed.configureTestingModule({
      providers: [
        AvailabilityCalendarStore,
        {
          provide: SpecialistsApi,
          useValue: { availability: () => throwError(() => ({ status: 0 })), daySlots: vi.fn() },
        },
      ],
    });
    const store = TestBed.inject(AvailabilityCalendarStore);
    store.load('doc-1', TZ);
    expect(store.loading()).toBe(false);
    expect(store.error()).toBeTruthy();
    expect(store.days()).toEqual([]);
  });

  it('drops a day’s failure once times load, or a cached month shows', () => {
    const { store, daySlots } = setup({ '2026-10-16': 'available', '2026-10-19': 'available' });
    store.load('doc-1', TZ);
    daySlots.mockImplementationOnce(() => throwError(() => ({ status: 0 })));
    store.selectDate('2026-10-16');
    expect(store.error()).toBeTruthy();

    store.selectDate('2026-10-19');
    expect(store.error()).toBeNull();
    expect(store.slots()?.length).toBe(1);

    daySlots.mockImplementationOnce(() => throwError(() => ({ status: 0 })));
    store.refresh();
    expect(store.error()).toBeTruthy();
    store.setMonth('2026-11'); // prefetched: shows from the cache
    expect(store.error()).toBeNull();
  });

  it('takes the zone the server used when it did not know the one asked for', () => {
    const { store, availability, daySlots } = setup({ '2026-10-16': 'available' });
    store.load('doc-1', 'Mars/Olympus_Mons');
    expect(store.tz()).toBe(TZ); // the mock answers in Lagos time, like the API's fallback
    expect(availability).toHaveBeenLastCalledWith('doc-1', expect.objectContaining({ tz: TZ })); // the prefetch
    store.selectDate('2026-10-16');
    expect(daySlots).toHaveBeenCalledWith('doc-1', '2026-10-16', TZ);

    // Loading the same doctor and zone again keeps what is there.
    const calls = availability.mock.calls.length;
    store.load('doc-1', 'Mars/Olympus_Mons');
    expect(availability.mock.calls.length).toBe(calls);
  });

  it('reads the doctor’s own or the staff calendar for those scopes', () => {
    const data = range('2026-09-28', '2026-11-08', { '2026-10-16': 'available' });
    const slots = { date: '2026-10-16', tz: TZ, slots: [] } as DaySlotsDto;
    const doctor = {
      calendar: vi.fn(() => of({ status: 'success', message: 'OK', data })),
      calendarSlots: vi.fn(() => of({ status: 'success', message: 'OK', data: slots })),
    };
    const specialists = {
      availability: vi.fn(),
      daySlots: vi.fn(),
      staffAvailability: vi.fn(() => of({ status: 'success', message: 'OK', data })),
      staffDaySlots: vi.fn(() => of({ status: 'success', message: 'OK', data: slots })),
    };
    TestBed.configureTestingModule({
      providers: [
        AvailabilityCalendarStore,
        { provide: SpecialistsApi, useValue: specialists },
        { provide: DoctorApi, useValue: doctor },
      ],
    });
    const store = TestBed.inject(AvailabilityCalendarStore);

    store.load('me', TZ, { scope: 'doctor' });
    store.selectDate('2026-10-16');
    expect(doctor.calendar).toHaveBeenCalledWith(expect.objectContaining({ tz: TZ }));
    expect(doctor.calendarSlots).toHaveBeenCalledWith('2026-10-16', TZ);

    store.load('doc-1', TZ, { scope: 'staff' });
    store.selectDate('2026-10-16');
    expect(specialists.staffAvailability).toHaveBeenCalledWith('doc-1', expect.objectContaining({ tz: TZ }));
    expect(specialists.staffDaySlots).toHaveBeenCalledWith('doc-1', '2026-10-16', TZ);
    expect(specialists.availability).not.toHaveBeenCalled();
    expect(specialists.daySlots).not.toHaveBeenCalled();
  });
});
