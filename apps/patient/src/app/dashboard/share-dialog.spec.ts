import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { API_CONFIG } from '@supadoc/data-access';
import type {
  CreateDocumentShareInput,
  DoctorAccessSummaryDto,
  DocumentGrantDto,
  DocumentShareResultDto,
  SharingDoctorDto,
} from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { ShareDialog } from './share-dialog';

const BASE = 'http://api.test';
const SHARE_URL = `${BASE}/api/portal/document-access/grants`;

function access(over: Partial<DoctorAccessSummaryDto> = {}): DoctorAccessSummaryDto {
  return {
    state: 'none',
    scope: null,
    document_count: 0,
    until: null,
    until_label_at: null,
    indefinite: false,
    folder_until_label_at: null,
    folder_indefinite: false,
    next_change_at: null,
    last_viewed_at: null,
    active_grant_ids: [],
    hidden_count: 0,
    hidden_document_ids: [],
    ...over,
  };
}

function doctor(over: Partial<SharingDoctorDto> = {}, accessOver: Partial<DoctorAccessSummaryDto> = {}): SharingDoctorDto {
  return {
    specialist: { id: 'sp-1', name: 'Bayo Ade', specialty: 'Cardiology', photo_url: null },
    can_share: true,
    unavailable_reason: null,
    last_appointment_at: '2026-10-01T10:00:00Z',
    next_appointment: null,
    access: access(accessOver),
    pending_request: null,
    requests_blocked: false,
    ...over,
  };
}

function grant(over: Partial<DocumentGrantDto> = {}): DocumentGrantDto {
  return {
    id: 'g-1',
    specialist: { id: 'sp-1', name: 'Bayo Ade', specialty: null, photo_url: null },
    scope: 'all',
    status: 'active',
    source: 'share',
    surface: 'manage_sharing',
    duration: '7d',
    starts_at: '2026-10-20T10:00:00Z',
    expires_at: '2030-10-27T10:00:00Z',
    until_label_at: '2030-10-27T10:00:00Z',
    ended_at: null,
    end_reason: null,
    ended_by: null,
    document_ids: [],
    document_count: 0,
    appointment: null,
    request_id: null,
    revoke_batch_id: null,
    restorable_until: null,
    last_accessed_at: null,
    access_count: 0,
    created_at: '2026-10-20T10:00:00Z',
    ...over,
  };
}

@Component({
  imports: [ShareDialog],
  template: `
    @if (show()) {
      <pat-share-dialog
        [mode]="mode()"
        [grant]="grant()"
        [preselectDoctorIds]="doctorIds()"
        [lockDoctor]="lock()"
        surface="manage_sharing"
        (done)="results.push($event)"
        (closed)="show.set(false)"
      />
    }
  `,
})
class Host {
  readonly show = signal(false);
  readonly mode = signal<'create' | 'edit'>('create');
  readonly grant = signal<DocumentGrantDto | null>(null);
  readonly doctorIds = signal<string[]>([]);
  readonly lock = signal(false);
  readonly results: (DocumentShareResultDto | DocumentGrantDto)[] = [];
}

