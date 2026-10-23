import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, TestRequest } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { ApproveApplicationInput, RequestInfoInput, ScheduleInterviewInput } from '@supadoc/models';
import { AdminDoctorApplicationsApi } from './admin-doctor-applications.api';
import { API_CONFIG } from './api-config';
import { PASSIVE_REQUEST_HEADER } from './api.service';

const base = 'https://api.example.test';
const B = `${base}/api/doctor-applications`;
/** An id that must be percent-encoded in a path segment. */
const ODD = 'a/b?c#d';
const ODD_ENC = 'a%2Fb%3Fc%23d';
const OK = { status: 'success', message: 'OK', data: null };

function setup() {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: API_CONFIG, useValue: { baseUrl: `${base}/` } },
    ],
  });
  return {
    api: TestBed.inject(AdminDoctorApplicationsApi),
    http: TestBed.inject(HttpTestingController),
  };
}

/** Assert the method, the body and that the client itself adds no Authorization header. */
function expectCall(req: TestRequest, method: string, body?: unknown): void {
  expect(req.request.method).toBe(method);
  if (body !== undefined) expect(req.request.body).toEqual(body);
  expect(req.request.headers.has('Authorization')).toBe(false);
  expect(req.request.headers.has(PASSIVE_REQUEST_HEADER)).toBe(false);
  req.flush(OK);
}

describe('AdminDoctorApplicationsApi', () => {
  let s: ReturnType<typeof setup>;

  beforeEach(() => (s = setup()));
  afterEach(() => s.http.verify());

  it('lists page 1 of 20 by default', () => {
    s.api.list({}).subscribe();
    const req = s.http.expectOne((r) => r.url === B);
    expect(req.request.params.get('page')).toBe('1');
    expect(req.request.params.get('per_page')).toBe('20');
    expect(req.request.params.keys().sort()).toEqual(['page', 'per_page']);
    expectCall(req, 'GET');
  });

  it('passes every filter and overrides the paging, leaving unset keys out', () => {
    s.api
      .list({ q: 'ada obi', filter: 'needs_action', route: 'abroad', sort: 'interview', page: 3, per_page: 50 })
      .subscribe();
    const req = s.http.expectOne((r) => r.url === B);
    const p = req.request.params;
    expect(p.get('q')).toBe('ada obi');
    expect(p.get('filter')).toBe('needs_action');
    expect(p.get('route')).toBe('abroad');
    expect(p.get('sort')).toBe('interview');
    expect(p.get('page')).toBe('3');
    expect(p.get('per_page')).toBe('50');
    expectCall(req, 'GET');

    s.api.list({ q: undefined, filter: 'approved' }).subscribe();
    const sparse = s.http.expectOne((r) => r.url === B);
    expect(sparse.request.params.has('q')).toBe(false);
    expect(sparse.request.params.get('filter')).toBe('approved');
    expectCall(sparse, 'GET');
  });

  it('reads the queue as a passive background poll', () => {
    s.api.queue().subscribe();
    const req = s.http.expectOne(`${B}/queue`);
    expect(req.request.method).toBe('GET');
    expect(req.request.headers.get(PASSIVE_REQUEST_HEADER)).toBe('1');
    expect(req.request.headers.has('Authorization')).toBe(false);
    req.flush(OK);
  });

  it('reads one application and streams a document at encoded paths', () => {
    s.api.detail(ODD).subscribe();
    expectCall(s.http.expectOne(`${B}/${ODD_ENC}`), 'GET');

    s.api.documentFile(ODD, ODD).subscribe();
    const file = s.http.expectOne(`${B}/${ODD_ENC}/documents/${ODD_ENC}/file`);
    expect(file.request.method).toBe('GET');
    expect(file.request.responseType).toBe('blob');
    expect(file.request.headers.has('Authorization')).toBe(false);
    file.flush(new Blob(['x']));
  });

  it('starts a review with an empty body by default, or the expected status', () => {
    s.api.startReview('app-1').subscribe();
    expectCall(s.http.expectOne(`${B}/app-1/start-review`), 'POST', {});

    s.api.startReview(ODD, { expected_status: 'more_info_needed' }).subscribe();
    expectCall(s.http.expectOne(`${B}/${ODD_ENC}/start-review`), 'POST', { expected_status: 'more_info_needed' });
  });

  it('requests more information', () => {
    const input: RequestInfoInput = {
      expected_status: 'under_review',
      message: 'Please send a clearer copy of your ID.',
      items: [
        { kind: 'section', key: 'licence' },
        { kind: 'document', key: 'government_id' },
        { kind: 'document', key: 'additional', label: 'Letter from your employer' },
      ],
    };
    s.api.requestInfo('app-1', input).subscribe();
    expectCall(s.http.expectOne(`${B}/app-1/request-info`), 'POST', input);
  });

  it('schedules and re-sends an interview', () => {
    const input: ScheduleInterviewInput = {
      starts_at: '2026-10-28T10:00:00+01:00',
      duration_minutes: 30,
      meeting_url: 'https://meet.google.com/abc-defg-hij',
      note: 'Have your MDCN certificate to hand.',
    };
    s.api.scheduleInterview('app-1', input).subscribe();
    expectCall(s.http.expectOne(`${B}/app-1/schedule-interview`), 'POST', input);

    s.api.resendInterview(ODD).subscribe();
    expectCall(s.http.expectOne(`${B}/${ODD_ENC}/resend-interview`), 'POST', {});
  });

  it('approves with the attestation per document', () => {
    const input: ApproveApplicationInput = {
      expected_status: 'interview_scheduled',
      attest: true,
      consultation_fee: '15000.00',
      specialty: 'Cardiology',
      documents: {
        'doc-1': { checked: true, register_reference: 'MDCN search 2026-10-23', number: 'MDCN/12345', expires_on: '2026-12-31' },
        'doc-2': { checked: true, register_reference: 'ID seen' },
      },
    };
    s.api.approve('app-1', input).subscribe();
    expectCall(s.http.expectOne(`${B}/app-1/approve`), 'POST', input);
  });

  it('rejects with the reason the applicant will see', () => {
    s.api.reject('app-1', { reason: 'We could not verify your licence.' }).subscribe();
    expectCall(s.http.expectOne(`${B}/app-1/reject`), 'POST', { reason: 'We could not verify your licence.' });
  });

  it('reads and adds internal notes', () => {
    s.api.notes(ODD).subscribe();
    expectCall(s.http.expectOne(`${B}/${ODD_ENC}/notes`), 'GET');

    s.api.addNote('app-1', 'Called the referee.').subscribe();
    expectCall(s.http.expectOne(`${B}/app-1/notes`), 'POST', { body: 'Called the referee.' });
  });
});
