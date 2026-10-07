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
}

function setup(opts: {
  summary: ClinicalSummaryDto;
  draft?: Partial<PrescriptionDto>;
  create?: () => Observable<unknown>;
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
