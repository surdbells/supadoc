import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DoctorApi, PrescriptionsApi } from '@supadoc/data-access';
import type { PrescriptionSummaryDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { DocumentViewerService } from '@supadoc/viewer';
import { Observable, of, Subject, throwError } from 'rxjs';
import { STANDING_REFUSED } from '../call-workspace/call-workspace-copy';
import { RxFiles } from './rx-files';
import { RxHistory } from './rx-history';

function rx(id: string, over: Partial<PrescriptionSummaryDto> = {}): PrescriptionSummaryDto {
  return {
    id,
    number: `GVM-RX-20261101-0000${id}`,
    status: 'active',
    appointment_id: 'ap-9',
    patient_id: 'p1',
    prescriber: 'Dr Ada Obi',
    patient_name: 'Bola Ade',
    items_count: 2,
    valid_until: '2026-12-01',
    allows_repeats: false,
    sent_at: '2026-11-01T10:00:00Z',
    cancelled_at: null,
    created_at: '2026-11-01T09:00:00Z',
    ...over,
  };
}

const page = (data: PrescriptionSummaryDto[], total = data.length) => ({
  status: 'success',
  message: 'OK',
  data,
  meta: { total, page: 1, per_page: 50, total_pages: 1 },
});

describe('RxHistory (the Full EMR’s prescriptions, read-only)', () => {
  let fixture: ComponentFixture<RxHistory>;
  let el: HTMLElement;
  let all: ReturnType<typeof vi.fn>;
  let view: ReturnType<typeof vi.fn>;

  function setup(answer: () => Observable<ReturnType<typeof page>>, active = true) {
    all = vi.fn(answer);
    view = vi.fn();
    TestBed.configureTestingModule({
      imports: [RxHistory],
      providers: [
        provideSupadocIcons(),
        { provide: DoctorApi, useValue: { allPrescriptions: all, getProfile: () => of({ data: { id: 'd', name: 'Dr', timezone: 'Africa/Lagos', timezone_source: 'manual' } }) } },
        { provide: PrescriptionsApi, useValue: {} },
        { provide: DocumentViewerService, useValue: {} },
        { provide: RxFiles, useValue: { view } },
      ],
    });
    fixture = TestBed.createComponent(RxHistory);
    fixture.componentRef.setInput('patientId', 'p1');
    fixture.componentRef.setInput('active', active);
    fixture.detectChanges();
    el = fixture.nativeElement;
  }

  const buttons = () => Array.from(el.querySelectorAll('button')).map((b) => b.textContent?.trim());

  it('reads this doctor’s prescriptions for the patient; only View PDF, never New, Continue, Delete, Cancel or Download', () => {
    setup(() => of(page([rx('1'), rx('2', { status: 'expired' })])));
    expect(all).toHaveBeenCalledTimes(1);
    expect(all).toHaveBeenCalledWith({ patient_id: 'p1', per_page: 50 });
    expect(el.textContent).toContain('GVM-RX-20261101-00001');
    expect(el.textContent).toContain('2 medicines');
    expect(buttons()).toEqual(['View PDF', 'View PDF']);
  });

  it('View PDF opens the prescription, focus coming back to the button', () => {
    setup(() => of(page([rx('1')])));
    const b = el.querySelector('button');
    expect(b?.getAttribute('aria-label')).toBe('View PDF of GVM-RX-20261101-00001');
    b?.click();
    expect(view).toHaveBeenCalledTimes(1);
    expect(view.mock.calls[0]?.[0]).toMatchObject({ id: '1' });
    expect(view.mock.calls[0]?.[1]).toBe(b);
  });

  it('a draft row has no View PDF (nor any other action)', () => {
    setup(() => of(page([rx('d', { status: 'draft', sent_at: null })])));
    expect(el.textContent).toContain('Draft');
    expect(el.textContent).toContain('Created');
    expect(el.querySelectorAll('button').length).toBe(0);
  });

  it('empty', () => {
    setup(() => of(page([])));
    expect(el.textContent).toContain("You haven't written a prescription for this patient yet.");
  });

  it('an error says so, with Try again that reads once more', () => {
    let fail = true;
    setup(() => (fail ? throwError(() => new Error('boom')) : of(page([rx('1')]))));
    expect(el.textContent).toContain('Could not load the prescriptions.');
    fail = false;
    el.querySelector('button')?.click();
    fixture.detectChanges();
    expect(all).toHaveBeenCalledTimes(2);
    expect(el.textContent).toContain('GVM-RX-20261101-00001');
    expect(el.textContent).not.toContain('Could not load');
  });

  it('a standing refusal shows the standing copy, without Try again', () => {
    setup(() => throwError(() => ({ status: 403, errors: { code: 'doctor_suspended' } })));
    expect(el.textContent).toContain(STANDING_REFUSED);
    expect(el.textContent).not.toContain('Could not load');
    expect(el.querySelectorAll('button').length).toBe(0);
  });

  it('says when it shows only the latest 50', () => {
    setup(() => of(page([rx('1')], 51)));
    expect(el.textContent).toContain('Showing the 50 most recent.');
  });

  it('50 or fewer: no such note', () => {
    setup(() => of(page([rx('1')], 50)));
    expect(el.textContent).not.toContain('Showing the 50 most recent.');
  });

  describe('active (the list goes stale behind the Prescriptions tab otherwise)', () => {
    const set = (key: 'active' | 'patientId', value: unknown) => {
      fixture.componentRef.setInput(key, value);
      fixture.detectChanges();
    };

    it('not on screen: no read; each time it comes back, one', () => {
      setup(() => of(page([rx('1')])), false);
      expect(all).not.toHaveBeenCalled();
      set('active', true);
      expect(all).toHaveBeenCalledTimes(1);
      set('active', false);
      expect(all).toHaveBeenCalledTimes(1);
      set('active', true);
      expect(all).toHaveBeenCalledTimes(2);
    });

    it('a prescription sent or cancelled meanwhile shows when it comes back', () => {
      setup(() => of(page([rx('1')])));
      expect(el.textContent).not.toContain('Cancelled');
      set('active', false);
      all.mockReturnValue(of(page([rx('1', { status: 'cancelled' }), rx('2')])));
      set('active', true);
      expect(el.textContent).toContain('Cancelled');
      expect(el.textContent).toContain('GVM-RX-20261101-00002');
    });

    it('a re-read keeps the list on screen until the answer (no flash of shimmer)', () => {
      setup(() => of(page([rx('1')])));
      all.mockReturnValue(new Subject());
      set('active', false);
      set('active', true);
      expect(el.querySelector('.sd-shimmer')).toBeNull();
      expect(el.textContent).toContain('GVM-RX-20261101-00001');
    });

    it('another patient: the list goes at once, even off screen, and a read still out never lands', () => {
      const slow = new Subject<ReturnType<typeof page>>();
      setup(() => of(page([rx('1')])));
      all.mockReturnValue(slow);
      set('active', false);
      set('active', true);
      expect(slow.observed).toBe(true);
      set('active', false);
      set('patientId', 'p2');
      expect(slow.observed).toBe(false);
      expect(el.textContent).not.toContain('GVM-RX-20261101-00001');
      expect(el.querySelector('.sd-shimmer')).not.toBeNull();
    });
  });
});
