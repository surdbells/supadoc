import { HttpEventType, provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { API_CONFIG } from '@supadoc/data-access';
import type {
  DoctorAccessSummaryDto,
  LabResultUploadedDto,
  LabResultsSharing,
  PatientLabRequestDto,
  SharingDoctorDto,
} from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import {
  LabResultUploadDialog,
  type LabUploadRefused,
} from './lab-result-upload-dialog';

const BASE = 'http://api.test';
const UPLOAD = `${BASE}/api/portal/lab-requests/lr-1/results`;
const DOCTORS = `${BASE}/api/portal/document-access/doctors`;

function access(
  over: Partial<DoctorAccessSummaryDto> = {},
): DoctorAccessSummaryDto {
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

function doctor(
  id: string,
  name: string,
  folder: 'none' | 'active' | 'paused' = 'none',
): SharingDoctorDto {
  return {
    specialist: { id, name, specialty: null, photo_url: null },
    can_share: folder !== 'paused',
    unavailable_reason: null,
    last_appointment_at: null,
    next_appointment: null,
    access:
      folder === 'none'
        ? access()
        : access({
            state: folder,
            scope: 'all',
            folder_indefinite: true,
            indefinite: true,
          }),
    pending_request: null,
    requests_blocked: false,
  };
}

function request(
  over: Partial<PatientLabRequestDto> = {},
): PatientLabRequestDto {
  return {
    id: 'lr-1',
    number: 'GVM-REQ-20261104-00012',
    status: 'booked',
    priority: 'routine',
    doctor: { id: 'sp-req', name: 'Dr. Grace Bell', specialty: 'Cardiology' },
    items_count: 2,
    results_count: 0,
    reviewed: false,
    awaiting_review: false,
    appointment_id: null,
    sent_at: '2026-11-04T10:00:00Z',
    valid_until: '2026-12-04',
    expires_at: '2026-12-04T23:00:00Z',
    last_activity_at: '2026-11-04T10:00:00Z',
    clinical_question: 'Tiredness',
    purpose: 'diagnosis',
    items: [
      {
        id: 'i-1',
        kind: 'lab',
        label: 'FBC - Full Blood Count',
        short: 'FBC',
        specimen_label: 'Whole blood (EDTA)',
        preparation_code: null,
        preparation_label: null,
      },
      {
        id: 'i-2',
        kind: 'lab',
        label: 'MP - Malaria Parasite',
        short: 'MP',
        specimen_label: 'Whole blood (EDTA)',
        preparation_code: null,
        preparation_label: null,
      },
    ],
    instructions: [],
    consent_version: 'LAB-2026-11.1',
    consent_statements: [],
    consent: {
      version: 'LAB-2026-11.1',
      consented_at: '2026-11-04T11:00:00Z',
      share_results: true,
    },
    lab_name: null,
    lab_date: null,
    declined_at: null,
    decline_reason: null,
    sample_at: null,
    result_ready_at: null,
    cancelled_at: null,
    cancel_reason: null,
    expired_at: null,
    results_sharing: 'none',
    doctor_available: true,
    results: [],
    timeline: [],
    can: {
      accept: false,
      decline: false,
      sample: true,
      upload: true,
      pdf: true,
    },
    result_document_types: [
      { value: 'laboratory_test_report', label: 'Laboratory Test Report' },
      { value: 'blood_test_report', label: 'Blood Test Report' },
    ],
    default_document_type: 'blood_test_report',
    ...over,
  };
}

@Component({
  imports: [LabResultUploadDialog],
  template: `
    @if (show()) {
      <pat-lab-result-upload-dialog
        [request]="req()"
        (uploaded)="uploads.push($event)"
        (refused)="refusals.push($event)"
        (closed)="show.set(false)"
      />
    }
  `,
})
class Host {
  readonly show = signal(false);
  readonly req = signal(request());
  readonly uploads: LabResultUploadedDto[] = [];
  readonly refusals: LabUploadRefused[] = [];
}

describe('LabResultUploadDialog', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;
  let el: HTMLElement;
  let http: HttpTestingController;

  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const text = () => el.textContent?.replace(/\s+/g, ' ') ?? '';
  const dialog = (): LabResultUploadDialog =>
    fixture.debugElement.query(By.directive(LabResultUploadDialog))
      .componentInstance as LabResultUploadDialog;
  const uploadButton = () =>
    Array.from(el.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Upload',
    ) as HTMLButtonElement;
  const shareBox = () =>
    el.querySelector<HTMLInputElement>(
      '[data-testid="lab-share"]',
    ) as HTMLInputElement;
  const folderBox = (id: string) =>
    el.querySelector<HTMLInputElement>(`[data-folder="${id}"]`);
  const itemBox = (id: string) =>
    el.querySelector<HTMLInputElement>(
      `[data-item="${id}"]`,
    ) as HTMLInputElement;
  const pick = async (name: string, size = 3) => {
    const file = new File(['x'.repeat(size)], name);
    (dialog() as unknown as { pick(f: File[]): void }).pick([file]);
    await render();
  };
  const open = async (
    over: Partial<PatientLabRequestDto> = {},
    doctors: SharingDoctorDto[] | null = [],
  ) => {
    host.req.set(request(over));
    host.show.set(true);
    await render();
    if (doctors) {
      http
        .expectOne(DOCTORS)
        .flush({ status: 'success', message: 'OK', data: doctors });
      await render();
    }
  };
  const submit = async () => {
    uploadButton().click();
    await render();
  };
  const nextUpload = (): TestRequest =>
    http.expectOne((r) => r.method === 'POST' && r.url === UPLOAD);
  const form = (req: TestRequest) => req.request.body as FormData;
  const response = (
    over: Partial<LabResultUploadedDto['result']> = {},
  ): { status: string; message: string; data: LabResultUploadedDto } => ({
    status: 'success',
    message: 'Result added',
    data: {
      result: {
        id: 'res-1',
        uploaded_at: '2026-11-05T10:00:00Z',
        item_ids: ['i-1', 'i-2'],
        document: {
          id: 'd-1',
          title: 'result',
          type_label: 'Blood Test Report',
          extension: 'pdf',
          size_label: '1KB',
        },
        share_outcome: 'shared',
        shared_now: true,
        viewable: true,
        reviewable: true,
        review: null,
        ...over,
      },
      request: request({ status: 'result_ready', results_count: 1 }),
    },
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

  it('takes one result file (E13 types), the request’s default type, and every test ticked', async () => {
    await open();
    expect(text()).toContain('Upload result');
    expect(text()).toContain('Add the result file the lab gave you.');
    expect(text()).toContain('Click to upload or drag and drop');
    expect(text()).toContain(
      'PDF, JPG, PNG, WEBP, DICOM (.dcm) or Word, up to 10MB',
    );
    const input = el.querySelector<HTMLInputElement>(
      'input[type="file"]',
    ) as HTMLInputElement;
    expect(input.accept).toBe(
      '.pdf,.jpg,.jpeg,.png,.webp,.dcm,.docx,application/pdf,image/jpeg,image/png,image/webp,application/dicom,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(input.multiple).toBe(false);
    const select = el.querySelector<HTMLSelectElement>(
      '#lab-upload-type',
    ) as HTMLSelectElement;
    expect(select.value).toBe('blood_test_report');
    expect(itemBox('i-1').checked).toBe(true);
    expect(itemBox('i-2').checked).toBe(true);
    await pick('clip.mov');
    expect(text()).toContain(
      'Upload a PDF, photo (JPG, PNG, WEBP), DICOM (.dcm) or Word file.',
    );
  });

  it('Share is ticked while the grant is active, and before any grant when the patient agreed', async () => {
    await open({ results_sharing: 'active' });
    expect(shareBox().checked).toBe(true);
    expect(text()).toContain('Share this result with Dr. Grace Bell');
    expect(text()).toContain(
      'Dr. Grace Bell can view and print it in VideoMed, but not download it.',
    );
    host.show.set(false);
    await render();
    await open({ results_sharing: 'none' });
    expect(shareBox().checked).toBe(true);
    host.show.set(false);
    await render();
    await open({
      results_sharing: 'none',
      consent: {
        version: 'LAB-2026-11.1',
        consented_at: '',
        share_results: false,
      },
    });
    expect(shareBox().checked).toBe(false);
  });

  it('after the patient stopped sharing: unticked, with "You stopped sharing…"', async () => {
    await open({ results_sharing: 'ended' as LabResultsSharing });
    expect(shareBox().checked).toBe(false);
    expect(text()).toContain(
      "You stopped sharing this request's results with Dr. Grace Bell. Tick to share this file with them.",
    );
    expect(shareBox().getAttribute('aria-describedby')).toBe(
      'lab-upload-share-note lab-upload-share-ended',
    );
  });

  it('lists other whole-folder holders unticked (never the requesting doctor) and excludes the unticked', async () => {
    await open({}, [
      doctor('sp-req', 'Dr. Grace Bell', 'active'),
      doctor('sp-b', 'Bayo Ade', 'active'),
      doctor('sp-c', 'Chi Okoro', 'paused'),
      doctor('sp-d', 'Dami Lee'),
    ]);
    expect(text()).toContain('Doctors who can see your whole folder');
    expect(folderBox('sp-req')).toBeNull();
    expect(folderBox('sp-d')).toBeNull();
    expect(folderBox('sp-b')?.checked).toBe(false);
    expect(folderBox('sp-c')?.checked).toBe(false);
    expect(text()).toContain('Also let Dr Bayo Ade see this file');
    expect(text()).toContain('Whole folder with no end date');
    // Tick B: only C is excluded.
    const b = folderBox('sp-b') as HTMLInputElement;
    b.checked = true;
    b.dispatchEvent(new Event('change'));
    await render();
    await pick('result.pdf');
    await submit();
    const req = nextUpload();
    expect(form(req).getAll('exclude_specialist_ids[]')).toEqual(['sp-c']);
    expect(form(req).get('share')).toBe('1');
    expect(form(req).get('document_type')).toBe('blood_test_report');
    expect(form(req).getAll('item_ids[]')).toEqual(['i-1', 'i-2']);
    req.flush(response());
    await render();
  });

  it('Upload stays disabled until the folder list has loaded (and offers a retry when it fails)', async () => {
    await open({}, null);
    expect(text()).toContain('Checking who can see your folder…');
    expect(uploadButton().disabled).toBe(true);
    http
      .expectOne(DOCTORS)
      .flush({ message: 'down' }, { status: 500, statusText: 'Server Error' });
    await render();
    expect(text()).toContain(
      "Couldn't check who can see your folder. Try again.",
    );
    expect(uploadButton().disabled).toBe(true);
    (
      Array.from(el.querySelectorAll('button')).find(
        (x) => x.textContent?.trim() === 'Try again',
      ) as HTMLButtonElement
    ).click();
    await render();
    http
      .expectOne(DOCTORS)
      .flush({ status: 'success', message: 'OK', data: [] });
    await render();
    expect(uploadButton().disabled).toBe(false);
  });

  it('sharing switched off: no fieldset, and Upload may go', async () => {
    await open({}, null);
    http
      .expectOne(DOCTORS)
      .flush(
        {
          status: 'error',
          message: 'off',
          errors: { code: 'sharing_unavailable' },
        },
        { status: 503, statusText: 'Unavailable' },
      );
    await render();
    expect(text()).not.toContain('Doctors who can see your whole folder');
    expect(text()).not.toContain('Checking who can see your folder');
    expect(uploadButton().disabled).toBe(false);
  });

  it('warns when sharing a DOCX or DICOM the doctor can’t open (not when unshared)', async () => {
    await open();
    await pick('report.docx');
    expect(
      el.querySelector('[data-testid="lab-view-warning"]')?.textContent,
    ).toContain(
      "Dr. Grace Bell can't open DOCX files in VideoMed. Share a PDF or photo.",
    );
    await pick('scan.dcm');
    expect(
      el.querySelector('[data-testid="lab-view-warning"]')?.textContent,
    ).toContain("can't open DCM files");
    shareBox().checked = false;
    shareBox().dispatchEvent(new Event('change'));
    await render();
    expect(el.querySelector('[data-testid="lab-view-warning"]')).toBeNull();
  });

  it('needs at least one test; sends only the ticked ones and share 0 when unticked', async () => {
    await open();
    await pick('result.pdf');
    for (const id of ['i-1', 'i-2']) {
      itemBox(id).checked = false;
      itemBox(id).dispatchEvent(new Event('change'));
    }
    await render();
    await submit();
    expect(text()).toContain('Choose at least one test.');
    http.expectNone((r) => r.url === UPLOAD);
    itemBox('i-2').checked = true;
    itemBox('i-2').dispatchEvent(new Event('change'));
    shareBox().checked = false;
    shareBox().dispatchEvent(new Event('change'));
    await render();
    await submit();
    const req = nextUpload();
    expect(form(req).getAll('item_ids[]')).toEqual(['i-2']);
    expect(form(req).get('share')).toBe('0');
    expect(form(req).getAll('exclude_specialist_ids[]')).toEqual([]);
    req.flush(response({ share_outcome: 'private' }));
    await render();
  });

  it('shows progress while uploading, then hands the result to the page and closes', async () => {
    await open();
    await pick('result.pdf');
    await submit();
    const req = nextUpload();
    expect(dialog().uploading()).toBe(true);
    req.event({ type: HttpEventType.UploadProgress, loaded: 1, total: 2 });
    await render();
    const bar = el.querySelector('[role="progressbar"]') as HTMLElement;
    expect(bar.getAttribute('aria-valuenow')).toBe('50');
    expect(bar.getAttribute('aria-label')).toBe('Uploading…');
    req.flush(response());
    await render();
    expect(host.uploads).toHaveLength(1);
    expect(host.uploads[0].result.share_outcome).toBe('shared');
  });

  it('a 409 status_changed: nothing stored, the page gets the message (and reloads)', async () => {
    await open();
    await pick('result.pdf');
    await submit();
    nextUpload().flush(
      {
        status: 'error',
        message: 'This request was cancelled.',
        errors: { code: 'status_changed', status: 'cancelled' },
      },
      { status: 409, statusText: 'Conflict' },
    );
    await render();
    expect(host.refusals).toEqual([{ message: 'This request was cancelled.' }]);
    expect(host.uploads).toHaveLength(0);
  });

  it('other errors stay in the dialog (role="alert")', async () => {
    await open();
    await pick('result.pdf');
    await submit();
    nextUpload().flush(
      {
        status: 'error',
        message: 'Validation failed',
        errors: {
          results: 'You can add up to 10 result files to one request.',
        },
      },
      { status: 422, statusText: 'Unprocessable' },
    );
    await render();
    const alert = Array.from(el.querySelectorAll('[role="alert"]')).find((a) =>
      a.textContent?.includes('up to 10 result files'),
    );
    expect(alert).toBeTruthy();
    expect(dialog().uploading()).toBe(false);
  });
});
