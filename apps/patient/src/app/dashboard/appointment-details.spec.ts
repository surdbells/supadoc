import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject, firstValueFrom, type Observable, of } from 'rxjs';
import {
  API_CONFIG,
  AppointmentsApi,
  DocumentSharingApi,
  DocumentsApi,
  PrescriptionsApi,
  SpecialistsApi,
  WalletApi,
} from '@supadoc/data-access';
import type { AppointmentDocumentAccessDto, AppointmentDto, MedicalDocumentDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { DocumentViewerService, type ViewerOpenOptions, type ViewerSource } from '@supadoc/viewer';
import { AppointmentDetails } from './appointment-details';

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

const libDoc = (id: string, title: string): MedicalDocumentDto =>
  ({
    id,
    patient_id: 'p-1',
    uploader_role: 'patient',
    uploader_name: 'Ada Obi',
    appointment_id: 'ap-1',
    document_type: 'booking_attachment',
    custom_type: null,
    type_label: 'Booking attachment',
    title,
    extension: 'pdf',
    mime_type: 'application/pdf',
    size_bytes: 100,
    size_label: '100 B',
    created_at: '2026-11-01T10:00:00Z',
  }) as MedicalDocumentDto;

const access = {
  specialist: { id: 'sp-1', name: 'Bayo Ade', specialty: 'Cardiology', photo_url: null },
  appointment: { id: 'ap-1', scheduled_at: '2026-11-01T15:00:00Z', ends_at: '2026-11-01T15:30:00Z', after_options: { after_24h: null, after_7d: null, after_30d: null } },
  can_share: true,
  unavailable_reason: null,
  access: {
    state: 'active',
    scope: 'selected',
    document_count: 2,
    until: null,
    until_label_at: null,
    indefinite: true,
    folder_until_label_at: null,
    folder_indefinite: false,
    next_change_at: null,
    last_viewed_at: null,
    active_grant_ids: [],
    hidden_count: 0,
    hidden_document_ids: [],
  },
  visible_documents: [
    { ...libDoc('v-1', 'ECG trace'), via: 'document', until: null, until_label_at: null, indefinite: true },
    { ...libDoc('v-2', 'Echo report'), via: 'document', until: null, until_label_at: null, indefinite: true },
  ],
  unshared_attachments: [libDoc('u-1', 'Old letter'), libDoc('u-2', 'Insurance card')],
  pending_request: null,
} as unknown as AppointmentDocumentAccessDto;

const rx = {
  id: 'rx-1',
  number: 'GVM-RX-1',
  status: 'active',
  appointment_id: 'ap-1',
  patient_id: 'p-1',
  prescriber: 'Dr Bayo Ade',
  patient_name: 'Ada Obi',
  items_count: 1,
  valid_until: null,
  allows_repeats: false,
  sent_at: '2026-11-01T15:20:00Z',
  cancelled_at: null,
  created_at: '2026-11-01T15:10:00Z',
};

describe('AppointmentDetails › the document viewer', () => {
  let fixture: ComponentFixture<AppointmentDetails>;
  let el: HTMLElement;
  const open = vi.fn();
  const documentPdf = vi.fn(() => of(new Blob(['%PDF'], { type: 'application/pdf' })));
  const fileBlob = vi.fn(() => of(new Blob(['%PDF'], { type: 'application/pdf' })));
  /** Who is in the call: the page polls it — always passive (X-SD-Passive). */
  const presence = vi.fn<(options?: { passive?: boolean }) => Observable<unknown>>(() => ok({}));

  /** The page polls call presence and ticks its clock on intervals, so the zone is never stable: flush by hand. */
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      fixture.detectChanges();
      await new Promise((r) => setTimeout(r));
    }
    fixture.detectChanges();
  };
  const lastOpen = () => open.mock.calls[open.mock.calls.length - 1] as [readonly ViewerSource[], ViewerOpenOptions];
  const button = (label: string) => el.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) as HTMLButtonElement;

  beforeEach(async () => {
    open.mockReset();
    presence.mockClear();
    documentPdf.mockClear();
    fileBlob.mockClear();
    vi.spyOn(window, 'open').mockReturnValue(null);
    await TestBed.configureTestingModule({
      imports: [AppointmentDetails],
      providers: [
        provideRouter([]),
        provideSupadocIcons(),
        { provide: API_CONFIG, useValue: { baseUrl: 'http://api.test' } },
        {
          provide: ActivatedRoute,
          useValue: {
            paramMap: new BehaviorSubject(convertToParamMap({ id: 'ap-1' })),
            snapshot: { paramMap: convertToParamMap({ id: 'ap-1' }), queryParamMap: convertToParamMap({}) },
            queryParamMap: of(convertToParamMap({})),
          },
        },
        {
          provide: AppointmentsApi,
          useValue: apiStub({
            getMine: () => ok(appointment),
            presence,
            prescriptions: () => ok([rx]),
            referrals: () =>
              ok([{ id: 'r-1', appointment_id: 'ap-1', referral_type: 'specialist', target: 'Lagos Heart Centre', reason: 'Murmur', clinical_summary: null, priority: 'routine', status: 'sent', author: null, created_at: '2026-11-01T15:15:00Z' }]),
            certificates: () =>
              ok([{ id: 'c-1', appointment_id: 'ap-1', type: 'sick_leave', type_label: 'Sick leave certificate', diagnosis: null, statement: 'Rest', from_date: null, to_date: null, days: null, author: null, created_at: '2026-11-01T15:16:00Z' }]),
            documentPdf,
            followUpQuote: () => of({ status: 'success', message: 'OK', data: null }),
            guests: () => ok({ guests: [], can_manage: false, can_add: false, max_guests: 0, manage_problem: null, currency: 'NGN', guest_fee: '0' }),
          }),
        },
        { provide: PrescriptionsApi, useValue: apiStub({}) },
        { provide: DocumentsApi, useValue: apiStub({ fileBlob }) },
        { provide: DocumentSharingApi, useValue: apiStub({ forAppointment: () => ok(access) }) },
        { provide: WalletApi, useValue: apiStub({}) },
        { provide: SpecialistsApi, useValue: apiStub({}) },
        { provide: DocumentViewerService, useValue: { open } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(AppointmentDetails);
    el = fixture.nativeElement;
    document.body.append(el);
    await settle();
  });

  afterEach(() => {
    fixture.destroy();
    el.remove();
    vi.restoreAllMocks();
  });

  it('a shared document opens the viewer over the documents shared with the doctor', async () => {
    const row = button('Open Echo report, Booking attachment');
    row.click();
    const [sources, options] = lastOpen();
    expect(sources.map((s) => s.key)).toEqual(['doc:v-1', 'doc:v-2']);
    expect(sources.every((s) => s.policy === 'owner')).toBe(true);
    expect(options.index).toBe(1);
    expect(options.opener).toBe(row);
    expect(options.listLabel).toBe('documents shared with Dr Ade');
    await firstValueFrom(sources[1].load());
    expect(fileBlob).toHaveBeenCalledExactlyOnceWith('v-2');
    expect(window.open).not.toHaveBeenCalled();
  });

  it('a booking attachment that isn’t shared opens over the attachments sub-list', () => {
    button('Open Insurance card').click();
    const [sources, options] = lastOpen();
    expect(sources.map((s) => s.key)).toEqual(['doc:u-1', 'doc:u-2']);
    expect(options.index).toBe(1);
    expect(options.listLabel).toBe('attachments not shared with Dr Ade');
  });

  it('a prescription’s View opens the consultation’s documents at it, as a signed link', () => {
    button('View prescription GVM-RX-1').click();
    const [sources, options] = lastOpen();
    expect(sources.map((s) => s.key)).toEqual(['rx:rx-1', 'referral:r-1', 'certificate:c-1']);
    expect(options.index).toBe(0);
    expect(sources[0].policy).toBe('owner');
    expect(typeof sources[0].download).toBe('function');
    expect(window.open).not.toHaveBeenCalled();
  });

  it('a referral reads "View" with an eye and names the document, and opens its PDF (no HTML tab)', async () => {
    const view = button('View referral letter to Lagos Heart Centre');
    expect(view).toBeTruthy();
    expect(view.textContent?.trim()).toBe('View');
    expect(view.querySelector('sd-icon')?.getAttribute('name') ?? view.querySelector('sd-icon')?.getAttribute('ng-reflect-name')).toBe('eye');
    expect(el.textContent).not.toContain('Open / print');
    expect(button('View sick leave certificate')).toBeTruthy();
    view.click();
    const [sources, options] = lastOpen();
    expect(options.index).toBe(1);
    const referral = sources[1];
    expect(referral.key).toBe('referral:r-1');
    expect(referral.policy).toBe('owner');
    expect(referral.typeLabel).toBe('Referral letter');
    expect(referral.filename).toMatch(/^referral-2026-11-0[12]\.pdf$/);
    await firstValueFrom(referral.load());
    expect(documentPdf).toHaveBeenCalledExactlyOnceWith('ap-1', 'referral', 'r-1');
    expect(window.open).not.toHaveBeenCalled();
  });

  it('polls who is in the call with passive reads only (X-SD-Passive): a page left open never keeps the session alive', () => {
    expect(presence).toHaveBeenCalled();
    expect(presence.mock.calls.every((c) => JSON.stringify(c[0]) === '{"passive":true}')).toBe(true);
  });
});
