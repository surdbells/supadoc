import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { API_CONFIG } from '@supadoc/data-access';
import type {
  DoctorAccessSummaryDto,
  SharingAppointmentRefDto,
  SharingDoctorDto,
  UploadedDocumentDto,
} from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { DocumentUploadDialog } from './document-upload-dialog';

const BASE = 'http://api.test';
const UPLOAD = `${BASE}/api/portal/documents`;

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

function doctor(id: string, name: string, folder = false): SharingDoctorDto {
  return {
    specialist: { id, name, specialty: null, photo_url: null },
    can_share: true,
    unavailable_reason: null,
    last_appointment_at: null,
    next_appointment: null,
    access: folder ? access({ state: 'active', scope: 'all', folder_indefinite: true, indefinite: true }) : access(),
    pending_request: null,
    requests_blocked: false,
  };
}

const appointment: SharingAppointmentRefDto = {
  id: 'ap-1',
  scheduled_at: '2030-10-28T15:00:00Z',
  ends_at: '2030-10-28T15:30:00Z',
  after_options: { after_24h: '2030-10-29T15:30:00Z', after_7d: '2030-11-04T15:30:00Z', after_30d: null },
};

function uploaded(over: Partial<UploadedDocumentDto> = {}): UploadedDocumentDto {
  return {
    id: 'd-1',
    patient_id: 'p',
    uploader_role: 'patient',
    uploader_name: 'Ada Obi',
    appointment_id: null,
    document_type: 'lab',
    custom_type: null,
    type_label: 'Lab result',
    title: 'scan',
    extension: 'pdf',
    mime_type: 'application/pdf',
    size_bytes: 3,
    size_label: '1kb',
    created_at: '2026-10-21T10:00:00Z',
    shared_with: [],
    share_outcome: 'private',
    share_ended_for: [],
    ...over,
  };
}

@Component({
  imports: [DocumentUploadDialog],
  template: `
    @if (show()) {
      <pat-document-upload-dialog
        [presetDoctorId]="preset()"
        [appointment]="appt()"
        [lockDoctor]="!!preset()"
        [surface]="preset() ? 'appointment_details' : 'documents_page'"
        (uploaded)="docs.push($event)"
        (closed)="show.set(false)"
      />
    }
  `,
})
class Host {
  readonly show = signal(false);
  readonly preset = signal<string | null>(null);
  readonly appt = signal<SharingAppointmentRefDto | null>(null);
  readonly docs: UploadedDocumentDto[] = [];
}

