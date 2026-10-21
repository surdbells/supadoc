import { HttpEventType, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { API_CONFIG } from './api-config';
import { ApiService, PASSIVE_REQUEST_HEADER } from './api.service';
import { AppointmentsApi } from './appointments.api';
import { DoctorApi } from './doctor.api';
import { DocumentSharingApi } from './document-sharing.api';
import { DocumentsApi } from './documents.api';

const base = 'https://api.example.test';
/** An id that must be percent-encoded in a path segment. */
const ODD = 'a/b?c#d';
const ODD_ENC = 'a%2Fb%3Fc%23d';

function setup() {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: API_CONFIG, useValue: { baseUrl: `${base}/` } },
    ],
  });
  return {
    sharing: TestBed.inject(DocumentSharingApi),
    documents: TestBed.inject(DocumentsApi),
    appointments: TestBed.inject(AppointmentsApi),
    doctor: TestBed.inject(DoctorApi),
    api: TestBed.inject(ApiService),
    http: TestBed.inject(HttpTestingController),
  };
}

const OK = { status: 'success', message: 'OK', data: null };

describe('DocumentSharingApi', () => {
  let s: ReturnType<typeof setup>;

  beforeEach(() => (s = setup()));
  afterEach(() => s.http.verify());

  it('reads the booked doctors, the grants (with filters) and the requests', () => {
    s.sharing.doctors().subscribe();
    const doctors = s.http.expectOne(`${base}/api/portal/document-access/doctors`);
    expect(doctors.request.method).toBe('GET');
    expect(doctors.request.headers.has(PASSIVE_REQUEST_HEADER)).toBe(false);
    doctors.flush(OK);

    s.sharing.grants().subscribe();
    const all = s.http.expectOne(`${base}/api/portal/document-access/grants`);
    expect(all.request.method).toBe('GET');
    expect(all.request.params.keys()).toEqual([]);
    all.flush(OK);

    s.sharing.grants({ status: 'ended', specialist_id: 'sp-1' }).subscribe();
    const ended = s.http.expectOne(
      (r) => r.url === `${base}/api/portal/document-access/grants`,
    );
    expect(ended.request.params.get('status')).toBe('ended');
    expect(ended.request.params.get('specialist_id')).toBe('sp-1');
    ended.flush(OK);

    s.sharing.requests({ status: 'pending' }).subscribe();
    const pending = s.http.expectOne(
      (r) => r.url === `${base}/api/portal/document-access/requests`,
    );
    expect(pending.request.method).toBe('GET');
    expect(pending.request.params.get('status')).toBe('pending');
    pending.flush(OK);

    s.sharing.request(ODD).subscribe();
    const one = s.http.expectOne(`${base}/api/portal/document-access/requests/${ODD_ENC}`);
    expect(one.request.method).toBe('GET');
    one.flush(OK);
  });

  it('creates a share with the input as the JSON body', () => {
    const input = {
      specialist_ids: ['sp-1', 'sp-2'],
      scope: 'selected' as const,
      document_ids: ['d-1'],
      duration: 'until' as const,
      expires_at: '2026-10-31T00:00:00+01:00',
      client_key: 'k-1',
      answers_request_id: 'r-1',
      show_hidden_for_specialist_ids: [],
      surface: 'manage_sharing' as const,
    };
    s.sharing.share(input).subscribe();
    const req = s.http.expectOne(`${base}/api/portal/document-access/grants`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual(input);
    req.flush(OK);
  });

  it('patches, revokes and restores one grant at its encoded path', () => {
    s.sharing.updateGrant(ODD, { duration: 'indefinite' }).subscribe();
    const patch = s.http.expectOne(`${base}/api/portal/document-access/grants/${ODD_ENC}`);
    expect(patch.request.method).toBe('PATCH');
    expect(patch.request.body).toEqual({ duration: 'indefinite' });
    patch.flush(OK);

    s.sharing.revokeGrant(ODD).subscribe();
    const revoke = s.http.expectOne(`${base}/api/portal/document-access/grants/${ODD_ENC}/revoke`);
    expect(revoke.request.method).toBe('POST');
    expect(revoke.request.body).toEqual({});
    revoke.flush(OK);

    s.sharing.restoreGrant(ODD).subscribe();
    const restore = s.http.expectOne(`${base}/api/portal/document-access/grants/${ODD_ENC}/restore`);
    expect(restore.request.method).toBe('POST');
    expect(restore.request.body).toEqual({});
    restore.flush(OK);
  });

  it('stops sharing with one doctor, with everyone, and lets a blocked doctor ask again', () => {
    s.sharing.stopSharingWith(ODD).subscribe();
    const stop = s.http.expectOne(`${base}/api/portal/document-access/doctors/${ODD_ENC}/revoke`);
    expect(stop.request.method).toBe('POST');
    stop.flush(OK);

    s.sharing.revokeAll().subscribe();
    const all = s.http.expectOne(`${base}/api/portal/document-access/revoke-all`);
    expect(all.request.method).toBe('POST');
    expect(all.request.body).toEqual({});
    all.flush(OK);

    s.sharing.allowRequests(ODD).subscribe();
    const allow = s.http.expectOne(
      `${base}/api/portal/document-access/doctors/${ODD_ENC}/allow-requests`,
    );
    expect(allow.request.method).toBe('POST');
    allow.flush(OK);
  });

  it('approves and declines a request', () => {
    const approval = { scope: 'all' as const, duration: '7d' as const, show_hidden: true };
    s.sharing.approveRequest(ODD, approval).subscribe();
    const approve = s.http.expectOne(
      `${base}/api/portal/document-access/requests/${ODD_ENC}/approve`,
    );
    expect(approve.request.method).toBe('POST');
    expect(approve.request.body).toEqual(approval);
    approve.flush(OK);

    s.sharing.declineRequest(ODD).subscribe();
    const plain = s.http.expectOne(
      `${base}/api/portal/document-access/requests/${ODD_ENC}/decline`,
    );
    expect(plain.request.method).toBe('POST');
    expect(plain.request.body).toEqual({});
    plain.flush(OK);

    s.sharing.declineRequest('r-2', { block_future_requests: true }).subscribe();
    const blocked = s.http.expectOne(`${base}/api/portal/document-access/requests/r-2/decline`);
    expect(blocked.request.body).toEqual({ block_future_requests: true });
    blocked.flush(OK);
  });

  it('pages the activity history with only the filters given', () => {
    s.sharing.history({ page: 2, per_page: 50, document_id: 'd-1' }).subscribe();
    const req = s.http.expectOne((r) => r.url === `${base}/api/portal/document-access/history`);
    expect(req.request.method).toBe('GET');
    expect(req.request.params.get('page')).toBe('2');
    expect(req.request.params.get('per_page')).toBe('50');
    expect(req.request.params.get('document_id')).toBe('d-1');
    expect(req.request.params.has('specialist_id')).toBe(false);
    req.flush({ status: 'success', message: 'OK', data: [], meta: {} });
  });

  it("loads an appointment's document access, marking background refreshes passive", () => {
    s.sharing.forAppointment(ODD).subscribe();
    const active = s.http.expectOne(
      `${base}/api/portal/appointments/${ODD_ENC}/document-access`,
    );
    expect(active.request.method).toBe('GET');
    expect(active.request.headers.has(PASSIVE_REQUEST_HEADER)).toBe(false);
    active.flush(OK);

    s.sharing.forAppointment('ap-1', { passive: true }).subscribe();
    const passive = s.http.expectOne(`${base}/api/portal/appointments/ap-1/document-access`);
    expect(passive.request.headers.get(PASSIVE_REQUEST_HEADER)).toBe('1');
    passive.flush(OK);
  });
});

describe('ApiService passive requests', () => {
  let s: ReturnType<typeof setup>;

  beforeEach(() => (s = setup()));
  afterEach(() => s.http.verify());

  it('sends X-SD-Passive: 1 only when { passive: true }, keeping the query params', () => {
    expect(PASSIVE_REQUEST_HEADER).toBe('X-SD-Passive');

    s.api.get('api/x', { a: 1, b: undefined }, { passive: true }).subscribe();
    const passive = s.http.expectOne((r) => r.url === `${base}/api/x`);
    expect(passive.request.headers.get('X-SD-Passive')).toBe('1');
    expect(passive.request.params.get('a')).toBe('1');
    expect(passive.request.params.has('b')).toBe(false);
    passive.flush({});

    s.api.get('api/y', undefined, { passive: false }).subscribe();
    const explicit = s.http.expectOne(`${base}/api/y`);
    expect(explicit.request.headers.has('X-SD-Passive')).toBe(false);
    explicit.flush({});

    s.api.get('api/z').subscribe();
    const plain = s.http.expectOne(`${base}/api/z`);
    expect(plain.request.headers.has('X-SD-Passive')).toBe(false);
    plain.flush({});
  });

  it('marks a POST passive only when asked (the refresh a background poll needed)', () => {
    s.api.post('api/auth/refresh', { refresh_token: 'R' }, { passive: true }).subscribe();
    const passive = s.http.expectOne(`${base}/api/auth/refresh`);
    expect(passive.request.method).toBe('POST');
    expect(passive.request.headers.get('X-SD-Passive')).toBe('1');
    expect(passive.request.body).toEqual({ refresh_token: 'R' });
    passive.flush({});

    s.api.post('api/auth/refresh', { refresh_token: 'R' }).subscribe();
    const plain = s.http.expectOne(`${base}/api/auth/refresh`);
    expect(plain.request.headers.has('X-SD-Passive')).toBe(false);
    plain.flush({});
  });
});

describe('DocumentsApi sharing', () => {
  let s: ReturnType<typeof setup>;

  beforeEach(() => (s = setup()));
  afterEach(() => s.http.verify());

  const file = () => new File(['%PDF'], 'scan.pdf', { type: 'application/pdf' });

  it('uploads without any sharing field when no share is given (unchanged call)', () => {
    s.documents.upload(file(), 'lab_result').subscribe();
    const req = s.http.expectOne(`${base}/api/portal/documents`);
    expect(req.request.method).toBe('POST');
    expect(req.request.reportProgress).toBe(true);
    const form = req.request.body as FormData;
    expect([...form.keys()].sort()).toEqual(['document_type', 'file']);
    expect(form.get('document_type')).toBe('lab_result');
    req.flush(OK);
  });

  it('appends every share field, repeating the array fields with []', () => {
    s.documents
      .upload(file(), 'other', 'Discharge letter', {
        specialist_ids: ['sp-1', 'sp-2'],
        duration: 'after_24h',
        expires_at: null,
        batch_id: 'batch-1',
        appointment_id: 'ap-1',
        exclude_specialist_ids: ['sp-9'],
        surface: 'appointment_details',
      })
      .subscribe();
    const req = s.http.expectOne(`${base}/api/portal/documents`);
    const form = req.request.body as FormData;
    expect(form.get('custom_type')).toBe('Discharge letter');
    expect(form.getAll('share_specialist_ids[]')).toEqual(['sp-1', 'sp-2']);
    expect(form.get('share_duration')).toBe('after_24h');
    expect(form.has('share_expires_at')).toBe(false);
    expect(form.get('share_batch_id')).toBe('batch-1');
    expect(form.get('share_appointment_id')).toBe('ap-1');
    expect(form.getAll('exclude_specialist_ids[]')).toEqual(['sp-9']);
    expect(form.get('share_surface')).toBe('appointment_details');
    req.flush(OK);
  });

  it('sends an until share with its expiry, and an exclude-only upload with nothing else', () => {
    s.documents
      .upload(file(), 'scan', undefined, {
        specialist_ids: ['sp-1'],
        duration: 'until',
        expires_at: '2026-10-31T00:00:00+01:00',
        batch_id: 'b',
      })
      .subscribe();
    const until = s.http.expectOne(`${base}/api/portal/documents`);
    const untilForm = until.request.body as FormData;
    expect(untilForm.get('share_expires_at')).toBe('2026-10-31T00:00:00+01:00');
    expect(untilForm.has('custom_type')).toBe(false);
    expect(untilForm.has('share_surface')).toBe(false);
    until.flush(OK);

    s.documents.upload(file(), 'scan', undefined, { specialist_ids: [], exclude_specialist_ids: ['sp-3', 'sp-4'] }).subscribe();
    const exclude = s.http.expectOne(`${base}/api/portal/documents`);
    const form = exclude.request.body as FormData;
    expect([...new Set(form.keys())].sort()).toEqual(['document_type', 'exclude_specialist_ids[]', 'file']);
    expect(form.getAll('exclude_specialist_ids[]')).toEqual(['sp-3', 'sp-4']);
    exclude.flush(OK);
  });

  it('never sends the share fields without a doctor to share with (exclude-only from an appointment)', () => {
    s.documents
      .upload(file(), 'scan', undefined, {
        specialist_ids: [],
        appointment_id: 'ap-1',
        duration: '7d',
        expires_at: '2026-10-31T00:00:00+01:00',
        batch_id: 'batch-1',
        exclude_specialist_ids: ['sp-3'],
      })
      .subscribe();
    const req = s.http.expectOne(`${base}/api/portal/documents`);
    const form = req.request.body as FormData;
    expect([...new Set(form.keys())].sort()).toEqual(['document_type', 'exclude_specialist_ids[]', 'file']);
    expect(form.getAll('exclude_specialist_ids[]')).toEqual(['sp-3']);
    req.flush(OK);

    // blank ids count as no doctor; share_surface still goes
    s.documents
      .upload(file(), 'scan', undefined, {
        specialist_ids: [''],
        appointment_id: 'ap-1',
        duration: 'after_24h',
        surface: 'appointment_details',
      })
      .subscribe();
    const blank = s.http.expectOne(`${base}/api/portal/documents`);
    const blankForm = blank.request.body as FormData;
    expect([...new Set(blankForm.keys())].sort()).toEqual(['document_type', 'file', 'share_surface']);
    expect(blankForm.get('share_surface')).toBe('appointment_details');
    blank.flush(OK);
  });

  it('emits progress events and the uploaded document with its share outcome', () => {
    const types: HttpEventType[] = [];
    s.documents.upload(file(), 'scan').subscribe((e) => types.push(e.type));
    const req = s.http.expectOne(`${base}/api/portal/documents`);
    req.flush({ status: 'success', message: 'OK', data: { id: 'd-1', share_outcome: 'private' } });
    expect(types).toContain(HttpEventType.Response);
  });

  it("reads, removes and unhides one document's access at encoded paths", () => {
    s.documents.access(ODD).subscribe();
    const access = s.http.expectOne(`${base}/api/portal/documents/${ODD_ENC}/access`);
    expect(access.request.method).toBe('GET');
    access.flush(OK);

    s.documents.removeDoctorAccess(ODD, 'sp/1').subscribe();
    const remove = s.http.expectOne(`${base}/api/portal/documents/${ODD_ENC}/access/sp%2F1`);
    expect(remove.request.method).toBe('DELETE');
    remove.flush(OK);

    s.documents.unhideForDoctor(ODD, 'sp/1').subscribe();
    const unhide = s.http.expectOne(`${base}/api/portal/documents/${ODD_ENC}/access/sp%2F1/unhide`);
    expect(unhide.request.method).toBe('POST');
    expect(unhide.request.body).toEqual({});
    unhide.flush(OK);
  });
});

describe('AppointmentsApi booking attachments', () => {
  let s: ReturnType<typeof setup>;

  beforeEach(() => (s = setup()));
  afterEach(() => s.http.verify());

  const file = () => new File(['x'], 'photo.jpg', { type: 'image/jpeg' });

  it('uploads with no show list by default (hidden from every folder holder)', () => {
    s.appointments.uploadDocument(file()).subscribe();
    const req = s.http.expectOne(`${base}/api/portal/appointment-documents`);
    const form = req.request.body as FormData;
    expect([...form.keys()]).toEqual(['document']);
    req.flush(OK);
  });

  it('appends show_specialist_ids[] for each ticked doctor', () => {
    s.appointments.uploadDocument(file(), { show_specialist_ids: ['sp-1', 'sp-2'] }).subscribe();
    const req = s.http.expectOne(`${base}/api/portal/appointment-documents`);
    const form = req.request.body as FormData;
    expect(form.getAll('show_specialist_ids[]')).toEqual(['sp-1', 'sp-2']);
    req.flush(OK);
  });

  it('sends document_share with the booking body', () => {
    const params = {
      specialist_id: 'sp-1',
      scheduled_at: '2026-10-30T09:00:00+01:00',
      document_ids: ['d-1'],
      document_share: { duration: null, show_specialist_ids: ['sp-2'] },
    };
    s.appointments.book(params).subscribe();
    const req = s.http.expectOne(`${base}/api/portal/appointments`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual(params);
    req.flush(OK);
  });
});

describe('DoctorApi document access', () => {
  let s: ReturnType<typeof setup>;

  beforeEach(() => (s = setup()));
  afterEach(() => s.http.verify());

  it('loads document access (active by default, passive on request)', () => {
    s.doctor.documentAccess(ODD).subscribe();
    const active = s.http.expectOne(`${base}/api/doctor/appointments/${ODD_ENC}/document-access`);
    expect(active.request.method).toBe('GET');
    expect(active.request.headers.has(PASSIVE_REQUEST_HEADER)).toBe(false);
    active.flush(OK);

    s.doctor.documentAccess('ap-1', { passive: true }).subscribe();
    const passive = s.http.expectOne(`${base}/api/doctor/appointments/ap-1/document-access`);
    expect(passive.request.headers.get(PASSIVE_REQUEST_HEADER)).toBe('1');
    passive.flush(OK);
  });

  it('requests access with an optional note and withdraws the request', () => {
    s.doctor.requestDocumentAccess(ODD, '  For the follow-up  ').subscribe();
    const withNote = s.http.expectOne(
      `${base}/api/doctor/appointments/${ODD_ENC}/document-access/request`,
    );
    expect(withNote.request.method).toBe('POST');
    expect(withNote.request.body).toEqual({ message: 'For the follow-up' });
    withNote.flush(OK);

    s.doctor.requestDocumentAccess('ap-1').subscribe();
    const bare = s.http.expectOne(`${base}/api/doctor/appointments/ap-1/document-access/request`);
    expect(bare.request.body).toEqual({});
    bare.flush(OK);

    s.doctor.requestDocumentAccess('ap-1', '   ').subscribe();
    const blank = s.http.expectOne(`${base}/api/doctor/appointments/ap-1/document-access/request`);
    expect(blank.request.body).toEqual({});
    blank.flush(OK);

    s.doctor.cancelDocumentAccessRequest(ODD).subscribe();
    const cancel = s.http.expectOne(
      `${base}/api/doctor/appointments/${ODD_ENC}/document-access/request/cancel`,
    );
    expect(cancel.request.method).toBe('POST');
    expect(cancel.request.body).toEqual({});
    cancel.flush(OK);
  });

  it('keeps the legacy list and the file path', () => {
    s.doctor.patientDocuments('ap-1').subscribe();
    s.http.expectOne(`${base}/api/doctor/appointments/ap-1/patient-documents`).flush(OK);

    s.doctor.patientDocumentBlob('ap-1', ODD).subscribe();
    const file = s.http.expectOne(
      `${base}/api/doctor/appointments/ap-1/patient-documents/${ODD_ENC}/file`,
    );
    expect(file.request.responseType).toBe('blob');
    file.flush(new Blob(['x']));
  });
});
