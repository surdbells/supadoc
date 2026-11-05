import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationRef, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { StaffAuthService } from '@supadoc/auth';
import { AvailabilityCalendarStore, DoctorApi, provideSupadocDataAccess } from '@supadoc/data-access';
import type { DoctorDocumentAccessDto, DoctorSharedDocumentDto, ReferralDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { DocumentViewerService, type ViewerOpenOptions, type ViewerSession, type ViewerSource } from '@supadoc/viewer';
import { firstValueFrom, of } from 'rxjs';
import { DoctorAppointmentDetail } from './appointment-detail';
import { NOT_SHARED } from './document-access';
import { NoteDraftStore } from './note-draft';

/*
 * The appointment page with the shared viewer (§6.1 D-1, D-2): a focused spec of
 * the wiring only — the viewer itself is a spy here (its behaviour is the lib's).
 */

function doc(id: string, over: Partial<DoctorSharedDocumentDto> = {}): DoctorSharedDocumentDto {
  return {
    id,
    patient_id: 'p1',
    uploader_role: 'patient',
    uploader_name: 'Bola Ade',
    appointment_id: 'ap-1',
    document_type: 'laboratory_test_report',
    custom_type: null,
    type_label: 'Lab report',
    title: `Report ${id}`,
    extension: 'pdf',
    mime_type: 'application/pdf',
    size_bytes: 1_200_000,
    size_label: '1.2 MB',
    created_at: '2026-11-04T14:00:00Z',
    via: 'document',
    shared_until: null,
    shared_until_label_at: null,
    shared_indefinitely: true,
    shared_at: '2026-11-04T14:00:00Z',
    ...over,
  };
}

function access(docs: DoctorSharedDocumentDto[]): DoctorDocumentAccessDto {
  return {
    access: {
      state: docs.length ? 'active' : 'none',
      scope: docs.length ? 'selected' : null,
      document_count: docs.length,
      until: null,
      until_label_at: null,
      indefinite: true,
      folder_until_label_at: null,
      folder_indefinite: false,
      next_change_at: null,
      ends_soon: false,
      had_access_before: false,
    },
    documents: docs,
    request: { can_request: false, kind: 'access', blocked_reason: null, available_at: null, pending: null, last: null },
    server_time: new Date().toISOString(),
  } as unknown as DoctorDocumentAccessDto;
}

const APPT = {
  id: 'ap-1',
  patient_id: 'p1',
  patient_name: 'Bola Ade',
  specialist: { id: 's1', name: 'Dr Ada Obi' },
  scheduled_at: '2026-11-03T15:00:00Z',
  ends_at: '2026-11-03T15:30:00Z',
  type: 'video',
  type_label: 'Video consultation',
  status: 'completed',
  status_label: 'Completed',
  phase: 'past',
  amount: '5000',
  created_at: '2026-11-01T10:00:00Z',
  join_url: null,
};

const REFERRAL: ReferralDto = {
  id: 'ref-1',
  appointment_id: 'ap-1',
  referral_type: 'specialist',
  target: 'Cardiology, LUTH',
  reason: 'Murmur',
  clinical_summary: null,
  priority: 'routine',
  status: 'issued',
  author: 'Dr Ada Obi',
  created_at: '2026-11-03T15:20:00Z',
};

describe('DoctorAppointmentDetail with the shared viewer', () => {
  let fixture: ComponentFixture<DoctorAppointmentDetail>;
  let el: HTMLElement;
  let docs: DoctorSharedDocumentDto[];
  let session: ReturnType<typeof signal<ViewerSession | null>>;
  let viewer: {
    session: typeof session;
    open: ReturnType<typeof vi.fn>;
    revoke: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    isShowing: (key: string) => boolean;
  };
  let api: Record<string, ReturnType<typeof vi.fn>>;

  /** Every DoctorApi call the page makes answers something harmless unless a test says otherwise. */
  function doctorApi(): DoctorApi {
    const known: Record<string, (...a: unknown[]) => unknown> = {
      appointment: () => of({ data: APPT }),
      patient: () => of({ data: { patient: { id: 'p1', name: 'Bola Ade' }, medical: {}, appointments: [] } }),
      documentAccess: () => of({ data: access(docs) }),
      listReferrals: () => of({ data: [REFERRAL] }),
      listCertificates: () => of({ data: [], meta: {} }),
      documentPdf: () => of(new Blob(['%PDF'], { type: 'application/pdf' })),
      patientDocumentView: () => of({ blob: new Blob(['%PDF']), mime: 'application/pdf', viewRef: null, viewedAt: '' }),
      presence: () => of({ data: {} }),
      getProfile: () => of({ data: { id: 'd1', name: 'Dr Ada Obi', timezone: 'UTC', timezone_source: 'manual' } }),
    };
    api = {};
    return new Proxy({} as DoctorApi, {
      get: (_t, name: string) => (api[name] ??= vi.fn((...args: unknown[]) => (known[name] ? known[name](...args) : of({ data: [] })))),
    });
  }

  async function setup(list: DoctorSharedDocumentDto[], tab = 'documents') {
    docs = list;
    session = signal<ViewerSession | null>(null);
    viewer = {
      session,
      open: vi.fn((sources: ViewerSource | readonly ViewerSource[], options: ViewerOpenOptions = {}) => {
        const all = Array.isArray(sources) ? (sources as readonly ViewerSource[]) : [sources as ViewerSource];
        session.set({ seq: 1, sources: all, refused: all.map(() => null), options });
        return { closed: Promise.resolve(), close: () => session.set(null) };
      }),
      revoke: vi.fn(),
      close: vi.fn(() => session.set(null)),
      isShowing: (key: string) => !!session()?.sources.some((s) => s.key === key),
    };
    TestBed.configureTestingModule({
      imports: [DoctorAppointmentDetail],
      providers: [
        provideRouter([]),
        provideSupadocIcons(),
        // Anything else the page's children reach goes nowhere (a testing backend).
        provideHttpClient(),
        provideHttpClientTesting(),
        provideSupadocDataAccess({ baseUrl: 'http://api.test' }),
        { provide: DoctorApi, useValue: doctorApi() },
        { provide: DocumentViewerService, useValue: viewer },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { paramMap: convertToParamMap({ id: 'ap-1' }) },
            queryParamMap: of(convertToParamMap({ tab })),
          },
        },
        {
          provide: StaffAuthService,
          useValue: {
            isAuthenticated: signal(true),
            displayName: signal('Dr Ada Obi'),
            subject: signal('doc-1'),
            activityKey: 'videomed.doctor.activity',
            clockOffset: () => 0,
          },
        },
        { provide: AvailabilityCalendarStore, useValue: { load: () => undefined } },
        { provide: NoteDraftStore, useValue: { take: () => null, clear: () => undefined, save: () => true, peek: () => null } },
      ],
    });
    fixture = TestBed.createComponent(DoctorAppointmentDetail);
    el = fixture.nativeElement;
    document.body.appendChild(el);
    await settle();
  }

  /** The page polls and ticks (intervals), so it is never "stable": render a few rounds instead. */
  async function settle(rounds = 4) {
    for (let i = 0; i < rounds; i++) {
      fixture.detectChanges();
      TestBed.inject(ApplicationRef).tick();
      await new Promise((r) => setTimeout(r));
    }
  }

  afterEach(() => {
    fixture?.destroy();
    el?.remove();
    vi.restoreAllMocks();
  });

  const rows = () => Array.from(el.querySelectorAll<HTMLButtonElement>('ul li > button')).filter((b) => /Report/.test(b.textContent ?? ''));

  it('a Documents row opens the viewer on the list as displayed, at that row, with the row as opener', async () => {
    await setup([doc('a'), doc('b'), doc('c', { viewable: false })]);
    expect(rows().length).toBe(3);
    rows()[1].click();
    expect(viewer.open).toHaveBeenCalledTimes(1);
    const [sources, options] = viewer.open.mock.calls[0] as [ViewerSource[], ViewerOpenOptions];
    expect(sources.map((s) => s.key)).toEqual(['doc:a', 'doc:b', 'doc:c']);
    expect(sources.every((s) => s.policy === 'view_only' && !s.download)).toBe(true);
    expect(sources[2].viewable).toBe(false);
    expect(options.index).toBe(1);
    expect(options.opener).toBe(rows()[1]);
    expect(options.watermark).toEqual({ viewerName: 'Dr Ada Obi', timeZone: expect.any(String) });
    expect(options.tone).toBe('light');
    expect(options.listLabel).toBe('shared documents');
    expect(typeof options.fallbackFocus).toBe('function');
    // Loaded through the view-only route only when the viewer asks.
    expect(api['patientDocumentView']).toBeUndefined();
    await firstValueFrom(sources[1].load());
    expect(api['patientDocumentView']).toHaveBeenCalledWith('ap-1', 'b');
  });

  it('opens on the filtered list (search) when the doctor searched', async () => {
    await setup([doc('a', { title: 'Chest X-ray' }), doc('b', { title: 'Blood test' }), doc('c', { title: 'Chest CT' })]);
    const search = el.querySelector<HTMLInputElement>('input[aria-label="Search the shared documents"]');
    expect(search).not.toBeNull();
    if (!search) return;
    search.value = 'chest';
    search.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    const shown = Array.from(el.querySelectorAll<HTMLButtonElement>('ul li > button')).filter((b) => /Chest/.test(b.textContent ?? ''));
    expect(shown.length).toBe(2);
    shown[1].click();
    const [sources, options] = viewer.open.mock.calls[0] as [ViewerSource[], ViewerOpenOptions];
    expect(sources.map((s) => s.key)).toEqual(['doc:a', 'doc:c']);
    expect(options.index).toBe(1);
  });

  it('a re-read without an open document revokes it in place (NOT_SHARED), and only that one', async () => {
    await setup([doc('a'), doc('b')]);
    rows()[0].click();
    docs = [doc('a')];
    (fixture.componentInstance as unknown as { loadDocs(mode: string): void }).loadDocs('poll');
    fixture.detectChanges();
    expect(viewer.revoke).toHaveBeenCalledTimes(1);
    expect(viewer.revoke).toHaveBeenCalledWith('doc:b', NOT_SHARED);
  });

  it('"Open / print" on a referral opens its PDF as authored_print (Print, no Download), never a window', async () => {
    const open = vi.spyOn(window, 'open');
    await setup([], 'clinical');
    const clinical = fixture.componentInstance as unknown as { select(tab: string): Promise<void> };
    await clinical.select('referrals');
    await settle();
    const button = Array.from(el.querySelectorAll<HTMLElement>('button')).find((b) => (b.textContent ?? '').includes('Open / print'));
    expect(button).toBeDefined();
    button?.click();
    expect(viewer.open).toHaveBeenCalledTimes(1);
    const source = viewer.open.mock.calls[0][0] as ViewerSource;
    expect(source.policy).toBe('authored_print');
    expect(source.download).toBeUndefined();
    expect(source.key).toBe('referral:ref-1');
    expect(source.title).toBe('Referral letter');
    await firstValueFrom(source.load());
    expect(api['documentPdf']).toHaveBeenCalledWith('ap-1', 'referral', 'ref-1');
    expect(api['document']).toBeUndefined();
    expect(open).not.toHaveBeenCalled();
  });

  it('no viewer dialog of its own is left in the page', async () => {
    await setup([doc('a')]);
    expect(el.querySelector('sd-dialog[size="xl"]')).toBeNull();
    expect(el.querySelector('doc-protected-document-viewer')).toBeNull();
    expect(el.querySelector('sd-document-viewer')).toBeNull();
    expect(Array.from(el.querySelectorAll('dialog')).some((d) => d.getAttribute('aria-labelledby') === 'doc-viewer-title')).toBe(false);
  });
});
