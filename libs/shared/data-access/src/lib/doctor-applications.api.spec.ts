import { HttpEventType, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, TestRequest } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { CreateDraftInput, SaveSectionInput } from '@supadoc/models';
import { API_CONFIG } from './api-config';
import {
  APPLICANT_DRAFT_PREFIX,
  APPLICANT_TRACK_PREFIXES,
  DOCTOR_APPLICATIONS_PUBLIC_PATH,
  DoctorApplicationsApi,
} from './doctor-applications.api';

const base = 'https://api.example.test';
const P = `${base}/api/public/doctor-applications`;
const D = `${P}/drafts/current`;
/** An id that must be percent-encoded in a path segment. */
const ODD = 'a/b?c#d';
const ODD_ENC = 'a%2Fb%3Fc%23d';
const OK = { status: 'success', message: 'OK', data: null };

function setup() {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      // A trailing slash on the base must not double up in any URL.
      { provide: API_CONFIG, useValue: { baseUrl: `${base}/` } },
    ],
  });
  return {
    api: TestBed.inject(DoctorApplicationsApi),
    http: TestBed.inject(HttpTestingController),
  };
}

/** Assert the method, the body and that the client never adds an Authorization header. */
function expectCall(req: TestRequest, method: string, body?: unknown): void {
  expect(req.request.method).toBe(method);
  if (body !== undefined) expect(req.request.body).toEqual(body);
  expect(req.request.headers.has('Authorization')).toBe(false);
  req.flush(OK);
}

