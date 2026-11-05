import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject, firstValueFrom, of } from 'rxjs';
import { API_CONFIG, AppointmentsApi, DocumentSharingApi, LabRequestsApi, PrescriptionsApi } from '@supadoc/data-access';
import type { AppointmentDto, PatientLabRequestSummaryDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { DocumentViewerService, type ViewerOpenOptions, type ViewerSource } from '@supadoc/viewer';
import { HistoryDetails } from './history-details';

const ok = <T,>(data: T) => of({ status: 'success', message: 'OK', data });

/** An API service whose every other method answers an empty list. */
function apiStub(overrides: Record<string, unknown>): unknown {
  return new Proxy(overrides, {
    get: (target, prop: string) => (prop in target ? target[prop] : () => ok([])),
  });
}

const appointment = {
  id: 'ap-1',
  scheduled_at: '2026-11-01T15:00:00Z',
  status: 'completed',
  type: 'video',
  type_label: 'Video consultation',
  notes: null,
  amount: '0',
  document_url: null,
  guests: [],
  specialist: { id: 'sp-1', name: 'Bayo Ade', specialty: 'Cardiology', photo_url: null, timezone: 'Africa/Lagos' },
} as unknown as AppointmentDto;

/** A lab request the doctor sent from this consultation (a list row: no test names). */
const labRow = {
  id: 'lr-1',
  number: 'GVM-REQ-20261101-00001',
  status: 'result_ready',
  priority: 'routine',
  doctor: { id: 'sp-1', name: 'Bayo Ade', specialty: 'Cardiology' },
  items_count: 2,
  results_count: 1,
  reviewed: true,
  awaiting_review: false,
  appointment_id: 'ap-1',
  sent_at: '2026-11-01T15:30:00Z',
  valid_until: '2026-12-01',
  expires_at: '2026-12-01T23:00:00Z',
  last_activity_at: '2026-11-02T10:00:00Z',
} as PatientLabRequestSummaryDto;

describe('HistoryDetails › documents in the viewer', () => {
  let fixture: ComponentFixture<HistoryDetails>;
  let el: HTMLElement;
  const open = vi.fn();
  const documentPdf = vi.fn(() => of(new Blob(['%PDF'], { type: 'application/pdf' })));
  const link = vi.fn(() => ok({ url: '/api/public/prescriptions/file?token=t', expires_at: '', filename: 'rx.pdf' }));
  const labMine = vi.fn(() => ok([labRow]));

  /** The page polls the visit's status on an interval, so the zone is never stable: flush by hand. */
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      fixture.detectChanges();
      await new Promise((r) => setTimeout(r));
    }
    fixture.detectChanges();
  };
  const lastOpen = () => open.mock.calls[open.mock.calls.length - 1] as [readonly ViewerSource[], ViewerOpenOptions];

  beforeEach(async () => {
    open.mockReset();
    documentPdf.mockClear();
    link.mockClear();
    vi.spyOn(window, 'open').mockReturnValue(null);
    await TestBed.configureTestingModule({
      imports: [HistoryDetails],
      providers: [
        provideRouter([]),
        provideSupadocIcons(),
        { provide: API_CONFIG, useValue: { baseUrl: 'http://api.test' } },
        { provide: ActivatedRoute, useValue: { paramMap: new BehaviorSubject(convertToParamMap({ id: 'ap-1' })), snapshot: { paramMap: convertToParamMap({ id: 'ap-1' }) } } },
        {
          provide: AppointmentsApi,
          useValue: apiStub({
            getMine: () => ok(appointment),
            prescriptions: () =>
              ok([{ id: 'rx-1', number: 'GVM-RX-1', status: 'active', appointment_id: 'ap-1', patient_id: 'p-1', prescriber: 'Dr Bayo Ade', patient_name: null, items_count: 1, valid_until: null, allows_repeats: false, sent_at: '2026-11-01T15:20:00Z', cancelled_at: null, created_at: '2026-11-01T15:10:00Z' }]),
            referrals: () =>
              ok([{ id: 'r-1', appointment_id: 'ap-1', referral_type: 'specialist', target: 'Lagos Heart Centre', reason: 'Murmur', clinical_summary: null, priority: 'routine', status: 'sent', author: null, created_at: '2026-11-01T15:15:00Z' }]),
            certificates: () =>
              ok([{ id: 'c-1', appointment_id: 'ap-1', type: 'sick_leave', type_label: 'Sick leave certificate', diagnosis: null, statement: 'Rest', from_date: null, to_date: null, days: null, author: null, created_at: '2026-11-01T15:16:00Z' }]),
            consultationSummary: () => ok({ available: false }),
            followUpQuote: () => of({ status: 'success', message: 'OK', data: null }),
            documentPdf,
          }),
        },
        { provide: PrescriptionsApi, useValue: apiStub({ link, fileBlob: () => of(new Blob(['%PDF'], { type: 'application/pdf' })) }) },
        {
          provide: DocumentSharingApi,
          useValue: apiStub({
            forAppointment: () => ok({ specialist: { id: 'sp-1', name: 'Bayo Ade' }, access: { state: 'none', scope: null, document_count: 0 } }),
          }),
        },
        { provide: DocumentViewerService, useValue: { open } },
        { provide: LabRequestsApi, useValue: apiStub({ mine: labMine }) },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(HistoryDetails);
    el = fixture.nativeElement;
    document.body.append(el);
    await settle();
  });

  afterEach(() => {
    fixture.destroy();
    el.remove();
    vi.restoreAllMocks();
  });

  it('each eye button names its document (never just "Open document")', () => {
    expect(el.querySelector('button[aria-label="Open document"]')).toBeNull();
    expect(el.querySelector('button[aria-label="View referral letter to Lagos Heart Centre"]')).toBeTruthy();
    expect(el.querySelector('button[aria-label="View sick leave certificate"]')).toBeTruthy();
  });

  it('a referral opens its PDF in the viewer, among the consultation’s documents (no HTML tab)', async () => {
    const eye = el.querySelector<HTMLButtonElement>('button[aria-label="View referral letter to Lagos Heart Centre"]') as HTMLButtonElement;
    eye.click();
    const [sources, options] = lastOpen();
    expect(sources.map((s) => s.key)).toEqual(['rx:rx-1', 'referral:r-1', 'certificate:c-1']);
    expect(options.index).toBe(1);
    expect(options.opener).toBe(eye);
    expect(sources.every((s) => s.policy === 'owner')).toBe(true);
    await firstValueFrom(sources[1].load());
    expect(documentPdf).toHaveBeenCalledExactlyOnceWith('ap-1', 'referral', 'r-1');
    expect(window.open).not.toHaveBeenCalled();
  });

  it('a prescription’s View opens it in the viewer (the link is minted by the viewer, not the page)', async () => {
    el.querySelector<HTMLButtonElement>('button[aria-label="View prescription GVM-RX-1"]')?.click();
    const [sources, options] = lastOpen();
    expect(options.index).toBe(0);
    expect(sources[0].key).toBe('rx:rx-1');
    expect(link).not.toHaveBeenCalled();
    await firstValueFrom(sources[0].load());
    expect(link).toHaveBeenCalledExactlyOnceWith('rx-1', false);
    expect(window.open).not.toHaveBeenCalled();
  });

  it('lists the consultation’s lab requests: number, chip, and a link to the request (legacy rows unchanged)', () => {
    // The page load's read: no request options (it counts as activity).
    expect(labMine).toHaveBeenCalledWith({ appointment_id: 'ap-1', per_page: 50 }, undefined);
    const row = el.querySelector<HTMLAnchorElement>('a[href="/dashboard/lab-requests/lr-1"]');
    expect(row).toBeTruthy();
    expect(row?.textContent).toContain('Lab request GVM-REQ-20261101-00001');
    expect(row?.textContent).toContain('Reviewed by your doctor');
    expect(row?.textContent?.toLowerCase()).not.toContain('abnormal');
  });
});

describe('HistoryDetails › the status poll is passive', () => {
  /** Every AppointmentsApi / LabRequestsApi call, by method name, with its arguments. */
  let calls: Record<string, unknown[][]>;
  /** What `getMine` answers (a test closes the visit by changing it). */
  let current: AppointmentDto;
  let fixture: ComponentFixture<HistoryDetails>;

  /** A service that records every call and answers `answers[name]` (else an empty list). */
  function recording(answers: Record<string, () => unknown>): unknown {
    return new Proxy({}, {
      get: (_t, name: string) =>
        (...args: unknown[]) => {
          (calls[name] ??= []).push(args);
          return name in answers ? answers[name]() : ok([]);
        },
    });
  }

  /** The extras a load (or a status change) reads, and where each takes its request options. */
  const EXTRAS: Readonly<Record<string, number>> = {
    consultationSummary: 1,
    followUps: 1,
    followUpQuote: 2,
    prescriptions: 1,
    referrals: 1,
    certificates: 1,
    labOrders: 1,
    mine: 1,
  };
  /** The request options of each call of `name`. */
  const optionsOf = (name: string) => (calls[name] ?? []).map((args) => args[EXTRAS[name] ?? 1]);

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    calls = {};
    current = { ...appointment, status: 'confirmed' } as AppointmentDto;
    await TestBed.configureTestingModule({
      imports: [HistoryDetails],
      providers: [
        provideRouter([]),
        provideSupadocIcons(),
        { provide: API_CONFIG, useValue: { baseUrl: 'http://api.test' } },
        { provide: ActivatedRoute, useValue: { paramMap: new BehaviorSubject(convertToParamMap({ id: 'ap-1' })), snapshot: { paramMap: convertToParamMap({ id: 'ap-1' }) } } },
        {
          provide: AppointmentsApi,
          useValue: recording({ getMine: () => ok(current), consultationSummary: () => ok({ available: false }), followUpQuote: () => ok(null) }),
        },
        { provide: PrescriptionsApi, useValue: apiStub({}) },
        { provide: DocumentSharingApi, useValue: apiStub({ forAppointment: () => ok({ specialist: { id: 'sp-1', name: 'Bayo Ade' }, access: { state: 'none', scope: null, document_count: 0 } }) }) },
        { provide: DocumentViewerService, useValue: { open: vi.fn() } },
        { provide: LabRequestsApi, useValue: recording({}) },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(HistoryDetails);
    fixture.detectChanges();
    await new Promise((r) => setTimeout(r));
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('the page load counts; the 30 s look for the doctor closing the visit is passive (X-SD-Passive)', () => {
    expect(calls['getMine']).toEqual([['ap-1']]);

    vi.advanceTimersByTime(30_000);
    expect(calls['getMine'].slice(1)).toEqual([['ap-1', { passive: true }]]);
    vi.advanceTimersByTime(60_000);
    expect(calls['getMine'].slice(1).every((c) => JSON.stringify(c[1]) === '{"passive":true}')).toBe(true);
    expect(calls['getMine'].length).toBe(4);
    // Nothing changed: the extras were read once, by the page load.
    for (const name of Object.keys(EXTRAS)) expect(optionsOf(name), name).toEqual([undefined]);
  });

  it('the doctor closing the visit reloads the extras passively (the page load’s reads counted)', () => {
    for (const name of Object.keys(EXTRAS)) expect(optionsOf(name), name).toEqual([undefined]);

    current = { ...current, status: 'completed' } as AppointmentDto;
    vi.advanceTimersByTime(30_000);
    expect(calls['getMine'].at(-1)).toEqual(['ap-1', { passive: true }]);
    for (const name of Object.keys(EXTRAS)) expect(optionsOf(name), name).toEqual([undefined, { passive: true }]);

    // Closed: the poll stops, nothing more is read.
    const reads = calls['getMine'].length;
    vi.advanceTimersByTime(90_000);
    expect(calls['getMine'].length).toBe(reads);
  });
});
