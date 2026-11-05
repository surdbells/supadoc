import { TestBed } from '@angular/core/testing';
import { LabRequestsApi } from '@supadoc/data-access';
import type { PatientLabRequestDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { NEVER } from 'rxjs';
import { LabAcceptDialog } from './lab-accept-dialog';

const STATEMENTS: PatientLabRequestDto['consent_statements'] = [
  { key: 'tests', text: 'I agree to have the tests in this request.', required: true, default: false },
  { key: 'pays_lab', text: 'I choose the lab and pay it directly.', required: true, default: false },
  { key: 'lab_disclosure', text: 'The request PDF includes the clinical details.', required: true, default: false },
  { key: 'share_results', text: 'Share the results with Dr. Grace Bell.', required: false, default: true },
];

/** The fields the dialog reads; a fresh object (and fresh statements) every call, like a reload. */
const request = (version = 'LAB-2026-11.1'): PatientLabRequestDto =>
  ({
    id: 'lr-1',
    number: 'GVM-REQ-20261104-00012',
    status: 'awaiting_consent',
    valid_until: '2026-12-04',
    doctor: { id: 'd-1', name: 'Grace Bell' },
    consent_version: version,
    consent_statements: STATEMENTS.map((s) => ({ ...s })),
  }) as unknown as PatientLabRequestDto;

describe('LabAcceptDialog', () => {
  const boxes = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));

  async function setup() {
    TestBed.configureTestingModule({
      imports: [LabAcceptDialog],
      providers: [provideSupadocIcons(), { provide: LabRequestsApi, useValue: { accept: () => NEVER } }],
    });
    const fixture = TestBed.createComponent(LabAcceptDialog);
    fixture.componentRef.setInput('request', request());
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture;
  }

  it('the same request reloaded keeps its boxes and ticks (no re-creation, no NG0956); a new wording starts afresh', async () => {
    const warn = vi.spyOn(console, 'warn');
    const fixture = await setup();
    const el: HTMLElement = fixture.nativeElement;
    const before = boxes(el);
    expect(before.map((b) => b.dataset['key'])).toEqual(['tests', 'pays_lab', 'lab_disclosure', 'share_results']);
    before[0].checked = true;
    before[0].dispatchEvent(new Event('change'));
    fixture.detectChanges();

    // The page reloads the request (new objects, same wording) — as it does while the dialog closes.
    fixture.componentRef.setInput('request', request());
    fixture.detectChanges();
    const after = boxes(el);
    expect(after.every((b, i) => b === before[i])).toBe(true);
    expect(after.map((b) => b.checked)).toEqual([true, false, false, true]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('NG0956'))).toBe(false);

    // A changed wording (409 consent_changed reload): new boxes from the served defaults.
    fixture.componentRef.setInput('request', request('LAB-2026-12.1'));
    fixture.detectChanges();
    const fresh = boxes(el);
    expect(fresh.some((b, i) => b === before[i])).toBe(false);
    expect(fresh.map((b) => b.checked)).toEqual([false, false, false, true]);
    warn.mockRestore();
  });
});