describe('DocumentUploadDialog', () => {
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
  const labelInput = (label: string): HTMLInputElement => {
    const l = Array.from(el.querySelectorAll('label')).find((x) => x.textContent?.includes(label));
    const input = l?.querySelector('input');
    if (!input) throw new Error(`No "${label}" option`);
    return input;
  };
  const choose = async (label: string, on = true) => {
    const input = labelInput(label);
    input.checked = on;
    input.dispatchEvent(new Event('change'));
    await render();
  };
  const dialog = (): DocumentUploadDialog =>
    fixture.debugElement.query(By.directive(DocumentUploadDialog)).componentInstance as DocumentUploadDialog;

  /** Open, pick `names`, type them all "lab", and go to "Who can see these files?". */
  const toShareStep = async (doctors: SharingDoctorDto[], names = ['scan.pdf']) => {
    host.show.set(true);
    await render();
    http.expectOne(`${BASE}/api/portal/document-types`).flush({ status: 'success', message: 'OK', data: [{ value: 'lab', label: 'Lab result' }] });
    http.expectOne(`${BASE}/api/portal/document-access/doctors`).flush({ status: 'success', message: 'OK', data: doctors });
    await render();
    dialog()['addFiles'](names.map((n) => new File(['abc'], n, { type: 'application/pdf' })));
    await render();
    for (const select of Array.from(el.querySelectorAll('select'))) {
      select.value = 'lab';
      select.dispatchEvent(new Event('change'));
    }
    await render();
    await click('Continue');
  };
  const nextUpload = (): TestRequest => http.expectOne((r) => r.method === 'POST' && r.url === UPLOAD);
  const form = (req: TestRequest) => req.request.body as FormData;

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

  it('asks who can see the files, keeping them private by default', async () => {
    await toShareStep([doctor('sp-1', 'Bayo Ade')]);
    expect(text()).toContain('Who can see these files?');
    expect(labelInput('Keep private').checked).toBe(true);
    expect(text()).toContain('Only you can see them. You can share later.');
    await click('Upload 1 file');
    const req = nextUpload();
    expect(form(req).getAll('share_specialist_ids[]')).toEqual([]);
    expect(form(req).get('share_batch_id')).toBeNull();
    req.flush({ status: 'success', message: 'OK', data: uploaded() });
    await render();
    expect(text()).toContain('Kept private — only you can see them.');
  });

  it('renames Keep private and ticks folder doctors on the documents page; unticked ones are excluded', async () => {
    await toShareStep([doctor('sp-1', 'Bayo Ade'), doctor('sp-2', 'Ada Obi', true), doctor('sp-3', 'Kemi Bello', true)]);
    expect(text()).toContain("Don't share with anyone new");
    expect(text()).toContain('Doctors who can see your whole folder are listed below.');
    expect(labelInput('Also let Dr Ada Obi see these files').checked).toBe(true);
    expect(labelInput('Also let Dr Kemi Bello see these files').checked).toBe(true);
    expect(text()).toContain('Whole folder with no end date');
    await choose('Also let Dr Kemi Bello see these files', false);
    await click('Upload 1 file');
    const req = nextUpload();
    expect(form(req).getAll('exclude_specialist_ids[]')).toEqual(['sp-3']);
    expect(form(req).get('share_surface')).toBe('documents_page');
    req.flush({
      status: 'success',
      message: 'OK',
      data: uploaded({ shared_with: [{ specialist_id: 'sp-2', name: 'Ada Obi', via: 'folder', until: null, until_label_at: null, indefinite: true, paused: false }] }),
    });
    await render();
    expect(text()).toContain('Dr Ada Obi can also see it through your whole-folder share.');
  });

  it('from an appointment: shares with its doctor (after the consultation) and ticks only that doctor', async () => {
    host.preset.set('sp-1');
    host.appt.set(appointment);
    await toShareStep([doctor('sp-1', 'Bayo Ade', true), doctor('sp-2', 'Ada Obi', true)]);
    expect(labelInput('Share with doctors').checked).toBe(true);
    expect(labelInput('Until 24 hours after your').checked).toBe(true);
    expect(labelInput('Also let Dr Ada Obi see these files').checked).toBe(false);
    await click('Upload 1 file');
    const req = nextUpload();
    const body = form(req);
    expect(body.getAll('share_specialist_ids[]')).toEqual(['sp-1']);
    expect(body.get('share_duration')).toBe('after_24h');
    expect(body.get('share_appointment_id')).toBe('ap-1');
    expect(body.getAll('exclude_specialist_ids[]')).toEqual(['sp-2']);
    expect(body.get('share_surface')).toBe('appointment_details');
    req.flush({
      status: 'success',
      message: 'OK',
      data: uploaded({
        share_outcome: 'shared',
        shared_with: [{ specialist_id: 'sp-1', name: 'Bayo Ade', via: 'document', until: '2030-10-29T15:30:00Z', until_label_at: '2030-10-29T15:30:00Z', indefinite: false, paused: false }],
      }),
    });
    await render();
    expect(text()).toContain('Shared with Dr Bayo Ade until 29 Oct 2030');
  });

  it('keeps one batch key for every file and every retry', async () => {
    host.preset.set('sp-1');
    await toShareStep([doctor('sp-1', 'Bayo Ade')], ['a.pdf', 'b.pdf']);
    await click('Upload 2 files');
    const first = nextUpload();
    const batch = form(first).get('share_batch_id');
    expect(batch).toBeTruthy();
    first.flush({ status: 'error', message: 'Upload failed' }, { status: 500, statusText: 'Server Error' });
    await render();
    const second = nextUpload();
    expect(form(second).get('share_batch_id')).toBe(batch);
    second.flush({ status: 'success', message: 'OK', data: uploaded({ id: 'd-2' }) });
    await render();
    await click('Retry');
    const retry = nextUpload();
    expect(form(retry).get('share_batch_id')).toBe(batch);
    retry.flush({
      status: 'success',
      message: 'OK',
      data: uploaded({ share_outcome: 'share_ended', share_ended_for: ['sp-1'] }),
    });
    await render();
    expect(text()).toContain(
      "Saved, but your share with Dr Bayo Ade had already ended, so they can't see this file. You can share again from Manage sharing.",
    );
    expect(host.docs.length).toBe(2);
  });

  it('says nobody is booked yet, and that the files stay private', async () => {
    await toShareStep([]);
    expect(text()).toContain("You haven't booked a doctor yet, so these files will be private.");
    await click('Upload 1 file');
    nextUpload().flush({ status: 'success', message: 'OK', data: uploaded() });
    await render();
  });

  it('lists a paused folder holder unticked and keeps the files from them', async () => {
    const paused: SharingDoctorDto = {
      ...doctor('sp-4', 'Tunde Ola'),
      can_share: false,
      unavailable_reason: 'doctor_unavailable',
      access: access({ state: 'paused', scope: 'all', folder_indefinite: true, indefinite: true }),
    };
    await toShareStep([doctor('sp-1', 'Bayo Ade'), paused]);
    // Not "Only you can see them": a paused folder share resumes if the doctor comes back.
    expect(text()).toContain("Don't share with anyone new");
    expect(text()).not.toContain('Only you can see them.');
    expect(labelInput('Also let Dr Tunde Ola see these files').checked).toBe(false);
    expect(text()).toContain('Paused — not practising on VideoMed right now');
    await click('Upload 1 file');
    const req = nextUpload();
    expect(form(req).getAll('exclude_specialist_ids[]')).toEqual(['sp-4']);
    req.flush({ status: 'success', message: 'OK', data: uploaded() });
    await render();
  });

  it('shows a doctor who is not practising disabled in the Who list', async () => {
    const away: SharingDoctorDto = { ...doctor('sp-5', 'Ngozi Eze'), can_share: false, unavailable_reason: 'doctor_unavailable' };
    await toShareStep([doctor('sp-1', 'Bayo Ade'), away]);
    await choose('Share with doctors');
    expect(labelInput('Dr Ngozi Eze').disabled).toBe(true);
    expect(text()).toContain('Not available — not practising on VideoMed right now');
    expect(labelInput('Dr Bayo Ade').disabled).toBe(false);
  });

  it('sends the consultation only for an "after the consultation" end', async () => {
    host.preset.set('sp-1');
    host.appt.set(appointment);
    await toShareStep([doctor('sp-1', 'Bayo Ade')]);
    await choose('30 days');
    await click('Upload 1 file');
    const req = nextUpload();
    expect(form(req).get('share_duration')).toBe('30d');
    expect(form(req).get('share_appointment_id')).toBeNull();
    req.flush({ status: 'success', message: 'OK', data: uploaded() });
    await render();
  });
});
