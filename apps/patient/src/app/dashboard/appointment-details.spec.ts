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

describe('AppointmentDetails › header and card CTAs', () => {
  let fixture: ComponentFixture<AppointmentDetails>;
  let el: HTMLElement;
  /** Who is in the call (the page polls it). */
  let inCall: Record<string, unknown> = {};

  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      fixture.detectChanges();
      await new Promise((r) => setTimeout(r));
    }
    fixture.detectChanges();
  };
  const text = (n: Element | null | undefined) => (n?.textContent ?? '').replace(/\s+/g, ' ').trim();
  /** The actions card's CTA row (the one holding Join / Reschedule / Cancel). */
  const actionsRow = () =>
    [...el.querySelectorAll('.sd-cta-row')].find((r) => /Reschedule Appointment|Join/.test(r.textContent ?? '')) as HTMLElement;

  async function render(a: Partial<AppointmentDto>) {
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
            getMine: () => ok({ ...appointment, ...a }),
            presence: () => ok(inCall),
            followUpQuote: () => of({ status: 'success', message: 'OK', data: null }),
            guests: () => ok({ guests: [], can_manage: false, can_add: false, max_guests: 0, manage_problem: null, currency: 'NGN', guest_fee: '0' }),
          }),
        },
        { provide: PrescriptionsApi, useValue: apiStub({}) },
        { provide: DocumentsApi, useValue: apiStub({}) },
        { provide: DocumentSharingApi, useValue: apiStub({ forAppointment: () => ok(access) }) },
        { provide: WalletApi, useValue: apiStub({}) },
        { provide: SpecialistsApi, useValue: apiStub({}) },
        { provide: DocumentViewerService, useValue: { open: vi.fn() } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(AppointmentDetails);
    el = fixture.nativeElement;
    document.body.append(el);
    await settle();
  }

  const soon = () => new Date(Date.now() + 2 * 24 * 3600_000).toISOString();

  afterEach(() => {
    fixture?.destroy();
    el?.remove();
    inCall = {};
    vi.restoreAllMocks();
  });

  it('the header Book CTA keeps one line and is always named "Book Consultation"', async () => {
    await render({});
    const host = [...el.querySelectorAll('sd-button')].find((b) => /^Book/.test(text(b))) as HTMLElement;
    expect(host.classList).toContain('shrink-0');
    expect(host.classList).toContain('whitespace-nowrap');
    expect(text(host.querySelector('button'))).toBe('Book Consultation');
    // Only " Consultation" hides, and only in a narrow header row (a size container).
    expect(host.querySelector('[class~="@max-xl:sr-only"]')?.textContent).toBe(' Consultation');
    expect(host.closest('[class~="@container"]')).toBeTruthy();
  });

  it('an upcoming appointment: Join, Reschedule and Cancel share one CTA row; the cancel hint sits outside it', async () => {
    await render({ status: 'confirmed', scheduled_at: soon(), phase: 'upcoming', display_status: 'upcoming' } as Partial<AppointmentDto>);
    const row = actionsRow();
    expect(row).toBeTruthy();
    const labels = [...row.children].map((c) => text(c));
    expect(labels).toEqual(['Join Consultation', 'Reschedule Appointment', 'Cancel Appointment']);
    expect([...row.children].every((c) => c.matches('sd-button, button'))).toBe(true);
    expect(row.querySelector('p')).toBeNull();
    // Nothing is urgent yet: no caption, nothing described.
    expect(el.querySelector('#pat-join-reason')).toBeNull();
    expect(row.querySelector('button')?.hasAttribute('aria-describedby')).toBe(false);
  });

  it('live: the Join label stays short ("Join now") and the reason is a caption read with it', async () => {
    await render({
      status: 'confirmed',
      scheduled_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      phase: 'upcoming',
      display_status: 'live',
      can_cancel: false,
      can_reschedule: false,
    } as Partial<AppointmentDto>);
    const join = actionsRow().querySelector('button') as HTMLButtonElement;
    expect(text(join)).toBe('Join now');
    const reason = el.querySelector('#pat-join-reason') as HTMLElement;
    expect(text(reason)).toBe('Your consultation has started');
    expect(join.getAttribute('aria-describedby')).toBe('pat-join-reason');
    // The caption comes before the buttons, so it is read and seen first.
    expect(reason.compareDocumentPosition(join) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('the doctor is in the call: the caption says so', async () => {
    inCall = { 'ap-1': { doctor: true, guests: [] } };
    await render({
      status: 'confirmed',
      scheduled_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      phase: 'upcoming',
      display_status: 'live',
      can_cancel: false,
      can_reschedule: false,
    } as Partial<AppointmentDto>);
    expect(text(actionsRow().querySelector('button'))).toBe('Join now');
    expect(text(el.querySelector('#pat-join-reason'))).toBe('Your doctor is in the call');
  });

  describe('follow-up proposal: the one-line Pay label (LD-B)', () => {
    const proposal = () =>
      ({
        status: 'proposed',
        amount: '15000',
        scheduled_at: soon(),
        expires_at: new Date(Date.now() + 864e5).toISOString(),
        follow_up_note: '',
        can_cancel: false,
        can_reschedule: false,
      }) as unknown as Partial<AppointmentDto>;
    /** The Accept button in the proposal footer's CTA row (Decline is the raw button before it). */
    const pay = () => [...el.querySelectorAll('.sd-cta-row sd-button > button')].find((b) => /accept|acceptance/i.test(b.textContent ?? '')) as HTMLButtonElement;
    /** What a sighted user reads (the sr-only method left out). */
    const shown = (b: Element) => {
      const k = b.cloneNode(true) as Element;
      k.querySelectorAll('.sr-only').forEach((n) => n.remove());
      return text(k);
    };

    it('by card: shows "Pay ₦15,000 & accept"; the name starts with it and then says how', async () => {
      await render(proposal());
      const b = pay();
      expect(b.closest('.sd-cta-row')?.children.length).toBe(2);
      expect(shown(b)).toBe('Pay ₦15,000 & accept');
      // Label in Name (WCAG 2.5.3): the visible label first, the method after it.
      expect(text(b)).toBe('Pay ₦15,000 & accept, by card');
    });

    it('from the wallet: the method read after the label changes, the visible label does not', async () => {
      await render(proposal());
      const wallet = [...el.querySelectorAll('button[aria-pressed]')].find((b) => /Wallet/.test(b.textContent ?? '')) as HTMLButtonElement;
      wallet.click();
      await settle();
      expect(shown(pay())).toBe('Pay ₦15,000 & accept');
      expect(text(pay())).toBe('Pay ₦15,000 & accept, from wallet');
    });

    it('a card payment already made reads "Complete acceptance" (no method)', async () => {
      await render(proposal());
      (fixture.componentInstance as unknown as { paid: { set(v: unknown): void } }).paid.set({ reference: 'ref-1', amount: 15000 });
      await settle();
      expect(text(pay())).toBe('Complete acceptance');
      expect(pay().querySelector('.sr-only')).toBeNull();
    });
  });

  it('Shared-with card: Share documents is in the CTA row; Manage sharing is a link below it', async () => {
    await render({});
    const share = [...el.querySelectorAll('button')].find((b) => text(b) === 'Share documents') as HTMLButtonElement;
    expect(share.parentElement?.classList).toContain('sd-cta-row');
    const manage = [...el.querySelectorAll('a')].find((a) => text(a) === 'Manage sharing') as HTMLAnchorElement;
    expect(manage.closest('.sd-cta-row')).toBeNull();
  });
});
