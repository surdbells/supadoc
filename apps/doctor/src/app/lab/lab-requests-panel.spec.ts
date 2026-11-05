import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { DoctorApi, LabRequestsApi } from '@supadoc/data-access';
import type { LabOrderDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { of } from 'rxjs';
import { LabRequestsPanel } from './lab-requests-panel';
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

describe('LabRequestsPanel (appointment page)', () => {
  @Component({
    imports: [LabRequestsPanel],
    template: `<doc-lab-requests-panel appointmentId="ap-1" patientId="p1" patientName="Chika Osuji" />`,
  })
  class Host {}

  function setup(legacy: LabOrderDto[] = []) {
    const a = apis(legacy);
    TestBed.configureTestingModule({
      imports: [Host],
      providers: [
        provideRouter([]),
        provideSupadocIcons(),
        { provide: LabRequestsApi, useValue: { list: a.list } },
        { provide: DoctorApi, useValue: { listLabOrders: a.listLabOrders } },
      ],
    });
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    return { el: fixture.nativeElement as HTMLElement, ...a };
  }

  it('"New lab request" opens the composer with the patient and this consultation', () => {
    const { el, list } = setup();
    expect(el.textContent).toContain('Request tests for Chika from this consultation.');
    const link = must(Array.from(el.querySelectorAll('a')).find((a) => a.textContent?.includes('New lab request')), 'element');
    expect(link.getAttribute('href')).toBe('/prescriptions/labs/new?patientId=p1&appointmentId=ap-1');
    expect(list).toHaveBeenCalledWith({ appointment_id: 'ap-1', per_page: 50 });
    const row = must(el.querySelector('a[href="/prescriptions/labs/lr1"]'), 'a[href="/prescriptions/labs/lr1"]');
    expect(row.textContent).toContain('GVM-REQ-20261104-00012');
    expect(row.textContent).toContain('Booked');
    expect(row.textContent).toContain('Troponin I, ECG (12-lead)');
  });

  it('earlier lab orders are listed read-only (no controls), only when there are some', () => {
    const none = setup();
    expect(none.el.textContent).not.toContain('Earlier lab orders');
    TestBed.resetTestingModule();
    const { el } = setup([ORDER]);
    const section = must(el.querySelector('[aria-labelledby="lab-legacy-title"]'), '[aria-labelledby="lab-legacy-title"]');
    expect(section.textContent).toContain('Ordered before lab requests. They can\'t be changed.');
    expect(section.textContent).toContain('Full blood count, Lipid panel');
    expect(section.textContent).toContain('Urgent');
    expect(section.textContent).toContain('Ordered');
    expect(section.querySelectorAll('button, a, input').length).toBe(0);
  });
});
