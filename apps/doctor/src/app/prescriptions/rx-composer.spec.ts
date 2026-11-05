import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { DoctorApi, PrescriptionsApi } from '@supadoc/data-access';
import type {
  ClinicalSummaryDto,
  PrescriptionDto,
  PrescriptionOptionsDto,
} from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { DocumentViewerService, type ViewerOpenOptions, type ViewerSource } from '@supadoc/viewer';
import { firstValueFrom, Observable, of, throwError } from 'rxjs';
import { RxComposer } from './rx-composer';
import { RxFiles } from './rx-files';
import { RX_PREGNANCY_LABELS, RX_SOURCE_LABELS, RX_FOLLOW_UP_LABELS } from './rx-shared';

const OPTIONS: PrescriptionOptionsDto = {
  valid_days: 30,
  default_valid_until: '2099-01-01',
  max_items: 10,
  rows_per_page: 5,
  max_repeats: 11,
  limits: { reason: 220, current_medications: 110, advice: 220, tests_referrals: 110, instructions: 110 },
  routes: ['By mouth'],
  readings: [],
  reading_sources: RX_SOURCE_LABELS,
  pregnancy: RX_PREGNANCY_LABELS,
  follow_up_modes: RX_FOLLOW_UP_LABELS,
  has_signature: false,
  mdcn_number: 'MDCN/1',
};

function summary(over: Partial<ClinicalSummaryDto> = {}, dob: string | null = '1990-01-01'): ClinicalSummaryDto {
  return {
    patient: { id: 'p1', name: 'Ada Obi', gender: 'female', date_of_birth: dob, age: 36 },
    allergies_recorded: true,
    allergies: [],
    ask_pregnancy: false,
    vitals: [],
    medicines: [],
    conditions: [],
    ...over,
  };
}

/** The composer's protected state, read the way the template does. */
interface Settable<T> {
  (): T;
  set(v: T): void;
}
interface ComposerView {
  pregnancy(): string;
  fe(key: string): string;
  formError(): string;
  patientError(): string;
  sendError(): string;
  drawn: Settable<string | null>;
  checkAllergies: Settable<boolean>;
  checkDoses: Settable<boolean>;
  checkPatient: Settable<boolean>;
  saveDrawn(): boolean;
  saveDraft(): void;
  confirmSend(): void;
  setSigMode(m: 'saved' | 'drawn'): void;
  rows(): { rxcui: string | null; dose: string }[];
  draft(): { key: number } | null;
  pickDraftDrug(d: Record<string, unknown>): void;
  setDraft(field: string, value: string | boolean): void;
  commitDraft(): boolean;
  startEdit(key: number): void;
  removeRow(key: number): void;
  undoRemove(): void;
  openSend(): void;
  sendOpen(): boolean;
}

const AMOXICILLIN = {
  rxcui: '308191',
  tty: 'SCD',
  name: 'amoxicillin 500 MG Oral Capsule',
  generic_name: 'amoxicillin',
  brand: null,
  branded: false,
  dose_form: 'Oral Capsule',
  route: 'By mouth',
};

/** Fill the add-medicine form with a complete medicine. */
function fillDraft(c: ComposerView, dose = '1 capsule'): void {
  c.pickDraftDrug(AMOXICILLIN);
  c.setDraft('dose', dose);
  c.setDraft('route', 'By mouth');
  c.setDraft('frequency', 'Three times daily');
  c.setDraft('duration', '7 days');
  c.setDraft('quantity', '21 capsules');
}

