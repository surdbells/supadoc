import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { API_CONFIG, CLINIC_TIME_ZONE, todayInZone } from '@supadoc/data-access';
import type { AdminLabRequestSummaryDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { LAB_STATUS_COPY, LabStatusDialog } from './lab-status-dialog';

const BASE = 'http://api.test';

function row(over: Partial<AdminLabRequestSummaryDto> = {}): AdminLabRequestSummaryDto {
  return {
    id: 'lab-1',
    number: 'GVM-REQ-20261104-00012',
    status: 'booked',
    priority: 'urgent',
    doctor_name: 'Dr. James Smith',
    items_count: 2,
    results_count: 0,
    sent_at: '2026-11-04T15:30:00Z',
    last_activity_at: '2026-11-04T16:00:00Z',
    corrections: ['in_lab'],
    consented_on: '2026-11-04',
    last_correction_note: null,
    ...over,
  };
}

@Component({
  imports: [LabStatusDialog],
  template: `
    <bo-lab-status-dialog
      [open]="open()"
      [request]="request()"
      (closed)="open.set(false); closedCount = closedCount + 1"
      (corrected)="corrected.push($event); open.set(false)"
      (conflict)="conflicts = conflicts + 1"
    />
  `,
})
class HostComponent {
  readonly open = signal(false);
  readonly request = signal<AdminLabRequestSummaryDto | null>(row());
  readonly corrected: AdminLabRequestSummaryDto[] = [];
  conflicts = 0;
  closedCount = 0;
}

describe('LabStatusDialog', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;
  let el: HTMLElement;
  let http: HttpTestingController;

  const tick = () => new Promise((resolve) => setTimeout(resolve));
  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const text = () => el.textContent?.replace(/\s+/g, ' ') ?? '';
  /** Opens the dialog on a row (closing it first if it is open, as the page does). */
  const openWith = async (r: AdminLabRequestSummaryDto) => {
    if (host.open()) {
      host.open.set(false);
      await render();
      await tick();
    }
    host.request.set(r);
    host.open.set(true);
    await render();
    await tick();
    await render();
  };
  const submit = async () => {
    el.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await render();
    await tick();
    await render();
  };
  const typeInto = async (selector: string, value: string) => {
    const field = el.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
    if (!field) throw new Error(`No ${selector}`);
    field.value = value;
    field.dispatchEvent(new Event('input'));
    await render();
  };
  const radios = () => Array.from(el.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
  const dateField = () => el.querySelector<HTMLInputElement>('input[type="date"]');
  const expectCorrect = (): TestRequest =>
    http.expectOne((r) => r.method === 'POST' && r.url === `${BASE}/api/admin/lab-requests/lab-1/status`);

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideSupadocIcons(),
        { provide: API_CONFIG, useValue: { baseUrl: BASE } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    el = fixture.nativeElement;
    document.body.appendChild(el);
    http = TestBed.inject(HttpTestingController);
    await render();
  });

  afterEach(() => {
    http.verify();
    el.remove();
  });

  it('titles the dialog with the number and the current status, and offers the allowed target', async () => {
    await openWith(row());
    expect(text()).toContain('Correct lab request status');
    expect(text()).toContain('GVM-REQ-20261104-00012 · now Booked');
    expect(el.querySelector('legend')?.textContent).toContain('New status');
    expect(radios().length).toBe(1);
    expect(radios()[0].value).toBe('in_lab');
    expect(radios()[0].checked).toBe(true);
    expect(radios()[0].closest('label')?.textContent).toContain('In Lab (sample given)');
    expect(text()).toContain('Change status');
    expect(text()).toContain('Cancel');
  });

  it('labels each target as the spec says', async () => {
    await openWith(row({ status: 'in_lab', corrections: ['booked'] }));
    expect(radios()[0].closest('label')?.textContent?.trim()).toBe('Booked');
    await openWith(row({ status: 'declined', corrections: ['awaiting_consent'], consented_on: null }));
    expect(radios()[0].closest('label')?.textContent?.trim()).toBe('Awaiting Consent (reopen)');
  });

  it('asks for the sample date only for In Lab, bounded by the consent date and clinic today', async () => {
    await openWith(row());
    const date = dateField();
    expect(date).not.toBeNull();
    expect(el.querySelector(`label[for="${date?.id}"]`)?.textContent).toContain('Date the sample was taken (optional)');
    expect(date?.getAttribute('min')).toBe('2026-11-04');
    expect(date?.getAttribute('max')).toBe(todayInZone(CLINIC_TIME_ZONE));
    expect(text()).toContain('Leave empty to use today.');
    expect(date?.getAttribute('aria-describedby')).toContain('-sample-hint');

    // Booked (C2), reopen (C3/C4): no date.
    await openWith(row({ status: 'in_lab', corrections: ['booked'] }));
    expect(dateField()).toBeNull();
    expect(text()).not.toContain('Date the sample was taken');
    await openWith(row({ status: 'expired', corrections: ['booked'] }));
    expect(dateField()).toBeNull();
  });

  it('shows the reason helper, and the reopen note only when reopening a declined or expired request', async () => {
    await openWith(row());
    expect(text()).toContain(LAB_STATUS_COPY.reasonHelper);
    expect(text()).toContain(
      'Kept with the request, visible only to staff who manage lab requests. The doctor sees that VideoMed support changed it, not your reason.',
    );
    expect(text()).not.toContain('The patient gets a notice that the request is open again.');

    await openWith(row({ status: 'in_lab', corrections: ['booked'] }));
    expect(text()).not.toContain('open again');

    await openWith(row({ status: 'declined', corrections: ['awaiting_consent'], consented_on: null }));
    expect(text()).toContain('The patient gets a notice that the request is open again.');

    await openWith(row({ status: 'expired', corrections: ['booked'] }));
    expect(text()).toContain('The patient gets a notice that the request is open again.');

    await openWith(row({ status: 'expired', corrections: ['awaiting_consent'], consented_on: null }));
    expect(text()).toContain('The patient gets a notice that the request is open again.');
  });

  it('requires a reason of at least 5 characters before sending anything', async () => {
    await openWith(row());
    await typeInto('textarea', 'abc');
    await submit();
    http.expectNone(() => true);
    const reason = el.querySelector('textarea');
    expect(reason?.getAttribute('aria-invalid')).toBe('true');
    expect(text()).toContain('Add a reason (at least 5 characters)');
    expect(reason?.getAttribute('maxlength')).toBe('500');
    expect(reason?.getAttribute('aria-describedby')).toContain('-reason-error');
  });

  it('refuses a sample date before the consent date (or after today) on the client', async () => {
    await openWith(row());
    await typeInto('textarea', 'Patient phoned support');
    await typeInto('input[type="date"]', '2026-11-01');
    await submit();
    http.expectNone(() => true);
    expect(dateField()?.getAttribute('aria-invalid')).toBe('true');
    expect(text()).toContain('Choose a date between 4 Nov 2026 and today');

    await typeInto('input[type="date"]', '2999-01-01');
    await submit();
    http.expectNone(() => true);
    expect(text()).toContain('Choose a date between 4 Nov 2026 and today');
  });

  it('sends In Lab with the reason and the sample date, and emits the updated row', async () => {
    await openWith(row());
    await typeInto('textarea', '  Patient phoned support: sample taken 4 Nov  ');
    await typeInto('input[type="date"]', '2026-11-04');
    await submit();
    const req = expectCorrect();
    expect(req.request.body).toEqual({ status: 'in_lab', reason: 'Patient phoned support: sample taken 4 Nov', sample_date: '2026-11-04' });
    req.flush({ status: 'success', message: 'Status updated', data: row({ status: 'in_lab', corrections: ['booked'] }) });
    await render();
    expect(host.corrected.length).toBe(1);
    expect(host.corrected[0].status).toBe('in_lab');
  });

  it('leaves the sample date out when it is empty, and for other targets', async () => {
    await openWith(row());
    await typeInto('textarea', 'Patient phoned support');
    await submit();
    const first = expectCorrect();
    expect(first.request.body).toEqual({ status: 'in_lab', reason: 'Patient phoned support' });
    first.flush({ status: 'success', message: 'OK', data: row({ status: 'in_lab', corrections: ['booked'] }) });
    await render();

    await openWith(row({ status: 'declined', corrections: ['awaiting_consent'], consented_on: null }));
    await typeInto('textarea', 'Patient declined by mistake');
    await submit();
    const second = expectCorrect();
    expect(second.request.body).toEqual({ status: 'awaiting_consent', reason: 'Patient declined by mistake' });
    second.flush({ status: 'success', message: 'OK', data: row({ status: 'awaiting_consent', corrections: [] }) });
  });

  it('a 409 says the request changed and tells the page to reload', async () => {
    await openWith(row());
    await typeInto('textarea', 'Patient phoned support');
    await submit();
    expectCorrect().flush(
      { status: 'error', message: 'This lab request changed', errors: { code: 'status_changed' } },
      { status: 409, statusText: 'Conflict' },
    );
    await render();
    expect(text()).toContain('This request changed. Reload and try again.');
    expect(host.conflicts).toBe(1);
    expect(host.corrected.length).toBe(0);
  });

  it("the API's 422 `status` refusal (the row is out of date) is the same conflict, and nothing more is sent from the stale row", async () => {
    await openWith(row());
    await typeInto('textarea', 'Patient phoned support');
    await submit();
    expectCorrect().flush(
      { status: 'error', message: 'Choose a status from the list', errors: { status: 'Choose a status from the list' } },
      { status: 422, statusText: 'Unprocessable' },
    );
    await render();
    await tick();
    expect(text()).toContain('This request changed. Reload and try again.');
    expect(host.conflicts).toBe(1);
    expect(host.corrected.length).toBe(0);
    // Not shown as a field error on the only (stale) choice.
    expect(text()).not.toContain('Choose a status from the list');
    expect(el.querySelector('fieldset')?.getAttribute('aria-describedby')).toBeNull();

    // "Change status" is disabled, a retry sends nothing, and focus is on Cancel.
    const buttons = Array.from(el.querySelectorAll('button'));
    const change = buttons.find((b) => b.textContent?.includes('Change status'));
    const cancel = buttons.find((b) => b.textContent?.trim() === 'Cancel');
    expect(change?.disabled).toBe(true);
    expect(document.activeElement).toBe(cancel);
    await submit();
    http.expectNone(() => true);

    // Reopened on the reloaded row: a fresh, sendable form.
    await openWith(row({ status: 'in_lab', corrections: ['booked'] }));
    expect(text()).not.toContain('This request changed');
    expect(Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Change status'))?.disabled).toBe(false);
  });

  it('a 409 also stops further sends from the stale row', async () => {
    await openWith(row());
    await typeInto('textarea', 'Patient phoned support');
    await submit();
    expectCorrect().flush(
      { status: 'error', message: 'This lab request changed', errors: { code: 'status_changed', status: 'in_lab' } },
      { status: 409, statusText: 'Conflict' },
    );
    await render();
    await submit();
    http.expectNone(() => true);
    expect(host.conflicts).toBe(1);
  });

  it("shows the API's field errors next to their fields", async () => {
    await openWith(row());
    await typeInto('textarea', 'Patient phoned support');
    await submit();
    expectCorrect().flush(
      { status: 'error', message: 'Validation failed', errors: { sample_date: 'Choose a date between 4 Nov 2026 and today' } },
      { status: 422, statusText: 'Unprocessable' },
    );
    await render();
    expect(dateField()?.getAttribute('aria-invalid')).toBe('true');
    expect(text()).toContain('Choose a date between 4 Nov 2026 and today');
  });

  it('Cancel closes without sending', async () => {
    await openWith(row());
    const cancel = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Cancel');
    cancel?.click();
    await render();
    http.expectNone(() => true);
    expect(host.closedCount).toBe(1);
  });
});
