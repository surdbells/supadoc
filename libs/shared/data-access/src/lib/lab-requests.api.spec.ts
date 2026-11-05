import { HttpEvent, HttpEventType, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { firstValueFrom } from 'rxjs';
import type {
  AdminLabRequestSummaryDto,
  CreateLabRequestInput,
  DoctorLabResultDto,
  LabRequestDto,
  LabRequestEventDto,
  LabRequestSummaryDto,
  PatientLabRequestDto,
  PatientLabRequestSummaryDto,
  PatientLabResultDto,
} from '@supadoc/models';
import { API_CONFIG } from './api-config';
import { DOCUMENT_VIEWER_HEADER } from './doctor.api';
import { LabRequestsApi } from './lab-requests.api';

const base = 'https://api.example.test';
const OK = { status: 'success', message: 'OK', data: null };

function setup() {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: API_CONFIG, useValue: { baseUrl: `${base}/` } },
    ],
  });
  return { lab: TestBed.inject(LabRequestsApi), http: TestBed.inject(HttpTestingController) };
}

function createBody(overrides: Partial<CreateLabRequestInput> = {}): CreateLabRequestInput {
  return {
    client_key: '6f1c2b9e-3d4a-4f5b-8c6d-7e8f9a0b1c2d',
    catalogue_version: '2026-11.1',
    patient_id: 'pat-1',
    appointment_id: null,
    duplicated_from: null,
    priority: 'routine',
    purpose: 'diagnosis',
    clinical_question: 'Suspected iron-deficiency anaemia',
    history: 'Fatigue for 3 weeks',
    medication: 'Paracetamol',
    allergies: 'Penicillin',
    clinical: {
      fasting: false,
      fasting_hours: null,
      pregnant: null,
      weeks_pregnant: null,
      infection_alerts: ['hiv'],
      transfusion_3m: false,
    },
    items: [
      { code: 'FBC', specimen_mode: 'auto' },
      { code: 'GRAM-BLOOD' },
      { code: 'XR-CHEST', preparation_code: 'full_bladder' },
      { code: 'ECG12' },
    ],
    imaging_safety: { contrast_allergy: 'no', mobility: 'walking' },
    attest: true,
    signature: { mode: 'saved' },
    ...overrides,
  };
}