describe('ShareDialog', () => {
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
    const b = Array.from(el.querySelectorAll('button')).find((x) => x.textContent?.trim() === label);
    if (!b) throw new Error(`No "${label}" button`);
    return b;
  };
  const click = async (label: string) => {
    button(label).click();
    await render();
    await tick();
    await render();
  };
  /** Tick / choose the input inside the label containing `label`. */
  const choose = async (label: string, on = true) => {
    const l = Array.from(el.querySelectorAll('label')).find((x) => x.textContent?.includes(label));
    const input = l?.querySelector('input');
    if (!input) throw new Error(`No "${label}" option`);
    input.checked = on;
    input.dispatchEvent(new Event('change'));
    await render();
  };

  const open = async (doctors: SharingDoctorDto[], setup: (h: Host) => void = () => undefined) => {
    setup(host);
    host.show.set(true);
    await render();
    http.expectOne(`${BASE}/api/portal/document-access/doctors`).flush({ status: 'success', message: 'OK', data: doctors });
    http
      .expectOne((r) => r.url === `${BASE}/api/portal/documents`)
      .flush({
        status: 'success',
        message: 'OK',
        data: [{ id: 'd-1', patient_id: 'p', uploader_role: 'patient', appointment_id: null, document_type: 'lab', custom_type: null, type_label: 'Lab result', title: 'Blood test', extension: 'pdf', mime_type: 'application/pdf', size_bytes: 10, size_label: '10kb', created_at: '2026-10-10T10:00:00Z' }],
        meta: { page: 1, per_page: 100, total: 1, total_pages: 1 },
      });
    await render();
  };
  const expectShare = (): TestRequest => http.expectOne((r) => r.method === 'POST' && r.url === SHARE_URL);
  const result = (outcome: 'created' | 'extended' | 'unchanged' = 'created'): DocumentShareResultDto => ({
    grants: [grant()],
    outcomes: [{ specialist_id: 'sp-1', grant_id: 'g-1', outcome }],
    approved_request_ids: [],
    replayed: false,
  });

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

  it('gates each step: a doctor, then what they see, before going on', async () => {
    await open([doctor()]);
    expect(button('Continue').disabled).toBe(true);
    await choose('Dr Bayo Ade');
    expect(button('Continue').disabled).toBe(false);
    await click('Continue');
    expect(text()).toContain('What can they see?');
    await click('Continue');
    expect(text()).toContain('Choose what they can see.');
    await choose('Selected documents');
    await click('Continue');
    expect(text()).toContain('Choose at least one document.');
    await choose('Blood test');
    await click('Continue');
    expect(text()).toContain('For how long?');
  });

  it('says whether a share extends a folder share or leaves it as it is', async () => {
    const holder = doctor({}, { state: 'active', scope: 'all', folder_until_label_at: '2030-01-01T10:00:00Z' });
    await open([holder], (h) => {
      h.doctorIds.set(['sp-1']);
      h.lock.set(true);
    });
    await choose('All my documents');
    await click('Continue');
    await choose('24 hours');
    await click('Continue');
    expect(text()).toContain('Dr Bayo Ade can already see your whole folder until 1 Jan 2030');
    expect(text()).toContain('That stays as it is.');
    await click('Back');
    await choose('No end date');
    await click('Continue');
    expect(text()).toContain('This extends it to no end date.');
  });

  it('sends Show them too for hidden documents and answers a pending request when ticked', async () => {
    const pending = {
      id: 'rq-1',
      specialist: { id: 'sp-1', name: 'Bayo Ade', specialty: null, photo_url: null },
      appointment: null,
      kind: 'access' as const,
      status: 'pending' as const,
      message: null,
      created_at: '2026-10-20T10:00:00Z',
      expires_at: '2026-10-27T10:00:00Z',
      decided_at: null,
      grant_id: null,
      suggestion: { scope: null, document_ids: [], duration: '7d' as const, appointment_id: null },
    };
    const holder = doctor({ pending_request: pending }, { state: 'active', scope: 'all', hidden_count: 2 });
    await open([holder], (h) => {
      h.doctorIds.set(['sp-1']);
      h.lock.set(true);
    });
    await choose('All my documents');
    await click('Continue');
    await click('Continue');
    expect(text()).toContain('2 documents you hid from Dr Bayo Ade stay hidden.');
    expect(text()).toContain("This answers Dr Bayo Ade's request");
    await choose('Show them too');
    await click('Share');
    const req = expectShare();
    const body = req.request.body as CreateDocumentShareInput;
    expect(body.show_hidden_for_specialist_ids).toEqual(['sp-1']);
    expect(body.answers_request_id).toBe('rq-1');
    expect(body.scope).toBe('all');
    expect(body.surface).toBe('manage_sharing');
    req.flush({ status: 'success', message: 'OK', data: result() });
    await render();
    expect(host.results.length).toBe(1);
  });

  it('leaves the request open when "This answers …" is unticked', async () => {
    const pending = {
      id: 'rq-1',
      specialist: { id: 'sp-1', name: 'Bayo Ade', specialty: null, photo_url: null },
      appointment: null,
      kind: 'access' as const,
      status: 'pending' as const,
      message: null,
      created_at: '2026-10-20T10:00:00Z',
      expires_at: '2026-10-27T10:00:00Z',
      decided_at: null,
      grant_id: null,
      suggestion: { scope: null, document_ids: [], duration: '7d' as const, appointment_id: null },
    };
    await open([doctor({ pending_request: pending })], (h) => {
      h.doctorIds.set(['sp-1']);
      h.lock.set(true);
    });
    await choose('All my documents');
    await click('Continue');
    await click('Continue');
    await choose('This answers', false);
    await click('Share');
    const req = expectShare();
    expect((req.request.body as CreateDocumentShareInput).answers_request_id).toBeUndefined();
    req.flush({ status: 'success', message: 'OK', data: result() });
    await render();
  });

  it('shows the share’s real end when it is edited without changing how long', async () => {
    await open([doctor({}, { state: 'active', scope: 'all' })], (h) => {
      h.mode.set('edit');
      h.grant.set(grant({ duration: '7d', expires_at: '2030-10-27T10:00:00Z', until_label_at: '2030-10-27T10:00:00Z' }));
    });
    await click('Continue');
    await click('Continue');
    // Not "now + 7 days": the PATCH leaves the end alone.
    expect(text()).toContain('27 Oct 2030');
    expect(button('Save changes').disabled).toBe(true);
  });

  it('offers Share again with the same choices when the edited share has ended', async () => {
    await open([doctor({}, { state: 'active', scope: 'all' })], (h) => {
      h.mode.set('edit');
      h.grant.set(grant());
    });
    expect(text()).toContain('Change what Dr Bayo Ade can see');
    await click('Continue');
    await choose('30 days');
    await click('Continue');
    await click('Save changes');
    const patch = http.expectOne((r) => r.method === 'PATCH' && r.url === `${SHARE_URL}/g-1`);
    expect(patch.request.body).toEqual({ duration: '30d' });
    patch.flush(
      { status: 'error', message: 'This access already ended.', errors: { code: 'grant_ended' } },
      { status: 409, statusText: 'Conflict' },
    );
    await render();
    expect(text()).toContain('This access already ended. Share again to give access.');
    await click('Share again');
    await click('Share');
    const create = expectShare();
    const body = create.request.body as CreateDocumentShareInput;
    expect(body).toEqual(
      expect.objectContaining({ specialist_ids: ['sp-1'], scope: 'all', duration: '30d', surface: 'manage_sharing' }),
    );
    create.flush({ status: 'success', message: 'OK', data: result() });
    await render();
    expect(host.results.length).toBe(1);
  });

  it('makes a new key after an idempotency conflict', async () => {
    await open([doctor()], (h) => {
      h.doctorIds.set(['sp-1']);
      h.lock.set(true);
    });
    await choose('All my documents');
    await click('Continue');
    await click('Continue');
    await click('Share');
    const first = expectShare();
    const firstKey = (first.request.body as CreateDocumentShareInput).client_key;
    first.flush(
      { status: 'error', message: 'Conflict', errors: { code: 'idempotency_conflict' } },
      { status: 409, statusText: 'Conflict' },
    );
    await render();
    expect(text()).toContain('Something changed. Check your choices and try again.');
    await click('Share');
    const second = expectShare();
    const secondKey = (second.request.body as CreateDocumentShareInput).client_key;
    expect(secondKey).toBeTruthy();
    expect(secondKey).not.toBe(firstKey);
    second.flush({ status: 'success', message: 'OK', data: result() });
    await render();
  });

  it('shows the unavailable copy and no actions when sharing is switched off', async () => {
    host.show.set(true);
    await render();
    http
      .expectOne(`${BASE}/api/portal/document-access/doctors`)
      .flush(
        { status: 'error', message: 'Unavailable', errors: { code: 'sharing_unavailable' } },
        { status: 503, statusText: 'Unavailable' },
      );
    http.expectOne((r) => r.url === `${BASE}/api/portal/documents`).flush({ status: 'success', message: 'OK', data: [], meta: { page: 1, per_page: 100, total: 0, total_pages: 1 } });
    await render();
    expect(text()).toContain('Sharing is unavailable right now. Your documents stay private.');
    expect(Array.from(el.querySelectorAll('button')).some((b) => b.textContent?.trim() === 'Continue')).toBe(false);
  });
});
