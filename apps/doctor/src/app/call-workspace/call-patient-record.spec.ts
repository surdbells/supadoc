import { ApplicationRef } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { DoctorApi, LabRequestsApi } from '@supadoc/data-access';
import type { AppointmentDto, DoctorPatientRecordDto, DoctorSharedDocumentDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { DocumentViewerService } from '@supadoc/viewer';
import { Observable, of, throwError } from 'rxjs';
import { LabFiles } from '../lab/lab-files';
import { RxFiles } from '../prescriptions/rx-files';
import { CallPatientRecord } from './call-patient-record';
import { STANDING_TERMS, WS_EMR_DOCS_EMPTY, WS_EMR_DOCS_FAILED, WS_EMR_FAILED, WS_EMR_NO_DETAILS, WS_EMR_SIGNED_OUT, type WorkspaceTab } from './call-workspace-copy';

function visit(id: string, at: string): AppointmentDto {
  return {
    id,
    patient_id: 'p1',
    specialist: { id: 'd1', name: 'Dr Ada Obi' },
    scheduled_at: at,
    type: 'video',
    type_label: 'Video consultation',
    status: 'completed',
    status_label: 'Completed',
    amount: '0',
    created_at: at,
  } as unknown as AppointmentDto;
}

const RECORD: DoctorPatientRecordDto = {
  patient: { id: 'p1', name: 'Bola Ade', email: 'bola@example.test', phone: null, gender: 'female', date_of_birth: '1990-05-01' },
  medical: { allergies: [], conditions: [{ condition: 'Asthma', status: 'resolved' }, { condition: 'Migraine', status: 'active' }], medications: [], history: [] },
  appointments: [visit('v-old', '2026-01-01T10:00:00Z'), visit('v-new', '2026-06-01T10:00:00Z')],
  visit_count: 2,
} as unknown as DoctorPatientRecordDto;

function doc(id: string, over: Partial<DoctorSharedDocumentDto> = {}): DoctorSharedDocumentDto {
  return {
    id,
    uploader_role: 'patient',
    type_label: 'Lab report',
    title: `Report ${id}`,
    extension: 'pdf',
    size_label: '1.2 MB',
    ...over,
  } as unknown as DoctorSharedDocumentDto;
}

describe('CallPatientRecord (the Full EMR)', () => {
  let fixture: ComponentFixture<CallPatientRecord>;
  let el: HTMLElement;
  let patient: ReturnType<typeof vi.fn>;
  let answer: () => Observable<{ data: DoctorPatientRecordDto }>;
  let goTo: WorkspaceTab[];
  let getNote: ReturnType<typeof vi.fn>;
  let allPrescriptions: ReturnType<typeof vi.fn>;

  const render = () => {
    fixture.detectChanges();
    TestBed.inject(ApplicationRef).tick();
  };

  function setup(inputs: Record<string, unknown> = { active: true, signedIn: true, patientId: 'p1' }) {
    answer = answer ?? (() => of({ data: RECORD }));
    patient = vi.fn(() => answer());
    const clinical = () => of({ data: [] });
    getNote = vi.fn((id: string) => of({ data: { subjective: 'Note of ' + id, status: 'draft' } }));
    allPrescriptions = vi.fn(() => of({ data: [], meta: { total: 0 } }));
    TestBed.configureTestingModule({
      imports: [CallPatientRecord],
      providers: [
        provideRouter([]),
        provideSupadocIcons(),
        {
          provide: DoctorApi,
          useValue: {
            patient,
            getProfile: () => of({ data: { id: 'd', name: 'Dr', timezone: 'Africa/Lagos', timezone_source: 'manual' } }),
            allPrescriptions,
            getNote,
            listPrescriptions: clinical,
            listReferrals: clinical,
            listCertificates: clinical,
            getCarePlan: () => of({ data: { items: [], published: false } }),
          },
        },
        { provide: LabRequestsApi, useValue: { list: clinical } },
        { provide: RxFiles, useValue: { view: vi.fn() } },
        { provide: LabFiles, useValue: { view: vi.fn() } },
        { provide: DocumentViewerService, useValue: { open: vi.fn() } },
      ],
    });
    fixture = TestBed.createComponent(CallPatientRecord);
    goTo = [];
    fixture.componentInstance.goTo.subscribe((t) => goTo.push(t));
    for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
    el = fixture.nativeElement;
    document.body.appendChild(el);
    render();
  }

  afterEach(() => {
    fixture?.destroy();
    el?.remove();
    answer = undefined as unknown as typeof answer;
  });

  const tab = (key: string) => el.querySelector<HTMLButtonElement>('#ws-emr-tab-' + key);
  const panel = (key: string) => el.querySelector<HTMLElement>('#ws-emr-panel-' + key);
  const byText = (text: string, root: Element = el) => Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.includes(text)) ?? null;
  const key = (target: Element | null, k: string) => target?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

  describe('loading', () => {
    it('not active: no request; active and signed in: one; again active: no second; Refresh: one more', () => {
      setup({ active: false, signedIn: true, patientId: 'p1' });
      expect(patient).not.toHaveBeenCalled();
      fixture.componentRef.setInput('active', true);
      render();
      expect(patient).toHaveBeenCalledTimes(1);
      expect(patient).toHaveBeenCalledWith('p1');
      fixture.componentRef.setInput('active', false);
      render();
      fixture.componentRef.setInput('active', true);
      render();
      expect(patient).toHaveBeenCalledTimes(1);
      el.querySelector<HTMLButtonElement>('[aria-label="Refresh the patient record"]')?.click();
      render();
      expect(patient).toHaveBeenCalledTimes(2);
    });

    it('signed out: no request, the sign-in card and its button; signed in again: it loads', () => {
      setup({ active: true, signedIn: false, patientId: 'p1' });
      expect(patient).not.toHaveBeenCalled();
      expect(el.textContent).toContain(WS_EMR_SIGNED_OUT);
      let signIns = 0;
      fixture.componentInstance.signIn.subscribe(() => signIns++);
      byText('Sign in to the doctor portal')?.click();
      expect(signIns).toBe(1);
      fixture.componentRef.setInput('signedIn', true);
      render();
      expect(patient).toHaveBeenCalledTimes(1);
      expect(el.textContent).toContain('Bola Ade');
    });

    it('signing out drops what was loaded; signing in reads afresh', () => {
      setup();
      expect(el.textContent).toContain('bola@example.test');
      fixture.componentRef.setInput('signedIn', false);
      render();
      expect(el.textContent).not.toContain('bola@example.test');
      expect(el.querySelector('doc-patient-overview')).toBeNull();
      fixture.componentRef.setInput('signedIn', true);
      render();
      expect(patient).toHaveBeenCalledTimes(2);
    });

    it('no patient id yet: says so', () => {
      setup({ active: true, signedIn: true, patientId: null });
      expect(patient).not.toHaveBeenCalled();
      expect(el.textContent).toContain('Loading the patient…');
    });

    it('no patient id and the look-up failed: its message and Try again, which emits; no endless "Loading"', () => {
      setup({ active: true, signedIn: true, patientId: null, patientError: 'Could not find the patient for this consultation.' });
      expect(el.querySelector('[role="alert"]')?.textContent).toContain('Could not find the patient for this consultation.');
      // --color-alert as text is under 4.5:1 on both cockpit backgrounds; the light theme remaps text-white to ink.
      expect(el.querySelector('[role="alert"]')?.classList.contains('text-alert')).toBe(false);
      expect(el.querySelector('[role="alert"]')?.classList.contains('text-white')).toBe(true);
      expect(el.textContent).not.toContain('Loading the patient…');
      let retries = 0;
      fixture.componentInstance.retryPatient.subscribe(() => retries++);
      byText('Try again')?.click();
      expect(retries).toBe(1);
      expect(patient).not.toHaveBeenCalled();
    });

    it('no patient id and the consultation’s details failed: says so, with nothing to press; no endless "Loading"', () => {
      setup({ active: true, signedIn: true, patientId: null, detailsFailed: true });
      expect(el.textContent).toContain(WS_EMR_NO_DETAILS);
      expect(el.textContent).not.toContain('Loading the patient…');
      expect(el.querySelector('button')).toBeNull();
    });

    it('the look-up retried and answering: the record loads', () => {
      setup({ active: true, signedIn: true, patientId: null, patientError: 'Nope' });
      fixture.componentRef.setInput('patientError', '');
      render();
      expect(el.textContent).toContain('Loading the patient…');
      fixture.componentRef.setInput('patientId', 'p1');
      render();
      expect(patient).toHaveBeenCalledTimes(1);
      expect(el.textContent).toContain('Bola Ade');
    });

    it('signed out wins over a failed look-up', () => {
      setup({ active: true, signedIn: false, patientId: null, patientError: 'Nope' });
      expect(el.textContent).toContain(WS_EMR_SIGNED_OUT);
      expect(el.textContent).not.toContain('Nope');
    });

    it('an error: the message and Try again, which reads again', () => {
      answer = () => throwError(() => new Error('boom'));
      setup();
      expect(el.textContent).toContain(WS_EMR_FAILED);
      answer = () => of({ data: RECORD });
      byText('Try again')?.click();
      render();
      expect(patient).toHaveBeenCalledTimes(2);
      expect(el.textContent).toContain('Bola Ade');
      expect(el.textContent).not.toContain(WS_EMR_FAILED);
    });

    it('a standing refusal: the API’s message, no Try again, not the generic one', () => {
      answer = () => throwError(() => ({ status: 403, message: 'Your account is suspended.', errors: { code: 'doctor_suspended' } }));
      setup();
      expect(el.textContent).not.toContain(WS_EMR_FAILED);
      expect(byText('Try again')).toBeNull();
      expect(el.querySelector('[role="alert"]')?.textContent).toContain('Your account is suspended.');
    });

    it('owing the terms with no message: the shared fallback copy', () => {
      answer = () => throwError(() => ({ status: 403, errors: { code: 'terms_required' } }));
      setup();
      expect(el.querySelector('[role="alert"]')?.textContent).toContain(STANDING_TERMS);
      expect(el.textContent).not.toContain(WS_EMR_FAILED);
      expect(byText('Try again')).toBeNull();
    });
  });

  describe('sub-tabs', () => {
    it('five, with arrows, Home and End; aria-controls only once mounted', () => {
      setup();
      const tabs = Array.from(el.querySelectorAll<HTMLElement>('[role="tablist"][aria-label="Patient record"] [role="tab"]'));
      expect(tabs.map((t) => t.textContent?.replace(/\d+/g, '').trim())).toEqual(['Overview', 'Medical history', 'Visits', 'Prescription history', 'Documents']);
      expect(tab('overview')?.getAttribute('aria-controls')).toBe('ws-emr-panel-overview');
      expect(tab('history')?.getAttribute('aria-controls')).toBeNull();
      key(tab('overview'), 'ArrowRight');
      render();
      expect(tab('history')?.getAttribute('aria-selected')).toBe('true');
      expect(document.activeElement).toBe(tab('history'));
      expect(tab('history')?.getAttribute('aria-controls')).toBe('ws-emr-panel-history');
      expect(panel('overview')?.hidden).toBe(true);
      expect(panel('history')?.hidden).toBe(false);
      key(tab('history'), 'ArrowLeft');
      render();
      key(tab('overview'), 'ArrowLeft');
      render();
      expect(tab('documents')?.getAttribute('aria-selected')).toBe('true');
      key(tab('documents'), 'Home');
      render();
      expect(tab('overview')?.getAttribute('aria-selected')).toBe('true');
      key(tab('overview'), 'End');
      render();
      expect(tab('documents')?.getAttribute('aria-selected')).toBe('true');
    });

    it('the Overview’s footer link: Medical history shows, focus on its tab', () => {
      setup();
      byText('View full medical history')?.click();
      render();
      expect(panel('history')?.hidden).toBe(false);
      expect(document.activeElement).toBe(tab('history'));
    });

    it('"Write prescription" and "New lab request" emit goTo; no link anywhere', () => {
      setup();
      byText('Write prescription')?.click();
      byText('New lab request')?.click();
      expect(goTo).toEqual(['prescriptions', 'labs']);
      expect(el.querySelector('a')).toBeNull();
    });

    it('Prescription history renders doc-rx-history and nothing editable', () => {
      setup();
      tab('prescriptions')?.click();
      render();
      expect(panel('prescriptions')?.querySelector('doc-rx-history')).not.toBeNull();
      expect(panel('prescriptions')?.querySelectorAll('input, textarea, select').length).toBe(0);
    });

    it('Prescription history reads afresh each time it shows, and on Refresh while it shows', () => {
      setup();
      const refresh = () => el.querySelector<HTMLButtonElement>('[aria-label="Refresh the patient record"]')?.click();
      refresh();
      render();
      expect(allPrescriptions).not.toHaveBeenCalled();
      tab('prescriptions')?.click();
      render();
      expect(allPrescriptions).toHaveBeenCalledTimes(1);
      refresh();
      render();
      expect(allPrescriptions).toHaveBeenCalledTimes(2);
      // Another sub-tab: nothing (not even on Refresh); back: one.
      tab('history')?.click();
      render();
      refresh();
      render();
      expect(allPrescriptions).toHaveBeenCalledTimes(2);
      tab('prescriptions')?.click();
      render();
      expect(allPrescriptions).toHaveBeenCalledTimes(3);
      // The workspace closing and opening again on it (or another tool's tab showing): one.
      fixture.componentRef.setInput('active', false);
      render();
      expect(allPrescriptions).toHaveBeenCalledTimes(3);
      fixture.componentRef.setInput('active', true);
      render();
      expect(allPrescriptions).toHaveBeenCalledTimes(4);
    });
  });

  describe('the visit drill-in', () => {
    it('Overview → View visit: Visits with the summary, focus on its heading; Back: the Overview, on the button inside its panel', () => {
      setup();
      const row = panel('overview')?.querySelector<HTMLButtonElement>('[data-visit-id]');
      expect(row).toBeTruthy();
      const id = row?.getAttribute('data-visit-id');
      row?.click();
      render();
      expect(panel('visits')?.hidden).toBe(false);
      expect(panel('overview')?.hidden).toBe(true);
      expect(panel('visits')?.querySelector('doc-call-visit-summary')).not.toBeNull();
      expect(document.activeElement?.tagName).toBe('H4');
      expect(el.querySelector('a')).toBeNull();
      byText('Back to visits')?.click();
      render();
      expect(panel('overview')?.hidden).toBe(false);
      expect(document.activeElement).toBe(panel('overview')?.querySelector(`[data-visit-id="${id}"]`));
      expect(document.activeElement).toBe(row);
    });

    it('Visits → View visit → Back: the row’s button inside the Visits panel', () => {
      setup();
      tab('visits')?.click();
      render();
      const row = panel('visits')?.querySelector<HTMLButtonElement>('[data-visit-id="v-old"]');
      row?.click();
      render();
      expect(panel('visits')?.querySelector('doc-patient-visits')).toBeNull();
      byText('Back to visits')?.click();
      render();
      expect(panel('visits')?.hidden).toBe(false);
      expect(document.activeElement).toBe(panel('visits')?.querySelector('[data-visit-id="v-old"]'));
    });

    it('the current consultation: the notice, whose buttons emit goTo', () => {
      setup({ active: true, signedIn: true, patientId: 'p1', currentAppointmentId: 'v-new' });
      tab('visits')?.click();
      render();
      expect(panel('visits')?.textContent).toContain('This consultation');
      panel('visits')?.querySelector<HTMLButtonElement>('[data-visit-id="v-new"]')?.click();
      render();
      byText('Prescriptions', panel('visits') as Element)?.click();
      expect(goTo).toEqual(['prescriptions']);
    });

    it('"Open latest visit" drills into the newest one', () => {
      setup();
      byText('Open latest visit')?.click();
      render();
      expect(panel('visits')?.querySelector('doc-call-visit-summary')).not.toBeNull();
      byText('Back to visits')?.click();
      render();
      expect(panel('overview')?.hidden).toBe(false);
    });

    it('"Open latest visit" while in an older visit: the summary follows it, nothing of the older one left', () => {
      setup();
      tab('visits')?.click();
      render();
      panel('visits')?.querySelector<HTMLButtonElement>('[data-visit-id="v-old"]')?.click();
      render();
      expect(panel('visits')?.textContent).toContain('Note of v-old');
      byText('Open latest visit')?.click();
      render();
      expect(getNote).toHaveBeenLastCalledWith('v-new');
      expect(panel('visits')?.textContent).toContain('Note of v-new');
      expect(panel('visits')?.textContent).not.toContain('Note of v-old');
      expect(document.activeElement?.tagName).toBe('H4');
    });

    it('the Overview’s View visit with a drill-in still mounted in the hidden Visits panel: the same', () => {
      setup();
      tab('visits')?.click();
      render();
      panel('visits')?.querySelector<HTMLButtonElement>('[data-visit-id="v-old"]')?.click();
      render();
      tab('overview')?.click();
      render();
      panel('overview')?.querySelector<HTMLButtonElement>('[data-visit-id="v-new"]')?.click();
      render();
      expect(panel('visits')?.hidden).toBe(false);
      expect(panel('visits')?.textContent).toContain('Note of v-new');
      expect(panel('visits')?.textContent).not.toContain('Note of v-old');
    });

    it('the current consultation first, then another visit: it reads, no endless shimmer', () => {
      setup({ active: true, signedIn: true, patientId: 'p1', currentAppointmentId: 'v-old' });
      tab('visits')?.click();
      render();
      panel('visits')?.querySelector<HTMLButtonElement>('[data-visit-id="v-old"]')?.click();
      render();
      expect(getNote).not.toHaveBeenCalled();
      tab('overview')?.click();
      render();
      panel('overview')?.querySelector<HTMLButtonElement>('[data-visit-id="v-new"]')?.click();
      render();
      expect(getNote).toHaveBeenCalledWith('v-new');
      expect(panel('visits')?.querySelector('.sd-shimmer')).toBeNull();
      expect(panel('visits')?.textContent).toContain('Note of v-new');
    });

    it('the drill-in survives a sub-tab switch', () => {
      setup();
      panel('overview')?.querySelector<HTMLButtonElement>('[data-visit-id]')?.click();
      render();
      const summary = panel('visits')?.querySelector('doc-call-visit-summary');
      tab('history')?.click();
      render();
      tab('visits')?.click();
      render();
      expect(panel('visits')?.querySelector('doc-call-visit-summary')).toBe(summary);
    });

    it('signing out destroys the drill-in', () => {
      setup();
      panel('overview')?.querySelector<HTMLButtonElement>('[data-visit-id]')?.click();
      render();
      fixture.componentRef.setInput('signedIn', false);
      render();
      expect(el.querySelector('doc-call-visit-summary')).toBeNull();
    });
  });

  describe('Documents', () => {
    const showDocuments = () => {
      tab('documents')?.click();
      render();
    };

    it('loading: shimmer rows; failed: the message and Try again, which emits', () => {
      setup({ active: true, signedIn: true, patientId: 'p1', documentsState: 'loading' });
      showDocuments();
      expect(panel('documents')?.querySelectorAll('.sd-shimmer').length).toBe(2);
      expect(panel('documents')?.querySelector('[aria-busy="true"]')).not.toBeNull();
      fixture.componentRef.setInput('documentsState', 'failed');
      render();
      expect(panel('documents')?.textContent).toContain(WS_EMR_DOCS_FAILED);
      let retries = 0;
      fixture.componentInstance.retryDocuments.subscribe(() => retries++);
      byText('Try again', panel('documents') as Element)?.click();
      expect(retries).toBe(1);
    });

    it('ready and empty: says how to ask', () => {
      setup();
      showDocuments();
      expect(panel('documents')?.textContent).toContain(WS_EMR_DOCS_EMPTY);
    });

    it('a list: one View per document, emitting it and the button; no download, request or withdraw anywhere', () => {
      const docs = () => ([doc('a'), doc('b', { uploader_role: 'doctor', viewable: false })]);
      setup({ active: true, signedIn: true, patientId: 'p1', documents: docs() });
      showDocuments();
      const seen: Array<{ doc: DoctorSharedDocumentDto; opener: HTMLElement | null }> = [];
      fixture.componentInstance.openDocument.subscribe((e) => seen.push({ doc: e.doc, opener: e.opener }));
      const views = Array.from(panel('documents')?.querySelectorAll<HTMLButtonElement>('[data-doc-id]') ?? []);
      expect(views.map((b) => b.getAttribute('aria-label'))).toEqual(['View Report a', 'View Report b']);
      views[0]?.click();
      expect(seen[0]?.doc.id).toBe('a');
      expect(seen[0]?.opener).toBe(views[0]);
      const text = panel('documents')?.textContent ?? '';
      expect(text).toContain('Lab report · PDF · 1.2 MB');
      expect(text).toContain('Patient upload');
      expect(text).toContain('Doctor-uploaded');
      expect(text).toContain('Preview not available');
      for (const banned of ['Download', 'Request', 'Withdraw']) expect(text).not.toContain(banned);
    });
  });
});
