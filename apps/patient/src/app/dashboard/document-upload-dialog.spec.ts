import { HttpEventType, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { API_CONFIG, DOCTOR_VIEWABLE_ACCEPT } from '@supadoc/data-access';
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

/** Each row's type field (the searchable combobox's trigger). */
function typeTriggers(el: HTMLElement): HTMLButtonElement[] {
  return Array.from(el.querySelectorAll<HTMLButtonElement>('sd-search-select button[aria-haspopup="listbox"]'));
}

/** Open each row's type list and click `label` in it (as a person would). */
async function chooseEveryType(el: HTMLElement, render: () => Promise<void>, label: string): Promise<void> {
  for (let i = 0; i < typeTriggers(el).length; i++) {
    typeTriggers(el)[i].click();
    await render();
    const option = Array.from(el.querySelectorAll<HTMLElement>('[role="option"]')).find((o) => o.textContent?.trim() === label);
    if (!option) throw new Error(`No "${label}" option`);
    option.click();
    await render();
  }
}

/** A key on an element (bubbling, cancelable, like the browser's). */
function key(target: Element, k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
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
  const typeAll = (label: string) => chooseEveryType(el, render, label);

  /** Open, pick `names`, type them all "lab", and go to "Who can see these files?". */
  const toShareStep = async (doctors: SharingDoctorDto[], names = ['scan.pdf']) => {
    host.show.set(true);
    await render();
    http.expectOne(`${BASE}/api/portal/document-types`).flush({ status: 'success', message: 'OK', data: [{ value: 'lab', label: 'Lab result' }] });
    http.expectOne(`${BASE}/api/portal/document-access/doctors`).flush({ status: 'success', message: 'OK', data: doctors });
    await render();
    dialog()['addFiles'](names.map((n) => new File(['abc'], n, { type: 'application/pdf' })));
    await render();
    await typeAll('Lab result');
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

  it('shows real progress, then "Finishing…" (announced once) when every byte is sent, then the outcome', async () => {
    await toShareStep([doctor('sp-1', 'Bayo Ade')], ['scan.pdf', 'labs.pdf']);
    await click('Upload 2 files');
    const req = nextUpload();
    const bar = () => el.querySelector('[role="progressbar"]') as HTMLElement;
    const live = () => el.querySelector('p.sr-only[aria-live="polite"]')?.textContent?.trim();
    const pill = (i: number) => el.querySelectorAll('[aria-label="Upload progress"] li')[i]?.querySelector('span.rounded-pill')?.textContent?.trim();
    expect(live()).toBe('Uploading scan.pdf, 1 of 2.');

    req.event({ type: HttpEventType.UploadProgress, loaded: 250, total: 1000 });
    await render();
    expect(bar().getAttribute('aria-label')).toBe('Uploading scan.pdf');
    expect(bar().getAttribute('aria-valuenow')).toBe('25');
    expect(pill(0)).toBe('25%');
    expect(live()).toBe('Uploading scan.pdf, 1 of 2.'); // not on every tick

    // Every byte is out but the server hasn't answered: an indeterminate "Finishing…", not a frozen 100%.
    req.event({ type: HttpEventType.UploadProgress, loaded: 1000, total: 1000 });
    await render();
    expect(bar().hasAttribute('aria-valuenow')).toBe(false);
    expect(bar().getAttribute('aria-valuetext')).toBe('Finishing…');
    expect(bar().dataset['state']).toBe('finishing');
    expect(pill(0)).toBe('Finishing…');
    expect(live()).toBe('scan.pdf is sent. Finishing up… File 1 of 2.');
    expect(text()).toContain('0 of 2 uploaded');

    req.flush({ status: 'success', message: 'OK', data: uploaded() });
    await render();
    expect(text()).toContain('1 of 2 uploaded');
    expect(live()).toBe('Uploading labs.pdf, 2 of 2.');
    const second = nextUpload();
    // The browser can't tell this one's size: a sweep saying "Uploading…", never a stuck 0%.
    second.event({ type: HttpEventType.UploadProgress, loaded: 10 });
    await render();
    expect(bar().getAttribute('aria-valuetext')).toBe('Uploading…');
    expect(pill(1)).toBe('Uploading…');
    second.flush({ status: 'success', message: 'OK', data: uploaded({ id: 'd-2' }) });
    await render();
    expect(el.querySelector('[role="progressbar"]')).toBeNull();
    expect(live()).toContain('2 documents uploaded.');
    expect(host.docs.length).toBe(2);
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

  it('accepts WEBP photos (as the server does)', async () => {
    host.show.set(true);
    await render();
    http.expectOne(`${BASE}/api/portal/document-types`).flush({ status: 'success', message: 'OK', data: [] });
    http.expectOne(`${BASE}/api/portal/document-access/doctors`).flush({ status: 'success', message: 'OK', data: [] });
    await render();
    expect(el.querySelector('sd-file-drop')).toBeTruthy();
    expect(dialog()['accept']()).toContain('.webp');
    expect(dialog()['accept']()).toContain('image/webp');
    dialog()['addFiles']([new File(['abc'], 'rash.webp', { type: 'image/webp' })]);
    await render();
    expect(text()).toContain('rash.webp');
    expect(text()).not.toContain('wasn’t added');
  });

  it("warns (D32) when a file a doctor can't open is shared with them, and still shares it", async () => {
    await toShareStep([doctor('sp-1', 'Bayo Ade')], ['notes.docx', 'scan.pdf']);
    expect(el.querySelectorAll('[data-testid="view-warning"]').length).toBe(0); // private so far
    await choose('Share with doctors');
    await choose('Dr Bayo Ade');
    const warnings = Array.from(el.querySelectorAll('[data-testid="view-warning"]')).map((w) => w.textContent?.replace(/\s+/g, ' ').trim());
    expect(warnings).toEqual(["notes.docx: Dr Ade can't open DOCX files in VideoMed. Share a PDF or photo."]);
    await click('Upload 2 files');
    const req = nextUpload();
    expect(form(req).getAll('share_specialist_ids[]')).toEqual(['sp-1']);
    req.flush({ status: 'success', message: 'OK', data: uploaded() });
    await render();
    nextUpload().flush({ status: 'success', message: 'OK', data: uploaded({ id: 'd-2' }) });
    await render();
  });

  it('flags the file under its row when the doctor is already chosen (appointment details)', async () => {
    host.preset.set('sp-1');
    host.appt.set(appointment);
    host.show.set(true);
    await render();
    http.expectOne(`${BASE}/api/portal/document-types`).flush({ status: 'success', message: 'OK', data: [{ value: 'lab', label: 'Lab result' }] });
    http.expectOne(`${BASE}/api/portal/document-access/doctors`).flush({ status: 'success', message: 'OK', data: [doctor('sp-1', 'Bayo Ade')] });
    await render();
    dialog()['addFiles']([new File(['abc'], 'clip.mov', { type: 'video/quicktime' }), new File(['abc'], 'x.png', { type: 'image/png' })]);
    await render();
    const warnings = Array.from(el.querySelectorAll('[data-testid="view-warning"]')).map((w) => w.textContent?.trim());
    expect(warnings).toEqual(["Dr Ade can't open MOV files in VideoMed. Share a PDF or photo."]);
  });

  describe('the searchable document type', () => {
    const TYPES = [
      { value: 'laboratory_test_report', label: 'Laboratory Test Report' },
      { value: 'blood_test_report', label: 'Blood Test Report' },
      { value: 'xray_report', label: 'X-Ray Report' },
      { value: 'prescription', label: 'Prescription' },
    ];
    const optionLabels = () => Array.from(el.querySelectorAll('[role="option"]')).map((o) => o.textContent?.trim());
    const search = () => el.querySelector<HTMLInputElement>('sd-search-select input[role="combobox"]') as HTMLInputElement;
    const typeInto = async (text: string) => {
      search().value = text;
      search().dispatchEvent(new Event('input'));
      await render();
    };
    /** Open the dialog with TYPES and pick `names`. */
    const pick = async (names = ['scan.pdf']) => {
      host.show.set(true);
      await render();
      http.expectOne(`${BASE}/api/portal/document-types`).flush({ status: 'success', message: 'OK', data: TYPES });
      http.expectOne(`${BASE}/api/portal/document-access/doctors`).flush({ status: 'success', message: 'OK', data: [] });
      await render();
      dialog()['addFiles'](names.map((n) => new File(['abc'], n, { type: 'application/pdf' })));
      await render();
    };

    it('filters as you type: anywhere in the label, any case, and says when nothing matches', async () => {
      await pick();
      typeTriggers(el)[0].click();
      await render();
      expect(optionLabels()).toEqual(TYPES.map((t) => t.label));
      await typeInto('TEST rep');
      expect(optionLabels()).toEqual(['Laboratory Test Report', 'Blood Test Report']);
      await typeInto('ray');
      expect(optionLabels()).toEqual(['X-Ray Report']);
      expect(el.querySelector('[role="status"]')?.textContent?.trim()).toBe('1 match');
      await typeInto('zzz');
      expect(optionLabels()).toEqual([]);
      expect(text()).toContain('No matches');
      expect(el.querySelector('[role="status"]')?.textContent?.trim()).toBe('No matches');
      expect(search().getAttribute('aria-activedescendant')).toBeNull();
    });

    it('is an APG combobox: labelled per file, ↓ ↑ move, Enter picks, focus back on the field', async () => {
      await pick(['scan.pdf']);
      const trigger = typeTriggers(el)[0];
      expect(trigger.getAttribute('aria-labelledby')).toBe(`doc-type-label-1 doc-type-1-value`);
      expect(el.querySelector('#doc-type-label-1')?.textContent).toContain('Document type for scan.pdf');
      expect(trigger.textContent?.trim()).toBe('Select document type');
      // A letter on the closed field opens the list, searching for it.
      trigger.focus();
      key(trigger, 'b');
      await render();
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      expect(trigger.getAttribute('aria-controls')).toBe('doc-type-1-list');
      expect(search().value).toBe('b');
      expect(search().getAttribute('aria-controls')).toBe('doc-type-1-list');
      expect(el.querySelector('#doc-type-1-list')?.getAttribute('role')).toBe('listbox');
      expect(el.querySelector('#doc-type-1-list')?.getAttribute('aria-labelledby')).toBe('doc-type-label-1');
      await typeInto('report');
      const active = () => el.querySelector(`#${search().getAttribute('aria-activedescendant')}`)?.textContent?.trim();
      expect(active()).toBe('Laboratory Test Report');
      key(search(), 'ArrowDown');
      await render();
      expect(active()).toBe('Blood Test Report');
      expect(el.querySelector('.sd-ss-active')?.textContent?.trim()).toBe('Blood Test Report');
      key(search(), 'ArrowDown');
      key(search(), 'ArrowUp');
      await render();
      expect(active()).toBe('Blood Test Report');
      const enter = key(search(), 'Enter');
      await render();
      expect(enter.defaultPrevented).toBe(true);
      expect(el.querySelector('[role="listbox"]')).toBeNull();
      expect(trigger.textContent?.trim()).toBe('Blood Test Report');
      expect(document.activeElement).toBe(trigger);
      expect(text()).not.toContain('Choose a type for 1 more document');
    });

    it('Esc closes just the list, not the dialog; ↓ on the field reopens it on the chosen type', async () => {
      await pick();
      const trigger = typeTriggers(el)[0];
      trigger.click();
      await render();
      const esc = key(search(), 'Escape');
      await render();
      expect(esc.defaultPrevented).toBe(true);
      expect(el.querySelector('[role="listbox"]')).toBeNull();
      expect(text()).toContain('Document Type');
      expect(document.activeElement).toBe(trigger);
      // Pointer pick, then the keyboard reopens on it.
      await chooseEveryType(el, render, 'X-Ray Report');
      key(trigger, 'ArrowDown');
      await render();
      expect(el.querySelector(`#${search().getAttribute('aria-activedescendant')}`)?.textContent?.trim()).toBe('X-Ray Report');
      expect(el.querySelector('[aria-selected="true"]')?.textContent?.trim()).toBe('X-Ray Report');
      // Shift+Tab moves back from the field (the browser's own move); leaving it closes the list.
      const tab = key(search(), 'Tab', { shiftKey: true });
      expect(tab.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(trigger);
      trigger.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: button('Cancel') }));
      await render();
      expect(el.querySelector('[role="listbox"]')).toBeNull();
      expect(trigger.textContent?.trim()).toBe('X-Ray Report');
      expect(text()).not.toContain('Choose a type for this document.'); // it has one
    });

    it('a press on the search icon keeps focus in the search box: Esc then closes just the list', async () => {
      await pick();
      const trigger = typeTriggers(el)[0];
      trigger.click();
      await render();
      const icon = el.querySelector('sd-search-select .sd-menu sd-icon') as Element;
      const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      icon.dispatchEvent(press);
      expect(press.defaultPrevented).toBe(true);
      (el.querySelector('sd-search-select .sd-menu') as HTMLElement).focus(); // whatever takes focus in the list
      expect(document.activeElement).toBe(search());
      const esc = key(document.activeElement as Element, 'Escape');
      await render();
      expect(esc.defaultPrevented).toBe(true);
      expect(el.querySelector('[role="listbox"]')).toBeNull();
      expect(text()).toContain('Document Type'); // no "Discard the selected file?"
      expect(text()).not.toContain('Discard');
      expect(document.activeElement).toBe(trigger);
    });

    it('names each search box after its file', async () => {
      await pick(['a.pdf', 'b.pdf']);
      typeTriggers(el)[1].click();
      await render();
      expect(search().getAttribute('aria-labelledby')).toBe('doc-type-label-2 doc-type-2-search-label');
      const names = search()
        .getAttribute('aria-labelledby')
        ?.split(' ')
        .map((id) => el.querySelector(`#${id}`)?.textContent?.trim());
      expect(names).toEqual(['Document type for b.pdf', 'Search document types']);
    });

    it('opened before the types arrive: says they are loading, then starts on the first', async () => {
      host.show.set(true);
      await render();
      const types = http.expectOne(`${BASE}/api/portal/document-types`);
      http.expectOne(`${BASE}/api/portal/document-access/doctors`).flush({ status: 'success', message: 'OK', data: [] });
      await render();
      dialog()['addFiles']([new File(['abc'], 'scan.pdf', { type: 'application/pdf' })]);
      await render();
      typeTriggers(el)[0].click();
      await render();
      expect(text()).toContain('Loading document types…');
      expect(text()).not.toContain('No matches');
      types.flush({ status: 'success', message: 'OK', data: TYPES });
      await render();
      expect(text()).not.toContain('Loading document types…');
      expect(el.querySelector('.sd-ss-active')?.textContent?.trim()).toBe('Laboratory Test Report');
      key(search(), 'Enter');
      await render();
      expect(typeTriggers(el)[0].textContent?.trim()).toBe('Laboratory Test Report');
    });

    it('says there are no types when the list could not be loaded', async () => {
      host.show.set(true);
      await render();
      http.expectOne(`${BASE}/api/portal/document-types`).flush({ message: 'Down' }, { status: 500, statusText: 'Server Error' });
      http.expectOne(`${BASE}/api/portal/document-access/doctors`).flush({ status: 'success', message: 'OK', data: [] });
      await render();
      dialog()['addFiles']([new File(['abc'], 'scan.pdf', { type: 'application/pdf' })]);
      await render();
      typeTriggers(el)[0].click();
      await render();
      expect(text()).toContain('No document types available');
      expect(text()).not.toContain('Loading document types…');
    });

    it('says a file needs a type when its field is left empty, and clears once one is chosen', async () => {
      await pick();
      const trigger = typeTriggers(el)[0];
      const field = el.querySelector('sd-search-select') as HTMLElement;
      // Moving between the field and its own list is not leaving it.
      trigger.click();
      await render();
      search().dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: trigger }));
      await render();
      expect(text()).not.toContain('Choose a type for this document.');
      key(search(), 'Escape');
      await render();
      field.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: button('Cancel') }));
      await render();
      expect(text()).toContain('Choose a type for this document.');
      expect(trigger.getAttribute('aria-invalid')).toBe('true');
      expect(trigger.getAttribute('aria-describedby')).toBe('doc-type-error-1');
      expect(el.querySelector('#doc-type-error-1')?.textContent?.trim()).toBe('Choose a type for this document.');
      expect(trigger.className).toContain('border-alert');
      expect(text()).toContain('Choose a type for 1 more document to continue.');
      expect(button('Continue').disabled).toBe(true);
      await chooseEveryType(el, render, 'Prescription');
      expect(text()).not.toContain('Choose a type for this document.');
      expect(trigger.hasAttribute('aria-invalid')).toBe(false);
      expect(trigger.getAttribute('aria-describedby')).toBeNull();
      expect(button('Continue').disabled).toBe(false);
    });

    it('keeps each file its own type and sends the chosen values unchanged', async () => {
      await pick(['a.pdf', 'b.pdf']);
      expect(text()).toContain('Choose a type for 2 more documents to continue.');
      expect(typeTriggers(el).map((t) => t.id)).toEqual(['doc-type-1', 'doc-type-2']);
      typeTriggers(el)[1].click();
      await render();
      Array.from(el.querySelectorAll<HTMLElement>('[role="option"]'))
        .find((o) => o.textContent?.trim() === 'Blood Test Report')
        ?.click();
      await render();
      expect(typeTriggers(el).map((t) => t.textContent?.trim())).toEqual(['Select document type', 'Blood Test Report']);
      expect(text()).toContain('Choose a type for 1 more document to continue.');
      typeTriggers(el)[0].click();
      await render();
      await typeInto('x-ray');
      key(search(), 'Enter');
      await render();
      expect(typeTriggers(el).map((t) => t.textContent?.trim())).toEqual(['X-Ray Report', 'Blood Test Report']);
      expect(text()).not.toContain('more document');
      await click('Continue');
      await click('Upload 2 files');
      const first = nextUpload();
      expect(form(first).get('document_type')).toBe('xray_report');
      expect((form(first).get('file') as File).name).toBe('a.pdf');
      first.flush({ status: 'success', message: 'OK', data: uploaded() });
      await render();
      const second = nextUpload();
      expect(form(second).get('document_type')).toBe('blood_test_report');
      expect((form(second).get('file') as File).name).toBe('b.pdf');
      second.flush({ status: 'success', message: 'OK', data: uploaded({ id: 'd-2' }) });
      await render();
    });

    it('draws the light field (the classes the portal’s dark mode re-points) with its list in the flow', async () => {
      await pick();
      const trigger = typeTriggers(el)[0];
      expect(el.querySelector('sd-search-select > div')?.classList.contains('sd-ss-call')).toBe(false);
      for (const cls of ['bg-white', 'border-[#b8c6d4]', 'py-3', 'text-body-sm']) expect(trigger.classList.contains(cls)).toBe(true);
      expect(trigger.querySelector('span')?.classList.contains('text-slate')).toBe(true);
      trigger.click();
      await render();
      const menu = el.querySelector('sd-search-select .sd-menu') as HTMLElement;
      expect(menu.classList.contains('relative')).toBe(true); // inline: never clipped by the dialog body
      expect(menu.classList.contains('absolute')).toBe(false);
      expect(menu.classList.contains('bg-white')).toBe(true);
      expect(el.querySelector('.sd-ss-active')?.getAttribute('role')).toBe('option');
    });
  });
});