function setup(opts: {
  summary: ClinicalSummaryDto;
  draft?: Partial<PrescriptionDto>;
  create?: (input?: unknown) => Observable<unknown>;
  send?: () => Observable<unknown>;
  options?: () => Observable<unknown>;
}) {
  TestBed.configureTestingModule({
    imports: [RxComposer],
    providers: [
      provideRouter([]),
      provideSupadocIcons(),
      { provide: RxFiles, useValue: {} },
      {
        provide: DoctorApi,
        useValue: {
          prescriptionOptions: opts.options ?? (() => of({ data: OPTIONS })),
          getPrescription: () =>
            of({ data: { id: 'rx1', status: 'draft', items: [], readings: {}, ...opts.draft } }),
          clinicalSummary: () => of({ data: opts.summary }),
          createPrescription: opts.create ?? (() => of({ data: { id: 'rx1', status: 'draft' } })),
          sendPrescription: opts.send ?? (() => of({ data: { id: 'rx1', status: 'active' } })),
          searchDrugs: () => of({ data: [] }),
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(RxComposer);
  fixture.componentRef.setInput('patientId', 'p1');
  fixture.componentRef.setInput('appointmentId', 'a1');
  if (opts.draft) fixture.componentRef.setInput('prescriptionId', 'rx1');
  fixture.detectChanges();
  fixture.detectChanges();
  const c = fixture.componentInstance as unknown as ComposerView;
  return { fixture, c, text: () => (fixture.nativeElement as HTMLElement).textContent ?? '' };
}

describe('RxComposer', () => {
  it('warns up front when the patient has no date of birth on file', async () => {
    const { fixture, text } = setup({ summary: summary({}, null) });
    await fixture.whenStable();
    expect(text()).toContain("This patient's date of birth is not on file");
  });

  it('clears a hidden "Not applicable" pregnancy answer for a patient who must be asked', async () => {
    const { fixture, c } = setup({
      summary: summary({ ask_pregnancy: true }),
      draft: { pregnancy_status: 'not_applicable' },
    });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(c.pregnancy()).toBe('');
    expect(c.fe('pregnancy_status')).not.toBe('');
  });

  it('shows why a prescription cannot be created for this appointment', async () => {
    const message = 'This consultation was cancelled before it took place.';
    const { fixture, c } = setup({
      summary: summary(),
      create: () =>
        throwError(() => ({ statusCode: 422, message: 'Validation failed', errors: { appointment_id: message } })),
    });
    await fixture.whenStable();
    c.saveDraft();
    expect(c.formError()).toBe(message);
  });

  it('shows a send refused for a missing date of birth as its own banner, not as box errors', async () => {
    const message = "The patient's date of birth is not on file.";
    const { fixture, c } = setup({
      summary: summary(),
      draft: { reason: 'Cough' },
      send: () => throwError(() => ({ statusCode: 422, message: 'Validation failed', errors: { patient: message } })),
    });
    await fixture.whenStable();
    c.checkAllergies.set(true);
    c.checkDoses.set(true);
    c.checkPatient.set(true);
    c.setSigMode('drawn');
    c.drawn.set('data:image/png;base64,AAAA');
    c.confirmSend();
    fixture.detectChanges();
    expect(c.patientError()).toBe(message);
    expect(c.sendError()).toBe('');
    expect(c.formError()).toBe('');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(message);
  });

  it('reports no unsaved changes when the form failed to load (nothing to lose)', async () => {
    const { fixture } = setup({
      summary: summary(),
      options: () => throwError(() => ({ statusCode: 503, message: 'Service unavailable' })),
    });
    await fixture.whenStable();
    expect(fixture.componentInstance.hasUnsavedChanges()).toBe(false);
  });

  it('treats pregnancy as not applicable for a male patient', async () => {
    let sent: Record<string, unknown> | null = null;
    const { fixture, c, text } = setup({
      summary: summary({ patient: { id: 'p1', name: 'Ade Obi', gender: 'male', date_of_birth: '1990-01-01', age: 36 } }),
      create: (input?: unknown) => {
        sent = input as Record<string, unknown>;
        return of({ data: { id: 'rx1', status: 'draft', items: [], readings: {} } });
      },
    });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(text()).toContain('Not applicable — male patient');
    expect((fixture.nativeElement as HTMLElement).querySelector('select[id$="-preg"]')).toBeNull();
    // Showing "Not applicable" is not an edit.
    expect(fixture.componentInstance.hasUnsavedChanges()).toBe(false);
    c.saveDraft();
    const form = ((sent as { form?: Record<string, unknown> } | null)?.form ?? sent) as Record<string, unknown>;
    expect(form['pregnancy_status']).toBe('not_applicable');
  });

  it('only lists a medicine once it is complete, and supports edit, remove and undo', async () => {
    const { fixture, c } = setup({ summary: summary() });
    await fixture.whenStable();
    expect(c.rows().length).toBe(0);
    expect(c.draft()).not.toBeNull();

    // Incomplete: stays in the form with its messages.
    expect(c.commitDraft()).toBe(false);
    expect(c.rows().length).toBe(0);
    const key = c.draft()?.key ?? -1;
    expect(c.fe(`row:${key}.rxcui`)).not.toBe('');
    expect(c.fe(`row:${key}.dose`)).not.toBe('');

    fillDraft(c);
    expect(c.commitDraft()).toBe(true);
    expect(c.rows().map((r) => r.dose)).toEqual(['1 capsule']);
    expect(c.draft()).toBeNull();
    expect(c.fe(`row:${key}.rxcui`)).toBe('');

    // Edit in the form; the list changes only on "Save changes".
    const listed = c.rows()[0] as unknown as { key: number };
    c.startEdit(listed.key);
    c.setDraft('dose', '2 capsules');
    expect(c.rows()[0].dose).toBe('1 capsule');
    expect(c.commitDraft()).toBe(true);
    expect(c.rows()[0].dose).toBe('2 capsules');

    c.removeRow(listed.key);
    expect(c.rows().length).toBe(0);
    c.undoRemove();
    expect(c.rows().map((r) => r.dose)).toEqual(['2 capsules']);
  });

  it('keeps an edit\'s errors in the form: Cancel leaves the listed medicine as it was', async () => {
    const { fixture, c } = setup({ summary: summary() });
    await fixture.whenStable();
    fillDraft(c);
    c.commitDraft();
    const listed = c.rows()[0] as unknown as { key: number };
    c.startEdit(listed.key);
    c.setDraft('dose', '');
    expect(c.commitDraft()).toBe(false);
    expect(c.fe(`row:${c.draft()?.key}.dose`)).not.toBe('');
    // The listed medicine shows no error, and none appears after Cancel.
    expect(c.fe(`row:${listed.key}.dose`)).toBe('');
    (c as unknown as { cancelDraft(): void }).cancelDraft();
    expect(c.fe(`row:${listed.key}.dose`)).toBe('');
    expect(c.rows()[0].dose).toBe('1 capsule');
    // Edit is not offered while the form holds unsaved work.
    (c as unknown as { startAdd(): void }).startAdd();
    c.setDraft('dose', '5 ml');
    c.startEdit(listed.key);
    expect((c.draft() as unknown as { dose: string }).dose).toBe('5 ml');
  });

  it('will not send while the medicine form holds an incomplete medicine', async () => {
    const { fixture, c } = setup({ summary: summary(), draft: { reason: 'Cough' } });
    await fixture.whenStable();
    fillDraft(c);
    c.commitDraft();
    // Start another one and leave it half-filled.
    (c as unknown as { startAdd(): void }).startAdd();
    c.setDraft('dose', '1 tablet');
    c.openSend();
    expect(c.sendOpen()).toBe(false);
    expect(c.formError()).toContain('Finish the medicine in the form');
    expect(c.rows().length).toBe(1);
  });

  it('starts from a blank pad whenever the signature mode changes', () => {
    const { c } = setup({ summary: summary() });
    c.setSigMode('drawn');
    c.drawn.set('data:image/png;base64,AAAA');
    c.setSigMode('saved');
    c.setSigMode('drawn');
    expect(c.drawn()).toBeNull();
    expect(c.saveDrawn()).toBe(false);
  });

  it("names the missing registration number the doctor's way (MDCN, or their regulator abroad)", async () => {
    const ng = setup({ summary: summary(), options: () => of({ data: { ...OPTIONS, mdcn_number: null } }) });
    await ng.fixture.whenStable();
    ng.fixture.detectChanges();
    expect(ng.text()).toContain('Add your MDCN number in your profile');
    TestBed.resetTestingModule();
    const abroad = setup({
      summary: summary(),
      options: () => of({ data: { ...OPTIONS, mdcn_number: null, registration_label: 'General Medical Council number' } }),
    });
    await abroad.fixture.whenStable();
    abroad.fixture.detectChanges();
    expect(abroad.text()).toContain('Add your General Medical Council number in your profile');
  });
});

describe('RxComposer — PDFs in the shared viewer', () => {
  type Opened = { sources: ViewerSource; options: ViewerOpenOptions; active: Element | null };
  let opened: Opened[];
  let order: string[];

  function setupViewer(opts: { draft?: Partial<PrescriptionDto>; create?: () => Observable<unknown> } = {}) {
    opened = [];
    order = [];
    const viewer = {
      open: vi.fn((sources: ViewerSource, options: ViewerOpenOptions = {}) => {
        opened.push({ sources, options, active: document.activeElement });
        return { closed: Promise.resolve(), close: () => undefined };
      }),
    };
    const api = {
      prescriptionOptions: () => of({ data: OPTIONS }),
      getPrescription: () => of({ data: { id: 'rx1', number: 'GVM-RX-1', status: 'draft', items: [], readings: {}, ...opts.draft } }),
      clinicalSummary: () => of({ data: summary() }),
      createPrescription: vi.fn(
        opts.create ??
          (() =>
            new Observable((sub) => {
              order.push('persist');
              sub.next({ data: { id: 'rx-new', number: 'GVM-RX-2', status: 'draft', items: [], readings: {} } });
              sub.complete();
            })),
      ),
      updatePrescription: vi.fn(() => of({ data: { id: 'rx1', number: 'GVM-RX-1', status: 'draft', items: [], readings: {} } })),
      sendPrescription: () => of({ data: { id: 'rx1', number: 'GVM-RX-1', status: 'active', items: [], readings: {} } }),
      prescriptionLink: vi.fn((id: string) => {
        order.push(`link:${id}`);
        return of({ data: { url: 'api/public/prescriptions/file?token=t', filename: 'x.pdf', expires_at: '' } });
      }),
      searchDrugs: () => of({ data: [] }),
    };
    TestBed.configureTestingModule({
      imports: [RxComposer],
      providers: [
        provideRouter([]),
        provideSupadocIcons(),
        { provide: DoctorApi, useValue: api },
        { provide: PrescriptionsApi, useValue: { fileBlob: () => of(new Blob(['%PDF'], { type: 'application/pdf' })) } },
        { provide: DocumentViewerService, useValue: viewer },
      ],
    });
    const fixture = TestBed.createComponent(RxComposer);
    document.body.appendChild(fixture.nativeElement);
    fixture.componentRef.setInput('patientId', 'p1');
    fixture.componentRef.setInput('appointmentId', 'a1');
    if (opts.draft) fixture.componentRef.setInput('prescriptionId', 'rx1');
    fixture.detectChanges();
    fixture.detectChanges();
    const c = fixture.componentInstance as unknown as ComposerView & { preview(): void; viewPdf(): void; busy(): string };
    return { fixture, c, api, viewer, el: fixture.nativeElement as HTMLElement };
  }

  afterEach(() => document.querySelectorAll('doc-rx-composer, div[id^="root"]').forEach((n) => n.remove()));

  it('has no blocked-tab link: nothing opens a tab any more', async () => {
    const { fixture, el } = setupViewer({ draft: { status: 'active' } });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.textContent).not.toContain('blocked the new tab');
    expect(el.querySelector('a[target="_blank"][href*="prescriptions"]')).toBeNull();
  });

  it('Preview from a NEW composer opens the viewer at once; the save runs inside its load, then the link for the saved id', async () => {
    const { fixture, c, api } = setupViewer();
    await fixture.whenStable();
    fillDraft(c);
    c.commitDraft();
    c.preview();
    // At once, in the loading state: nothing saved or linked yet.
    expect(opened).toHaveLength(1);
    expect(api.createPrescription).not.toHaveBeenCalled();
    const source = opened[0].sources;
    expect(source.key).toMatch(/^rx-draft:\d+$/);
    expect(source.key).not.toContain('undefined');
    expect(source.policy).toBe('authored_draft');
    expect(source.download).toBeUndefined();
    await firstValueFrom(source.load());
    expect(order).toEqual(['persist', 'link:rx-new']);
    expect(api.prescriptionLink).toHaveBeenCalledWith('rx-new');
    expect(api.prescriptionLink).not.toHaveBeenCalledWith(undefined);
    expect(c.busy()).toBe('');
  });

  it('Preview of a saved, unchanged draft links it without saving again; the key stays the composer’s', async () => {
    const { fixture, c, api } = setupViewer({ draft: { reason: 'Cough' } });
    await fixture.whenStable();
    fixture.detectChanges();
    c.preview();
    const first = opened[0].sources;
    await firstValueFrom(first.load());
    expect(api.createPrescription).not.toHaveBeenCalled();
    expect(api.updatePrescription).not.toHaveBeenCalled();
    expect(order).toEqual(['link:rx1']);
    c.preview();
    expect(opened[1].sources.key).toBe(first.key);
  });

  it('a save that fails shows in the viewer (Try again) and under the form', async () => {
    const message = 'This consultation was cancelled before it took place.';
    const { fixture, c } = setupViewer({
      create: () => throwError(() => ({ statusCode: 422, message: 'Validation failed', errors: { appointment_id: message } })),
    });
    await fixture.whenStable();
    c.preview();
    const source = opened[0].sources;
    let err: unknown = null;
    await firstValueFrom(source.load()).catch((e: unknown) => (err = e));
    expect(err).not.toBeNull();
    expect(source.mapError?.(err)).toEqual({ state: 'error', text: message, retry: true });
    expect(c.formError()).toBe(message);
    expect(source.mapError?.({ statusCode: 503 })).toBeNull();
  });

  it('"View PDF" in the Send dialog opens the viewer stacked over it, its button the opener focus returns to', async () => {
    const { fixture, c, el } = setupViewer({ draft: { reason: 'Cough' } });
    await fixture.whenStable();
    fixture.detectChanges();
    c.checkAllergies.set(true);
    c.checkDoses.set(true);
    c.checkPatient.set(true);
    c.setSigMode('drawn');
    c.drawn.set('data:image/png;base64,AAAA');
    (c as unknown as { sendOpen: { set(v: boolean): void } }).sendOpen.set(true);
    c.confirmSend();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const button = Array.from(el.querySelectorAll<HTMLButtonElement>('dialog button')).find((b) => (b.textContent ?? '').includes('View PDF'));
    expect(button).toBeDefined();
    // Safari doesn't focus a clicked button: the click (here on its icon) names the opener itself.
    expect(document.activeElement).not.toBe(button);
    button?.querySelector('sd-icon')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(opened).toHaveLength(1);
    expect(opened[0].sources.policy).toBe('authored');
    expect(opened[0].sources.key).toBe('rx:rx1');
    // The button inside the Send dialog, so focus returns to it when the stacked viewer closes.
    expect(opened[0].options.opener).toBe(button);
  });

  it('"Preview PDF" and a locked composer’s "View PDF" name their clicked button as the opener (no focus needed)', async () => {
    const draft = setupViewer({ draft: { reason: 'Cough' } });
    await draft.fixture.whenStable();
    draft.fixture.detectChanges();
    const preview = Array.from(draft.el.querySelectorAll<HTMLButtonElement>('button')).find((b) => (b.textContent ?? '').includes('Preview'));
    expect(preview).toBeDefined();
    expect(document.activeElement).not.toBe(preview);
    preview?.click();
    expect(opened).toHaveLength(1);
    expect(opened[0].sources.policy).toBe('authored_draft');
    expect(opened[0].options.opener).toBe(preview);
    draft.fixture.destroy();
    document.querySelectorAll('doc-rx-composer').forEach((n) => n.remove());
    TestBed.resetTestingModule();

    const sent = setupViewer({ draft: { status: 'active' } });
    await sent.fixture.whenStable();
    sent.fixture.detectChanges();
    const view = Array.from(sent.el.querySelectorAll<HTMLButtonElement>('button')).find((b) => (b.textContent ?? '').includes('View PDF'));
    expect(view).toBeDefined();
    view?.click();
    expect(opened).toHaveLength(1);
    expect(opened[0].sources.key).toBe('rx:rx1');
    expect(opened[0].options.opener).toBe(view);
  });
});
