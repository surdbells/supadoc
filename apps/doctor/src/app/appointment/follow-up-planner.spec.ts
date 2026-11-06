import { ApplicationRef } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { API_CONFIG, ApiService, DoctorApi } from '@supadoc/data-access';
import type { AppointmentDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { of } from 'rxjs';
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
} as unknown as AppointmentDto;

describe('FollowUpPlanner: Esc in the withdraw confirm', () => {
  let fixture: ComponentFixture<FollowUpPlanner>;
  let el: HTMLElement;

  function setup() {
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
              followUps: () => of({ data: [PROPOSAL] }),
              listFollowUps: () => of({ data: [PROPOSAL] }),
              getProfile: () => of({ data: { id: 'd', name: 'Dr', timezone: 'Africa/Lagos', timezone_source: 'manual' } }),
            } as Record<string, unknown>,
            { get: (t, k: string) => t[k] ?? (() => of({ data: [] })) },
          ),
        },
      ],
    });
    fixture = TestBed.createComponent(FollowUpPlanner);
    fixture.componentRef.setInput('appointmentId', 'ap-1');
    fixture.componentRef.setInput('parentStatus', 'confirmed');
    fixture.componentRef.setInput('parentScheduledAt', '2026-11-01T10:00:00Z');
    fixture.componentRef.setInput('active', true);
    el = fixture.nativeElement;
    document.body.appendChild(el);
    fixture.detectChanges();
    TestBed.inject(ApplicationRef).tick();
    fixture.detectChanges();
  }

  beforeEach(() => vi.stubGlobal('CSS', { escape: (id: string) => id }));

  afterEach(() => {
    fixture?.destroy();
    el?.remove();
    vi.unstubAllGlobals();
  });

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