@Component({
  imports: [DocumentUploadDialog],
  template: `
    @if (show()) {
      <div class="sd-call" data-theme="dark">
        <pat-document-upload-dialog
          [presetDoctorId]="'sp-1'"
          [appointment]="appt"
          [lockDoctor]="true"
          surface="call"
          theme="call"
          fixedDuration="indefinite"
          acceptKinds="viewable"
          [maxFiles]="5"
          doneLabel="Done"
          (uploaded)="docs.push($event)"
          (closed)="show.set(false)"
        />
      </div>
    }
  `,
})
class CallHost {
  readonly show = signal(false);
  readonly appt = appointment;
  readonly docs: UploadedDocumentDto[] = [];
}

describe('DocumentUploadDialog in a call', () => {
  let fixture: ComponentFixture<CallHost>;
  let host: CallHost;
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
  const dialog = (): DocumentUploadDialog =>
    fixture.debugElement.query(By.directive(DocumentUploadDialog)).componentInstance as DocumentUploadDialog;
  const typeAll = (label: string) => chooseEveryType(el, render, label);
  const open = async (doctors: SharingDoctorDto[] = [doctor('sp-1', 'Bayo Ade', true), doctor('sp-2', 'Ada Obi', true)]) => {
    host.show.set(true);
    await render();
    http.expectOne(`${BASE}/api/portal/document-types`).flush({ status: 'success', message: 'OK', data: [{ value: 'lab', label: 'Lab result' }] });
    http.expectOne(`${BASE}/api/portal/document-access/doctors`).flush({ status: 'success', message: 'OK', data: doctors });
    await render();
  };
  const toShareStep = async (names = ['scan.pdf']) => {
    await open();
    dialog()['addFiles'](names.map((n) => new File(['abc'], n, { type: 'application/pdf' })));
    await render();
    await typeAll('Lab result');
    await click('Continue');
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CallHost],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideSupadocIcons(),
        { provide: API_CONFIG, useValue: { baseUrl: BASE } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(CallHost);
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

  it('only takes what the doctor can open in VideoMed, and says so', async () => {
    await open();
    expect(text()).toContain('Upload & share');
    expect(text()).toContain('Your doctor can view PDFs, photos (JPG, PNG, WEBP) and videos (MP4, WEBM) during the call.');
    // The cockpit's own picker (not the portal's light drop zone), limited to the viewable types.
    expect(el.querySelector('sd-file-drop')).toBeNull();
    const picker = el.querySelector<HTMLInputElement>('input[type="file"]');
    expect(picker?.accept).toBe(DOCTOR_VIEWABLE_ACCEPT);
    dialog()['addFiles']([
      new File(['abc'], 'letter.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
      new File(['abc'], 'rash.webp', { type: 'image/webp' }),
    ]);
    await render();
    expect(text()).toContain("letter.docx: this file type can't be viewed by your doctor in the call. Share it as a PDF or photo.");
    expect(text()).toContain('rash.webp');
  });

  it('has no "keep private" and no duration chips: that doctor, with no end date', async () => {
    await toShareStep();
    expect(text()).not.toContain('Keep private');
    expect(text()).not.toContain("Don't share with anyone new");
    expect(text()).not.toContain('For how long?');
    expect(text()).toContain(
      'Dr Bayo Ade can see these files during this consultation and afterwards, with no end date. You can stop sharing any time in Manage sharing.',
    );
    // Another folder holder keeps the opt-in tick (unticked from a consultation).
    expect(text()).toContain('Also let Dr Ada Obi see these files');
  });

  it('sends the consultation with an indefinite share to that doctor (surface call)', async () => {
    await toShareStep();
    await click('Upload 1 file');
    const req = http.expectOne((r) => r.method === 'POST' && r.url === UPLOAD);
    const body = req.request.body as FormData;
    expect(body.getAll('share_specialist_ids[]')).toEqual(['sp-1']);
    expect(body.get('share_duration')).toBe('indefinite');
    expect(body.get('share_appointment_id')).toBe('ap-1');
    expect(body.get('share_surface')).toBe('call');
    expect(body.getAll('exclude_specialist_ids[]')).toEqual(['sp-2']);
    expect(body.get('share_batch_id')).toBeTruthy();
    req.flush({
      status: 'success',
      message: 'OK',
      data: uploaded({
        share_outcome: 'shared',
        shared_with: [{ specialist_id: 'sp-1', name: 'Bayo Ade', via: 'document', until: null, until_label_at: null, indefinite: true, paused: false }],
      }),
    });
    await render();
    expect(host.docs.length).toBe(1);
    expect(text()).toContain('Shared with Dr Bayo Ade with no end date.');
    expect(button('Done')).toBeTruthy();
  });

  it('keeps a batch to 5 files', async () => {
    await open();
    dialog()['addFiles'](['a', 'b', 'c', 'd', 'e', 'f'].map((n) => new File(['abc'], `${n}.pdf`, { type: 'application/pdf' })));
    await render();
    expect(text()).toContain('f.pdf: You can upload up to 5 files at a time.');
  });

  it('draws the "Others (Specify)" field with a cockpit border that reads (white/45, not white/15)', async () => {
    host.show.set(true);
    await render();
    http
      .expectOne(`${BASE}/api/portal/document-types`)
      .flush({ status: 'success', message: 'OK', data: [{ value: 'lab', label: 'Lab result' }, { value: 'other', label: 'Other' }] });
    http.expectOne(`${BASE}/api/portal/document-access/doctors`).flush({ status: 'success', message: 'OK', data: [] });
    await render();
    dialog()['addFiles']([new File(['abc'], 'scan.pdf', { type: 'application/pdf' })]);
    await render();
    await typeAll('Other');
    const other = el.querySelector('input[placeholder="Enter document type"]') as HTMLInputElement;
    for (const cls of ['border-white/45', 'focus-within:border-sky', 'focus-within:ring-1', 'focus-within:ring-sky', 'text-white']) {
      expect(other.classList.contains(cls)).toBe(true);
    }
    expect(other.classList.contains('border-white/15')).toBe(false);
    expect(other.closest('.sd-share')).not.toBeNull(); // the light cockpit's mapping (styles.css) is scoped to it
  });

  it("draws the type field in the cockpit's palette, searchable, with its list in the flow", async () => {
    await open();
    dialog()['addFiles']([new File(['abc'], 'scan.pdf', { type: 'application/pdf' })]);
    await render();
    const root = el.querySelector('sd-search-select > div') as HTMLElement;
    expect(root.classList.contains('sd-ss-call')).toBe(true);
    const trigger = typeTriggers(el)[0];
    expect(trigger.classList.contains('border-(--ss-border)')).toBe(true);
    expect(trigger.classList.contains('bg-white')).toBe(false);
    trigger.click();
    await render();
    const menu = el.querySelector('sd-search-select .sd-menu') as HTMLElement;
    expect(menu.classList.contains('relative')).toBe(true);
    expect(menu.classList.contains('bg-white')).toBe(false);
    const search = el.querySelector<HTMLInputElement>('input[role="combobox"]') as HTMLInputElement;
    search.value = 'LAB';
    search.dispatchEvent(new Event('input'));
    await render();
    expect(Array.from(el.querySelectorAll('[role="option"]')).map((o) => o.textContent?.trim())).toEqual(['Lab result']);
    key(search, 'Enter');
    await render();
    expect(trigger.textContent?.trim()).toBe('Lab result');
    await click('Continue');
    await click('Upload 1 file');
    const req = http.expectOne((r) => r.method === 'POST' && r.url === UPLOAD);
    expect((req.request.body as FormData).get('document_type')).toBe('lab');
    req.flush({ status: 'success', message: 'OK', data: uploaded() });
    await render();
  });
});
