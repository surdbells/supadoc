import { ApplicationRef } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { API_CONFIG, ApiService, DoctorApi, ymdInZone } from '@supadoc/data-access';
import type { AppointmentDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { of } from 'rxjs';
import { DoctorClock } from '../doctor-clock';
import { FollowUpPlanner } from './follow-up-planner';

const PROPOSAL = {
  id: 'f1',
  patient_id: 'p1',
  specialist: { id: 'd1', name: 'Dr Ada Obi' },
  scheduled_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  expires_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
  type: 'video',
  type_label: 'Video follow-up',
  status: 'proposed',
  status_label: 'Proposed',
  amount: '0',
  proposed_by: 'doctor',
  created_at: '2026-11-01T10:00:00Z',
  notes: 'Persistent cough at night',
} as unknown as AppointmentDto;

let fixture: ComponentFixture<FollowUpPlanner>;
let el: HTMLElement;

/** The doctor's calendar as the API answers it: days grouped, and "today", in the zone asked for. */
function calendarIn(params: { from: string; to: string; tz: string }) {
  return of({
    data: {
      tz: params.tz,
      today: ymdInZone(new Date(), params.tz),
      bookable_from: ymdInZone(new Date(), params.tz),
      bookable_until: '2027-11-30',
      horizon_days: 365,
      slot_minutes: 30,
      // An opening on the 20th, so the calendar shows (with nothing open the typed time shows instead).
      next_available: '2026-11-20T09:00:00Z',
      days: [{ date: '2026-11-20', status: 'available', open: 4, first: '2026-11-20T09:00:00Z' }],
    },
  });
}

function setup(inputs: { linkRecord?: boolean; proposal?: AppointmentDto; proposals?: AppointmentDto[]; zone?: string } = {}) {
  const proposal = inputs.proposal ?? PROPOSAL;
  const list = inputs.proposals ?? [proposal];
  TestBed.configureTestingModule({
    imports: [FollowUpPlanner],
    providers: [
      provideRouter([]),
      provideSupadocIcons(),
      // The availability calendar's reads (nothing here looks at them).
      { provide: API_CONFIG, useValue: { baseUrl: 'http://api.test' } },
      { provide: ApiService, useValue: { get: () => of({ data: [] }), request: () => of({ data: [] }) } },
      {
        provide: DoctorApi,
        useValue: new Proxy(
          {
            followUps: () => of({ data: list }),
            listFollowUps: () => of({ data: list }),
            getProfile: () => of({ data: { id: 'd', name: 'Dr', timezone: 'Africa/Lagos', timezone_source: 'manual' } }),
            calendar: calendarIn,
          } as Record<string, unknown>,
          { get: (t, k: string) => t[k] ?? (() => of({ data: [] })) },
        ),
      },
    ],
  });
  if (inputs.zone) TestBed.inject(DoctorClock).apply({ timezone: inputs.zone });
  fixture = TestBed.createComponent(FollowUpPlanner);
  fixture.componentRef.setInput('appointmentId', 'ap-1');
  fixture.componentRef.setInput('parentStatus', 'confirmed');
  fixture.componentRef.setInput('parentScheduledAt', '2026-11-01T10:00:00Z');
  fixture.componentRef.setInput('active', true);
  if (inputs.linkRecord !== undefined) fixture.componentRef.setInput('linkRecord', inputs.linkRecord);
  el = fixture.nativeElement;
  document.body.appendChild(el);
  fixture.detectChanges();
  TestBed.inject(ApplicationRef).tick();
  fixture.detectChanges();
}

function teardown() {
  fixture?.destroy();
  el?.remove();
  vi.unstubAllGlobals();
}

describe('FollowUpPlanner: Esc in the withdraw confirm', () => {
  beforeEach(() => vi.stubGlobal('CSS', { escape: (id: string) => id }));
  afterEach(teardown);

  it('closes the confirm (the proposal kept) and prevents the default, so a modal around it stays open', () => {
    setup();
    const withdraw = Array.from(el.querySelectorAll('button')).find((b) => /withdraw/i.test(b.textContent ?? ''));
    expect(withdraw).toBeTruthy();
    withdraw?.click();
    fixture.detectChanges();
    const group = el.querySelector('[role="group"]');
    expect(group?.textContent).toContain('Withdraw this proposal?');
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    group?.querySelector('p')?.dispatchEvent(ev);
    fixture.detectChanges();
    expect(ev.defaultPrevented).toBe(true);
    expect(el.querySelector('[role="group"]')?.textContent ?? '').not.toContain('Withdraw this proposal?');
  });
});

describe('FollowUpPlanner: the record link (LD6)', () => {
  beforeEach(() => vi.stubGlobal('CSS', { escape: (id: string) => id }));
  afterEach(teardown);

  const row = () => el.querySelector('ul > li') as HTMLElement;
  /** The row's own Withdraw (not the confirm step's "Withdraw proposal"). */
  const withdrawButton = () => Array.from(row().querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Withdraw');

  it('by default (the standalone pages) each row has "Open record": a same-tab router link, no new-tab icon', () => {
    setup();
    const links = Array.from(el.querySelectorAll('a'));
    expect(links).toHaveLength(1);
    expect(links[0].textContent?.trim()).toBe('Open record');
    expect(links[0].getAttribute('href')).toBe('/appointments/f1');
    expect(links[0].hasAttribute('target')).toBe(false);
    expect(links[0].querySelector('sd-icon[name="chevron-right"]')).not.toBeNull();
    expect(el.querySelector('a[target="_blank"], sd-icon[name="external-link"]')).toBeNull();
    // The record holds the type and the reason: the row does not repeat them.
    expect(row().textContent).not.toContain('Reason for consultation');
    expect(row().textContent).not.toContain('Video follow-up');
  });

  it('in the call (linkRecord false): no link at all; the visit type and the reason show in the row; Withdraw still confirms', () => {
    setup({ linkRecord: false });
    expect(el.querySelectorAll('a')).toHaveLength(0);
    expect(row().querySelector('sd-icon[name="video"]')?.parentElement?.textContent?.trim()).toBe('Video follow-up');
    const reason = Array.from(row().querySelectorAll('p')).find((p) => p.textContent?.includes('Reason for consultation:'));
    expect(reason?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Reason for consultation: Persistent cough at night');
    expect(withdrawButton()).toBeDefined();
    withdrawButton()?.click();
    fixture.detectChanges();
    expect(el.querySelector('[role="group"]')?.textContent).toContain('Withdraw this proposal?');
    // With no link and the confirm step open, the actions row has nothing to hold and is not rendered.
    expect(withdrawButton()).toBeUndefined();
    expect(Array.from(row().children).filter((c) => c.className === 'flex flex-wrap gap-2')).toHaveLength(0);
  });

  it('in the call, a follow-up without a reason shows no reason line', () => {
    setup({ linkRecord: false, proposal: { ...PROPOSAL, notes: null } as unknown as AppointmentDto });
    expect(row().textContent).toContain('Video follow-up');
    expect(row().textContent).not.toContain('Reason for consultation');
  });
});

describe("FollowUpPlanner: the calendar's today is on the doctor's clock", () => {
  beforeEach(() => {
    vi.stubGlobal('CSS', { escape: (id: string) => id });
    // 00:30 on the 12th in Lagos (WAT); still the 11th in Chicago (17:30 CST).
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-11T23:30:00Z') });
  });
  afterEach(() => {
    teardown();
    vi.useRealTimers();
  });

  const caption = () => Array.from(el.querySelectorAll('sd-booking-calendar p')).find((p) => p.textContent?.includes('Times in'))?.textContent?.replace(/\s+/g, ' ').trim();
  const today = () => el.querySelector('sd-booking-calendar td[aria-current="date"]')?.getAttribute('data-date');
  const disabled = (date: string) => el.querySelector(`sd-booking-calendar td[data-date="${date}"]`)?.getAttribute('aria-disabled');
  const render = () => {
    fixture.detectChanges();
    TestBed.inject(ApplicationRef).tick();
    fixture.detectChanges();
  };

  it('in WAT just past midnight: "Times in WAT", the 12th is today and the 11th past', () => {
    setup({ zone: 'Africa/Lagos', proposals: [] });
    expect(caption()).toBe('Times in WAT');
    expect(today()).toBe('2026-11-12');
    expect(disabled('2026-11-11')).toBe('true');
  });

  it('a zone that arrives after the first read (the profile loads late) re-reads the calendar in it', () => {
    setup({ zone: 'America/Chicago', proposals: [] });
    expect(caption()).toBe('Times in CST');
    expect(today()).toBe('2026-11-11');
    TestBed.inject(DoctorClock).apply({ timezone: 'Africa/Lagos' });
    render();
    expect(caption()).toBe('Times in WAT');
    expect(today()).toBe('2026-11-12');
    expect(disabled('2026-11-11')).toBe('true');
  });
});

describe('FollowUpPlanner: a repeated error is announced again', () => {
  beforeEach(() => vi.stubGlobal('CSS', { escape: (id: string) => id }));
  afterEach(teardown);

  const propose = () => {
    const btn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Propose follow-up'));
    if (!btn) throw new Error('No "Propose follow-up" button');
    btn.click();
    fixture.detectChanges();
  };
  const whenError = () => el.querySelector('p[role="alert"][id$="-when-error"]');

  it('Propose twice with no time: the same words in a new alert element, one at a time', () => {
    setup({ proposals: [] });
    propose();
    const first = whenError();
    expect(first?.textContent?.trim()).toBe('Pick a day, then one of its open times.');
    // The deep red (alert-ink): 6.4:1 on the call's glacier paper, where the brand red was 4.1.
    expect(first?.classList.contains('text-alert-ink')).toBe(true);
    propose();
    const second = whenError();
    expect(second?.textContent?.trim()).toBe('Pick a day, then one of its open times.');
    expect(second).not.toBe(first);
    expect(el.querySelectorAll('p[role="alert"][id$="-when-error"]')).toHaveLength(1);
  });
});
