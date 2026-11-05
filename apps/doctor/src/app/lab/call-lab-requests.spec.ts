import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { DoctorApi, LabRequestsApi } from '@supadoc/data-access';
import type { LabOrderDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { of } from 'rxjs';
import { CALL_LAB_CAPTION, CALL_LAB_CAPTION_NARROW, CallLabRequests } from './call-lab-requests';
import { labSummary, must } from './testing/lab-fixtures';

const ORDER: LabOrderDto = {
  id: 'o1',
  appointment_id: 'ap-1',
  tests: ['Full blood count', 'Lipid panel'],
  instructions: null,
  priority: 'urgent',
  status: 'ordered',
  author: 'Dr. James Smith',
  created_at: '2026-10-01T10:00:00Z',
};

function apis(legacy: LabOrderDto[] = []) {
  const list = vi.fn(() =>
    of({
      status: 'success',
      message: 'OK',
      data: [labSummary({ appointment_id: 'ap-1', status: 'booked' })],
      meta: { total: 1, page: 1, per_page: 50, total_pages: 1, counts: { all: 1, awaiting_patient: 0, in_progress: 1, result_ready: 0 } },
    }),
  );
  const listLabOrders = vi.fn(() => of({ data: legacy }));
  return { list, listLabOrders };
}

describe('CallLabRequests (in-call tab)', () => {
  @Component({
    imports: [CallLabRequests],
    template: `<doc-call-lab-requests [appointmentId]="aid()" [patientId]="pid()" [signedIn]="signedIn()" [narrow]="narrow()" tone="dark" />`,
  })
  class Host {
    readonly aid = signal<string | null>('ap-1');
    readonly pid = signal<string | null>('p 1');
    readonly signedIn = signal(true);
    readonly narrow = signal(false);
  }

  function setup(legacy: LabOrderDto[] = []) {
    const a = apis(legacy);
    TestBed.configureTestingModule({
      imports: [Host],
      providers: [
        provideSupadocIcons(),
        { provide: LabRequestsApi, useValue: { list: a.list } },
        { provide: DoctorApi, useValue: { listLabOrders: a.listLabOrders } },
      ],
    });
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    return { fixture, host: fixture.componentInstance, el: fixture.nativeElement as HTMLElement, ...a };
  }

  afterEach(() => vi.restoreAllMocks());

  it('"New lab request" opens the composer in a new tab (same-origin path, noopener); the call tab stays', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const { el } = setup();
    const btn = must(Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('New lab request')), 'element');
    btn.click();
    expect(open).toHaveBeenCalledWith('/prescriptions/labs/new?patientId=p%201&appointmentId=ap-1', '_blank', 'noopener');
    must(Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Open'), 'element').click();
    expect(open).toHaveBeenLastCalledWith('/prescriptions/labs/lr1', '_blank', 'noopener');
  });

  it('the caption warns about a paused video only in the narrow layout', () => {
    const { el, fixture, host } = setup();
    expect(el.textContent).toContain(CALL_LAB_CAPTION);
    expect(el.textContent).not.toContain('video may pause');
    host.narrow.set(true);
    fixture.detectChanges();
    expect(el.textContent).toContain(CALL_LAB_CAPTION_NARROW);
  });

  it('while the patient is loading the button waits', () => {
    const { el, fixture, host } = setup();
    host.pid.set(null);
    fixture.detectChanges();
    expect(el.textContent).toContain('Loading the patient…');
    expect(must(Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('New lab request')), 'element').disabled).toBe(true);
  });

  it('signed out: asks to sign in, loads nothing', () => {
    const { el, fixture, host, list } = setup();
    host.signedIn.set(false);
    fixture.detectChanges();
    expect(el.textContent).toContain('Sign in to the doctor portal to request tests.');
    expect(Array.from(el.querySelectorAll('button')).some((b) => b.textContent?.includes('New lab request'))).toBe(false);
    list.mockClear();
    window.dispatchEvent(new Event('focus'));
    expect(list).not.toHaveBeenCalled();
  });

  it('refreshes when the doctor comes back to this tab, and on Refresh; lists legacy orders read-only', () => {
    const { el, list } = setup([ORDER]);
    expect(list).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('focus'));
    expect(list).toHaveBeenCalledTimes(2);
    must(Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Refresh'), 'Refresh').click();
    expect(list).toHaveBeenCalledTimes(3);
    expect(el.textContent).toContain('Earlier lab orders');
    expect(el.textContent).toContain('Full blood count, Lipid panel');
  });
});
