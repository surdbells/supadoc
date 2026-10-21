import type { Signal, WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DoctorApi } from '@supadoc/data-access';
import type {
  AvailabilitySlotDto,
  DoctorAvailabilityDto,
  SuccessResponse,
} from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { of } from 'rxjs';
import { DoctorAvailability } from './availability';

/**
 * The API ↔ editor contract of the clock fix: every row of
 * GET /api/doctor/availability carries `starts_at` / `ends_at` as DATE_ATOM in
 * UTC ("…+00:00"), whatever the API box's php.ini zone. The editor works in UTC
 * wall-clock and reads those strings directly (day = chars 0–10, a full-day
 * block starts at "00:00"), so it shows the times the doctor entered.
 */

/** "Now" for these tests: 21 Oct 2026, noon UTC. D is the next UTC day. */
const NOW = '2026-10-21T12:00:00Z';
const D = '2026-10-22';
const D1 = '2026-10-23';
const D2 = '2026-10-24';

/** The post-release shape: UTC instants only, deliberately out of order. */
const SLOTS: AvailabilitySlotDto[] = [
  {
    id: 's-0900',
    starts_at: `${D}T09:00:00+00:00`,
    ends_at: `${D}T09:30:00+00:00`,
    kind: 'open',
    status: 'open',
    reason: null,
  },
  {
    id: 's-0830',
    starts_at: `${D}T08:30:00+00:00`,
    ends_at: `${D}T09:00:00+00:00`,
    kind: 'open',
    status: 'open',
    reason: null,
  },
  {
    // A booking with no matching open slot (ListAvailabilityAction's synthetic row).
    id: 'appt-00000000-0000-4000-8000-000000000001',
    starts_at: `${D}T10:00:00+00:00`,
    ends_at: `${D}T10:30:00+00:00`,
    kind: 'open',
    status: 'booked',
    reason: null,
    patient_name: 'Test Patient',
  },
  {
    // Late in the UTC day: still on D, never pushed to the next day.
    id: 's-2330',
    starts_at: `${D}T23:30:00+00:00`,
    ends_at: `${D}T23:45:00+00:00`,
    kind: 'open',
    status: 'open',
    reason: null,
  },
  {
    // A full-day block on D+1 (BlockAvailabilityAction, entire_day).
    id: 'b-full',
    starts_at: `${D1}T00:00:00+00:00`,
    ends_at: `${D2}T00:00:00+00:00`,
    kind: 'block',
    status: 'blocked',
    reason: 'Annual leave',
  },
];

/** The editor's protected state, read through a typed cast. */
interface EditorInternals {
  readonly selectedDate: WritableSignal<string>;
  readonly selectedBlock: Signal<AvailabilitySlotDto | null>;
  readonly calendar: Signal<readonly { date: string }[]>;
  dayState(date: string): 'open' | 'blocked' | 'booked' | 'none';
}

describe('DoctorAvailability — UTC rows from the API (clock fix contract)', () => {
  let fixture: ComponentFixture<DoctorAvailability>;
  let el: HTMLElement;
  let editor: EditorInternals;

  /** The API stub answers synchronously; `whenStable()` would wait on the editor's 30 s clock tick. */
  async function render() {
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();
  }

  async function setup() {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    const payload: SuccessResponse<DoctorAvailabilityDto> = {
      status: 'success',
      message: 'OK',
      data: {
        from: '2026-09-28',
        to: '2026-11-08',
        slot_minutes: 30,
        slots: SLOTS,
      },
    };
    TestBed.configureTestingModule({
      imports: [DoctorAvailability],
      providers: [
        provideSupadocIcons(),
        { provide: DoctorApi, useValue: { availability: () => of(payload) } },
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

  /** Whitespace-normalised text (Intl may put U+202F before AM/PM). */
  const text = (node: Element | null | undefined) =>
    (node?.textContent ?? '').replace(/\s+/g, ' ').trim();

  /** The day panel's rows: [time range, status label]. */
  const dayRows = () =>
    Array.from(el.querySelectorAll('ul.divide-y > li')).map((li) => [
      text(li.querySelector(':scope > div:first-child > span:first-child')),
      text(li.querySelector(':scope > div:last-child > span')),
    ]);

  /** The month grid's button for a UTC date. */
  function cell(date: string): HTMLButtonElement {
    const i = editor.calendar().findIndex((c) => c.date === date);
    const b = el.querySelectorAll<HTMLButtonElement>('.grid-cols-7 > button')[
      i
    ];
    if (i < 0 || !b) throw new Error(`No calendar cell for ${date}`);
    return b;
  }
  /** A day's underline colour (shown while another day is selected). */
  const underline = (date: string) =>
    cell(date).querySelector('span')?.className ?? '';

  afterEach(() => {
    fixture?.destroy();
    el?.remove();
    vi.useRealTimers();
  });

  it('lists the day’s rows by instant with UTC labels, the 11:30 PM row still on that day', async () => {
    await setup();
    await select(D);

    expect(text(el)).toContain('Thursday, October 22, 2026.');
    expect(dayRows()).toEqual([
      ['8:30 AM - 9:00 AM', 'Open'],
      ['9:00 AM - 9:30 AM', 'Open'],
      ['10:00 AM - 10:30 AM', 'Booked'],
      ['11:30 PM - 11:45 PM', 'Open'],
    ]);
    expect(editor.selectedBlock()).toBeNull();
  });

  it('marks the day’s calendar cell open', async () => {
    await setup();
    await select(D1);

    expect(editor.dayState(D)).toBe('open');
    expect(underline(D)).toContain('bg-sage');
    // The 23:30 row did not spill into the next day's counts.
    expect(editor.dayState(D1)).toBe('blocked');
  });

  it('recognises the full-day block on the next day and renders the blocked-day panel', async () => {
    await setup();
    await select(D1);

    expect(editor.selectedBlock()?.id).toBe('b-full');
    expect(text(el)).toContain('Blocked - Annual leave');
    expect(text(el)).toContain('Remove block');
    expect(el.querySelector('ul.divide-y')).toBeNull();

    await select(D);
    expect(editor.dayState(D1)).toBe('blocked');
    expect(underline(D1)).toContain('bg-alert');
  });
});