describe('DoctorApplicationsApi', () => {
  let s: ReturnType<typeof setup>;

  beforeEach(() => (s = setup()));
  afterEach(() => s.http.verify());

  it('exports the URL prefixes the onboarding interceptor matches on', () => {
    expect(DOCTOR_APPLICATIONS_PUBLIC_PATH).toBe('api/public/doctor-applications');
    expect(APPLICANT_DRAFT_PREFIX).toBe('api/public/doctor-applications/drafts/current');
    expect(APPLICANT_TRACK_PREFIXES).toEqual([
      'api/public/doctor-applications/track/status',
      'api/public/doctor-applications/track/application',
      'api/public/doctor-applications/track/info-response',
      'api/public/doctor-applications/track/documents',
      'api/public/doctor-applications/track/withdraw',
    ]);
    // track/start, request-code and verify are anonymous: no prefix may cover them.
    for (const open of ['track/start', 'track/request-code', 'track/verify', 'config', 'drafts', 'drafts/resume']) {
      const path = `${DOCTOR_APPLICATIONS_PUBLIC_PATH}/${open}`;
      expect(APPLICANT_TRACK_PREFIXES.some((p) => path.startsWith(p))).toBe(false);
      expect(path.startsWith(APPLICANT_DRAFT_PREFIX)).toBe(false);
    }
  });

  it('reads the public config', () => {
    s.api.config$().subscribe();
    expectCall(s.http.expectOne(`${P}/config`), 'GET');
  });

  it('creates, resumes and re-sends drafts at the anonymous draft routes', () => {
    const input: CreateDraftInput = {
      licence_route: 'abroad',
      personal: { email: 'ada@example.com', first_name: 'Ada' },
      partial: true,
    };
    s.api.createDraft(input).subscribe();
    expectCall(s.http.expectOne(`${P}/drafts`), 'POST', input);

    s.api.resumeWithCode({ email: 'ada@example.com', draft_code: '7K3M9Q' }).subscribe();
    expectCall(s.http.expectOne(`${P}/drafts/resume`), 'POST', {
      email: 'ada@example.com',
      draft_code: '7K3M9Q',
    });

    s.api.resumeWithLink('tok-123').subscribe();
    expectCall(s.http.expectOne(`${P}/drafts/resume-link`), 'POST', { token: 'tok-123' });

    s.api.resendResume('ada@example.com').subscribe();
    expectCall(s.http.expectOne(`${P}/drafts/resend`), 'POST', { email: 'ada@example.com' });
  });

  it('reads, re-routes and discards the current draft', () => {
    s.api.getDraft().subscribe();
    expectCall(s.http.expectOne(D), 'GET');

    s.api.changeRoute('ng').subscribe();
    expectCall(s.http.expectOne(D), 'PATCH', { licence_route: 'ng' });

    s.api.discardDraft().subscribe();
    expectCall(s.http.expectOne(D), 'DELETE');
  });

  it('saves a section with its values and the partial flag', () => {
    const input: SaveSectionInput<'licence'> = {
      values: { mdcn_number: 'MDCN/12345', full_registration_year: 2012 },
      partial: true,
    };
    s.api.saveSection('licence', input).subscribe();
    expectCall(s.http.expectOne(`${D}/sections/licence`), 'PUT', input);

    const consent: SaveSectionInput<'consent'> = {
      values: {
        accept_terms: true,
        authorise_verification: true,
        confirm_accurate: true,
        signature_name: 'Ada Obi',
        consent_version: '2026-10',
      },
    };
    s.api.saveSection('consent', consent).subscribe();
    expectCall(s.http.expectOne(`${D}/sections/consent`), 'PUT', consent);
  });

  it('uploads a draft document as multipart with progress events', () => {
    const file = new File(['%PDF-1.7'], 'id card.pdf', { type: 'application/pdf' });
    const events: HttpEventType[] = [];
    s.api.uploadDocument('government_id', file).subscribe((e) => events.push(e.type));

    const req = s.http.expectOne(`${D}/documents`);
    expect(req.request.method).toBe('POST');
    expect(req.request.reportProgress).toBe(true);
    expect(req.request.headers.has('Authorization')).toBe(false);
    const body = req.request.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('slot')).toBe('government_id');
    const sent = body.get('file') as File;
    expect(sent).toBeInstanceOf(File);
    expect(sent.name).toBe('id card.pdf');
    req.event({ type: HttpEventType.UploadProgress, loaded: 4, total: 8 });
    req.flush(OK);
    expect(events).toContain(HttpEventType.UploadProgress);
    expect(events).toContain(HttpEventType.Response);
  });

  it('removes and streams draft documents at encoded paths', () => {
    s.api.removeDocument(ODD).subscribe();
    expectCall(s.http.expectOne(`${D}/documents/${ODD_ENC}`), 'DELETE');

    s.api.documentFile(ODD).subscribe();
    const file = s.http.expectOne(`${D}/documents/${ODD_ENC}/file`);
    expect(file.request.method).toBe('GET');
    expect(file.request.responseType).toBe('blob');
    expect(file.request.headers.has('Authorization')).toBe(false);
    file.flush(new Blob(['x']));
  });

  it('sends the resume email, the email code and verifies it', () => {
    s.api.sendResumeEmail().subscribe();
    expectCall(s.http.expectOne(`${D}/resume-email`), 'POST', {});

    s.api.sendEmailCode().subscribe();
    expectCall(s.http.expectOne(`${D}/email-code`), 'POST', {});

    s.api.verifyEmail({ code: '123456' }).subscribe();
    expectCall(s.http.expectOne(`${D}/email-verify`), 'POST', { code: '123456' });
  });

  it('submits the current draft', () => {
    s.api.submit().subscribe();
    expectCall(s.http.expectOne(`${D}/submit`), 'POST', {});
  });

  it('starts tracking, requests a code and verifies it', () => {
    s.api.trackStart({ reference: 'GVM-DR-2026-48213', contact: '08031234567' }).subscribe();
    expectCall(s.http.expectOne(`${P}/track/start`), 'POST', {
      reference: 'GVM-DR-2026-48213',
      contact: '08031234567',
    });

    s.api.trackRequestCode({ track_id: 't-1', channel: 'sms' }).subscribe();
    expectCall(s.http.expectOne(`${P}/track/request-code`), 'POST', { track_id: 't-1', channel: 'sms' });

    s.api.trackVerify({ track_id: 't-1', code: '654321' }).subscribe();
    expectCall(s.http.expectOne(`${P}/track/verify`), 'POST', { track_id: 't-1', code: '654321' });
  });

  it('reads the status and the editable application', () => {
    s.api.status().subscribe();
    expectCall(s.http.expectOne(`${P}/track/status`), 'GET');

    s.api.application().subscribe();
    expectCall(s.http.expectOne(`${P}/track/application`), 'GET');
  });

  it('edits requested sections and documents in an info response', () => {
    const input: SaveSectionInput<'indemnity'> = {
      values: { provider: 'Medical Defence Union', policy_number: 'MDU-1', cover_expires_on: '2027-06-30' },
    };
    s.api.saveInfoSection('indemnity', input).subscribe();
    expectCall(s.http.expectOne(`${P}/track/info-response/sections/indemnity`), 'PUT', input);

    const file = new File(['png'], 'letter.png', { type: 'image/png' });
    s.api.uploadInfoDocument('additional', file).subscribe();
    const upload = s.http.expectOne(`${P}/track/info-response/documents`);
    expect(upload.request.method).toBe('POST');
    expect(upload.request.reportProgress).toBe(true);
    expect(upload.request.headers.has('Authorization')).toBe(false);
    const body = upload.request.body as FormData;
    expect(body.get('slot')).toBe('additional');
    expect((body.get('file') as File).name).toBe('letter.png');
    upload.flush(OK);

    s.api.removeInfoDocument(ODD).subscribe();
    expectCall(s.http.expectOne(`${P}/track/info-response/documents/${ODD_ENC}`), 'DELETE');

    s.api.trackDocumentFile(ODD).subscribe();
    const blob = s.http.expectOne(`${P}/track/documents/${ODD_ENC}/file`);
    expect(blob.request.method).toBe('GET');
    expect(blob.request.responseType).toBe('blob');
    blob.flush(new Blob(['x']));
  });

  it('sends the info response and withdraws', () => {
    s.api.submitInfoResponse({ note: 'Uploaded the renewed licence.' }).subscribe();
    expectCall(s.http.expectOne(`${P}/track/info-response/submit`), 'POST', {
      note: 'Uploaded the renewed licence.',
    });

    s.api.withdraw({ confirm: true, reason: 'apply_later' }).subscribe();
    expectCall(s.http.expectOne(`${P}/track/withdraw`), 'POST', { confirm: true, reason: 'apply_later' });
  });
});
