import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { StaffAuthService } from '@supadoc/auth';
import { DoctorApi } from '@supadoc/data-access';
import type { PrescriptionDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { of, throwError } from 'rxjs';
import { PrescriptionPage } from './prescription-page';
import { RxFiles } from './rx-files';

/** A sent prescription as the API returns it (no "medicines already taken" unless given). */
function sent(over: Partial<PrescriptionDto> = {}): PrescriptionDto {
  return {
    id: 'rx1',
    number: 'GVM-RX-20261105-00001',
    status: 'active',
    appointment_id: 'a1',
    patient_id: 'p1',
    prescriber: 'Dr. Grace Bell',
    patient_name: 'Ada Obi',
    items_count: 0,
    valid_until: '2026-12-05',
    allows_repeats: false,
    sent_at: '2026-11-05T09:00:00Z',
    cancelled_at: null,
    created_at: '2026-11-05T08:50:00Z',
    readings: {},
    reason: 'Acute sinusitis',
    icd_code: 'CA01',
    current_medications: null,
    pregnancy_status: 'no',
    items: [],
    advice: null,
    follow_up_date: null,
    follow_up_mode: null,
    tests_referrals: null,
    prescriber_details: { name: 'Dr. Grace Bell' },
    patient_details: { name: 'Ada Obi' },
    signature_mode: 'saved',
    cancel_reason: null,
    replaces_id: null,
    replaced_by_id: null,
    page_count: 1,
    notes: null,
    signed_at: '2026-11-05T09:00:00Z',
    author: null,
    specialist_id: 's1',
    ...over,
  };
}

async function render(rx: PrescriptionDto): Promise<HTMLElement> {
  TestBed.configureTestingModule({
    imports: [PrescriptionPage],
    providers: [
      provideRouter([]),
      provideSupadocIcons(),
      { provide: RxFiles, useValue: {} },
      {
        provide: ActivatedRoute,
        useValue: {
          paramMap: of(convertToParamMap({ id: rx.id })),
          snapshot: { paramMap: convertToParamMap({ id: rx.id }) },
        },
      },
      { provide: StaffAuthService, useValue: { isAuthenticated: signal(true) } },
      {
        provide: DoctorApi,
        useValue: {
          getPrescription: () => of({ data: rx }),
          // Labels only: the page falls back to its own.
          prescriptionOptions: () => throwError(() => new Error('offline')),
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(PrescriptionPage);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

/** The read-only Consultation card's label → value pairs. */
function consultation(el: HTMLElement): Record<string, string> {
  const card = Array.from(el.querySelectorAll('section')).find((s) => s.querySelector('h2')?.textContent?.includes('Consultation'));
  expect(card).toBeTruthy();
  const pairs: Record<string, string> = {};
  for (const row of Array.from(card?.querySelectorAll('dl > div') ?? [])) {
    pairs[row.querySelector('dt')?.textContent?.trim() ?? ''] = row.querySelector('dd')?.textContent?.trim() ?? '';
  }
  return pairs;
}

describe('PrescriptionPage — medicines already taken', () => {
  it('leaves the row out for a prescription without one (every new prescription)', async () => {
    const el = await render(sent());
    const rows = consultation(el);
    expect(rows['Reason for the prescription']).toBe('Acute sinusitis');
    expect(rows['Illness code (ICD)']).toBe('CA01');
    expect(Object.keys(rows)).not.toContain('Medicines already taken');
    expect(el.textContent).not.toContain('Medicines already taken');
  });

  it('leaves it out when only blank space was stored', async () => {
    const el = await render(sent({ current_medications: '   ' }));
    expect(Object.keys(consultation(el))).not.toContain('Medicines already taken');
  });

  it('still shows it on an older prescription that has one', async () => {
    const el = await render(sent({ current_medications: 'Metformin 500 mg twice daily' }));
    expect(consultation(el)['Medicines already taken']).toBe('Metformin 500 mg twice daily');
  });
});

describe('PrescriptionPage — readings above the expected range', () => {
  it('marks the tile of a reading the API lists as above range, and only that one', async () => {
    const el = await render(
      sent({ readings: { temperature: '46', heart_rate: '80' }, readings_above_range: ['temperature'] }),
    );
    const marks = el.querySelectorAll('[data-above-range]');
    expect(marks.length).toBe(1);
    expect(marks[0].textContent).toContain('Above expected range — verify');
    expect(marks[0].closest('div')?.textContent).toContain('46');
  });

  it('says nothing for an older API without the marker', async () => {
    const el = await render(sent({ readings: { temperature: '46' } }));
    expect(el.querySelector('[data-above-range]')).toBeNull();
  });
});