describe('LabRequestsApi', () => {
  let s: ReturnType<typeof setup>;

  beforeEach(() => (s = setup()));
  afterEach(() => s.http.verify());

  describe('fileUrl', () => {
    it('resolves a relative signed link against the API base, and keeps an absolute one', () => {
      expect(s.lab.fileUrl({ url: '/api/public/lab-requests/file?token=abc', expires_at: 'x', filename: 'GVM-REQ-20261104-00012.pdf' }))
        .toBe(`${base}/api/public/lab-requests/file?token=abc`);
      expect(s.lab.fileUrl({ url: 'https://files.example.test/f?token=1', expires_at: 'x', filename: 'f.pdf' }))
        .toBe('https://files.example.test/f?token=1');
    });
  });

  describe('fileBlob', () => {
    it('GETs the relative signed link through HttpClient as a blob (for the viewer and Download)', async () => {
      const got = firstValueFrom(
        s.lab.fileBlob({ url: '/api/public/lab-requests/file?token=abc', expires_at: 'x', filename: 'GVM-REQ-1.pdf' }),
      );
      const req = s.http.expectOne(`${base}/api/public/lab-requests/file?token=abc`);
      expect(req.request.method).toBe('GET');
      expect(req.request.responseType).toBe('blob');
      expect(req.request.headers.has(DOCUMENT_VIEWER_HEADER)).toBe(false);
      req.flush(new Blob(['%PDF-1.7'], { type: 'application/pdf' }));
      expect((await got).size).toBeGreaterThan(0);
    });
  });

  describe('doctor', () => {
    it('GETs the options', () => {
      s.lab.options().subscribe();
      const req = s.http.expectOne(`${base}/api/doctor/lab-requests/options`);
      expect(req.request.method).toBe('GET');
      expect(req.request.params.keys()).toEqual([]);
      req.flush(OK);
    });

    it('GETs the patient picker with search and paging, leaving out a blank search', () => {
      s.lab.patients({ search: 'chika', page: 2, per_page: 20 }).subscribe();
      const req = s.http.expectOne((r) => r.url === `${base}/api/doctor/lab-requests/patients`);
      expect(req.request.method).toBe('GET');
      expect(req.request.params.get('search')).toBe('chika');
      expect(req.request.params.get('page')).toBe('2');
      expect(req.request.params.get('per_page')).toBe('20');
      req.flush({ ...OK, data: [], meta: { total: 0, page: 2, per_page: 20, total_pages: 0 } });

      s.lab.patients({ search: '  ' }).subscribe();
      const blank = s.http.expectOne((r) => r.url === `${base}/api/doctor/lab-requests/patients`);
      expect(blank.request.params.keys()).toEqual([]);
      blank.flush(OK);

      s.lab.patients().subscribe();
      const none = s.http.expectOne((r) => r.url === `${base}/api/doctor/lab-requests/patients`);
      expect(none.request.params.keys()).toEqual([]);
      none.flush(OK);
    });

    it('GETs the context with patient_id, and appointment_id only when given', () => {
      s.lab.context('pat-1', 'ap-1').subscribe();
      const both = s.http.expectOne((r) => r.url === `${base}/api/doctor/lab-requests/context`);
      expect(both.request.method).toBe('GET');
      expect(both.request.params.get('patient_id')).toBe('pat-1');
      expect(both.request.params.get('appointment_id')).toBe('ap-1');
      both.flush(OK);

      s.lab.context('pat-1', null).subscribe();
      const nullAppt = s.http.expectOne((r) => r.url === `${base}/api/doctor/lab-requests/context`);
      expect(nullAppt.request.params.keys()).toEqual(['patient_id']);
      nullAppt.flush(OK);

      s.lab.context('pat-1').subscribe();
      const noAppt = s.http.expectOne((r) => r.url === `${base}/api/doctor/lab-requests/context`);
      expect(noAppt.request.params.has('appointment_id')).toBe(false);
      noAppt.flush(OK);
    });

    it('GETs the list with every filter, leaving out unset and blank ones', async () => {
      const page = firstValueFrom(
        s.lab.list({ group: 'in_progress', q: 'FBC', appointment_id: 'ap-1', patient_id: 'pat-1', page: 3, per_page: 10 }),
      );
      const req = s.http.expectOne((r) => r.url === `${base}/api/doctor/lab-requests`);
      expect(req.request.method).toBe('GET');
      expect(req.request.params.get('group')).toBe('in_progress');
      expect(req.request.params.get('q')).toBe('FBC');
      expect(req.request.params.get('appointment_id')).toBe('ap-1');
      expect(req.request.params.get('patient_id')).toBe('pat-1');
      expect(req.request.params.get('page')).toBe('3');
      expect(req.request.params.get('per_page')).toBe('10');
      const counts = { all: 5, awaiting_patient: 1, in_progress: 2, result_ready: 2 };
      req.flush({ status: 'success', message: 'OK', data: [], meta: { total: 5, page: 3, per_page: 10, total_pages: 1, counts } });
      expect((await page).meta.counts).toEqual(counts);

      s.lab.list({ group: 'all', q: '' }).subscribe();
      const blank = s.http.expectOne((r) => r.url === `${base}/api/doctor/lab-requests`);
      expect(blank.request.params.keys()).toEqual(['group']);
      blank.flush(OK);
    });

    it('always sends a group: all when the caller leaves it out (appointment panel, in-call panel)', () => {
      s.lab.list({ appointment_id: 'ap-1' }).subscribe();
      const panel = s.http.expectOne((r) => r.url === `${base}/api/doctor/lab-requests`);
      expect(panel.request.params.get('group')).toBe('all');
      expect(panel.request.params.get('appointment_id')).toBe('ap-1');
      expect(panel.request.params.keys().sort()).toEqual(['appointment_id', 'group']);
      panel.flush(OK);

      s.lab.list().subscribe();
      const plain = s.http.expectOne((r) => r.url === `${base}/api/doctor/lab-requests`);
      expect(plain.request.params.keys()).toEqual(['group']);
      expect(plain.request.params.get('group')).toBe('all');
      plain.flush(OK);

      s.lab.list({ group: undefined, patient_id: 'pat-1' }).subscribe();
      const undef = s.http.expectOne((r) => r.url === `${base}/api/doctor/lab-requests`);
      expect(undef.request.params.get('group')).toBe('all');
      undef.flush(OK);
    });

    it('POSTs create with the body as given, including client_key and catalogue_version', () => {
      const body = createBody();
      s.lab.create(body).subscribe();
      const req = s.http.expectOne(`${base}/api/doctor/lab-requests`);
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual(body);
      expect(req.request.body.client_key).toBe('6f1c2b9e-3d4a-4f5b-8c6d-7e8f9a0b1c2d');
      expect(req.request.body.catalogue_version).toBe('2026-11.1');
      req.flush({ ...OK, message: 'Request sent' }, { status: 201, statusText: 'Created' });
    });

    it('sends a body that leaves out pregnant / weeks_pregnant when Pregnant? is not asked', () => {
      // Type-checks only while the contract keeps both keys optional (spec §8.2 "pregnant omitted when not asked").
      const body: CreateLabRequestInput = createBody({
        clinical: { fasting: true, fasting_hours: 8, infection_alerts: [], transfusion_3m: null },
      });
      s.lab.create(body).subscribe();
      const req = s.http.expectOne(`${base}/api/doctor/lab-requests`);
      expect(req.request.body).toEqual(body);
      expect(Object.keys(req.request.body.clinical).sort()).toEqual(['fasting', 'fasting_hours', 'infection_alerts', 'transfusion_3m']);
      req.flush({ ...OK, message: 'Request sent' }, { status: 201, statusText: 'Created' });
    });

    it('re-sends the same client_key on a retry and never mints its own (idempotent send)', () => {
      const body = createBody({ signature: { mode: 'drawn', image: 'data:image/png;base64,AAAA', save: true } });

      let failed = false;
      s.lab.create(body).subscribe({ error: () => (failed = true) });
      s.http.expectOne(`${base}/api/doctor/lab-requests`).error(new ProgressEvent('error'));
      expect(failed).toBe(true);

      s.lab.create(body).subscribe();
      const retry = s.http.expectOne(`${base}/api/doctor/lab-requests`);
      expect(retry.request.body.client_key).toBe(body.client_key);
      expect(retry.request.body.signature).toEqual({ mode: 'drawn', image: 'data:image/png;base64,AAAA', save: true });
      retry.flush({ ...OK, message: 'Request already sent' });

      // After a 409 the caller mints a new key; the API layer sends whatever it is given.
      s.lab.create(createBody({ client_key: '0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d' })).subscribe();
      const fresh = s.http.expectOne(`${base}/api/doctor/lab-requests`);
      expect(fresh.request.body.client_key).toBe('0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d');
      fresh.flush(OK);
    });

    it('GETs one request with the id encoded', () => {
      s.lab.get('lab/1 2').subscribe();
      const req = s.http.expectOne(`${base}/api/doctor/lab-requests/lab%2F1%202`);
      expect(req.request.method).toBe('GET');
      req.flush(OK);
    });

    it('POSTs cancel with the reason', () => {
      s.lab.cancel('lab-1', 'Ordered for the wrong patient').subscribe();
      const req = s.http.expectOne(`${base}/api/doctor/lab-requests/lab-1/cancel`);
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({ reason: 'Ordered for the wrong patient' });
      req.flush(OK);
    });

    it('POSTs a review to the result', () => {
      s.lab.review('lab-1', 'res/1', { outcome: 'abnormal', comment: 'Low haemoglobin. Please book a follow-up.' }).subscribe();
      const req = s.http.expectOne(`${base}/api/doctor/lab-requests/lab-1/results/res%2F1/review`);
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({ outcome: 'abnormal', comment: 'Low haemoglobin. Please book a follow-up.' });
      req.flush(OK);

      s.lab.review('lab-1', 'res-2', { outcome: 'normal' }).subscribe();
      const normal = s.http.expectOne(`${base}/api/doctor/lab-requests/lab-1/results/res-2/review`);
      expect(normal.request.body).toEqual({ outcome: 'normal' });
      normal.flush(OK);
    });

    it('POSTs the PDF link with download false by default, true on request', () => {
      s.lab.link('lab-1').subscribe();
      const view = s.http.expectOne(`${base}/api/doctor/lab-requests/lab-1/link`);
      expect(view.request.method).toBe('POST');
      expect(view.request.body).toEqual({ download: false });
      view.flush(OK);

      s.lab.link('lab-1', true).subscribe();
      const dl = s.http.expectOne(`${base}/api/doctor/lab-requests/lab-1/link`);
      expect(dl.request.body).toEqual({ download: true });
      dl.flush(OK);
    });

    it('fetches a result for the viewer as a blob with X-SD-Viewer: 1 and reads the view headers', async () => {
      const view = firstValueFrom(s.lab.viewResult('lab 1', 'res/1'));
      const req = s.http.expectOne(`${base}/api/doctor/lab-requests/lab%201/results/res%2F1/file`);
      expect(req.request.method).toBe('GET');
      expect(req.request.headers.get(DOCUMENT_VIEWER_HEADER)).toBe('1');
      expect(req.request.headers.get('X-SD-Viewer')).toBe('1');
      expect(req.request.responseType).toBe('blob');
      req.flush(new Blob(['%PDF-1.7'], { type: 'application/pdf' }), {
        headers: {
          'Content-Type': 'application/pdf; charset=binary',
          'X-SD-View-Ref': 'VM-7F3A2C1D',
          'X-SD-Viewed-At': '2026-11-04T14:05:09+00:00',
        },
      });
      const out = await view;
      expect(out.mime).toBe('application/pdf');
      expect(out.viewRef).toBe('VM-7F3A2C1D');
      expect(out.viewedAt).toBe('2026-11-04T14:05:09+00:00');
      expect(out.blob.size).toBeGreaterThan(0);
    });

    it('maps a missing or malformed view ref to null and a missing time to now', async () => {
      const missing = firstValueFrom(s.lab.viewResult('lab-1', 'res-1'));
      s.http
        .expectOne(`${base}/api/doctor/lab-requests/lab-1/results/res-1/file`)
        .flush(new Blob(['x'], { type: 'image/png' }));
      const a = await missing;
      expect(a.viewRef).toBeNull();
      expect(a.mime).toBe('image/png');
      expect(Number.isFinite(Date.parse(a.viewedAt))).toBe(true);

      const malformed = firstValueFrom(s.lab.viewResult('lab-1', 'res-1'));
      s.http
        .expectOne(`${base}/api/doctor/lab-requests/lab-1/results/res-1/file`)
        .flush(new Blob(['x'], { type: 'image/webp' }), {
          headers: { 'Content-Type': 'image/webp', 'X-SD-View-Ref': 'vm-7f3a2c1d', 'X-SD-Viewed-At': 'not a date' },
        });
      const b = await malformed;
      expect(b.viewRef).toBeNull();
      expect(b.viewedAt).not.toBe('not a date');
      expect(Number.isFinite(Date.parse(b.viewedAt))).toBe(true);
    });

    it('records a print with { view_ref } when there is one, else {}', () => {
      s.lab.resultPrinted('lab-1', 'res-1', null).subscribe();
      const bare = s.http.expectOne(`${base}/api/doctor/lab-requests/lab-1/results/res-1/printed`);
      expect(bare.request.method).toBe('POST');
      expect(bare.request.body).toEqual({});
      bare.flush({ status: 'success', message: 'Recorded', data: { recorded: true } });

      s.lab.resultPrinted('lab-1', 'res-1', 'VM-7F3A2C1D').subscribe();
      const withRef = s.http.expectOne(`${base}/api/doctor/lab-requests/lab-1/results/res-1/printed`);
      expect(withRef.request.body).toEqual({ view_ref: 'VM-7F3A2C1D' });
      withRef.flush(OK);
    });
  });

  describe('patient', () => {
    it('GETs my list with group, appointment and paging', () => {
      s.lab.mine({ group: 'awaiting_patient', appointment_id: 'ap-1', page: 1, per_page: 20 }).subscribe();
      const req = s.http.expectOne((r) => r.url === `${base}/api/portal/lab-requests`);
      expect(req.request.method).toBe('GET');
      expect(req.request.params.get('group')).toBe('awaiting_patient');
      expect(req.request.params.get('appointment_id')).toBe('ap-1');
      expect(req.request.params.get('page')).toBe('1');
      expect(req.request.params.get('per_page')).toBe('20');
      req.flush(OK);

      s.lab.mine().subscribe();
      const plain = s.http.expectOne((r) => r.url === `${base}/api/portal/lab-requests`);
      expect(plain.request.params.keys()).toEqual(['group']);
      expect(plain.request.params.get('group')).toBe('all');
      plain.flush(OK);

      // The in-call labs tab passes only the appointment.
      s.lab.mine({ appointment_id: 'ap-2' }).subscribe();
      const call = s.http.expectOne((r) => r.url === `${base}/api/portal/lab-requests`);
      expect(call.request.params.get('group')).toBe('all');
      expect(call.request.params.get('appointment_id')).toBe('ap-2');
      call.flush(OK);
    });

    it('GETs one of my requests', () => {
      s.lab.mineOne('lab/1').subscribe();
      const req = s.http.expectOne(`${base}/api/portal/lab-requests/lab%2F1`);
      expect(req.request.method).toBe('GET');
      req.flush(OK);
    });

    it('POSTs accept with the three agreements, the share choice and the optional lab details', () => {
      const body = {
        consent_version: 'LAB-2026-11.1',
        agree_tests: true as const,
        agree_pays_lab: true as const,
        agree_disclosure: true as const,
        share_results: true,
        lab_name: 'Synlab Ikeja',
        lab_date: '2026-11-06',
      };
      s.lab.accept('lab-1', body).subscribe();
      const req = s.http.expectOne(`${base}/api/portal/lab-requests/lab-1/accept`);
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual(body);
      req.flush(OK);
    });

    it('POSTs decline with the reason only when one is given', () => {
      s.lab.decline('lab-1', "I'll do these tests next month").subscribe();
      const withReason = s.http.expectOne(`${base}/api/portal/lab-requests/lab-1/decline`);
      expect(withReason.request.method).toBe('POST');
      expect(withReason.request.body).toEqual({ reason: "I'll do these tests next month" });
      withReason.flush(OK);

      s.lab.decline('lab-1').subscribe();
      const none = s.http.expectOne(`${base}/api/portal/lab-requests/lab-1/decline`);
      expect(Object.keys(none.request.body)).toEqual([]);
      none.flush(OK);

      s.lab.decline('lab-1', '   ').subscribe();
      const blank = s.http.expectOne(`${base}/api/portal/lab-requests/lab-1/decline`);
      expect(Object.keys(blank.request.body)).toEqual([]);
      blank.flush(OK);
    });

    it('resolves decline and sample with the message whatever data the API sends (the caller reloads)', async () => {
      const declined = firstValueFrom(s.lab.decline('lab-1'));
      s.http.expectOne(`${base}/api/portal/lab-requests/lab-1/decline`).flush({ status: 'success', message: 'Request declined', data: null });
      expect(await declined).toEqual({ status: 'success', message: 'Request declined', data: null });

      const sampled = firstValueFrom(s.lab.sampleGiven('lab-1'));
      s.http.expectOne(`${base}/api/portal/lab-requests/lab-1/sample`).flush({ status: 'success', message: 'Sample recorded', data: null });
      expect((await sampled).message).toBe('Sample recorded');
    });

    it('POSTs the sample with {}', () => {
      s.lab.sampleGiven('lab-1').subscribe();
      const req = s.http.expectOne(`${base}/api/portal/lab-requests/lab-1/sample`);
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({});
      req.flush(OK);
    });

    const file = () => new File(['%PDF'], 'fbc-result.pdf', { type: 'application/pdf' });

    it('uploads a result as multipart with every field, reporting progress events', () => {
      const events: HttpEvent<unknown>[] = [];
      s.lab
        .uploadResult('lab/1', file(), {
          document_type: 'laboratory_test_report',
          item_ids: ['it-1', 'it-2', '', 'it-1'],
          share: true,
          exclude_specialist_ids: ['sp-9', '', 'sp-8'],
        })
        .subscribe((e) => events.push(e));
      const req = s.http.expectOne(`${base}/api/portal/lab-requests/lab%2F1/results`);
      expect(req.request.method).toBe('POST');
      expect(req.request.reportProgress).toBe(true);
      const form = req.request.body as FormData;
      expect(form).toBeInstanceOf(FormData);
      const sent = form.get('file');
      expect(sent).toBeInstanceOf(File);
      expect((sent as File).name).toBe('fbc-result.pdf');
      expect(form.get('document_type')).toBe('laboratory_test_report');
      expect(form.getAll('item_ids[]')).toEqual(['it-1', 'it-2']);
      expect(form.get('share')).toBe('1');
      expect(form.getAll('exclude_specialist_ids[]')).toEqual(['sp-9', 'sp-8']);
      expect([...new Set(form.keys())].sort()).toEqual(['document_type', 'exclude_specialist_ids[]', 'file', 'item_ids[]', 'share']);

      req.event({ type: HttpEventType.UploadProgress, loaded: 2, total: 4 });
      req.flush({ status: 'success', message: 'Result added', data: { result: {}, request: {} } }, { status: 201, statusText: 'Created' });
      const types = events.map((e) => e.type);
      expect(types).toContain(HttpEventType.Sent);
      expect(types).toContain(HttpEventType.UploadProgress);
      expect(types[types.length - 1]).toBe(HttpEventType.Response);
    });

    it('sends share 0 and leaves out the empty optional fields', () => {
      s.lab.uploadResult('lab-1', file(), { share: false, item_ids: [], exclude_specialist_ids: [] }).subscribe();
      const req = s.http.expectOne(`${base}/api/portal/lab-requests/lab-1/results`);
      const form = req.request.body as FormData;
      expect(form.get('share')).toBe('0');
      expect(form.has('item_ids[]')).toBe(false);
      expect(form.has('exclude_specialist_ids[]')).toBe(false);
      expect(form.has('document_type')).toBe(false);
      expect([...form.keys()].sort()).toEqual(['file', 'share']);
      req.flush(OK);

      s.lab.uploadResult('lab-1', file(), { share: true }).subscribe();
      const minimal = s.http.expectOne(`${base}/api/portal/lab-requests/lab-1/results`);
      const minimalForm = minimal.request.body as FormData;
      expect([...minimalForm.keys()].sort()).toEqual(['file', 'share']);
      expect(minimalForm.get('share')).toBe('1');
      minimal.flush(OK);
    });

    it('POSTs my PDF link with download false by default, true on request', () => {
      s.lab.myLink('lab-1').subscribe();
      const view = s.http.expectOne(`${base}/api/portal/lab-requests/lab-1/link`);
      expect(view.request.method).toBe('POST');
      expect(view.request.body).toEqual({ download: false });
      view.flush(OK);

      s.lab.myLink('lab-1', true).subscribe();
      const dl = s.http.expectOne(`${base}/api/portal/lab-requests/lab-1/link`);
      expect(dl.request.body).toEqual({ download: true });
      dl.flush(OK);
    });
  });

  describe('back office', () => {
    it("GETs a patient's lab requests", () => {
      s.lab.forPatient('pat/1').subscribe();
      const req = s.http.expectOne(`${base}/api/admin/patients/pat%2F1/lab-requests`);
      expect(req.request.method).toBe('GET');
      req.flush({ ...OK, data: [] });
    });

    it('POSTs the staff PDF link', () => {
      s.lab.staffLink('lab-1').subscribe();
      const view = s.http.expectOne(`${base}/api/admin/lab-requests/lab-1/link`);
      expect(view.request.method).toBe('POST');
      expect(view.request.body).toEqual({ download: false });
      view.flush(OK);

      s.lab.staffLink('lab-1', true).subscribe();
      const dl = s.http.expectOne(`${base}/api/admin/lab-requests/lab-1/link`);
      expect(dl.request.body).toEqual({ download: true });
      dl.flush(OK);
    });

    it('POSTs a status correction, with sample_date only when given', () => {
      s.lab.correctStatus('lab-1', { status: 'in_lab', reason: 'Patient phoned support: sample taken 5 Nov', sample_date: '2026-11-05' }).subscribe();
      const dated = s.http.expectOne(`${base}/api/admin/lab-requests/lab-1/status`);
      expect(dated.request.method).toBe('POST');
      expect(dated.request.body).toEqual({ status: 'in_lab', reason: 'Patient phoned support: sample taken 5 Nov', sample_date: '2026-11-05' });
      dated.flush(OK);

      for (const sample_date of ['', null, undefined]) {
        s.lab.correctStatus('lab-1', { status: 'in_lab', reason: 'Patient phoned support', sample_date }).subscribe();
        const req = s.http.expectOne(`${base}/api/admin/lab-requests/lab-1/status`);
        expect(Object.keys(req.request.body).sort()).toEqual(['reason', 'status']);
        req.flush(OK);
      }

      s.lab.correctStatus('lab-1', { status: 'awaiting_consent', reason: 'Declined by mistake' }).subscribe();
      const reopen = s.http.expectOne(`${base}/api/admin/lab-requests/lab-1/status`);
      expect(reopen.request.body).toEqual({ status: 'awaiting_consent', reason: 'Declined by mistake' });
      reopen.flush(OK);
    });
  });
});

