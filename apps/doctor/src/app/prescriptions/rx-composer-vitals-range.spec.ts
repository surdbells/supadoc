import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { DoctorApi } from '@supadoc/data-access';
import type {
  ClinicalSummaryDto,
  PrescriptionOptionsDto,
  ReadingKey,
} from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { of } from 'rxjs';
import { RxComposer } from './rx-composer';
import { RxFiles } from './rx-files';
import {
  RX_FOLLOW_UP_LABELS,
  RX_PREGNANCY_LABELS,
  RX_SOURCE_LABELS,
} from './rx-shared';

const OPTIONS: PrescriptionOptionsDto = {
  valid_days: 30,
  default_valid_until: '2099-01-01',
  max_items: 10,
  rows_per_page: 5,
  max_repeats: 11,
  limits: { reason: 220, advice: 220, tests_referrals: 110, instructions: 110 },
  routes: ['By mouth'],
  readings: [
    {
      key: 'temperature',
      label: 'Temperature',
      unit: '°C',
      min: 30,
      max: 45,
      max_hard: 9999,
      accepts_above: true,
    },
    {
      key: 'heart_rate',
      label: 'Heart rate',
      unit: 'beats/min',
      min: 20,
      max: 250,
      max_hard: 9999,
      accepts_above: true,
    },
    {
      key: 'blood_pressure',
      label: 'Blood pressure',
      unit: 'mmHg',
      min: null,
      max: null,
      max_hard: null,
      accepts_above: true,
      systolic: { min: 50, max: 260, max_hard: 999 },
      diastolic: { min: 30, max: 160, max_hard: 999 },
    },
    {
      key: 'oxygen_saturation',
      label: 'Oxygen level',
      unit: '%',
      min: 50,
      max: 100,
      max_hard: 100,
      accepts_above: false,
    },
    {
      key: 'weight',
      label: 'Weight',
      unit: 'kg',
      min: 0.5,
      max: 400,
      max_hard: 9999,
      accepts_above: true,
    },
    {
      key: 'height',
      label: 'Height',
      unit: 'cm',
      min: 30,
      max: 250,
      max_hard: 9999,
      accepts_above: true,
    },
    {
      key: 'bmi',
      label: 'BMI',
      unit: 'kg/m²',
      min: 5,
      max: 90,
      max_hard: 9999,
      accepts_above: true,
    },
  ],
  reading_sources: RX_SOURCE_LABELS,
  pregnancy: RX_PREGNANCY_LABELS,
  follow_up_modes: RX_FOLLOW_UP_LABELS,
  has_signature: false,
  mdcn_number: 'MDCN/1',
};

const SUMMARY: ClinicalSummaryDto = {
  patient: {
    id: 'p1',
    name: 'Ada Obi',
    gender: 'female',
    date_of_birth: '1990-01-01',
    age: 36,
  },
  allergies_recorded: true,
  allergies: [],
  ask_pregnancy: false,
  vitals: [],
  conditions: [],
};

interface ComposerView {
  setReading(key: ReadingKey, value: string): void;
  reading(key: ReadingKey): string;
  checkAllergies: { set(v: boolean): void };
  checkDoses: { set(v: boolean): void };
  checkPatient: { set(v: boolean): void };
  drawn: { set(v: string | null): void };
  setSigMode(m: 'saved' | 'drawn'): void;
  confirmSend(): void;
  sendOpen: { set(v: boolean): void };
}

