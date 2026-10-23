import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { PrescriptionsApi } from '@supadoc/data-access';
import type { PrescriptionCheckResult } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { of } from 'rxjs';
import { CheckPrescription } from './check-prescription';

type Match = Extract<PrescriptionCheckResult, { result: 'match' }>;

function match(over: Partial<Match> = {}): Match {
  return {
    result: 'match',
    number: 'GVM-RX-20261004-00027',
    status: 'active',
    sent_at: '2026-10-04T10:00:00Z',
    valid_until: '2026-11-03',
    doctor: 'Dr. Ada Obi',
    mdcn_number: 'MDCN/R/12345',
    ...over,
  };
}

describe('CheckPrescription — the prescriber’s registration', () => {
  let fixture: ComponentFixture<CheckPrescription>;
  let el: HTMLElement;
  let answer: PrescriptionCheckResult;

  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const type = async (id: string, value: string) => {
    const input = el.querySelector<HTMLInputElement>(`#${id}`);
    if (!input) throw new Error(`No #${id}`);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await render();
  };
  /** The <dd> beside a <dt> label in the result. */
  const value = (label: string): string | undefined => {
    const dt = Array.from(el.querySelectorAll('dt')).find((d) => d.textContent?.trim() === label);
    return dt?.nextElementSibling?.textContent?.trim();
  };

  async function check(result: PrescriptionCheckResult) {
    answer = result;
    await type('rx-check-number', 'GVM-RX-20261004-00027');
    await type('rx-check-dob', '1990-01-01');
    el.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await render();
  }

  beforeEach(async () => {
    try {
      localStorage.removeItem('videomed.rxcheck.device');
    } catch {
      // Storage may be unavailable: the page copes.
    }
    await TestBed.configureTestingModule({
      imports: [CheckPrescription],
      providers: [provideRouter([]), provideSupadocIcons(), { provide: PrescriptionsApi, useValue: { check: () => of({ data: answer }) } }],
    }).compileComponents();
    fixture = TestBed.createComponent(CheckPrescription);
    el = fixture.nativeElement;
    await render();
  });

  it('labels the number as the API says for a doctor licensed abroad', async () => {
    await check(match({ mdcn_number: 'GMC-7001', registration_label: 'General Medical Council number' }));
    expect(value('General Medical Council number')).toBe('GMC-7001');
    expect(Array.from(el.querySelectorAll('dt')).some((d) => d.textContent?.trim() === 'MDCN number')).toBe(false);
  });

  it('falls back to "MDCN number" when the API sends no label', async () => {
    await check(match());
    expect(value('MDCN number')).toBe('MDCN/R/12345');
  });
});
