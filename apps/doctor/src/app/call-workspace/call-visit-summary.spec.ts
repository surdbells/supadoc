import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DoctorApi, LabRequestsApi } from '@supadoc/data-access';
import type { AppointmentDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { DocumentViewerService, type ViewerSource } from '@supadoc/viewer';
import { Observable, of, Subject, throwError } from 'rxjs';
import { LabFiles } from '../lab/lab-files';
import { RxFiles } from '../prescriptions/rx-files';
import { CallVisitSummary } from './call-visit-summary';
import { STANDING_REFUSED, WS_VISIT_CURRENT, type WorkspaceTab } from './call-workspace-copy';

const VISIT = {
  id: 'visit-9',
  patient_id: 'p1',
  specialist: { id: 'd1', name: 'Dr Ada Obi' },
  scheduled_at: '2026-10-01T10:00:00Z',
  type: 'video',
  type_label: 'Video consultation',
  status: 'completed',
  status_label: 'Completed',
  amount: '0',
  notes: 'Follow up on blood pressure',
  created_at: '2026-09-01T10:00:00Z',
} as unknown as AppointmentDto;

const NOTE = {
  appointment_id: 'visit-9',
  subjective: 'Headache <b>for days</b>\nand nausea',
  objective: 'BP 148/92',
  assessment: null,
  plan: 'Rest',
  status: 'finalized',
  finalized_at: '2026-10-01T11:00:00Z',
  author: 'Dr Ada Obi',
  amendments: [],
  updated_at: '2026-10-01T11:00:00Z',
};

const RX = { id: 'rx1', number: 'RX-1', status: 'active', items_count: 2, sent_at: '2026-10-01T10:30:00Z', created_at: '2026-10-01T10:00:00Z' };
const DRAFT = { id: 'rx2', number: 'RX-2', status: 'draft', items_count: 1, sent_at: null, created_at: '2026-10-01T10:00:00Z' };
const LAB = { id: 'lab1', number: 'LAB-1', status: 'booked', abnormal: false, tests_label: 'Full blood count' };
const REF = { id: 'ref1', appointment_id: 'visit-9', referral_type: 'specialist', target: 'Cardiology', reason: 'Palpitations', priority: 'urgent', created_at: '2026-10-01T10:00:00Z' };
const CERT = { id: 'cert1', appointment_id: 'visit-9', type: 'general', type_label: 'General certificate', from_date: null, to_date: null, created_at: '2026-10-01T10:00:00Z' };
const PLAN = { appointment_id: 'visit-9', items: ['Walk daily'], published: true, author: null, updated_at: null };

type Reads = Record<'getNote' | 'listPrescriptions' | 'list' | 'listReferrals' | 'listCertificates' | 'getCarePlan', () => Observable<unknown>>;

describe('CallVisitSummary (a past visit inside the call)', () => {
  let fixture: ComponentFixture<CallVisitSummary>;
  let el: HTMLElement;
  let api: Record<string, ReturnType<typeof vi.fn>>;
  let lab: { list: ReturnType<typeof vi.fn> };
  let rxView: ReturnType<typeof vi.fn>;
  let labView: ReturnType<typeof vi.fn>;
  let open: ReturnType<typeof vi.fn>;

  function setup(over: Partial<Reads> = {}, current = false) {
    const reads: Reads = {
      getNote: () => of({ data: NOTE }),
      listPrescriptions: () => of({ data: [RX, DRAFT] }),
      list: () => of({ data: [LAB] }),
      listReferrals: () => of({ data: [REF] }),
      listCertificates: () => of({ data: [CERT] }),
      getCarePlan: () => of({ data: PLAN }),
      ...over,
    };
    api = {
      getNote: vi.fn(reads.getNote),
      listPrescriptions: vi.fn(reads.listPrescriptions),
      listReferrals: vi.fn(reads.listReferrals),
      listCertificates: vi.fn(reads.listCertificates),
      getCarePlan: vi.fn(reads.getCarePlan),
      documentPdf: vi.fn(() => of(new Blob(['x'], { type: 'application/pdf' }))),
      getProfile: vi.fn(() => of({ data: { id: 'd', name: 'Dr', timezone: 'Africa/Lagos', timezone_source: 'manual' } })),
    };
    lab = { list: vi.fn(reads.list) };
    rxView = vi.fn();
    labView = vi.fn();
    open = vi.fn();
    TestBed.configureTestingModule({
      imports: [CallVisitSummary],
      providers: [
        provideSupadocIcons(),
        { provide: DoctorApi, useValue: api },
        { provide: LabRequestsApi, useValue: lab },
        { provide: RxFiles, useValue: { view: rxView } },
        { provide: LabFiles, useValue: { view: labView } },
        { provide: DocumentViewerService, useValue: { open } },
      ],
    });
    fixture = TestBed.createComponent(CallVisitSummary);
    fixture.componentRef.setInput('visit', VISIT);
    fixture.componentRef.setInput('current', current);
    fixture.detectChanges();
    el = fixture.nativeElement;
  }

  const button = (label: string) => el.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
  const byText = (text: string) => Array.from(el.querySelectorAll('button')).filter((b) => b.textContent?.includes(text));

  it('six reads, each keyed by the VISIT’s id (never the call’s)', () => {
    setup();
    expect(api['getNote']).toHaveBeenCalledWith('visit-9');
    expect(api['listPrescriptions']).toHaveBeenCalledWith('visit-9');
    expect(lab.list).toHaveBeenCalledWith({ appointment_id: 'visit-9', per_page: 50 });
    expect(api['listReferrals']).toHaveBeenCalledWith('visit-9');
    expect(api['listCertificates']).toHaveBeenCalledWith('visit-9');
    expect(api['getCarePlan']).toHaveBeenCalledWith('visit-9');
  });

  it('the note as text: S/O/A/P in a list, an HTML string shown literally; who signed', () => {
    setup();
    const dds = Array.from(el.querySelectorAll('dd'));
    expect(dds.map((d) => d.textContent)).toEqual(['Headache <b>for days</b>\nand nausea', 'BP 148/92', 'Rest']);
    expect(el.querySelector('dd b')).toBeNull();
    expect(el.textContent).toContain('Signed');
    expect(el.textContent).toContain('by Dr Ada Obi');
  });

  it('an empty note says none was written; a draft says it is not finalized', () => {
    setup({ getNote: () => of({ data: { ...NOTE, subjective: null, objective: '  ', assessment: '', plan: null, status: 'draft' } }) });
    expect(el.textContent).toContain('No note was written.');
    fixture.destroy();
    TestBed.resetTestingModule();
    setup({ getNote: () => of({ data: { ...NOTE, status: 'draft', finalized_at: null } }) });
    expect(el.textContent).toContain('Draft — not finalized');
  });

  it('empty sections say so', () => {
    setup({
      listPrescriptions: () => of({ data: [] }),
      list: () => of({ data: [] }),
      listReferrals: () => of({ data: [] }),
      listCertificates: () => of({ data: [] }),
      getCarePlan: () => of({ data: { ...PLAN, items: [] } }),
    });
    for (const text of ['No prescriptions from this visit', 'No lab requests from this visit', 'No referrals from this visit', 'No certificates from this visit', 'No care plan from this visit']) {
      expect(el.textContent).toContain(text);
    }
  });

  it('an error in one section: Try again re-reads only that one', () => {
    let fail = true;
    setup({ listReferrals: () => (fail ? throwError(() => new Error('boom')) : of({ data: [REF] })) });
    expect(el.textContent).toContain('Could not load the referrals.');
    expect(el.textContent).toContain('RX-1');
    const retry = byText('Try again');
    expect(retry.length).toBe(1);
    fail = false;
    for (const fn of Object.values(api)) fn.mockClear();
    lab.list.mockClear();
    retry[0]?.click();
    fixture.detectChanges();
    expect(api['listReferrals']).toHaveBeenCalledTimes(1);
    expect(api['getNote']).not.toHaveBeenCalled();
    expect(lab.list).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Cardiology');
    expect(el.textContent).not.toContain('Could not load the referrals.');
  });

  it('a standing refusal: the standing copy, no Try again', () => {
    const refused = () => throwError(() => ({ status: 403, errors: { code: 'doctor_suspended' } }));
    setup({ getNote: refused, getCarePlan: refused });
    expect(el.textContent).toContain(STANDING_REFUSED);
    expect(el.textContent).not.toContain('Could not load the note.');
    expect(byText('Try again').length).toBe(0);
  });

  it('View PDF: a prescription; a draft row has none', () => {
    setup();
    expect(button('View PDF of RX-2')).toBeNull();
    const b = button('View PDF of RX-1');
    b?.click();
    expect(rxView).toHaveBeenCalledTimes(1);
    expect(rxView.mock.calls[0]?.[0]).toMatchObject({ id: 'rx1' });
    expect(rxView.mock.calls[0]?.[1]).toBe(b);
  });

  it('View PDF: a lab request', () => {
    setup();
    const b = button('View PDF of LAB-1');
    b?.click();
    expect(labView.mock.calls[0]?.[0]).toMatchObject({ id: 'lab1' });
    expect(labView.mock.calls[0]?.[1]).toBe(b);
  });

  it('View PDF: a referral and a certificate, Print only, read with the VISIT’s id', () => {
    setup();
    const ref = button('View PDF of the referral to Cardiology');
    ref?.click();
    const [src, opts] = open.mock.calls[0] as [ViewerSource, { opener: HTMLElement }];
    expect(src.key).toBe('referral:ref1');
    expect(src.policy).toBe('authored_print');
    expect(opts.opener).toBe(ref);
    src.load().subscribe();
    expect(api['documentPdf']).toHaveBeenCalledWith('visit-9', 'referral', 'ref1');

    button('View PDF of General certificate')?.click();
    const [cert] = open.mock.calls[1] as [ViewerSource];
    expect(cert.key).toBe('certificate:cert1');
    expect(cert.policy).toBe('authored_print');
    cert.load().subscribe();
    expect(api['documentPdf']).toHaveBeenCalledWith('visit-9', 'certificate', 'cert1');
  });

  it('the care plan: its items, and whether it was published', () => {
    setup();
    expect(el.textContent).toContain('Walk daily');
    expect(el.textContent).toContain('Published');
  });

  it('the consultation this call is: no reads, a notice with buttons to the other tabs', () => {
    setup({}, true);
    for (const fn of ['getNote', 'listPrescriptions', 'listReferrals', 'listCertificates', 'getCarePlan']) expect(api[fn]).not.toHaveBeenCalled();
    expect(lab.list).not.toHaveBeenCalled();
    expect(el.textContent).toContain(WS_VISIT_CURRENT);
    const seen: WorkspaceTab[] = [];
    fixture.componentInstance.goTo.subscribe((t) => seen.push(t));
    byText('Consultation Notes')[0]?.click();
    byText('Prescriptions')[0]?.click();
    byText('Lab requests')[0]?.click();
    expect(seen).toEqual(['notes', 'prescriptions', 'labs']);
  });

  describe('the drill-in moving to another visit (the same instance: @if keeps it)', () => {
    const OTHER = { ...VISIT, id: 'visit-10', type_label: 'Follow-up visit' } as AppointmentDto;
    const NOTE_10 = { ...NOTE, appointment_id: 'visit-10', objective: 'BP 120/80' };
    const moveTo = (v: AppointmentDto, current = false) => {
      fixture.componentRef.setInput('visit', v);
      fixture.componentRef.setInput('current', current);
      fixture.detectChanges();
    };

    it('six new reads keyed by it; nothing of the older visit stays under its heading', () => {
      setup();
      expect(el.textContent).toContain('BP 148/92');
      api['getNote'].mockReturnValue(of({ data: NOTE_10 }));
      moveTo(OTHER);
      expect(el.querySelector('h4')?.textContent).toBe('Follow-up visit');
      for (const fn of ['getNote', 'listPrescriptions', 'listReferrals', 'listCertificates', 'getCarePlan']) {
        expect(api[fn]).toHaveBeenCalledTimes(2);
        expect(api[fn]).toHaveBeenLastCalledWith('visit-10');
      }
      expect(lab.list).toHaveBeenLastCalledWith({ appointment_id: 'visit-10', per_page: 50 });
      expect(el.textContent).toContain('BP 120/80');
      expect(el.textContent).not.toContain('BP 148/92');
    });

    it('the sections show their shimmer until the new answers, never the older data', () => {
      setup();
      api['getNote'].mockReturnValue(new Subject());
      moveTo(OTHER);
      expect(el.textContent).not.toContain('BP 148/92');
      expect(el.querySelectorAll('.sd-shimmer').length).toBe(1);
    });

    it('a slow answer for the older visit is dropped, whenever it comes', () => {
      const slow = new Subject<unknown>();
      setup({ getNote: () => slow });
      api['getNote'].mockReturnValue(of({ data: NOTE_10 }));
      moveTo(OTHER);
      expect(slow.observed).toBe(false);
      slow.next({ data: NOTE });
      fixture.detectChanges();
      expect(el.textContent).toContain('BP 120/80');
      expect(el.textContent).not.toContain('BP 148/92');
    });

    it('from the consultation this call is to another visit: it reads (no endless shimmer)', () => {
      setup({}, true);
      expect(api['getNote']).not.toHaveBeenCalled();
      moveTo(OTHER);
      expect(api['getNote']).toHaveBeenCalledWith('visit-10');
      expect(el.querySelectorAll('.sd-shimmer').length).toBe(0);
      expect(el.textContent).toContain('BP 148/92');
      expect(el.textContent).not.toContain(WS_VISIT_CURRENT);
    });

    it('to the consultation this call is: no reads, and an answer still out never lands', () => {
      const slow = new Subject<unknown>();
      setup({ getNote: () => slow });
      moveTo(OTHER, true);
      expect(slow.observed).toBe(false);
      expect(api['listPrescriptions']).toHaveBeenCalledTimes(1);
      expect(el.textContent).toContain(WS_VISIT_CURRENT);
    });

    it('a refreshed copy of the same visit reads nothing again', () => {
      setup();
      moveTo({ ...VISIT, notes: 'Updated reason' } as AppointmentDto);
      expect(api['getNote']).toHaveBeenCalledTimes(1);
      expect(el.textContent).toContain('Updated reason');
      expect(el.textContent).toContain('BP 148/92');
    });

    it('Try again replaces a read still out, for that section only', () => {
      const first = new Subject<unknown>();
      setup({ getNote: () => first });
      const summary = fixture.componentInstance as unknown as { readNote(): void };
      api['getNote'].mockReturnValue(of({ data: NOTE_10 }));
      summary.readNote();
      fixture.detectChanges();
      expect(first.observed).toBe(false);
      expect(el.textContent).toContain('BP 120/80');
    });
  });

  it('Back to visits emits back; the heading can take focus', () => {
    setup();
    let backs = 0;
    fixture.componentInstance.back.subscribe(() => backs++);
    byText('Back to visits')[0]?.click();
    expect(backs).toBe(1);
    expect(el.querySelector('h4')?.getAttribute('tabindex')).toBe('-1');
    expect(el.querySelector('h4')?.textContent).toBe('Video consultation');
  });

  it('no link and no download anywhere', () => {
    setup();
    expect(el.querySelector('a')).toBeNull();
    expect(el.textContent).not.toContain('Download');
  });
});