function setup() {
  const send = vi.fn(() =>
    of({ data: { id: 'rx1', status: 'active', items: [], readings: {} } }),
  );
  TestBed.configureTestingModule({
    imports: [RxComposer],
    providers: [
      provideRouter([]),
      provideSupadocIcons(),
      { provide: RxFiles, useValue: {} },
      {
        provide: DoctorApi,
        useValue: {
          prescriptionOptions: () => of({ data: OPTIONS }),
          getPrescription: () =>
            of({
              data: {
                id: 'rx1',
                status: 'draft',
                items: [],
                readings: {},
                reason: 'Cough',
              },
            }),
          clinicalSummary: () => of({ data: SUMMARY }),
          createPrescription: () =>
            of({ data: { id: 'rx1', status: 'draft' } }),
          updatePrescription: () =>
            of({
              data: { id: 'rx1', status: 'draft', items: [], readings: {} },
            }),
          sendPrescription: send,
          searchDrugs: () => of({ data: [] }),
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(RxComposer);
  fixture.componentRef.setInput('patientId', 'p1');
  fixture.componentRef.setInput('appointmentId', 'a1');
  fixture.componentRef.setInput('prescriptionId', 'rx1');
  fixture.detectChanges();
  fixture.detectChanges();
  const c = fixture.componentInstance as unknown as ComposerView;
  const el = fixture.nativeElement as HTMLElement;
  const box = (key: string) =>
    el.querySelector<HTMLInputElement>(`input[id$="-r-${key}"]`);
  const type = (key: ReadingKey, value: string) => {
    c.setReading(key, value);
    fixture.detectChanges();
  };
  return { fixture, c, el, box, type, send };
}

describe('RxComposer — readings above the expected range', () => {
  it('warns under the box, describes the box by it and sums it up in the action bar', async () => {
    const { fixture, el, box, type } = setup();
    await fixture.whenStable();
    fixture.detectChanges();
    type('temperature', '46');
    const warn = el.querySelector('[data-rx-warning]') as HTMLElement;
    expect(warn.textContent).toContain(
      'Above the expected range (max 45 °C). Confirm the reading before issuing.',
    );
    expect(warn.getAttribute('role')).toBeNull();
    expect(warn.closest('[aria-live="polite"]')).toBeTruthy();
    expect(box('temperature')?.getAttribute('aria-describedby')).toBe(warn.id);
    expect(box('temperature')?.getAttribute('aria-invalid')).toBeNull();
    expect(el.querySelector('[data-rx-above-summary]')?.textContent).toContain(
      '1 reading above the expected range — confirm before issuing.',
    );

    type('heart_rate', '260');
    expect(el.querySelector('[data-rx-above-summary]')?.textContent).toContain(
      '2 readings above the expected range',
    );
  });

  it('warns on blood pressure above 260/160, never on oxygen, and not within range', async () => {
    const { fixture, el, type } = setup();
    await fixture.whenStable();
    fixture.detectChanges();
    type('blood_pressure', '300/170');
    expect(el.textContent).toContain(
      'Above the expected range (max 260/160 mmHg). Confirm the reading before issuing.',
    );
    type('blood_pressure', '120/80');
    type('oxygen_saturation', '101');
    type('temperature', '37');
    expect(el.querySelector('[data-rx-warning]')).toBeNull();
    expect(el.querySelector('[data-rx-above-summary]')).toBeNull();
  });

  it('says as it is typed when a number is too high for the API, and drops the warning', async () => {
    const { fixture, el, box, type } = setup();
    await fixture.whenStable();
    fixture.detectChanges();
    type('heart_rate', '9000');
    expect(el.querySelector('[data-rx-warning]')).toBeTruthy();
    type('heart_rate', '99999');
    expect(el.querySelector('[data-rx-warning]')).toBeNull();
    const limit = el.querySelector('[data-rx-limit]') as HTMLElement;
    expect(limit.textContent).toContain(
      'Heart rate is too large to be a reading. Check what you entered.',
    );
    expect(box('heart_rate')?.getAttribute('aria-invalid')).toBe('true');
    expect(box('heart_rate')?.getAttribute('aria-describedby')).toBe(limit.id);

    type('heart_rate', '');
    type('oxygen_saturation', '101');
    expect(el.querySelector('[data-rx-limit]')?.textContent).toContain(
      'Oxygen level must be a number between 50 and 100',
    );
    type('oxygen_saturation', '98');
    type('blood_pressure', '1000/80');
    expect(el.querySelector('[data-rx-limit]')?.textContent).toContain(
      'Each blood pressure number must be 3 digits or fewer.',
    );
    type('blood_pressure', '120/80');
    expect(el.querySelector('[data-rx-limit]')).toBeNull();
  });

  it('compares the value as it will be stored (one decimal), like the API', async () => {
    const { fixture, el, type } = setup();
    await fixture.whenStable();
    fixture.detectChanges();
    type('temperature', '45.04');
    expect(el.querySelector('[data-rx-warning]')).toBeNull();
    expect(el.querySelector('[data-rx-above-summary]')).toBeNull();
    type('temperature', '45.05');
    expect(el.querySelector('[data-rx-warning]')).toBeTruthy();
  });

  it('works a BMI above 90 out (no longer dropped) and asks to confirm weight and height', async () => {
    const { fixture, c, el, type } = setup();
    await fixture.whenStable();
    fixture.detectChanges();
    type('weight', '300');
    type('height', '150');
    expect(c.reading('bmi')).toBe('133.3');
    expect(el.textContent).toContain(
      'Above the expected range (max 90 kg/m²). Confirm weight and height before issuing.',
    );
  });

  it('asks to confirm a height above the range, with no urgent-care advice', async () => {
    const { fixture, el, type } = setup();
    await fixture.whenStable();
    fixture.detectChanges();
    type('height', '260');
    const warn = el.querySelector('[data-rx-warning]') as HTMLElement;
    expect(warn.textContent?.trim()).toContain(
      'Above the expected range (max 250 cm). Confirm the reading before issuing.',
    );
    expect(el.textContent?.toLowerCase()).not.toContain('urgent');
  });

  it('shows the readings in the Send dialog and still sends', async () => {
    const { fixture, c, el, type, send } = setup();
    await fixture.whenStable();
    fixture.detectChanges();
    type('temperature', '46');
    c.sendOpen.set(true);
    fixture.detectChanges();
    const sendNote = el.querySelector('[data-rx-above-send]') as HTMLElement;
    expect(sendNote.textContent).toContain(
      'Above the expected range: Temperature 46 °C. Confirm the readings before issuing.',
    );
    // A reminder, not an error: no assertive alert role.
    expect(sendNote.closest('[role="alert"]')).toBeNull();
    expect(sendNote.querySelector('[role="alert"]')).toBeNull();
    c.checkAllergies.set(true);
    c.checkDoses.set(true);
    c.checkPatient.set(true);
    c.setSigMode('drawn');
    c.drawn.set('data:image/png;base64,AAAA');
    c.confirmSend();
    await fixture.whenStable();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
