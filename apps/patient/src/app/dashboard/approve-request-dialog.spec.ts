import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { API_CONFIG } from '@supadoc/data-access';
import type { DocumentAccessRequestDto, DocumentGrantDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { type ApproveOutcome, approveOutcomeLine, ApproveRequestDialog } from './approve-request-dialog';

const BASE = 'http://api.test';
const REQ = `${BASE}/api/portal/document-access/requests/rq-1`;

function request(over: Partial<DocumentAccessRequestDto> = {}): DocumentAccessRequestDto {
  return {
    id: 'rq-1',
    specialist: { id: 'sp-1', name: 'Bayo Ade', specialty: 'Cardiology', photo_url: null },
    appointment: {
      id: 'ap-1',
      scheduled_at: '2030-10-28T15:00:00Z',
      ends_at: '2030-10-28T15:30:00Z',
      after_options: {
        after_24h: '2030-10-29T15:30:00Z',
        after_7d: '2030-11-04T15:30:00Z',
        after_30d: '2030-11-27T15:30:00Z',
      },
    },
    kind: 'access',
    status: 'pending',
    message: 'Please share your recent results.',
    created_at: '2030-10-20T10:00:00Z',
    expires_at: '2030-10-27T10:00:00Z',
    decided_at: null,
    grant_id: null,
    suggestion: { scope: 'selected', document_ids: ['d-1', 'd-2'], duration: 'after_7d', appointment_id: 'ap-1' },
    ...over,
  };
}

const grant = { id: 'g-9', scope: 'selected', document_count: 2, specialist: { id: 'sp-1', name: 'Bayo Ade' } } as unknown as DocumentGrantDto;

@Component({
  imports: [ApproveRequestDialog],
  template: `
    @if (show()) {
      <pat-approve-request-dialog [request]="req()" (done)="outcomes.push($event)" (closed)="show.set(false)" />
    }
  `,
})
class Host {
  readonly show = signal(false);
  readonly req = signal<DocumentAccessRequestDto>(request());
  readonly outcomes: ApproveOutcome[] = [];
}

describe('ApproveRequestDialog', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;
  let el: HTMLElement;
  let http: HttpTestingController;

  const tick = () => new Promise((resolve) => setTimeout(resolve));
  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const text = () => el.textContent?.replace(/\s+/g, ' ') ?? '';
  const button = (label: string): HTMLButtonElement => {
    const b = Array.from(el.querySelectorAll('button')).find((x) => x.textContent?.trim().startsWith(label));
    if (!b) throw new Error(`No "${label}" button`);
    return b;
  };
  const click = async (label: string) => {
    button(label).click();
    await render();
    await tick();
    await render();
  };
  const choose = async (label: string, on = true) => {
    const l = Array.from(el.querySelectorAll('label')).find((x) => x.textContent?.includes(label));
    const input = l?.querySelector('input');
    if (!input) throw new Error(`No "${label}" option`);
    input.checked = on;
    input.dispatchEvent(new Event('change'));
    await render();
  };
  const open = async (r: DocumentAccessRequestDto) => {
    host.req.set(r);
    host.show.set(true);
    await render();
  };
  const flushDoctors = () =>
    http.expectOne(`${BASE}/api/portal/document-access/doctors`).flush({ status: 'success', message: 'OK', data: [] });

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideSupadocIcons(),
        { provide: API_CONFIG, useValue: { baseUrl: BASE } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(Host);
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

  it('approves in one tap with the server’s suggestion', async () => {
    await open(request());
    flushDoctors();
    await render();
    expect(text()).toContain('Dr Bayo Ade asked to see your documents');
    expect(text()).toContain('Their note: “Please share your recent results.”');
    expect(text()).toContain('The 2 files you attached for this consultation');
    expect(text()).toContain('7 days after your');
    expect(button('Approve and share').disabled).toBe(false);
    await click('Approve and share');
    const req = http.expectOne((r) => r.method === 'POST' && r.url === `${REQ}/approve`);
    expect(req.request.body).toEqual({
      scope: 'selected',
      duration: 'after_7d',
      document_ids: ['d-1', 'd-2'],
      appointment_id: 'ap-1',
    });
    req.flush({ status: 'success', message: 'OK', data: { request: request({ status: 'approved' }), grant } });
    await render();
    expect(host.outcomes[0]?.kind).toBe('approved');
  });

  it('opens "Change what or how long" and waits for a choice when there is no suggestion', async () => {
    await open(request({ suggestion: { scope: null, document_ids: [], duration: '7d', appointment_id: null } }));
    flushDoctors();
    http
      .expectOne((r) => r.url === `${BASE}/api/portal/documents`)
      .flush({
        status: 'success',
        message: 'OK',
        data: [{ id: 'd-5', patient_id: 'p', uploader_role: 'patient', appointment_id: null, document_type: 'lab', custom_type: null, type_label: 'Lab result', title: 'Blood test', extension: 'pdf', mime_type: 'application/pdf', size_bytes: 1, size_label: '1kb', created_at: '2026-10-10T10:00:00Z' }],
        meta: { page: 1, per_page: 100, total: 1, total_pages: 1 },
      });
    await render();
    const disclosure = button('Change what or how long');
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
    expect(button('Approve and share').disabled).toBe(true);
    await choose('Blood test');
    expect(button('Approve and share').disabled).toBe(false);
    await click('Approve and share');
    const req = http.expectOne((r) => r.method === 'POST' && r.url === `${REQ}/approve`);
    expect(req.request.body).toEqual({ scope: 'selected', duration: '7d', document_ids: ['d-5'] });
    req.flush({ status: 'success', message: 'OK', data: { request: request({ status: 'approved' }), grant } });
    await render();
  });

  it('declines and can stop further requests', async () => {
    await open(request());
    flushDoctors();
    await render();
    await click('Decline');
    expect(text()).toContain("Decline Dr Bayo Ade's request?");
    expect(text()).toContain('If you leave this unticked, they can ask again after 3 days.');
    await choose("Don't let Dr Bayo Ade ask again");
    await click('Decline request');
    const req = http.expectOne((r) => r.method === 'POST' && r.url === `${REQ}/decline`);
    expect(req.request.body).toEqual({ block_future_requests: true });
    req.flush({ status: 'success', message: 'OK', data: request({ status: 'declined' }) });
    await render();
    expect(host.outcomes[0]?.kind).toBe('declined');
  });

  it('shows the info copy for a request that is no longer pending', async () => {
    await open(request({ status: 'expired' }));
    await render();
    expect(text()).toContain('This request closed without an answer. Nothing was shared.');
    expect(text()).toContain('Manage sharing');
    expect(Array.from(el.querySelectorAll('button')).some((b) => b.textContent?.includes('Approve and share'))).toBe(false);
  });

  it('treats an approval the server already recorded as a success', async () => {
    await open(request());
    flushDoctors();
    await render();
    await click('Approve and share');
    http
      .expectOne((r) => r.method === 'POST' && r.url === `${REQ}/approve`)
      .flush(
        { status: 'error', message: 'Not pending', errors: { code: 'request_not_pending', status: 'approved' } },
        { status: 409, statusText: 'Conflict' },
      );
    await render();
    const outcome = host.outcomes[0] as ApproveOutcome;
    expect(outcome.kind).toBe('approved');
    expect(outcome.kind === 'approved' ? outcome.grant : 'x').toBeNull();
    expect(approveOutcomeLine(outcome)).toBe("You've already approved Dr Bayo Ade's request.");
    expect(text()).not.toContain("You've already approved this request.");
  });

  it('shows the fresh status when the request closed another way', async () => {
    await open(request());
    flushDoctors();
    await render();
    await click('Approve and share');
    http
      .expectOne((r) => r.method === 'POST' && r.url === `${REQ}/approve`)
      .flush(
        { status: 'error', message: 'Not pending', errors: { code: 'request_not_pending', status: 'cancelled' } },
        { status: 409, statusText: 'Conflict' },
      );
    await render();
    expect(text()).toContain('Dr Bayo Ade withdrew this request.');
    expect(host.outcomes[0]).toEqual({ kind: 'stale', status: 'cancelled' });
  });

  it('picks documents like the Share dialog: search, Select all and Clear', async () => {
    await open(request({ suggestion: { scope: null, document_ids: [], duration: '7d', appointment_id: null } }));
    flushDoctors();
    const doc = (id: string, title: string) => ({ id, patient_id: 'p', uploader_role: 'patient', appointment_id: null, document_type: 'lab', custom_type: null, type_label: 'Lab result', title, extension: 'pdf', mime_type: 'application/pdf', size_bytes: 1, size_label: '1kb', created_at: '2026-10-10T10:00:00Z' });
    http
      .expectOne((r) => r.url === `${BASE}/api/portal/documents` && r.params.get('page') === '1')
      .flush({ status: 'success', message: 'OK', data: [doc('d-5', 'Blood test'), doc('d-6', 'Chest scan')], meta: { page: 1, per_page: 100, total: 250, total_pages: 3 } });
    http
      .expectOne((r) => r.url === `${BASE}/api/portal/documents` && r.params.get('page') === '2')
      .flush({ status: 'success', message: 'OK', data: [doc('d-7', 'Old letter')], meta: { page: 2, per_page: 100, total: 250, total_pages: 3 } });
    await render();
    expect(text()).toContain('Showing your 3 newest documents.');
    const search = el.querySelector<HTMLInputElement>('input[type="search"]');
    expect(search).not.toBeNull();
    if (search) {
      search.value = 'scan';
      search.dispatchEvent(new Event('input'));
    }
    await render();
    await click('Select all');
    expect(text()).toContain('1 selected');
    await click('Clear');
    expect(text()).toContain('0 selected');
  });

  it('turns "Selected documents" off when there are no documents', async () => {
    await open(request({ suggestion: { scope: null, document_ids: [], duration: '7d', appointment_id: null } }));
    flushDoctors();
    http
      .expectOne((r) => r.url === `${BASE}/api/portal/documents`)
      .flush({ status: 'success', message: 'OK', data: [], meta: { page: 1, per_page: 100, total: 0, total_pages: 0 } });
    await render();
    const selected = Array.from(el.querySelectorAll('label'))
      .find((l) => l.textContent?.includes('Selected documents'))
      ?.querySelector('input');
    expect(selected?.disabled).toBe(true);
    expect(selected?.checked).toBe(false);
    expect(text()).toContain("You haven't uploaded any documents yet.");
    expect(button('Approve and share').disabled).toBe(true);
    await choose('All my documents');
    expect(button('Approve and share').disabled).toBe(false);
  });
});
