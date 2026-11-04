import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { AuthService } from '@supadoc/auth';
import { API_CONFIG, PatientApi } from '@supadoc/data-access';
import type { HealthProfileDto, MyVitalsDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { MyProfile } from './my-profile';

const ok = <T,>(data: T) => of({ status: 'success', message: 'OK', data });

const health = {
  emergency_contact: {},
  insurance: {},
  medical: { history: [], allergies: [], medications: [], conditions: [] },
} as unknown as HealthProfileDto;

const vitals = {
  latest: [],
  fields: [
    {
      key: 'blood_pressure',
      label: 'Blood Pressure',
      unit: 'mmHg',
      min: null,
      max: null,
      step: null,
      systolic: { min: 50, max: 260 },
      diastolic: { min: 30, max: 160 },
    },
  ],
  sources: {},
  patient_sources: [],
  reminder: null,
} as unknown as MyVitalsDto;

/** An API service whose every other method answers an empty list. */
function apiStub(overrides: Record<string, unknown>): unknown {
  return new Proxy(overrides, {
    get: (target, prop: string) => (prop in target ? target[prop] : () => ok([])),
  });
}

describe('MyProfile › Vitals › Blood pressure', () => {
  let fixture: ComponentFixture<MyProfile>;
  let el: HTMLElement;

  beforeEach(async () => {
    // jsdom has no scrollIntoView (the editor scrolls to its heading).
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn();
    await TestBed.configureTestingModule({
      imports: [MyProfile],
      providers: [
        provideRouter([]),
        provideSupadocIcons(),
        { provide: API_CONFIG, useValue: { baseUrl: 'http://api.test' } },
        { provide: AuthService, useValue: { isAuthenticated: () => true, token: () => 'tok', logout: async () => undefined } },
        {
          provide: PatientApi,
          useValue: apiStub({
            me: () => ok({ id: 'p-1', first_name: 'Ada', last_name: 'Obi', email: 'ada@example.test', phone: null, avatar_url: null }),
            healthProfile: () => ok(health),
            vitals: () => ok(vitals),
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
    (fixture.componentInstance as unknown as { openEdit: (f: 'vitals') => void }).openEdit('vitals');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    el.remove();
  });

  it('splits the one box with a line in its own border colour, between the two numbers (no "/")', () => {
    const group = el.querySelector('[role="group"][aria-labelledby="bp-label"]');
    expect(group).toBeTruthy();
    const divider = group?.querySelector('[data-testid="bp-divider"]') as HTMLElement | null;
    expect(divider).toBeTruthy();
    expect(divider?.getAttribute('aria-hidden')).toBe('true');
    expect(divider?.className).toContain('[border-left-color:inherit]');
    // Both inputs and the line are direct children of the bordered box, in order.
    const box = divider?.parentElement as HTMLElement;
    expect(box.className).toContain('border-ash');
    const kids = Array.from(box.children).map((c) => c.getAttribute('aria-label') ?? c.getAttribute('data-testid'));
    expect(kids).toEqual(['Systolic (top number)', 'bp-divider', 'Diastolic (bottom number)']);
    expect(box.textContent?.trim()).toBe('');
    expect(group?.textContent).not.toContain('/');
    expect(group?.textContent).toContain('Systolic (top) | diastolic (bottom), in mmHg');
  });
});