/**
 * The DTO key fixture the API's DtoShapeTest compares with LabRequestPresenter.
 * It sits in shared-models; it is read from disk (not imported) because it is
 * data shared with PHP, not a dependency of this library.
 */
describe('lab-request-keys fixture', () => {
  /** Every key of T: a missing or extra key fails the type-check. */
  type KeySet<T> = { readonly [K in keyof Required<T>]: true };
  type Item<T> = T extends readonly (infer U)[] ? U : never;
  const keys = <T>(set: KeySet<T>): string[] => Object.keys(set);

  const fixture = JSON.parse(
    readFileSync(resolve(__dirname, '../../../models/src/lib/lab-request-keys.fixture.json'), 'utf8'),
  ) as Record<string, string[]>;

  const doctorSummary: KeySet<LabRequestSummaryDto> = {
    id: true, number: true, status: true, priority: true, appointment_id: true, patient: true, clinical_question: true,
    tests_label: true, items_count: true, counts: true, results_count: true, unreviewed_count: true, abnormal: true,
    sent_at: true, valid_until: true, expires_at: true, last_activity_at: true,
  };
  const patientSummary: KeySet<PatientLabRequestSummaryDto> = {
    id: true, number: true, status: true, priority: true, doctor: true, items_count: true, results_count: true,
    reviewed: true, awaiting_review: true, appointment_id: true, sent_at: true, valid_until: true, expires_at: true,
    last_activity_at: true,
  };
  const event: KeySet<LabRequestEventDto> = {
    event: true, from_status: true, to_status: true, actor_role: true, actor_name: true, at: true, sample_date: true,
  };
  const consent: KeySet<NonNullable<LabRequestDto['consent']>> = { version: true, consented_at: true, share_results: true };

  const expected: Record<string, string[]> = {
    doctor_summary: keys<LabRequestSummaryDto>(doctorSummary),
    doctor_detail: keys<LabRequestDto>({
      ...doctorSummary, appointment_scheduled_at: true, purpose: true, history: true, medication: true, allergies: true,
      clinical: true, imaging_safety: true, catalogue_version: true, items: true, prescriber: true, patient_snapshot: true,
      consent: true, lab_name: true, lab_date: true, declined_at: true, decline_reason: true, sample_at: true,
      result_ready_at: true, reviewed_at: true, cancelled_at: true, cancel_reason: true, expired_at: true,
      duplicated_from: true, results: true, timeline: true, can: true,
    }),
    doctor_result: keys<DoctorLabResultDto>({
      id: true, uploaded_at: true, item_ids: true, visible: true, reviewable: true, document: true, review: true,
    }),
    patient_summary: keys<PatientLabRequestSummaryDto>(patientSummary),
    patient_detail: keys<PatientLabRequestDto>({
      ...patientSummary, clinical_question: true, purpose: true, items: true, instructions: true, consent_version: true,
      consent_statements: true, consent: true, lab_name: true, lab_date: true, declined_at: true, decline_reason: true,
      sample_at: true, result_ready_at: true, cancelled_at: true, cancel_reason: true, expired_at: true,
      results_sharing: true, doctor_available: true, results: true, timeline: true, can: true,
      result_document_types: true, default_document_type: true,
    }),
    patient_result: keys<PatientLabResultDto>({
      id: true, uploaded_at: true, item_ids: true, document: true, share_outcome: true, shared_now: true, viewable: true,
      reviewable: true, review: true,
    }),
    admin_row: keys<AdminLabRequestSummaryDto>({
      id: true, number: true, status: true, priority: true, doctor_name: true, items_count: true, results_count: true,
      sent_at: true, last_activity_at: true, corrections: true, consented_on: true, last_correction_note: true,
    }),
    'doctor_summary.patient': keys<LabRequestSummaryDto['patient']>({ id: true, name: true, age: true, sex: true }),
    'doctor_summary.counts': keys<LabRequestSummaryDto['counts']>({ lab: true, imaging: true, physiological: true }),
    'doctor_detail.clinical': keys<LabRequestDto['clinical']>({
      fasting: true, fasting_hours: true, pregnancy_asked: true, pregnant: true, weeks_pregnant: true,
      infection_alerts: true, transfusion_3m: true,
    }),
    'doctor_detail.imaging_safety': keys<NonNullable<LabRequestDto['imaging_safety']>>({
      contrast_allergy: true, mobility: true, pregnant: true,
    }),
    'doctor_detail.items': keys<Item<LabRequestDto['items']>>({
      id: true, position: true, code: true, kind: true, category: true, modality: true, site: true, label: true,
      short: true, specimen_mode: true, specimen_code: true, specimen_label: true, preparation_code: true,
      preparation_label: true, contrast_possible: true, ionising: true,
    }),
    'doctor_detail.prescriber': keys<LabRequestDto['prescriber']>({
      id: true, name: true, specialty: true, qualifications: true, registration_label: true, registration_number: true,
    }),
    'doctor_detail.patient_snapshot': keys<LabRequestDto['patient_snapshot']>({
      name: true, reference: true, email: true, date_of_birth: true, age: true, sex: true,
    }),
    'doctor_detail.consent': keys<NonNullable<LabRequestDto['consent']>>(consent),
    'doctor_detail.timeline': keys<Item<LabRequestDto['timeline']>>(event),
    'doctor_detail.can': keys<LabRequestDto['can']>({ cancel: true, review: true, duplicate: true }),
    'doctor_result.document': keys<NonNullable<DoctorLabResultDto['document']>>({
      title: true, type_label: true, extension: true, size_label: true, viewable: true,
    }),
    'doctor_result.review': keys<NonNullable<DoctorLabResultDto['review']>>({ outcome: true, comment: true, reviewed_at: true }),
    'patient_summary.doctor': keys<PatientLabRequestSummaryDto['doctor']>({ id: true, name: true, specialty: true }),
    'patient_detail.items': keys<Item<PatientLabRequestDto['items']>>({
      id: true, kind: true, label: true, short: true, specimen_label: true, preparation_code: true, preparation_label: true,
    }),
    'patient_detail.instructions': keys<Item<PatientLabRequestDto['instructions']>>({ key: true, title: true, text: true }),
    'patient_detail.consent_statements': keys<Item<PatientLabRequestDto['consent_statements']>>({
      key: true, text: true, required: true, default: true,
    }),
    'patient_detail.consent': keys<NonNullable<PatientLabRequestDto['consent']>>(consent),
    'patient_detail.timeline': keys<Item<PatientLabRequestDto['timeline']>>(event),
    'patient_detail.can': keys<PatientLabRequestDto['can']>({ accept: true, decline: true, sample: true, upload: true, pdf: true }),
    'patient_detail.result_document_types': keys<Item<PatientLabRequestDto['result_document_types']>>({ value: true, label: true }),
    'patient_result.document': keys<PatientLabResultDto['document']>({
      id: true, title: true, type_label: true, extension: true, size_label: true,
    }),
    'patient_result.review': keys<NonNullable<PatientLabResultDto['review']>>({ comment: true, reviewed_at: true }),
  };

  const sorted = (list: readonly string[]) => [...list].sort();

  it('pins every DTO and every nested object, key for key, with the interfaces', () => {
    expect(sorted(Object.keys(fixture))).toEqual(sorted(Object.keys(expected)));
    for (const [section, list] of Object.entries(expected)) {
      const pinned = fixture[section] ?? [];
      expect(new Set(pinned).size, `${section} has a duplicate key`).toBe(pinned.length);
      expect(sorted(pinned), section).toEqual(sorted(list));
    }
  });

  it('pins the prescriber as registration_number (the stored snapshot says mdcn_number)', () => {
    expect(fixture['doctor_detail.prescriber']).toContain('registration_number');
    expect(fixture['doctor_detail.prescriber']).toContain('registration_label');
    for (const [section, list] of Object.entries(fixture)) expect(list, section).not.toContain('mdcn_number');
  });

  it('keeps clinical content and review outcomes out of patient and back-office payloads, and staff notes out of all', () => {
    const clinical = ['outcome', 'abnormal', 'clinical', 'history', 'medication', 'allergies', 'imaging_safety',
      'infection_alerts', 'transfusion_3m', 'pregnant', 'weeks_pregnant', 'pregnancy_asked'];
    expect(fixture['patient_result.review']).toEqual(['comment', 'reviewed_at']);
    for (const [section, list] of Object.entries(fixture)) {
      expect(list, section).not.toContain('staff_note');
      if (section.startsWith('patient_') || section === 'admin_row') {
        for (const key of clinical) expect(list, `${section} must not carry ${key}`).not.toContain(key);
      }
    }
    for (const key of ['clinical_question', 'tests_label', 'items']) expect(fixture['admin_row']).not.toContain(key);
  });
});
