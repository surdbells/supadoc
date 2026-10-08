import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { DoctorApi } from '@supadoc/data-access';
import type {
  ClinicalSummaryDto,
  PrescriptionDto,
  PrescriptionOptionsDto,
} from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { Observable, of, throwError } from 'rxjs';
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
});
