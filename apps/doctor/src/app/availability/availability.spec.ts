import type { Signal, WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { StaffAuthService } from '@supadoc/auth';
import { DoctorApi } from '@supadoc/data-access';
import type {
  AddAvailabilityInput,
  AddAvailabilityResultDto,
  AvailabilitySlotDto,
  BlockAvailabilityInput,
  DoctorAvailabilityDto,
  DoctorProfileDto,
} from '@supadoc/models';
import { DialogService, provideSupadocIcons, type ConfirmOptions } from '@supadoc/ui';
import { firstValueFrom, isObservable, Observable, of, throwError } from 'rxjs';
import { DoctorClock } from '../doctor-clock';
import { addSummary, API_UPDATING_TEXT, DoctorAvailability, ZONE_FAILED_TEXT } from './availability';

/**
 * The editor works on the doctor's PROFILE zone (America/Chicago here, on CST
 * in November): day keys, labels and "today" come from it, every request
 * carries `tz`, and a full-day block is the API's `entire_day`.
 */

/** "Now": Wed 4 Nov 2026, 12:00 PM CST (18:00Z). D is Thursday 5 Nov on the doctor's calendar. */
const NOW = '2026-11-04T18:00:00Z';
const CHICAGO = 'America/Chicago';
const D = '2026-11-05';
const D1 = '2026-11-06';

const SLOTS: AvailabilitySlotDto[] = [
  { id: 's-0900', starts_at: '2026-11-05T15:00:00+00:00', ends_at: '2026-11-05T15:30:00+00:00', kind: 'open', status: 'open', reason: null, series_id: 'ser-1' },
  { id: 's-0830', starts_at: '2026-11-05T14:30:00+00:00', ends_at: '2026-11-05T15:00:00+00:00', kind: 'open', status: 'open', reason: null, series_id: null },
  {
    // A booking with no matching open slot (ListAvailabilityAction's synthetic row).
    id: 'appt-00000000-0000-4000-8000-000000000001',
    starts_at: '2026-11-05T16:00:00+00:00',
    ends_at: '2026-11-05T16:30:00+00:00',
    kind: 'open',
    status: 'booked',
    reason: null,
    patient_name: 'Test Patient',
  },
  {
    // 11:30 PM CST on Thursday is already Friday in UTC: it stays on Thursday here.
    id: 's-2330',
    starts_at: '2026-11-06T05:30:00+00:00',
    ends_at: '2026-11-06T05:45:00+00:00',
    kind: 'open',
    status: 'open',
    reason: null,
  },
  {
    // A full-day block on Friday (the local day's bounds in Chicago).
    id: 'b-full',
    starts_at: '2026-11-06T06:00:00+00:00',
    ends_at: '2026-11-07T06:00:00+00:00',
    kind: 'block',
    status: 'blocked',
    reason: 'Annual leave',
    entire_day: true,
  },
];

interface EditorInternals {
  readonly selectedDate: WritableSignal<string>;
  readonly selectedBlock: Signal<AvailabilitySlotDto | null>;
  readonly calendar: Signal<readonly { date: string }[]>;
  readonly summary: Signal<string>;
  dayState(date: string): 'open' | 'blocked' | 'booked' | 'none';
  openAdd(date: string): void;
  removeSlot(s: AvailabilitySlotDto): Promise<void>;
}

const ADD_RESULT: AddAvailabilityResultDto = {
  created: 6,
  existing: 0,
  overlapping: 0,
  past: 0,
  blocked: 0,
  series_id: null,
  first_at: '2026-11-05T15:00:00+00:00',
  last_at: '2026-11-05T17:30:00+00:00',
  tz: CHICAGO,
  repeat: 'none',
};

describe('DoctorAvailability — on the doctor’s profile zone', () => {
  let fixture: ComponentFixture<DoctorAvailability>;
  let el: HTMLElement;
  let editor: EditorInternals;
  let listCalls: { from?: string; to?: string; tz?: string }[];
  let adds: AddAvailabilityInput[];
  let blocks: BlockAvailabilityInput[];
  let deletes: { id: string; scope: string; tz?: string }[];
  let list: () => Observable<{ data: DoctorAvailabilityDto }>;
  let addAnswer: () => Observable<{ data: AddAvailabilityResultDto }>;
  let profileAnswer: () => Observable<{ data: DoctorProfileDto }>;
  let confirmChoice: 'confirm' | 'secondary';
  let deleteAnswer: ((scope: string) => Observable<unknown>) | null;
  let confirmHook: ((opts: ConfirmOptions) => Promise<{ confirmed: boolean; choice?: string }>) | null;

  function payload(over: Partial<DoctorAvailabilityDto> = {}): DoctorAvailabilityDto {
    return { from: '2026-10-26', to: '2026-12-06', slot_minutes: 30, slots: SLOTS, tz: CHICAGO, regular_hours: null, regular_hours_source: null, ...over };
  }

  async function render() {
    fixture.detectChanges();
    for (let i = 0; i < 4; i++) await Promise.resolve();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  async function setup() {
    listCalls = [];
    adds = [];
    blocks = [];
    deletes = [];
    TestBed.configureTestingModule({
      imports: [DoctorAvailability],
      providers: [
        provideSupadocIcons(),
        { provide: StaffAuthService, useValue: { isAuthenticated: () => true, subject: () => 'doc-1' } },
        {
          provide: DoctorApi,
          useValue: {
            getProfile: () => profileAnswer(),
            setTimeZone: () => of({ data: null }),
            availability: (from?: string, to?: string, tz?: string) => {
              listCalls.push({ from, to, tz });
              return list();
            },
            addAvailability: (input: AddAvailabilityInput) => {
              adds.push(input);
              return addAnswer();
            },
            blockAvailability: (input: BlockAvailabilityInput) => {
              blocks.push(input);
              return of({ data: null });
            },
            deleteAvailability: (id: string, scope = 'one', tz?: string) => {
              deletes.push({ id, scope, tz });
              if (deleteAnswer) return deleteAnswer(scope);
              return of({ data: { deleted: scope === 'following' ? 5 : 1, kept_booked: 0 } });
            },
          },
        },
        {
          provide: DialogService,
          useValue: {
            requests: () => [],
            confirm: async (opts: ConfirmOptions) => {
              if (confirmHook) return confirmHook(opts);
              const run = async (action?: () => Promise<unknown> | Observable<unknown>) => {
                const r = action?.();
                if (isObservable(r)) await firstValueFrom(r);
                else await r;
              };
              if (confirmChoice === 'secondary' && opts.secondary) {
                await run(opts.secondary.action);
                return { confirmed: false, choice: opts.secondary.value };
              }
              await run(opts.action);
              return { confirmed: true };
            },
          },
        },
      ],
    });
    fixture = TestBed.createComponent(DoctorAvailability);
    el = fixture.nativeElement;
    document.body.appendChild(el);
    editor = fixture.componentInstance as unknown as EditorInternals;
    await render();
  }

  async function select(date: string) {
    editor.selectedDate.set(date);
    await render();
  }

  const text = (node: Element | null | undefined) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const dayRows = () =>
    Array.from(el.querySelectorAll('ul.divide-y > li')).map((li) => {
      const spans = li.querySelectorAll(':scope > div:last-child > span');
      return [text(li.querySelector(':scope > div:first-child > span:first-child')), text(spans[spans.length - 1])];
    });
  function cell(date: string): HTMLButtonElement {
    const i = editor.calendar().findIndex((c) => c.date === date);
    const b = el.querySelectorAll<HTMLButtonElement>('.grid-cols-7 > button')[i];
    if (i < 0 || !b) throw new Error(`No calendar cell for ${date}`);
    return b;
  }
  const underline = (date: string) => cell(date).querySelector('span')?.className ?? '';
  const button = (label: string) =>
    Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find((b) => text(b) === label) ?? null;
  const buttonByName = (name: string) =>
    Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.getAttribute('aria-label') === name) ?? null;
  async function click(b: HTMLElement | null) {
    if (!b) throw new Error('No such button');
    b.click();
    await render();
  }
  async function type(input: HTMLInputElement | null, value: string) {
    if (!input) throw new Error('No such input');
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await render();
  }
  async function openAdd(date = D) {
    editor.openAdd(date);
    await render();
  }
  const dateBox = () => el.querySelector<HTMLInputElement>('sd-dialog input[type="date"]');
  const weeksBox = () => el.querySelector<HTMLInputElement>('#add-weeks');
  const save = () => click(button('Save Availability'));

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    confirmChoice = 'confirm';
    deleteAnswer = null;
    confirmHook = null;
    list = () => of({ data: payload() });
    addAnswer = () => of({ data: ADD_RESULT });
    profileAnswer = () =>
      of({ data: { id: 'd1', name: 'Dr Ada Obi', specialty: 'GP', timezone: CHICAGO, timezone_source: 'manual' } as DoctorProfileDto });
  });

  afterEach(() => {
    fixture?.destroy();
    el?.remove();
    vi.useRealTimers();
  });

  it('reads the list in the profile zone and lists the day’s rows by instant, the 11:30 PM row still on that day', async () => {
    await setup();
    expect(listCalls.length).toBe(1);
    expect(listCalls[0].tz).toBe(CHICAGO);
    expect(text(el)).toContain('All times are in your time zone: Central Time (CST).');
    await select(D);
    expect(text(el)).toContain('Thursday, November 5, 2026.');
    expect(dayRows()).toEqual([
      ['8:30 AM - 9:00 AM', 'Open'],
      ['9:00 AM - 9:30 AM', 'Open'],
      ['10:00 AM - 10:30 AM', 'Booked'],
      ['11:30 PM - 11:45 PM', 'Open'],
    ]);
    expect(editor.selectedBlock()).toBeNull();
    // The series row carries a "Repeats" chip.
    expect(text(el.querySelector('ul.divide-y > li:nth-child(2)'))).toContain('Repeats');
  });

  it('keys days on the doctor’s calendar and takes entire_day from the API', async () => {
    await setup();
    await select(D1);
    expect(editor.dayState(D)).toBe('open');
    expect(underline(D)).toContain('bg-sage');
    expect(editor.dayState(D1)).toBe('blocked');
    expect(editor.selectedBlock()?.id).toBe('b-full');
    expect(text(el)).toContain('Blocked - Annual leave');
  });

  it('Every day sends repeat "daily" with the profile zone', async () => {
    await setup();
    await openAdd('2026-11-09');
    await click(button('Recurring'));
    expect(buttonByName('Repeats')).toBeNull(); // a group, not a button
    const daily = Array.from(el.querySelectorAll<HTMLButtonElement>('[aria-label="Repeats"] button'))[0];
    expect(daily.getAttribute('aria-pressed')).toBe('true');
    await save();
    expect(adds).toEqual([
      { date: '2026-11-09', start: '09:00', end: '12:00', duration: 30, tz: CHICAGO, repeat: 'daily', weeks: 8 },
    ]);
  });

  it('shows the live summary', async () => {
    await setup();
    await openAdd('2026-11-09');
    await click(button('Recurring'));
    expect(editor.summary()).toBe('Every day, 9:00 AM – 12:00 PM, Mon 9 Nov → Sun 3 Jan · about 336 times');
    expect(
      addSummary({ repeat: 'none', date: '2026-11-09', start: '09:00', end: '12:00', duration: 30, weeks: 8, days: [] }),
    ).toBe('Mon 9 Nov, 9:00 AM – 12:00 PM · 6 times');
  });

  it('Choose days: chips toggle aria-pressed, and an empty choice blocks Save', async () => {
    await setup();
    await openAdd('2026-11-09');
    await click(button('Recurring'));
    await click(button('Choose days'));
    const monday = buttonByName('Monday');
    expect(monday?.getAttribute('aria-pressed')).toBe('true');
    await click(monday);
    expect(buttonByName('Monday')?.getAttribute('aria-pressed')).toBe('false');
    for (const name of ['Tuesday', 'Wednesday', 'Thursday', 'Friday']) await click(buttonByName(name));
    expect(text(el.querySelector('[role="alert"]'))).toBe('Choose at least one day');
    await save();
    expect(adds.length).toBe(0);

    await click(buttonByName('Saturday'));
    await save();
    expect(adds[0]).toMatchObject({ repeat: 'days', days: [6], tz: CHICAGO });
  });

  it('an empty weeks box is an error, never 0', async () => {
    await setup();
    await openAdd('2026-11-09');
    await click(button('Recurring'));
    await type(weeksBox(), '');
    expect(text(el)).toContain('Choose 1 to 26 weeks');
    await save();
    expect(adds.length).toBe(0);
    await type(weeksBox(), '27');
    expect(text(el)).toContain('Choose 1 to 26 weeks');
  });

  it('refuses a series whose last time is more than 12 months ahead', async () => {
    await setup();
    await openAdd('2026-11-09');
    await click(button('Recurring'));
    expect(dateBox()?.getAttribute('max')).toBe('2027-11-04');
    await type(dateBox(), '2027-10-01');
    await save();
    expect(text(el.querySelector('sd-dialog [role="alert"]'))).toBe('Choose a date within the next 12 months');
    expect(adds.length).toBe(0);
  });

  it('"Until midnight" sends end "24:00"', async () => {
    await setup();
    await openAdd('2026-11-09');
    const until = button('Until midnight');
    await click(until);
    expect(button('Until midnight')?.getAttribute('aria-pressed')).toBe('true');
    await type(el.querySelector<HTMLInputElement>('input[aria-label="Start time"]'), '21:00');
    await save();
    expect(adds[0]).toMatchObject({ start: '21:00', end: '24:00', repeat: 'none', tz: CHICAGO });
  });

  it('says what was added', async () => {
    await setup();
    addAnswer = () =>
      of({
        data: {
          ...ADD_RESULT,
          created: 336,
          blocked: 6,
          repeat: 'daily',
          first_at: '2026-11-09T15:00:00+00:00',
          last_at: '2027-01-03T17:30:00+00:00',
        },
      });
    await openAdd('2026-11-09');
    await click(button('Recurring'));
    await save();
    expect(text(el.querySelector('p[role="status"]'))).toBe(
      "Added 336 times (Mon 9 Nov – Sun 3 Jan). 6 fall on blocked times (they'll open if you remove the block).",
    );
  });

  it('delete sends tz; a repeating time can remove this and later times', async () => {
    await setup();
    const one = SLOTS[1];
    await editor.removeSlot(one);
    expect(deletes).toEqual([{ id: 's-0830', scope: 'one', tz: CHICAGO }]);

    confirmChoice = 'secondary';
    await editor.removeSlot(SLOTS[0]);
    await render();
    expect(deletes[1]).toEqual({ id: 's-0900', scope: 'following', tz: CHICAGO });
    expect(listCalls.length).toBe(2); // reloaded
  });

  it('pressing Remove again after a 409 timezone_changed sends the zone just taken', async () => {
    await setup();
    let calls = 0;
    deleteAnswer = () =>
      ++calls === 1
        ? throwError(() => ({
            status: 409,
            error: { message: 'Your time zone was changed.', errors: { code: 'timezone_changed', timezone: 'Europe/London' } },
          }))
        : of({ data: { deleted: 1, kept_booked: 0 } });
    // The dialog stays open on the error and the doctor presses "Only this time" again.
    confirmHook = async (opts) => {
      const press = () => firstValueFrom(opts.action?.() as Observable<unknown>);
      await press().catch(() => undefined);
      await render();
      await press();
      return { confirmed: true };
    };
    await editor.removeSlot(SLOTS[0]);
    expect(deletes.map((d) => d.tz)).toEqual([CHICAGO, 'Europe/London']);
  });

  it('a zone changed elsewhere (the banner) reads the list again in it', async () => {
    await setup();
    expect(listCalls.map((c) => c.tz)).toEqual([CHICAGO]);
    TestBed.inject(DoctorClock).apply({ timezone: 'Europe/London', timezone_source: 'manual' });
    await render();
    expect(listCalls.map((c) => c.tz)).toEqual([CHICAGO, 'Europe/London']);
    // Its own reload isn't doubled.
    await render();
    expect(listCalls.length).toBe(2);
  });

  it('shows the regular hours on a day with no published times', async () => {
    list = () => of({ data: payload({ regular_hours: { '4': [['09:00', '17:00']] }, regular_hours_source: 'own' }) });
    await setup();
    await select('2026-11-12'); // a Thursday with nothing published
    expect(text(el)).toContain('Regular hours · 9:00 AM – 5:00 PM');
    expect(text(el)).toContain('Patients can book these unless you publish times for this day.');
    await select(D); // Thursday with published times: those, not the regular hours
    expect(text(el)).not.toContain('Regular hours ·');
  });

  it('a failed profile load disables Add, Block and Remove, offers Try again, and sends nothing', async () => {
    profileAnswer = () => throwError(() => new Error('offline'));
    await setup();
    expect(text(el)).toContain(ZONE_FAILED_TEXT);
    expect(button('Try again')).not.toBeNull();
    expect(listCalls.length).toBe(0);
    const block = Array.from(el.querySelectorAll<HTMLButtonElement>('header button')).find((b) => text(b) === 'Block this day');
    expect(block?.disabled).toBe(true);
    editor.openAdd(editor.selectedDate());
    await render();
    expect(el.querySelector('sd-dialog input[type="date"]')).toBeNull();
    await editor.removeSlot(SLOTS[1]);
    expect(deletes.length).toBe(0);

    profileAnswer = () =>
      of({ data: { id: 'd1', name: 'Dr Ada Obi', specialty: 'GP', timezone: CHICAGO, timezone_source: 'manual' } as DoctorProfileDto });
    await click(button('Try again'));
    expect(listCalls.map((c) => c.tz)).toEqual([CHICAGO]);
  });

  it('an API without tz keeps Add and Block off with the update notice', async () => {
    list = () => of({ data: payload({ tz: undefined }) });
    await setup();
    expect(text(el)).toContain(API_UPDATING_TEXT);
    const block = Array.from(el.querySelectorAll<HTMLButtonElement>('header button')).find((b) => text(b) === 'Block this day');
    expect(block?.disabled).toBe(true);
    editor.openAdd(D);
    await render();
    expect(adds.length).toBe(0);
    expect(el.querySelector('sd-dialog input[type="date"]')).toBeNull();
  });

  it('409 timezone_changed: takes the new zone, reloads in it and says so', async () => {
    await setup();
    addAnswer = () =>
      throwError(() => ({
        status: 409,
        error: { message: 'Your time zone was changed. Reload to continue.', errors: { code: 'timezone_changed', timezone: 'Europe/London' } },
      }));
    await openAdd(D);
    await save();
    expect(TestBed.inject(DoctorClock).zone()).toBe('Europe/London');
    expect(listCalls[listCalls.length - 1].tz).toBe('Europe/London');
    expect(text(el)).toContain(
      'Your time zone is now United Kingdom Time (GMT), changed in another window. Check your times and try again.',
    );
  });
});
