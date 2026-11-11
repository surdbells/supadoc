import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { AuthService } from '@supadoc/auth';
import { API_CONFIG, PatientApi } from '@supadoc/data-access';
import type { HealthProfileDto, MyVitalsDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { MyProfile } from './my-profile';

const ok = <T>(data: T) => of({ status: 'success', message: 'OK', data });

const health = {
  emergency_contact: {},
  insurance: {},
  medical: { history: [], allergies: [], medications: [], conditions: [] },
} as unknown as HealthProfileDto;

const fields = [
  {
    key: 'blood_pressure',
    label: 'Blood Pressure',
    unit: 'mmHg',
    min: null,
    max: null,
    step: null,
    max_hard: null,
    accepts_above: true,
    systolic: { min: 50, max: 260, max_hard: 999 },
    diastolic: { min: 30, max: 160, max_hard: 999 },
  },
  {
    key: 'heart_rate',
    label: 'Heart rate',
    unit: 'beats/min',
    min: 20,
    max: 250,
    max_hard: 9999,
    accepts_above: true,
    step: 1,
    normal_range: '50–100',
  },
  {
    key: 'temperature',
    label: 'Temperature',
    unit: '°C',
    min: 30,
    max: 45,
    max_hard: 9999,
    accepts_above: true,
    step: 0.1,
    normal_range: '36.0–37.5',
  },
  {
    key: 'weight',
    label: 'Weight',
    unit: 'kg',
    min: 0.5,
    max: 400,
    max_hard: 9999,
    accepts_above: true,
    step: 0.1,
  },
  {
    key: 'oxygen_saturation',
    label: 'Oxygen level',
    unit: '%',
    min: 50,
    max: 100,
    max_hard: 100,
    accepts_above: false,
    step: 1,
    normal_range: '95–100',
  },
  {
    key: 'height',
    label: 'Height',
    unit: 'cm',
    min: 30,
    max: 250,
    max_hard: 9999,
    accepts_above: true,
    step: 0.5,
  },
  {
    key: 'bmi',
    label: 'BMI',
    unit: 'kg/m²',
    min: 5,
    max: 90,
    max_hard: 9999,
    accepts_above: true,
    step: 0.1,
    derived: true,
    normal_range: '18.5–24.9',
  },
];

const aboveTemp = {
  key: 'temperature',
  label: 'Temperature',
  value: '46',
  unit: '°C',
  taken_at: new Date().toISOString(),
  source: 'self_reported',
  source_label: 'Self-reported',
  recorded_by: 'patient',
  stale: false,
  flag: {
    level: 'critical',
    label: 'Very high',
    advice: 'Seek urgent medical attention',
    out_of_range: true,
    usual_max: '45',
  },
};

/** An API service whose every other method answers an empty list. */
function apiStub(overrides: Record<string, unknown>): unknown {
  return new Proxy(overrides, {
    get: (target, prop: string) =>
      prop in target ? target[prop] : () => ok([]),
  });
}

type Testable = {
  openEdit: (f: 'vitals') => void;
  saveEdit: () => Promise<void>;
  view: { set: (v: string) => void };
};

describe('MyProfile › Vitals › Above the usual range', () => {
  let fixture: ComponentFixture<MyProfile>;
  let el: HTMLElement;
  let recordVitals: ReturnType<typeof vi.fn>;

  async function mount(latest: unknown[] = []): Promise<void> {
    // jsdom has no scrollIntoView (the editor scrolls to its heading).
    if (!Element.prototype.scrollIntoView)
      Element.prototype.scrollIntoView = vi.fn();
    const data = {
      latest,
      fields,
      sources: {},
      patient_sources: [],
      reminder: null,
    } as unknown as MyVitalsDto;
    recordVitals = vi.fn(() => ok({ ...data, latest: [aboveTemp] }));
    await TestBed.configureTestingModule({
      imports: [MyProfile],
      providers: [
        provideRouter([]),
        provideSupadocIcons(),
        { provide: API_CONFIG, useValue: { baseUrl: 'http://api.test' } },
        {
          provide: AuthService,
          useValue: {
            isAuthenticated: () => true,
            token: () => 'tok',
            logout: async () => undefined,
          },
        },
        {
          provide: PatientApi,
          useValue: apiStub({
            me: () =>
              ok({
                id: 'p-1',
                first_name: 'Ada',
                last_name: 'Obi',
                email: 'ada@example.test',
                phone: null,
                avatar_url: null,
              }),
            healthProfile: () => ok(health),
            vitals: () => ok(data),
            recordVitals,
            assetUrl: () => null,
          }),
        },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(MyProfile);
    el = fixture.nativeElement;
    document.body.appendChild(el);
    fixture.detectChanges();
    await fixture.whenStable();
  }

  async function openEditor(): Promise<void> {
    (fixture.componentInstance as unknown as Testable).openEdit('vitals');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function type(selector: string, value: string): void {
    const input = el.querySelector(selector) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  const summary = () =>
    el.querySelector('#vitals-above-summary')?.textContent?.trim() ?? '';

  afterEach(() => {
    fixture.destroy();
    el.remove();
  });

  it('accepts a temperature above the range with a calm, polite warning tied to the box', async () => {
    await mount();
    await openEditor();
    type('#vt-temperature', '46');
    const warn = el.querySelector('#vt-warn-temperature') as HTMLElement;
    expect(warn.textContent).toContain(
      'This is higher than readings usually go (up to 45 °C). Please check it was measured and entered correctly. If it is right, seek urgent medical attention.',
    );
    expect(warn.getAttribute('role')).toBeNull();
    expect(warn.closest('[aria-live="polite"]')).toBeTruthy();
    const input = el.querySelector('#vt-temperature') as HTMLInputElement;
    expect(input.getAttribute('aria-describedby')).toBe(
      'vt-hint-temperature vt-warn-temperature',
    );
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(el.querySelector('#vt-hint-temperature')?.textContent).toContain(
      'Normal range',
    );
    expect(summary()).toBe(
      '1 reading is higher than readings usually go. Please check it before you save.',
    );
    expect(
      el.querySelector('#vitals-above-summary')?.getAttribute('aria-live'),
    ).toBe('polite');
    expect(el.textContent?.toLowerCase()).not.toContain('abnormal');

    type('#vt-heart_rate', '260');
    expect(summary()).toBe(
      '2 readings are higher than readings usually go. Please check them before you save.',
    );
  });

  it('saves the above-range reading (the warning never blocks)', async () => {
    await mount();
    await openEditor();
    type('#vt-temperature', '46');
    await (fixture.componentInstance as unknown as Testable).saveEdit();
    expect(recordVitals).toHaveBeenCalledTimes(1);
    expect(recordVitals.mock.calls[0][0].readings).toEqual({
      temperature: '46',
    });
  });

  it('still rejects below the minimum, beyond the ceiling, and oxygen above 100', async () => {
    await mount();
    await openEditor();
    type('#vt-temperature', '10000');
    let err = el.querySelector('#vt-hint-temperature') as HTMLElement;
    expect(err.textContent).toContain(
      "Temperature can't be more than 9999 °C. Check the reading.",
    );
    expect(err.getAttribute('role')).toBe('alert');
    expect(el.querySelector('#vt-warn-temperature')).toBeNull();

    type('#vt-temperature', '29');
    err = el.querySelector('#vt-hint-temperature') as HTMLElement;
    expect(err.textContent).toContain('Temperature must be at least 30 °C');

    type('#vt-oxygen_saturation', '101');
    expect(
      el.querySelector('#vt-hint-oxygen_saturation')?.textContent,
    ).toContain('Oxygen level must be between 50 and 100 %');
    expect(el.querySelector('#vt-warn-oxygen_saturation')).toBeNull();

    await (fixture.componentInstance as unknown as Testable).saveEdit();
    expect(recordVitals).not.toHaveBeenCalled();
  });

  it('warns on blood pressure above 260/160 and keeps its other rules', async () => {
    await mount();
    await openEditor();
    const sys = '[aria-label="Systolic (top number)"]';
    const dia = '[aria-label="Diastolic (bottom number)"]';
    type(sys, '300');
    type(dia, '170');
    expect(el.querySelector('#vt-warn-blood_pressure')?.textContent).toContain(
      '(up to 260/160 mmHg)',
    );
    expect(el.querySelector(sys)?.getAttribute('aria-describedby')).toBe(
      'vt-hint-blood_pressure vt-warn-blood_pressure',
    );

    type(sys, '1000');
    expect(el.querySelector('#vt-hint-blood_pressure')?.textContent).toContain(
      "Blood pressure numbers can't be more than 999. Check the reading.",
    );
    type(sys, '170');
    type(dia, '180');
    expect(el.querySelector('#vt-hint-blood_pressure')?.textContent).toContain(
      'The bottom number must be lower than the top number',
    );
    expect(el.querySelector('#vt-warn-blood_pressure')).toBeNull();
  });

  it('works out a BMI above 90 and warns about it', async () => {
    await mount();
    await openEditor();
    type('#vt-weight', '300');
    type('#vt-height', '150');
    expect(el.textContent).toContain('133.3');
    expect(el.querySelector('#vt-warn-bmi')?.textContent).toContain(
      'This BMI is higher than readings usually go (up to 90 kg/m²)',
    );
  });

  it('keeps the warning on a saved reading in Medical Information', async () => {
    await mount([aboveTemp]);
    (fixture.componentInstance as unknown as Testable).view.set('medical');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const text = el.textContent ?? '';
    expect(text).toContain('Very high');
    expect(text).toContain('Check reading');
    expect(text).toContain(
      'Temperature is higher than readings usually go (up to 45 °C). Please check it was measured and entered correctly.',
    );
    expect(text).toContain('(Seek urgent medical attention)');
    expect(text.toLowerCase()).not.toContain('abnormal');
  });
});
