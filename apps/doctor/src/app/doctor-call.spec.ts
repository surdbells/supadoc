import { ApplicationRef, computed, type EmbeddedViewRef, signal, type WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { NEVER, Observable, of, Subject, throwError, timer } from 'rxjs';
import { map } from 'rxjs/operators';
import { SessionTimeoutService, StaffAuthService } from '@supadoc/auth';
import { API_CONFIG, ApiService, DoctorApi, LabRequestsApi } from '@supadoc/data-access';
import type { DoctorDocumentAccessDto, DoctorSharedDocumentDto } from '@supadoc/models';
import {
  CallControlsComponent,
  CallSelfTileComponent,
  CallTilesComponent,
  DialogService,
  provideSupadocIcons,
} from '@supadoc/ui';
import { DocumentViewerService, type ViewerCallContext, type ViewerOpenOptions, type ViewerSession, type ViewerSource } from '@supadoc/viewer';
import { NOT_SHARED } from './appointment/document-access';
import { NoteDraftStore } from './appointment/note-draft';
import { WS_EMR_NO_DETAILS, WS_RECORD_SHOWN, wsShareBanner } from './call-workspace/call-workspace-copy';
import { DoctorCall } from './doctor-call';
import { RxPanel } from './prescriptions/rx-panel';
import { RxComposer } from './prescriptions/rx-composer';
import { CallLabComposer } from './lab/call-lab-composer';
import { UNSAVED_LAB_LEAVE } from './lab/lab-composer';
import { labContext, labOptions, labRequest } from './lab/testing/lab-fixtures';

/** Agora, faked: a client that joins and keeps its event handlers (the nudge arrives on 'stream-message'). */
const agora = vi.hoisted(() => {
  const clients: Array<{
    handlers: Record<string, (...a: unknown[]) => unknown>;
    remoteUsers: Array<{ uid: number | string; videoTrack?: unknown }>;
    leave: (...a: unknown[]) => Promise<unknown>;
    join: (...a: unknown[]) => Promise<unknown>;
  }> = [];
  const track = (kind: string) => ({
    kind,
    enabled: true,
    play: vi.fn(),
    stop: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
    setEnabled: vi.fn(async () => undefined),
  });
  const module = {
    createClient: vi.fn(() => {
      const listeners: Record<string, Array<(...a: unknown[]) => unknown>> = {};
      /** One dispatcher per event: calls every listener, and waits for the async ones. */
      const handlers: Record<string, (...a: unknown[]) => unknown> = {};
      const client = {
        handlers,
        remoteUsers: [] as Array<{ uid: number | string; videoTrack?: unknown }>,
        on: vi.fn((event: string, cb: (...a: unknown[]) => unknown) => {
          (listeners[event] ??= []).push(cb);
          handlers[event] = (...a: unknown[]) => Promise.all(listeners[event].map((l) => l(...a)));
        }),
        off: vi.fn(),
        join: vi.fn(async () => 2),
        publish: vi.fn(async () => undefined),
        unpublish: vi.fn(async () => undefined),
        leave: vi.fn(async () => undefined),
        subscribe: vi.fn(async () => undefined),
        renewToken: vi.fn(async () => undefined),
        enableAudioVolumeIndicator: vi.fn(),
        getRTCStats: vi.fn(() => ({})),
        sendStreamMessage: vi.fn(async () => undefined),
      };
      clients.push(client);
      return client;
    }),
    createMicrophoneAndCameraTracks: vi.fn(async () => [track('audio'), track('video')]),
    createScreenVideoTrack: vi.fn(),
  };
  return { clients, module };
});
vi.mock('agora-rtc-sdk-ng', () => ({ default: agora.module }));

const JOIN = {
  appointment_id: 'ap-1',
  scheduled_at: '2026-11-04T15:00:00Z',
  specialist: { name: 'Dr Ada Obi', timezone: 'Africa/Lagos' },
  you: { role: 'doctor', name: 'Dr Ada Obi', uid: 2 },
  uid: 2,
  participants: [{ uid: 1, role: 'patient', name: 'Bola Ade' }],
  patient: { id: 'p1', name: 'Bola Ade', allergies: [{ allergen: 'Penicillin' }], vitals: [], conditions: [], medications: [], history: [] },
  configured: true,
  app_id: 'app',
  channel: 'ch',
  token: 'rtc',
};

/** The Full EMR's read. */
const EMR_RECORD = {
  patient: { id: 'p1', name: 'Bola Ade', email: 'bola@example.test', phone: null, gender: 'female', date_of_birth: '1990-05-01' },
  medical: { allergies: [], conditions: [], medications: [], history: [] },
  appointments: [],
  visit_count: 0,
};

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

/** The cockpit's state, through a typed cast. */
interface CallInternals {
  readonly status: WritableSignal<string>;
  readonly screenOn: WritableSignal<boolean>;
  readonly newDocCount: () => number;
  readonly docAlert: () => { count: number } | null;
  readonly docAlertView: () => { title: string; detail: string | null } | null;
  readonly callClosed: WritableSignal<string>;
  readonly connectionLost: WritableSignal<boolean>;
  readonly recordingError: WritableSignal<string>;
  readonly recordingActive: WritableSignal<boolean>;
  readonly joinStanding: WritableSignal<string | null>;
  readonly errorMessage: WritableSignal<string>;
  readonly docAnnounce: WritableSignal<string>;
  readonly peer: { track(): unknown; holder(): string; route(uid: number | string, track: unknown): void };
  readonly newDocIds: () => ReadonlySet<string>;
  loadDocumentAccess(mode: 'load' | 'refresh' | 'poll' | 'nudge'): void;
  rejoin(): Promise<void>;
  leave(to?: 'appointment' | 'schedule'): Promise<void>;
  openStanding(): Promise<void>;
  askEnd(): Promise<void>;
  toggleMic(): Promise<void>;
}

/** The shared viewer, faked: what the page registers and opens, with the service's hand-over order. */
function fakeViewer() {
  const session = signal<ViewerSession | null>(null);
  let ctx: ViewerCallContext | null = null;
  const unregister = vi.fn(() => {
    if (session()) viewer.close();
    ctx = null;
  });
  const viewer = {
    session,
    isOpen: computed(() => session() !== null),
    ctx: () => ctx,
    unregister,
    registerCall: vi.fn((c: ViewerCallContext) => {
      ctx = c;
      return unregister;
    }),
    open: vi.fn((sources: ViewerSource | readonly ViewerSource[], options: ViewerOpenOptions = {}) => {
      const list = Array.isArray(sources) ? (sources as readonly ViewerSource[]) : [sources as ViewerSource];
      const wasOpen = session() !== null;
      session.set({ seq: 1, sources: list, refused: list.map(() => null), options });
      if (!wasOpen) ctx?.willOpen();
      return { closed: Promise.resolve(), close: () => viewer.close() };
    }),
    close: vi.fn(() => {
      if (!session()) return;
      session.set(null);
      ctx?.didClose();
    }),
    revoke: vi.fn(),
    isShowing: (key: string) => session()?.sources.some((s) => s.key === key) ?? false,
  };
  return viewer;
}

// A first test compiles the whole component tree (JIT): beyond the 5 s default on a busy machine.
describe('DoctorCall — documents in the call', { timeout: 20_000 }, () => {
  let fixture: ComponentFixture<DoctorCall>;
  let call: CallInternals;
  let el: HTMLElement;
  let reads: { at: number; passive: boolean }[];
  let answer: () => Observable<{ data: DoctorDocumentAccessDto }>;
  let t0: number;
  let viewer: ReturnType<typeof fakeViewer>;
  let dialogConfirm: ReturnType<typeof vi.fn>;
  /** What the follow-up planner lists. */
  let followUps: unknown[] = [];
  /** Every portal request made through ApiService.request (the clinical panels, transcript, metrics). */
  let portal: { method: string; path: string; passive: boolean; body?: unknown }[];
  let session: { hold: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
  const signedIn = signal(true);
  const realMatchMedia = window.matchMedia;

  function media(matching: string[]) {
    window.matchMedia = ((query: string) => ({
      matches: matching.includes(query),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
  }

  const tick = async (ms = 0) => {
    await vi.advanceTimersByTimeAsync(ms);
    fixture.detectChanges();
    TestBed.inject(ApplicationRef).tick();
  };

  async function setup(docs: DoctorSharedDocumentDto[] = [doc('a')]) {
    followUps = [];
    reads = [];
    portal = [];
    session = { hold: vi.fn(), release: vi.fn() };
    answer = () => of({ data: access(docs) });
    signedIn.set(true);
    viewer = fakeViewer();
    dialogConfirm = vi.fn(async () => ({ confirmed: true }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-11-04T15:00:00Z'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/presence')
          ? new Response('{}', { status: 200 })
          : new Response(JSON.stringify({ data: JOIN }), { status: 200 }),
      ),
    );
    TestBed.configureTestingModule({
      imports: [DoctorCall],
      providers: [
        provideRouter([]),
        provideSupadocIcons(),
        { provide: API_CONFIG, useValue: { baseUrl: 'http://api.test' } },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ token: 'tok' }) } } },
        {
          provide: StaffAuthService,
          useValue: { isAuthenticated: signedIn, subject: signal('doc-1'), displayName: () => 'Dr Ada Obi', clockOffset: () => 0 },
        },
        {
          provide: ApiService,
          useValue: {
            get: () => of({ data: [] }),
            request: (method: string, path: string, body?: unknown, opts?: { passive?: boolean }) => {
              portal.push({ method: method.toUpperCase(), path, passive: !!opts?.passive, body });
              return of({ data: {} });
            },
          },
        },
        {
          provide: DoctorApi,
          useValue: {
            documentAccess: (_id: string, opts?: { passive?: boolean }) => {
              reads.push({ at: Date.now() - t0, passive: !!opts?.passive });
              return answer();
            },
            patientDocumentView: () => of({ blob: new Blob(['x']), mime: 'application/pdf', viewRef: null, viewedAt: new Date().toISOString() }),
            patientDocumentPrinted: () => of({ data: { recorded: true } }),
            appointment: () => of({ data: { patient_id: 'p1' } }),
            getProfile: () => of({ data: { id: 'd1', name: 'Dr Ada Obi', timezone: 'Africa/Lagos', timezone_source: 'manual' } }),
            complete: () => of({}),
            listLabOrders: () => of({ data: [] }),
            patient: () => of({ data: EMR_RECORD }),
            listPrescriptions: () => of({ data: [] }),
            allPrescriptions: () => of({ data: [], meta: { total: 0 } }),
            prescriptionOptions: () => of({ data: { readings: [], limits: {}, routes: [], reading_sources: {}, pregnancy: {}, follow_up_modes: {}, has_signature: true } }),
            clinicalSummary: () => NEVER,
            followUps: () => of({ data: followUps }),
            calendar: () => NEVER,
            documentPdf: () => of(new Blob(['x'])),
          },
        },
        // The Lab requests tab lists this consultation's requests, and composes and opens them in place.
        {
          provide: LabRequestsApi,
          useValue: {
            list: () => of({ data: [] }),
            options: () => of({ data: labOptions() }),
            context: () => of({ data: labContext() }),
            create: () => of({ data: labRequest({ id: 'new1', number: 'GVM-REQ-20261105-00001' }) }),
            get: (id: string) => of({ data: labRequest({ id }) }),
            cancel: () => NEVER,
          },
        },
        { provide: SessionTimeoutService, useValue: session },
        { provide: NoteDraftStore, useValue: { take: () => null, clear: () => undefined, save: () => true } },
        {
          provide: DialogService,
          useValue: { confirm: dialogConfirm, confirmLeave: async () => true, requests: () => [] },
        },
        { provide: DocumentViewerService, useValue: viewer },
      ],
    });
    fixture = TestBed.createComponent(DoctorCall);
    call = fixture.componentInstance as unknown as CallInternals;
    el = fixture.nativeElement;
    document.body.appendChild(el);
    t0 = Date.now();
    fixture.detectChanges();
    // Join: the API, Agora, the tracks — all resolve at once (fake time stands still).
    for (let i = 0; i < 10 && call.status() !== 'in-call'; i++) await tick();
    expect(call.status()).toBe('in-call');
  }

  const client = () => agora.clients[agora.clients.length - 1];
  const nudge = (uid: number | string = 1) => client().handlers['stream-message']?.(uid, 'sd:v1:docs');
  const text = () => (el.textContent ?? '').replace(/\s+/g, ' ');

  afterEach(() => {
    fixture?.destroy();
    el?.remove();
    window.matchMedia = realMatchMedia;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    vi.unstubAllGlobals();
    vi.useRealTimers();
    agora.clients.length = 0;
  });

  it('after the first read, a new document gives one alert and one badge (and no alert for the baseline)', async () => {
    await setup([doc('a')]);
    expect(reads.length).toBe(1);
    expect(call.docAlert()).toBeNull();
    expect(call.newDocCount()).toBe(0);

    answer = () => of({ data: access([doc('b', { title: 'Lab report' }), doc('a')]) });
    call.loadDocumentAccess('refresh');
    await tick();
    expect(call.newDocCount()).toBe(1);
    expect(call.docAlert()?.count).toBe(1);
    expect(text()).toContain('Bola shared a new document');
    expect(text()).toContain('“Lab report” · Lab report · 1.2 MB');
    expect(el.querySelector('#call-section-documents')?.textContent).toContain('1 new');

    // The same list again: nothing more.
    call.loadDocumentAccess('refresh');
    await tick();
    expect(call.docAlert()?.count).toBe(1);
  });

  it('leaves the file details out while the doctor shares their screen', async () => {
    await setup([doc('a')]);
    answer = () => of({ data: access([doc('a'), doc('b')]) });
    call.loadDocumentAccess('refresh');
    call.screenOn.set(true);
    await tick();
    expect(call.docAlertView()?.title).toBe('Bola shared a new document');
    expect(call.docAlertView()?.detail).toBeNull();
  });

  it('signing out clears it all, and signing in again starts a fresh baseline', async () => {
    await setup([doc('a')]);
    answer = () => of({ data: access([doc('a'), doc('b')]) });
    call.loadDocumentAccess('refresh');
    await tick();
    expect(call.newDocCount()).toBe(1);

    signedIn.set(false);
    await tick();
    expect(call.newDocCount()).toBe(0);
    expect(call.docAlert()).toBeNull();

    answer = () => of({ data: access([doc('a'), doc('b'), doc('c')]) });
    signedIn.set(true);
    await tick();
    expect(call.newDocCount()).toBe(0);
    expect(call.docAlert()).toBeNull();
  });

  it('a nudge during a read in flight queues exactly one more read', async () => {
    await setup([doc('a')]);
    const pending = new Subject<{ data: DoctorDocumentAccessDto }>();
    answer = () => pending;
    call.loadDocumentAccess('refresh');
    expect(reads.length).toBe(2);
    nudge();
    await tick(800);
    nudge();
    await tick(3_000);
    expect(reads.length).toBe(2); // both nudge reads waited for the one in flight
    answer = () => of({ data: access([doc('a')]) });
    pending.next({ data: access([doc('a')]) });
    pending.complete();
    await tick();
    expect(reads.length).toBe(3);
    await tick(5_000);
    expect(reads.filter((r) => r.at < 9_000).length).toBe(3);
  });

  it('nudges at 0, 1 and 2 s give reads at 0.75 s and 3.75 s (delayed, never dropped)', async () => {
    await setup([doc('a')]);
    nudge();
    await tick(1_000);
    nudge();
    await tick(1_000);
    nudge();
    await tick(4_000);
    const nudgeReads = reads.slice(1).map((r) => r.at);
    expect(nudgeReads).toEqual([750, 3_750]);
  });

  it('ignores a nudge from anyone but the patient', async () => {
    await setup([doc('a')]);
    nudge(3);
    await tick(2_000);
    expect(reads.length).toBe(1);
  });

  it('the chart’s vitals say a reading above its usual range needs confirming', async () => {
    await setup([doc('a')]);
    const c = fixture.componentInstance as unknown as {
      info: WritableSignal<{ patient?: Record<string, unknown> } | null>;
      isChartOpen(k: string): boolean;
      toggleChart(k: string): void;
    };
    const info = c.info();
    c.info.set({
      ...info,
      patient: {
        ...info?.patient,
        vitals: [
          {
            key: 'temperature', label: 'Temperature', value: '46', unit: '°C', taken_at: '2026-11-04T14:00:00Z',
            source: 'self_reported', source_label: 'Self-reported', recorded_by: 'patient', stale: false,
            flag: { level: 'critical', label: 'Very high', advice: 'Seek urgent medical attention', out_of_range: true, usual_max: '45' },
          },
        ],
      },
    });
    if (!c.isChartOpen('vitals')) c.toggleChart('vitals');
    await tick();
    const panel = el.querySelector('#call-chart-vitals');
    expect(panel?.querySelector('[data-above-range]')?.textContent).toContain('Above the expected range (max 45 °C) — confirm the reading.');
    expect(panel?.textContent?.replace(/\s+/g, ' ')).toContain(
      'Temperature is Very high — Above the expected range (max 45 °C) — confirm the reading. (Seek urgent medical attention)',
    );
    expect(panel?.querySelector('[title]')?.getAttribute('title')).toContain('above the expected range');
  });

  it('the chart asks to confirm a height above its usual range, with no urgent alert', async () => {
    await setup([doc('a')]);
    const c = fixture.componentInstance as unknown as {
      info: WritableSignal<{ patient?: Record<string, unknown> } | null>;
      isChartOpen(k: string): boolean;
      toggleChart(k: string): void;
    };
    const info = c.info();
    c.info.set({
      ...info,
      patient: {
        ...info?.patient,
        vitals: [
          {
            key: 'height', label: 'Height', value: '260', unit: 'cm', taken_at: '2026-11-04T14:00:00Z',
            source: 'self_reported', source_label: 'Self-reported', recorded_by: 'patient', stale: false,
            flag: { level: 'high', label: 'High', advice: null, out_of_range: true, usual_max: '250' },
          },
        ],
      },
    });
    if (!c.isChartOpen('vitals')) c.toggleChart('vitals');
    await tick();
    const panel = el.querySelector('#call-chart-vitals');
    expect(panel?.querySelector('[data-above-range]')?.textContent).toContain('Above the expected range (max 250 cm) — confirm the reading.');
    expect(panel?.textContent).not.toContain('Seek urgent medical attention');
    expect(panel?.textContent).not.toContain('Very high');
  });

  it('polls every 10 s from when each read STARTED, even when reads take 300 ms', async () => {
    await setup([doc('a')]);
    answer = () => timer(300).pipe(map(() => ({ data: access([doc('a')]) })));
    await tick(31_000);
    expect(reads.slice(1).map((r) => r.at)).toEqual([10_000, 20_000, 30_000]);
    expect(reads.slice(1).every((r) => r.passive)).toBe(true);
  });

  it('polls every 30 s while the tab is hidden', async () => {
    await setup([doc('a')]);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    await tick(91_000);
    expect(reads.slice(1).map((r) => r.at)).toEqual([30_000, 60_000, 90_000]);
  });

  describe('background requests are passive; the call hold keeps a live call alive', () => {
    const transcript = '/api/doctor/appointments/ap-1/transcript';
    const metrics = '/api/doctor/appointments/ap-1/metrics';

    it('the transcript poll (8 s) and the metrics report (15 s) are passive; the panels’ first loads are not', async () => {
      await setup([doc('a')]);
      // The clinical panels load once the doctor is signed in: requests the doctor's
      // opening of the call made, so they count (the transcript's first read too).
      const first = portal.filter((r) => r.path === transcript);
      expect(first).toEqual([{ method: 'GET', path: transcript, passive: false }]);
      expect(portal.some((r) => r.path.endsWith('/note') && !r.passive)).toBe(true);

      portal = [];
      await tick(30_000);
      const polls = portal.filter((r) => r.path === transcript);
      const reports = portal.filter((r) => r.path === metrics);
      expect(polls.length).toBe(3); // 8, 16, 24 s
      expect(reports.length).toBe(2); // 15, 30 s
      expect(reports.every((r) => r.method === 'POST')).toBe(true);
      // Nothing the timers sent counts as activity.
      expect(portal.length).toBe(polls.length + reports.length);
      expect(portal.every((r) => r.passive)).toBe(true);
    });

    it('what the doctor asks for stays active (e.g. Generate draft)', async () => {
      await setup([doc('a')]);
      portal = [];
      await (call as unknown as { generateDraft(): Promise<void> }).generateDraft();
      expect(portal).toEqual([{ method: 'POST', path: '/api/doctor/appointments/ap-1/copilot/draft', passive: false }]);
    });

    it('holds the session while the call is live, releases it when the patient leaves; the polls stay passive throughout and stop on leaving', async () => {
      await setup([doc('a')]);
      // Joined, waiting for the patient (bounded): held.
      expect(session.hold).toHaveBeenCalledWith('call');
      expect(session.release).not.toHaveBeenCalled();

      // The patient joins: still held — however long nobody touches anything.
      client().remoteUsers = [{ uid: 1 }];
      await client().handlers['user-joined']?.({ uid: 1 });
      await tick();
      portal = [];
      await tick(60 * 60_000);
      expect(session.release).not.toHaveBeenCalled();
      expect(portal.length).toBeGreaterThan(0);
      expect(portal.every((r) => r.passive)).toBe(true);

      // The patient leaves: the call is over for the session — released, so an
      // ended call left open idles out (its polls never kept it alive).
      client().remoteUsers = [];
      await client().handlers['user-left']?.({ uid: 1 });
      await tick();
      expect(session.release).toHaveBeenCalledWith('call');
      portal = [];
      await tick(60_000);
      expect(portal.length).toBeGreaterThan(0);
      expect(portal.every((r) => r.passive)).toBe(true);

      // Leaving stops every timer.
      await (call as unknown as { teardown(): Promise<void> }).teardown();
      portal = [];
      await tick(60_000);
      expect(portal).toEqual([]);
    });
  });

  it('puts the count in the title while the tab is hidden, and restores it on return', async () => {
    await setup([doc('a')]);
    document.title = 'VideoMed Doctor';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    answer = () => of({ data: access([doc('a'), doc('b')]) });
    call.loadDocumentAccess('refresh');
    await tick();
    expect(document.title).toBe('(1) New document · VideoMed Doctor');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await tick();
    expect(document.title).toBe('VideoMed Doctor');
  });

  it('a record opens the shared viewer on the filtered list (view-only, watermarked); with its opener gone, focus goes to Medical Records', async () => {
    media(['(min-width: 1024px)']);
    await setup([doc('a', { document_type: 'xray_report' }), doc('b'), doc('c', { document_type: 'xray_report', shared_at: '2026-11-04T14:30:00Z' })]);
    (call as unknown as { recordsTab: WritableSignal<string> }).recordsTab.set('imaging');
    (call as unknown as { sideTab: WritableSignal<string> }).sideTab.set('documents');
    await tick();
    const row = el.querySelector<HTMLButtonElement>('[data-doc-id="a"]');
    expect(row).not.toBeNull();
    row?.click();
    expect(viewer.open).toHaveBeenCalledTimes(1);
    const [sources, options] = viewer.open.mock.calls[0] as [ViewerSource[], ViewerOpenOptions];
    // The Imaging filter as shown (newest share first), at the row pressed.
    expect(sources.map((s) => s.key)).toEqual(['doc:c', 'doc:a']);
    expect(sources.every((s) => s.policy === 'view_only' && s.download === undefined)).toBe(true);
    expect(options.index).toBe(1);
    expect(options.opener).toBe(row);
    expect(options.watermark).toEqual({ viewerName: 'Dr Ada Obi', timeZone: expect.any(String) });
    expect(options.watermark?.timeZone).not.toBe('');
    expect(options.tone).toBeUndefined(); // the registered call sets the cockpit's
    // The opener went (the list re-rendered): the Medical Records heading, its side tab chosen first.
    (call as unknown as { sideTab: WritableSignal<string> }).sideTab.set('patient');
    await tick();
    expect(options.fallbackFocus?.()).toBeNull();
    await tick();
    expect(el.querySelector<HTMLElement>('#call-records')?.hidden).toBe(false);
    expect(document.activeElement?.id).toBe('call-records-heading');
  });

  it('pills (item 5): the "Documents / Imaging / Labs" filter is the S pill with the solid look, state from aria-pressed; chips and counts follow the standard', async () => {
    media(['(min-width: 1024px)']);
    await setup([doc('a', { document_type: 'xray_report' }), doc('b')]);
    (call as unknown as { sideTab: WritableSignal<string> }).sideTab.set('documents');
    await tick();
    const row = el.querySelector<HTMLElement>('#call-records [role="group"][aria-label="Show"]');
    expect(row?.classList.contains('sd-pill-row-wrap')).toBe(true);
    expect(row?.className).not.toMatch(/overflow-x-auto|\bgap-1\b/);
    const pills = Array.from(row?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    expect(pills.length).toBeGreaterThan(1);
    for (const p of pills) {
      expect(p.className.split(/\s+/).sort()).toEqual(['sd-filter-solid', 'sd-pill', 'sd-pill-s']);
    }
    expect(pills.map((p) => p.getAttribute('aria-pressed'))).toEqual(pills.map((_, i) => String(i === 0)));
    pills[1].click();
    await tick();
    expect(pills.map((p) => p.getAttribute('aria-pressed'))).toEqual(pills.map((_, i) => String(i === 1)));
    // The badges and "new" chips are standard counts and chips; no stray pill shape is left on the page.
    expect(el.querySelector('.sd-badge, .sd-new-pill, .rounded-pill')).toBeNull();
    expect(el.querySelector('[role="timer"]')?.className).toBe('sd-chip sd-tone-neutral');
    // The light-cockpit patches for the old pills are gone; the solid cerulean buttons keep white text.
    const styles = (DoctorCall as unknown as { ɵcmp: { styles: string[] } }).ɵcmp.styles.join('');
    expect(styles).not.toMatch(/sd-new-pill|sd-badge/);
    expect(styles).toMatch(/\.bg-cerulean\.text-white[^{]*\{[^}]*#ffffff/);
  });

  it('mid: new documents are announced from a live region outside every hideable panel and the cockpit', async () => {
    media(['(min-width: 1024px)']);
    await setup([doc('a')]);
    answer = () => of({ data: access([doc('b', { title: 'Lab report' }), doc('a')]) });
    call.loadDocumentAccess('refresh');
    await tick(100);
    expect(el.querySelector<HTMLElement>('#call-records')?.hidden).toBe(true); // the Patient side tab is chosen
    const regions = Array.from(el.querySelectorAll<HTMLElement>('[aria-live="polite"]'));
    const region = regions.find((p) => (p.textContent ?? '').includes('Bola shared a new document'));
    expect(region).toBeDefined();
    expect(region?.closest('[hidden]')).toBeNull();
    expect(region?.closest('main')).toBeNull();
    expect(regions.filter((p) => (p.textContent ?? '').includes('Bola shared')).length).toBe(1);
  });

  it('no "Document" tool tab, no narrow sheet and no hand-written inert: the viewer is a modal of its own', async () => {
    for (const size of [[], ['(min-width: 1024px)'], ['(min-width: 1024px)', '(min-width: 1280px)']]) {
      media(size);
      await setup([doc('a'), doc('b')]);
      el.querySelector<HTMLButtonElement>('[data-doc-id="b"]')?.click();
      await tick();
      expect(viewer.open).toHaveBeenCalledTimes(1);
      // The cockpit holds launchers, no inline tablist; the workspace holds the six tabs.
      expect(el.querySelector('[role="tablist"][aria-label="Consultation tools"]')).toBeNull();
      expect(el.querySelector('[aria-label="Close document"]')).toBeNull();
      expect(el.querySelector('doc-protected-document-viewer, sd-document-viewer')).toBeNull();
      expect(el.querySelector('.fixed.inset-0.z-50')).toBeNull();
      expect(el.querySelector('[inert]')).toBeNull();
      el.querySelector<HTMLButtonElement>('[data-ws-launcher="notes"]')?.click();
      await tick();
      const tabs = Array.from(el.querySelectorAll('[role="tablist"][aria-label="Consultation tools"] [role="tab"]')).map((t) => t.textContent?.trim());
      expect(tabs).toEqual(['Consultation Notes', 'Prescriptions', 'Lab requests', 'Follow-ups', 'Transcript & AI', 'Full EMR']);
      expect(el.querySelector('.fixed.inset-0.z-50')).toBeNull();
      fixture.destroy();
      el.remove();
      TestBed.resetTestingModule();
      vi.useRealTimers();
      agora.clients.length = 0;
    }
  });

  it('the Lab request tool in the workspace’s notes selects Lab requests, focus on its tab', async () => {
    await setup([doc('a')]);
    el.querySelector<HTMLButtonElement>('[data-ws-launcher="notes"]')?.click();
    await tick();
    const tool = Array.from(el.querySelectorAll('#ws-panel-notes button')).find((b) => b.textContent?.trim() === 'Lab request') as HTMLButtonElement | undefined;
    if (!tool) throw new Error('no Lab request tool');
    tool.focus();
    tool.click();
    await tick();
    expect(el.querySelector('#ws-tab-labs')?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement?.id).toBe('ws-tab-labs');
  });

  it('a document of the open viewer that stops being shared is revoked in place (NOT_SHARED), not closed', async () => {
    media(['(min-width: 1024px)']);
    await setup([doc('a'), doc('b')]);
    (call as unknown as { sideTab: WritableSignal<string> }).sideTab.set('documents');
    await tick();
    el.querySelector<HTMLButtonElement>('[data-doc-id="b"]')?.click();
    answer = () => of({ data: access([doc('a')]) });
    call.loadDocumentAccess('refresh');
    await tick();
    expect(viewer.revoke).toHaveBeenCalledTimes(1);
    expect(viewer.revoke).toHaveBeenCalledWith('doc:b', NOT_SHARED);
    expect(viewer.close).not.toHaveBeenCalled();
  });

  it('mid layout: the side wrapper is the one item in "side", showing only the chosen panel', async () => {
    media(['(min-width: 1024px)']);
    await setup([doc('a')]);
    const main = el.querySelector('main');
    const side = Array.from(main?.children ?? []).filter((c) => (c.getAttribute('class') ?? '').includes('[grid-area:side]'));
    expect(side.length).toBe(1);
    expect(el.querySelector<HTMLElement>('#call-chart')?.hidden).toBe(false);
    expect(el.querySelector<HTMLElement>('#call-records')?.hidden).toBe(true);
    expect(el.querySelector<HTMLElement>('#call-people')?.hidden).toBe(true);
    expect(el.querySelector('[role="tablist"][aria-label="Side panel"]')).not.toBeNull();
    expect(el.querySelector('[role="tablist"][aria-label="Sections"]')).toBeNull();
  });

  it('wide layout: the side wrapper is display: contents (chart and records are grid items)', async () => {
    media(['(min-width: 1024px)', '(min-width: 1280px)']);
    await setup([doc('a')]);
    const main = el.querySelector('main');
    const wrapper = el.querySelector('#call-chart')?.parentElement;
    expect(wrapper?.parentElement).toBe(main);
    expect(wrapper?.getAttribute('class')).toBe('contents');
    expect(el.querySelector<HTMLElement>('#call-records')?.hidden).toBe(false);
    expect(el.querySelector('#call-people')).toBeNull();
    expect(el.querySelector('#call-people-list')).not.toBeNull();
  });

  describe('the dock: every control in the bar (no More), Large and fill by default, as wide as the tools', () => {
    const KEYS = ['videomed.call.video-size', 'videomed.call.more-room', 'videomed.call.fit', 'videomed.call.self', 'videomed.call.theme'];
    const clear = () => KEYS.forEach((k) => localStorage.removeItem(k));
    const controlsCmp = () => fixture.debugElement.query(By.directive(CallControlsComponent)).componentInstance as CallControlsComponent;
    const tilesCmp = () => fixture.debugElement.query(By.directive(CallTilesComponent)).componentInstance as CallTilesComponent;
    const stage = () => el.querySelector<HTMLElement>('.sd-stage');
    const dock = () => el.querySelector<HTMLElement>('section[aria-label="Video call"]');
    const radio = (choice: string, value: string) =>
      el.querySelector<HTMLButtonElement>(`sd-call-controls [data-choice="${choice}"][data-value="${value}"]`) as HTMLButtonElement;
    const button = (id: string) => el.querySelector<HTMLButtonElement>(`sd-call-controls [data-control="${id}"]`) as HTMLButtonElement;
    const stageH = () => el.querySelector<HTMLElement>('main')?.style.getPropertyValue('--stage-h');
    const WIDE = ['(min-width: 1024px)', '(min-width: 1280px)'];
    beforeEach(clear);
    afterEach(clear);

    it('nothing saved: Large video, filling the frame; every setting is a control in the bar', async () => {
      media(WIDE);
      await setup([doc('a')]);
      expect(stageH()).toBe('clamp(320px, calc(100dvh - 16rem), 900px)');
      expect(tilesCmp().mainFit()).toBe('cover');
      expect(el.querySelector('sd-call-controls [data-control="more"], sd-call-controls [role="menu"]')).toBeNull();
      expect(controlsCmp().settings().map((s) => s.id)).toEqual(['size', 'fit', 'self']);
      expect(radio('size', 'l').getAttribute('aria-checked')).toBe('true');
      expect(radio('size', 'l').getAttribute('aria-label')).toBe('Large video');
      expect(radio('fit', 'cover').getAttribute('aria-checked')).toBe('true');
      expect(button('self').getAttribute('aria-pressed')).toBe('false');
      expect(el.querySelector('sd-call-controls [role="radiogroup"][aria-label="Video size"]')).not.toBeNull();
      expect(el.querySelector('sd-call-controls [role="group"][aria-label="Call settings"]')).not.toBeNull();
    });

    it('the bar’s choices change and remember the size and fit; Hide my preview is a toggle', async () => {
      media(WIDE);
      await setup([doc('a')]);
      radio('size', 'm').click();
      radio('fit', 'contain').click();
      await tick();
      expect(stageH()).toBe('clamp(260px, calc(52dvh - 3rem), 640px)');
      expect(tilesCmp().mainFit()).toBe('contain');
      expect(radio('size', 'm').getAttribute('aria-checked')).toBe('true');
      expect(localStorage.getItem('videomed.call.video-size')).toBe('m');
      expect(localStorage.getItem('videomed.call.fit')).toBe('contain');
      button('self').click();
      await tick();
      expect(tilesCmp().selfView()).toBe('hidden');
      expect(button('self').getAttribute('aria-pressed')).toBe('true');
      expect(localStorage.getItem('videomed.call.self')).toBe('hidden');
    });

    it('a saved choice is honoured, and the old "More room" switch still means Small', async () => {
      localStorage.setItem('videomed.call.video-size', 'm');
      localStorage.setItem('videomed.call.fit', 'contain');
      media(WIDE);
      await setup([doc('a')]);
      expect(stageH()).toBe('clamp(260px, calc(52dvh - 3rem), 640px)');
      expect(tilesCmp().mainFit()).toBe('contain');
      fixture.destroy();
      el.remove();
      TestBed.resetTestingModule();
      clear();
      localStorage.setItem('videomed.call.more-room', '1');
      await setup([doc('a')]);
      expect(stageH()).toBe('clamp(200px, 32dvh, 360px)');
      expect(radio('size', 's').getAttribute('aria-checked')).toBe('true');
    });

    it('wide and mid: the stage fills the tools column’s width, its height giving way before the launcher card’s', async () => {
      media(WIDE);
      await setup([doc('a')]);
      const tools = el.querySelector<HTMLElement>('#call-tools');
      expect(dock()?.className).toContain('[grid-area:dock]');
      expect(tools?.className).toContain('[grid-area:tools]');
      expect(el.querySelector('main')?.className).toContain('grid-rows-[minmax(0,auto)_minmax(auto,1fr)]');
      expect(dock()?.className).toContain('min-h-0');
      expect(stage()?.className.split(/\s+/)).toEqual(expect.arrayContaining(['w-full', 'min-h-0', 'h-[var(--stage-h)]']));
      expect(stage()?.className).not.toContain('shrink-0');
      expect(stage()?.className).not.toContain('max-w-');
      expect(el.querySelector('sd-call-controls')?.closest('.rounded-card')?.className).toContain('shrink-0');
    });

    it('narrow (a phone held upright): the stage is the content’s full width, 4:3 up to --stage-max; the theme joins the bar', async () => {
      media(['(max-width: 639.98px)']);
      await setup([doc('a')]);
      expect(stage()?.className.split(/\s+/)).toEqual(
        expect.arrayContaining(['w-full', 'aspect-[4/3]', 'max-h-[var(--stage-max)]', 'sm:aspect-video']),
      );
      expect(stage()?.className).not.toContain('mx-auto');
      expect(stage()?.className).not.toContain('max-w-');
      expect(controlsCmp().settings().map((s) => s.id)).toEqual(['size', 'fit', 'self', 'theme']);
      expect(button('theme').getAttribute('aria-label')).toBe('Light cockpit');
      button('theme').click();
      await tick();
      expect(button('theme').getAttribute('aria-pressed')).toBe('true');
      expect(el.getAttribute('data-theme')).toBe('light');
    });
  });

  describe('the shared viewer during the call (call band, peer hand-over)', () => {
    /** A remote video track, faked (the stage and the viewer's tile only play and stop it). */
    const remoteTrack = (name: string) => ({ name, play: vi.fn(), stop: vi.fn() });
    const tilesCmp = () => fixture.debugElement.query(By.directive(CallTilesComponent)).componentInstance as CallTilesComponent;
    const ctx = () => {
      const c = viewer.ctx();
      if (!c) throw new Error('No call registered');
      return c;
    };
    const bands: EmbeddedViewRef<unknown>[] = [];
    /** The registered band, rendered the way the viewer's outlet does (inside .sd-call[data-theme=dark]). */
    function band(): HTMLElement {
      const view = ctx().bar.createEmbeddedView(null);
      bands.push(view);
      view.detectChanges();
      const host = document.createElement('div');
      host.className = 'sd-call';
      host.dataset['theme'] = 'dark';
      for (const n of view.rootNodes) host.appendChild(n as Node);
      document.body.appendChild(host);
      return host;
    }
    /** The doctor leaves (what leave() and End do after asking). */
    const teardown = () => (call as unknown as { teardown(): Promise<void> }).teardown();
    const bandText = (h: HTMLElement) => (h.textContent ?? '').replace(/\s+/g, ' ');
    const button = (h: HTMLElement, label: string) =>
      Array.from(h.querySelectorAll<HTMLButtonElement>('button')).find(
        (b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').replace(/\s+/g, ' ').trim() === label,
      ) ?? null;
    /** The patient (uid 1) in the channel, with a video track Agora holds. */
    async function patientJoins(track = remoteTrack('v1')) {
      client().remoteUsers = [{ uid: 1, videoTrack: track }];
      await client().handlers['user-joined']?.({ uid: 1 });
      await client().handlers['user-published']?.({ uid: 1, videoTrack: track }, 'video');
      await tick();
      return track;
    }

    afterEach(() => {
      for (const v of bands.splice(0)) v.destroy();
      document.querySelectorAll('body > .sd-call').forEach((n) => n.remove());
    });

    it('registers once (band, peer tile, the cockpit’s signals) and unregisters on destroy; live is inLive', async () => {
      await setup([doc('a')]);
      expect(viewer.registerCall).toHaveBeenCalledTimes(1);
      const c = ctx();
      expect(c.bar).toBeTruthy();
      expect(c.peer).toBeTruthy();
      expect(c.peerName()).toBe('Bola Ade');
      expect(c.tone()).toBe('dark');
      expect(c.live()).toBe(true);
      expect(c.sharingScreen()).toBe(false);
      expect(c.recording()).toBe(false);
      call.callClosed.set('This consultation has ended.');
      expect(c.live()).toBe(false); // the API closed the call
      call.callClosed.set('');
      expect(c.live()).toBe(true);
      call.recordingActive.set(true);
      expect(c.recording()).toBe(true);
      // Leaving (teardown): live turns false and the viewer closes.
      viewer.open({ key: 'rx:1' } as ViewerSource);
      await teardown();
      await tick();
      expect(c.live()).toBe(false);
      expect(viewer.close).toHaveBeenCalled();
      expect(viewer.session()).toBeNull();
      fixture.destroy();
      expect(viewer.unregister).toHaveBeenCalledTimes(1);
      expect(viewer.registerCall).toHaveBeenCalledTimes(1);
    });

    it('opening hands the patient’s video to the tile: detached from the stage FIRST, then the track set', async () => {
      await setup([doc('a')]);
      const track = await patientJoins();
      const stage = tilesCmp();
      const order: string[] = [];
      vi.spyOn(stage, 'detach').mockImplementation((uid) => {
        order.push(`detach:${uid}:${call.peer.track() ? 'tile-has-track' : 'tile-empty'}`);
      });
      el.querySelector<HTMLButtonElement>('[data-doc-id="a"]')?.click();
      order.push(`tile:${(call.peer.track() as { name?: string } | null)?.name ?? 'none'}`);
      expect(order).toEqual(['detach:1:tile-empty', 'tile:v1']);
      expect(call.peer.track()).toBe(track);
    });

    it('closing takes it back: the tile’s track cleared, the CURRENT track re-read from Agora, attached with no config', async () => {
      await setup([doc('a')]);
      await patientJoins(remoteTrack('v1'));
      el.querySelector<HTMLButtonElement>('[data-doc-id="a"]')?.click();
      const stage = tilesCmp();
      // The patient re-published meanwhile (Agora's remoteUsers holds the new track).
      const fresh = remoteTrack('v2');
      client().remoteUsers = [{ uid: 1, videoTrack: fresh }];
      const attach = vi.spyOn(stage, 'attach');
      const order: string[] = [];
      attach.mockImplementation((uid) => {
        order.push(`attach:${uid}:${call.peer.track() === null ? 'tile-cleared' : 'tile-still-set'}`);
      });
      viewer.close();
      expect(call.peer.track()).toBeNull();
      expect(order).toEqual(['attach:1:tile-cleared']);
      expect(attach).toHaveBeenCalledWith(1, fresh);
      expect(attach.mock.calls[0]).toHaveLength(2);
    });

    it('while open, the patient’s re-publish goes to the tile (not the stage), an unpublish empties it; a guest still goes to the stage', async () => {
      await setup([doc('a')]);
      await patientJoins();
      el.querySelector<HTMLButtonElement>('[data-doc-id="a"]')?.click();
      const stage = tilesCmp();
      const attach = vi.spyOn(stage, 'attach');
      const detach = vi.spyOn(stage, 'detach');
      const again = remoteTrack('v2');
      await client().handlers['user-published']?.({ uid: 1, videoTrack: again }, 'video');
      expect(call.peer.track()).toBe(again);
      expect(attach).not.toHaveBeenCalled();
      await client().handlers['user-unpublished']?.({ uid: 1 }, 'video');
      expect(call.peer.track()).toBeNull();
      expect(detach).not.toHaveBeenCalled();
      const guest = remoteTrack('g');
      await client().handlers['user-published']?.({ uid: 3, videoTrack: guest }, 'video');
      expect(attach).toHaveBeenCalledWith(3, guest);
      await client().handlers['user-left']?.({ uid: 3 });
      expect(detach).toHaveBeenCalledWith(3);
    });

    it('rejoin() while open routes its detach loop through the gate: the tile drops the dead track, then gets the re-published one', async () => {
      await setup([doc('a')]);
      await patientJoins(remoteTrack('v1'));
      el.querySelector<HTMLButtonElement>('[data-doc-id="a"]')?.click();
      expect(call.peer.track()).not.toBeNull();
      const stage = tilesCmp();
      const detach = vi.spyOn(stage, 'detach');
      const rejoined = call.rejoin();
      await tick();
      await rejoined;
      expect(call.peer.track()).toBeNull();
      expect(detach).not.toHaveBeenCalledWith(1);
      const back = remoteTrack('v3');
      client().remoteUsers = [{ uid: 1, videoTrack: back }];
      await client().handlers['user-published']?.({ uid: 1, videoTrack: back }, 'video');
      expect(call.peer.track()).toBe(back);
    });

    it('the band: Back to call, who and how long, Mute and End while live — and every call banner with its action', async () => {
      await setup([doc('a')]);
      let h = band();
      expect(bandText(h)).toContain('Bola Ade · 00:00:00');
      expect(button(h, 'Back to call')).not.toBeNull();
      // Its label is screen-reader-only in the viewer's one-row band on a phone held sideways (§1.3.5).
      expect(button(h, 'Back to call')?.querySelector('[data-band-label]')?.textContent).toBe('Back to call');
      expect(button(h, 'Mute')).not.toBeNull();
      expect(button(h, 'Mute')?.hasAttribute('aria-pressed')).toBe(false);
      expect(button(h, 'End consultation')).not.toBeNull();
      // Back to call closes the viewer only.
      el.querySelector<HTMLButtonElement>('[data-doc-id="a"]')?.click();
      button(h, 'Back to call')?.click();
      expect(viewer.close).toHaveBeenCalledTimes(1);
      // Mute / End call the cockpit's own handlers (End asks first, over the viewer).
      const mic = vi.spyOn(call, 'toggleMic').mockResolvedValue(undefined);
      const end = vi.spyOn(call, 'askEnd').mockResolvedValue(undefined);
      button(h, 'Mute')?.click();
      button(h, 'End consultation')?.click();
      expect(mic).toHaveBeenCalledTimes(1);
      expect(end).toHaveBeenCalledTimes(1);

      call.recordingActive.set(true);
      call.recordingError.set('Recording failed.');
      call.docAnnounce.set('Request sent.');
      h = band();
      expect(h.querySelector('[role="status"]')?.textContent).toContain('Recording');
      expect(Array.from(h.querySelectorAll('[role="alert"]')).map((a) => a.textContent?.trim())).toContain('Recording failed.');
      expect(Array.from(h.querySelectorAll('[aria-live="polite"]')).some((p) => p.textContent?.includes('Request sent.'))).toBe(true);

      // The API closed the call (with a standing refusal): Mute / End go, the alert keeps its two ways out.
      call.recordingError.set('');
      call.joinStanding.set('terms_required');
      call.callClosed.set('This consultation has ended.');
      h = band();
      const closed = Array.from(h.querySelectorAll('[role="alert"]')).find((a) => a.textContent?.includes('This consultation has ended.'));
      expect(closed).toBeDefined();
      expect(button(h, 'Mute')).toBeNull();
      expect(button(h, 'End consultation')).toBeNull();
      const leave = vi.spyOn(call, 'leave').mockResolvedValue(undefined);
      const standing = vi.spyOn(call, 'openStanding').mockResolvedValue(undefined);
      button(h, 'Leave the call')?.click();
      button(h, 'Read and accept the terms')?.click();
      expect(leave).toHaveBeenCalledTimes(1);
      expect(standing).toHaveBeenCalledTimes(1);

      // Dropped from the channel: the disconnected alert with Rejoin.
      call.callClosed.set('');
      call.connectionLost.set(true);
      h = band();
      const lost = Array.from(h.querySelectorAll('[role="alert"]')).find((a) => a.textContent?.includes('You were disconnected from the call.'));
      expect(lost).toBeDefined();
      const rejoin = vi.spyOn(call, 'rejoin').mockResolvedValue(undefined);
      button(h, 'Rejoin')?.click();
      expect(rejoin).toHaveBeenCalledTimes(1);
    });

    it('the band says when the patient left the call', async () => {
      await setup([doc('a')]);
      await patientJoins();
      expect(bandText(band())).not.toContain('left the call');
      await client().handlers['user-left']?.({ uid: 1 });
      await tick();
      const h = band();
      expect(bandText(h)).toContain('Bola Ade left the call');
      expect(Array.from(h.querySelectorAll('[role="status"]')).some((s) => s.textContent?.includes('Bola Ade left the call'))).toBe(true);
    });

    it('the new-document alert in the band: its View dismisses it, marks the document seen and replaces the open one', async () => {
      await setup([doc('a')]);
      el.querySelector<HTMLButtonElement>('[data-doc-id="a"]')?.click();
      answer = () => of({ data: access([doc('b', { title: 'Lab report' }), doc('a')]) });
      call.loadDocumentAccess('refresh');
      await tick();
      expect(call.newDocIds().has('b')).toBe(true);
      const h = band();
      expect(bandText(h)).toContain('Bola shared a new document');
      const view = button(h, 'View');
      expect(view).not.toBeNull();
      view?.click();
      expect(call.docAlert()).toBeNull();
      expect(call.newDocIds().has('b')).toBe(false);
      expect(viewer.open).toHaveBeenCalledTimes(2);
      const [sources, options] = viewer.open.mock.calls[1] as [ViewerSource[], ViewerOpenOptions];
      expect(sources[options.index ?? 0].key).toBe('doc:b');
    });

    it('the band’s new-document alert stays while hovered (as the cockpit’s does), then hides after its 15 s', async () => {
      await setup([doc('a')]);
      el.querySelector<HTMLButtonElement>('[data-doc-id="a"]')?.click();
      answer = () => of({ data: access([doc('b', { title: 'Lab report' }), doc('a')]) });
      call.loadDocumentAccess('refresh');
      await tick();
      const h = band();
      const row = Array.from(h.querySelectorAll<HTMLElement>('[role="status"]')).find((r) => r.textContent?.includes('shared a new document'));
      expect(row).toBeDefined();
      row?.dispatchEvent(new MouseEvent('mouseenter'));
      await tick(20_000);
      expect(call.docAlert()).not.toBeNull();
      row?.dispatchEvent(new MouseEvent('mouseleave'));
      await tick(14_000);
      expect(call.docAlert()).not.toBeNull();
      await tick(1_000);
      expect(call.docAlert()).toBeNull();
    });

    it('the band mirrors the stage while joining and when the join fails, with its ways out', async () => {
      await setup([doc('a')]);
      // Records can be opened before Agora has joined (the camera prompt may still be up).
      call.status.set('loading');
      let h = band();
      const joining = Array.from(h.querySelectorAll('[role="status"]')).find((r) => r.textContent?.includes('Connecting to the consultation…'));
      expect(joining).toBeDefined();
      expect(button(h, 'Mute')).toBeNull();
      expect(button(h, 'End consultation')).toBeNull();

      // The join failed (camera denied, or refused for the doctor's standing): its alert and both ways out.
      call.errorMessage.set('Your account is suspended.');
      call.joinStanding.set('doctor_suspended');
      call.status.set('error');
      h = band();
      expect(bandText(h)).not.toContain('Connecting to the consultation…');
      const failed = Array.from(h.querySelectorAll('[role="alert"]')).find((a) => a.textContent?.includes('Your account is suspended.'));
      expect(failed).toBeDefined();
      expect(button(h, 'Mute')).toBeNull();
      const leave = vi.spyOn(call, 'leave').mockResolvedValue(undefined);
      const standing = vi.spyOn(call, 'openStanding').mockResolvedValue(undefined);
      button(h, 'See your account status')?.click();
      button(h, 'Back to schedule')?.click();
      expect(standing).toHaveBeenCalledTimes(1);
      expect(leave).toHaveBeenCalledWith('schedule');
    });

    it('signing out of the portal and leaving close the viewer; the API closing the call does not', async () => {
      await setup([doc('a')]);
      el.querySelector<HTMLButtonElement>('[data-doc-id="a"]')?.click();
      call.callClosed.set('This consultation was cancelled.');
      await tick();
      expect(viewer.close).not.toHaveBeenCalled();
      expect(viewer.session()).not.toBeNull();
      signedIn.set(false);
      await tick();
      expect(viewer.close).toHaveBeenCalledTimes(1);
      expect(viewer.session()).toBeNull();
      signedIn.set(true);
      await tick();
      el.querySelector<HTMLButtonElement>('[data-doc-id="a"]')?.click();
      expect(viewer.session()).not.toBeNull();
      await teardown();
      await tick();
      expect(viewer.session()).toBeNull();
    });

    it('stopSharing only stops a share that is on (never starts one)', async () => {
      await setup([doc('a')]);
      ctx().stopSharing();
      expect(agora.module.createScreenVideoTrack).not.toHaveBeenCalled();
    });
  });

  describe('the consultation workspace', () => {
    /** A remote video track that logs where it plays and when it stops. */
    const log: string[] = [];
    const where = (el: HTMLElement) => (el.closest('.ws-pip') ? 'workspace' : el.closest('[data-viewer-pip]') ? 'viewer' : 'stage');
    const fakeTrack = (name: string) => ({
      name,
      play: vi.fn((e: HTMLElement) => log.push(`play:${name}:${where(e)}`)),
      stop: vi.fn(() => log.push(`stop:${name}`)),
    });
    const launcher = (key: string) => el.querySelector<HTMLButtonElement>(`[data-ws-launcher="${key}"]`);
    const wsDialog = () => el.querySelector<HTMLDialogElement>('dialog.sd-dialog--viewer');
    /** The page's component CSS: jsdom has no layout, the real render checks what these rules do. */
    const callStyles = () => (DoctorCall as unknown as { ɵcmp: { styles: string[] } }).ɵcmp.styles.join('');
    const internals = () =>
      call as unknown as CallInternals & {
        wsOpen: WritableSignal<boolean>;
        wsTab: WritableSignal<string>;
        noteSaved: WritableSignal<string>;
        subjective: WritableSignal<string>;
        copilotDraft: WritableSignal<unknown>;
        recordRevealed: WritableSignal<boolean>;
        recordsTab: WritableSignal<string>;
        setNoteStatus(text: string, issue?: string): void;
        openWorkspace(tab: string, opener?: EventTarget | null): void;
        closeWorkspace(): void;
        backToCall(): void;
        canLeave(): boolean | Promise<boolean>;
        toggleScreen(): Promise<void>;
        teardown(): Promise<void>;
        remoteList: WritableSignal<Array<{ uid: number; hasVideo: boolean; hasAudio: boolean; speaking: boolean }>>;
        freshRoster: WritableSignal<unknown>;
        referrals: WritableSignal<unknown[]>;
        docAlert: WritableSignal<unknown>;
        sortedDocs(): DoctorSharedDocumentDto[];
        endOpen: WritableSignal<boolean>;
        openRxComposer(): void;
        selectWorkspaceTab(key: string, targetId?: string): void;
      };
    const patientJoins = async (track = fakeTrack('v1')) => {
      client().remoteUsers = [{ uid: 1, videoTrack: track }];
      await client().handlers['user-joined']?.({ uid: 1 });
      await client().handlers['user-published']?.({ uid: 1, videoTrack: track }, 'video');
      await tick();
      return track;
    };
    /** Opens it through its launcher and lets the timers and renders settle. */
    const openWs = async (key = 'notes') => {
      launcher(key)?.click();
      await tick();
      await tick();
    };
    const closeIt = async () => {
      internals().closeWorkspace();
      await tick();
      await tick();
    };
    const esc = (target: Element | null) => target?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

    beforeEach(() => {
      log.length = 0;
    });

    afterEach(() => {
      localStorage.removeItem('videomed.call.theme');
    });

    describe('pills in the panels (item 5, LD2)', () => {
      it('the look-alike buttons are C pills that keep their colours; the panel chips take the cockpit tones', async () => {
        media(['(min-width: 1024px)']);
        await setup();
        await openWs('notes');
        const byText = (t: string) =>
          Array.from(el.querySelectorAll<HTMLButtonElement>('#ws-panel-notes button')).find((b) => b.textContent?.includes(t));
        const finalize = byText('Finalize & sign');
        expect(finalize?.className).toBe('sd-pill sd-pill-c bg-cerulean text-white hover:bg-cerulean-dark');
        const draft = Array.from(el.querySelectorAll('#ws-panel-notes .sd-chip')).find((c) => c.textContent?.trim() === 'Draft');
        expect(draft?.className).toBe('sd-chip sd-tone-neutral');
        const tools = el.querySelector('#ws-panel-notes [role="group"][aria-labelledby="call-tools-label"]');
        expect(tools?.classList.contains('sd-pill-row-wrap')).toBe(true);
        for (const b of Array.from(tools?.querySelectorAll('button') ?? [])) {
          expect(b.className).toBe('sd-pill sd-pill-c sd-action');
        }
        // No field-radius button of 26-32px is left in the panels (they would render as accidental pills).
        const lookAlike = Array.from(el.querySelectorAll<HTMLElement>('[sdWsPanel] button, [sdwspanel] button')).filter(
          (b) => b.classList.contains('rounded-field') && /\bpy-(1|1\.5)\b/.test(b.className) && !b.classList.contains('call-row-btn'),
        );
        expect(lookAlike).toEqual([]);
      });

      it('the transcription toggle stops on the danger tone (no text-alert on its tint)', async () => {
        media(['(min-width: 1024px)']);
        await setup();
        await openWs('copilot');
        const toggle = Array.from(el.querySelectorAll<HTMLButtonElement>('#ws-panel-copilot button')).find((b) => /transcription/.test(b.textContent ?? ''));
        expect(toggle?.classList.contains('sd-pill')).toBe(true);
        expect(toggle?.classList.contains('sd-pill-c')).toBe(true);
        expect(toggle?.className).toContain('bg-cerulean');
        (call as unknown as { transcribing: WritableSignal<boolean> }).transcribing.set(true);
        await tick();
        expect(toggle?.className).toContain('text-(--sd-tone-danger-fg)');
        expect(toggle?.className).not.toMatch(/(^|\s)text-alert(\s|$)/);
      });
    });

    describe('launchers', () => {
      it('five in the card, plus View Full EMR, each opening its tab; no tool content while closed; window.open never', async () => {
        const opened = vi.spyOn(window, 'open').mockImplementation(() => null);
        await setup([doc('a')]);
        const buttons = Array.from(el.querySelectorAll<HTMLButtonElement>('#call-tools [data-ws-launcher]'));
        expect(buttons.map((b) => b.textContent?.trim())).toEqual(['Consultation Notes', 'Prescriptions', 'Lab requests', 'Follow-ups', 'Transcript & AI']);
        expect(buttons.every((b) => b.getAttribute('aria-haspopup') === 'dialog')).toBe(true);
        expect(launcher('record')?.textContent).toContain('View Full EMR');
        expect(launcher('record')?.getAttribute('aria-haspopup')).toBe('dialog');
        expect(el.querySelector('textarea, doc-rx-panel, doc-call-lab-requests')).toBeNull();
        for (const key of ['notes', 'prescriptions', 'labs', 'followup', 'copilot', 'record']) {
          await openWs(key);
          expect(internals().wsTab()).toBe(key);
          expect(el.querySelector('#ws-tab-' + key)?.getAttribute('aria-selected')).toBe('true');
          await closeIt();
        }
        expect(opened).not.toHaveBeenCalled();
        opened.mockRestore();
      });

      it('statuses come from typed state, never the words', async () => {
        await setup([doc('a')]);
        await tick();
        internals().setNoteStatus('Save failed — retry', 'failed');
        await tick();
        expect(launcher('notes')?.textContent).toContain('Not saved');
        expect(launcher('notes')?.textContent).toContain('open the note to retry');
        internals().setNoteStatus('Saved');
        // Only the words: no status.
        internals().noteSaved.set('Save failed — retry');
        await tick();
        expect(launcher('notes')?.textContent).not.toContain('Not saved');
        internals().copilotDraft.set({ diagnoses: [], medications: [] });
        await tick();
        expect(launcher('copilot')?.textContent).toContain('Draft ready');
      });

      it('the shared shell (sd-call-workspace) hosts the panels; the shared launcher list (sd-call-launchers) is the card, its CSS gone from the page', async () => {
        await setup([doc('a')]);
        expect(el.querySelector('sd-call-workspace')).not.toBeNull();
        expect(el.querySelector('doc-call-workspace')).toBeNull();
        expect(el.querySelector('#call-tools sd-call-launchers')).not.toBeNull();
        expect(el.querySelectorAll('#call-tools sd-call-launchers ul.ws-launchers > li > button.ws-launcher[data-ws-launcher]').length).toBe(5);
        expect(el.querySelector('#call-tools sd-call-launchers')?.getAttribute('data-tone')).toBe('dark');
        // A status line only where there is a status (its height reserved otherwise: item 3).
        expect(el.querySelectorAll('#call-tools .ws-launcher-status').length).toBe(el.querySelectorAll('#call-tools .ws-launcher-text:not(.ws-launcher-text--bare)').length);
        // The page keeps only its own rules (the launcher CSS lives in the shared component).
        expect(callStyles()).not.toContain('.ws-launchers');
        expect(callStyles()).not.toContain('.ws-launcher-status');
        expect(callStyles()).not.toContain('container: tools');
        expect(callStyles()).toMatch(/\.ws-ring\S*:focus-visible/);
        expect(callStyles()).toMatch(/\.ws-tools-start/);
        expect(callStyles()).toMatch(/\.ws-transcript/);
        await openWs('prescriptions');
        expect(el.querySelector('sd-call-workspace dialog.sd-dialog--viewer #ws-panel-prescriptions')).not.toBeNull();
        expect(el.querySelector('dialog.sd-dialog--viewer [role="tablist"]')?.getAttribute('aria-label')).toBe('Consultation tools');
        await closeIt();
      });
    });

    it('narrow: the switcher reads Tools · Patient · Documents · People, Tools’ panel the launcher card', async () => {
      await setup([doc('a')]);
      const tabs = Array.from(el.querySelectorAll('[role="tablist"][aria-label="Sections"] [role="tab"]')).map((t) => t.textContent?.trim());
      expect(tabs).toEqual(['Tools', 'Patient', 'Documents', 'People']);
      const tools = el.querySelector('#call-section-notes');
      expect(tools?.getAttribute('aria-controls')).toBe('call-tools');
      expect(el.querySelector('#call-tools')?.getAttribute('aria-labelledby')).toBe('call-section-notes');
      expect(el.querySelector('#call-tools')?.getAttribute('role')).toBe('tabpanel');
    });

    it('narrow: room under the launcher card, so the fixed Feedback button never sits on a launcher', async () => {
      await setup([doc('a')]);
      expect(el.querySelector('#call-tools')?.classList.contains('ws-tools-narrow')).toBe(true);
      expect(callStyles()).toMatch(/\.ws-tools-narrow[^{]*\{[^}]*margin-bottom/);
    });

    it('no patient id, the look-up failed: the Full EMR shows it and its Try again re-runs the look-up, as the Prescriptions tab', async () => {
      await setup([doc('a')]);
      await openWs('record');
      const c = internals() as unknown as {
        rxPatientId: () => string | null;
        rxPatientError: WritableSignal<string>;
        lookedUpPatientId: WritableSignal<string | null>;
        info: WritableSignal<{ patient?: { id?: string } } | null>;
      };
      const api = TestBed.inject(DoctorApi) as unknown as { appointment: () => Observable<unknown> };
      const working = api.appointment;
      api.appointment = () => throwError(() => new Error('boom'));
      const info = c.info();
      c.info.set({ ...info, patient: { ...info?.patient, id: '' } });
      c.lookedUpPatientId.set(null);
      await tick();
      expect(c.rxPatientId()).toBeFalsy();
      const panel = el.querySelector('#ws-panel-record');
      expect(panel?.querySelector('[role="alert"]')?.textContent).toContain('boom');
      expect(panel?.textContent).not.toContain('Loading the patient…');
      api.appointment = working;
      Array.from(panel?.querySelectorAll('button') ?? []).find((b) => b.textContent?.includes('Try again'))?.click();
      await tick();
      expect(c.rxPatientError()).toBe('');
      expect(c.lookedUpPatientId()).toBe('p1');
    });

    it('the join failed with no details: the Full EMR says so instead of loading for ever', async () => {
      await setup([doc('a')]);
      await openWs('record');
      const c = internals() as unknown as { info: WritableSignal<unknown>; lookedUpPatientId: WritableSignal<string | null> };
      c.info.set(null);
      c.lookedUpPatientId.set(null);
      internals().status.set('error');
      await tick();
      const panel = el.querySelector('#ws-panel-record');
      expect(panel?.textContent).toContain(WS_EMR_NO_DETAILS);
      expect(panel?.textContent).not.toContain('Loading the patient…');
    });

    it('no lost drafts: typed, closed with Esc, the autosave fires anyway; reopened, the same field with the text', async () => {
      await setup([doc('a')]);
      await tick();
      await openWs('notes');
      const field = el.querySelector<HTMLTextAreaElement>('#ws-panel-notes textarea');
      if (!field) throw new Error('no field');
      field.value = 'Headache for 3 days';
      field.dispatchEvent(new Event('input'));
      await tick();
      esc(field);
      await tick();
      expect(internals().wsOpen()).toBe(false);
      expect(el.querySelector('#ws-panel-notes')).toBeNull();
      portal = [];
      await tick(1300);
      expect(portal.some((r) => r.method === 'PUT' && r.path.endsWith('/note'))).toBe(true);
      await openWs('notes');
      const again = el.querySelector<HTMLTextAreaElement>('#ws-panel-notes textarea');
      expect(again).toBe(field);
      expect(again?.value).toBe('Headache for 3 days');
      // And across a tab switch.
      el.querySelector<HTMLButtonElement>('#ws-tab-labs')?.click();
      await tick();
      el.querySelector<HTMLButtonElement>('#ws-tab-notes')?.click();
      await tick();
      expect(el.querySelector('#ws-panel-notes textarea')).toBe(field);
    });

    it('a half-written prescription: closing asks nothing, the launcher and the tab say so, the same composer comes back; End and canLeave ask', async () => {
      const confirmLeave = vi.fn(async () => true);
      await setup([doc('a')]);
      TestBed.inject(DialogService).confirmLeave = confirmLeave as never;
      await openWs('prescriptions');
      const panel = fixture.debugElement.query(By.directive(RxPanel)).componentInstance as RxPanel;
      Array.from(el.querySelectorAll<HTMLButtonElement>('#ws-panel-prescriptions button')).find((b) => b.textContent?.includes('New prescription'))?.click();
      await tick();
      await tick();
      const field = el.querySelector<HTMLTextAreaElement>('#ws-panel-prescriptions doc-rx-composer textarea');
      if (!field) throw new Error('no composer field');
      field.value = 'Asthma flare';
      field.dispatchEvent(new Event('input'));
      await tick();
      expect(panel.hasUnsavedChanges()).toBe(true);
      expect(el.querySelector('#ws-tab-prescriptions')?.textContent).toContain(', unsaved changes');
      await closeIt();
      expect(confirmLeave).not.toHaveBeenCalled();
      expect(internals().wsOpen()).toBe(false);
      // Its name: the label, then the status, the rest for screen readers.
      expect(launcher('prescriptions')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Prescriptions, Unsaved changes');
      await openWs('prescriptions');
      expect(fixture.debugElement.query(By.directive(RxPanel)).componentInstance).toBe(panel);
      expect(el.querySelector('#ws-panel-prescriptions doc-rx-composer textarea')).toBe(field);
      expect(field.value).toBe('Asthma flare');
      await closeIt();
      await call.askEnd();
      expect(confirmLeave).toHaveBeenCalledTimes(1);
      await internals().canLeave();
      expect(confirmLeave).toHaveBeenCalledTimes(2);
    });

    describe('one live tile (the real CallPeerTileComponent)', () => {
      it('stage → workspace → viewer → workspace → stage: every hand-over a stop before a play', async () => {
        await setup([doc('a')]);
        const track = await patientJoins();
        expect(log).toEqual(['play:v1:stage']);
        log.length = 0;
        await openWs('notes');
        expect(log).toEqual(['stop:v1', 'play:v1:workspace']);
        expect(el.querySelector('.ws-pip sd-call-peer-tile')).not.toBeNull();
        expect(el.querySelectorAll('sd-call-peer-tile').length).toBe(1);

        log.length = 0;
        // A document from the workspace: its tile goes with the render (the fake viewer has no tile of its own here).
        el.querySelector<HTMLElement>('[data-doc-id="a"]')?.click();
        await tick();
        expect(log).toEqual(['stop:v1']);
        expect(call.peer.holder()).toBe('viewer');
        expect(call.peer.track()).toBe(track);
        expect(el.querySelector('.ws-pip sd-call-peer-tile')).toBeNull();
        expect(el.querySelector('.ws-pip .ws-peer-wait')).not.toBeNull();

        log.length = 0;
        viewer.close();
        await tick();
        expect(call.peer.holder()).toBe('workspace');
        expect(log).toEqual(['play:v1:workspace']);

        log.length = 0;
        const stage = fixture.debugElement.query(By.directive(CallTilesComponent)).componentInstance as CallTilesComponent;
        const attach = vi.spyOn(stage, 'attach');
        await closeIt();
        expect(log).toEqual(['stop:v1', 'play:v1:stage']);
        expect(call.peer.holder()).toBe('stage');
        expect(attach).toHaveBeenCalledTimes(1);
      });

      it('close and reopen in one turn: the stage never plays', async () => {
        await setup([doc('a')]);
        await patientJoins();
        await openWs('notes');
        log.length = 0;
        internals().closeWorkspace();
        internals().openWorkspace('notes');
        await tick();
        await tick();
        expect(log.some((l) => l.endsWith(':stage'))).toBe(false);
        expect(call.peer.holder()).toBe('workspace');
      });

      it('a rejoin while held: the tile gets nothing (initials), then the re-published track; the stage never the patient', async () => {
        await setup([doc('a')]);
        await patientJoins();
        await openWs('notes');
        const stage = fixture.debugElement.query(By.directive(CallTilesComponent)).componentInstance as CallTilesComponent;
        const attach = vi.spyOn(stage, 'attach');
        log.length = 0;
        const rejoined = call.rejoin();
        await tick();
        await rejoined;
        await tick();
        expect(call.peer.track()).toBeNull();
        expect(log).toEqual(['stop:v1']);
        const back = fakeTrack('v2');
        client().remoteUsers = [{ uid: 1, videoTrack: back }];
        await client().handlers['user-published']?.({ uid: 1, videoTrack: back }, 'video');
        await tick();
        expect(log).toEqual(['stop:v1', 'play:v2:workspace']);
        expect(attach).not.toHaveBeenCalledWith(1, expect.anything());
      });

      it('the patient leaves while held: initials, and the band says so', async () => {
        await setup([doc('a')]);
        await patientJoins();
        await openWs('notes');
        client().remoteUsers = [];
        await client().handlers['user-left']?.({ uid: 1 });
        await tick();
        expect(call.peer.track()).toBeNull();
        expect(el.querySelector('.ws-band')?.textContent).toContain('Bola Ade left the call');
      });
    });

    describe('Esc and focus', () => {
      it('Esc closes the workspace only (the call goes on); focus on the launcher', async () => {
        await setup([doc('a')]);
        launcher('labs')?.focus();
        await openWs('labs');
        expect(document.activeElement?.id).toBe('ws-tab-labs');
        esc(document.activeElement);
        await tick();
        await tick();
        expect(internals().wsOpen()).toBe(false);
        expect(call.status()).toBe('in-call');
        expect(client().leave).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(launcher('labs'));
      });

      it('over the viewer the workspace stays on its tab; Esc then closes it', async () => {
        await setup([doc('a')]);
        await openWs('record');
        el.querySelector<HTMLElement>('[data-doc-id="a"]')?.click();
        await tick();
        viewer.close();
        await tick();
        expect(internals().wsOpen()).toBe(true);
        expect(internals().wsTab()).toBe('record');
      });

      it('an opener gone after the viewer closes: over the workspace, its selected tab', async () => {
        await setup([doc('a')]);
        await openWs('labs');
        el.querySelector<HTMLElement>('[data-doc-id="a"]')?.click();
        const [, options] = viewer.open.mock.calls[0] as [ViewerSource[], ViewerOpenOptions];
        expect(options.fallbackFocus?.()?.id).toBe('ws-tab-labs');
      });
    });

    describe('Back to call', () => {
      const back = () => Array.from(el.querySelectorAll<HTMLButtonElement>('.ws-band [aria-label="Back to call"]'))[0];

      it('from the workspace’s band: closed', async () => {
        await setup([doc('a')]);
        await openWs('notes');
        back()?.click();
        await tick();
        expect(internals().wsOpen()).toBe(false);
      });

      it('with the viewer over it: both closed, then one stage play', async () => {
        await setup([doc('a')]);
        await patientJoins();
        await openWs('notes');
        el.querySelector<HTMLElement>('[data-doc-id="a"]')?.click();
        await tick();
        log.length = 0;
        internals().backToCall();
        await tick();
        await tick();
        expect(internals().wsOpen()).toBe(false);
        expect(viewer.session()).toBeNull();
        expect(call.peer.holder()).toBe('stage');
        expect(log).toEqual(['play:v1:stage']);
      });

      it('over a tool’s own dialog: only the viewer goes; the workspace closes once that dialog has', async () => {
        await setup([doc('a')]);
        await openWs('prescriptions');
        const stand = document.createElement('dialog');
        stand.setAttribute('open', '');
        el.querySelector('#ws-panel-prescriptions')?.appendChild(stand);
        el.querySelector<HTMLElement>('[data-doc-id="a"]')?.click();
        await tick();
        internals().backToCall();
        await tick();
        expect(viewer.session()).toBeNull();
        expect(internals().wsOpen()).toBe(true);
        // Nor does anything else close it under that dialog.
        internals().closeWorkspace();
        expect(internals().wsOpen()).toBe(true);
        stand.removeAttribute('open');
        stand.remove();
        internals().backToCall();
        expect(internals().wsOpen()).toBe(false);
        await tick();
        await tick();
        expect(document.documentElement.style.overflow).not.toBe('hidden');
      });
    });

    describe('sharing the screen', () => {
      it('a banner on the tool tabs (Stop sharing only when on), the Full EMR covered; Show anyway reveals and says so; stopping forgets it', async () => {
        await setup([doc('a')]);
        await openWs('notes');
        const screen = { kind: 'video', enabled: true, play: vi.fn(), stop: vi.fn(), close: vi.fn(), on: vi.fn(), setEnabled: vi.fn(async () => undefined) };
        agora.module.createScreenVideoTrack.mockResolvedValueOnce(screen);
        await internals().toggleScreen();
        await tick();
        expect(call.screenOn()).toBe(true);
        const banner = () => el.querySelector('.ws-share');
        expect(banner()?.textContent).toContain(wsShareBanner(false));
        el.querySelector<HTMLButtonElement>('#ws-tab-record')?.click();
        await tick();
        // Its own cover says it: no banner over it.
        expect(banner()).toBeNull();
        const panel = () => el.querySelector('#ws-panel-record');
        expect(panel()?.textContent).toContain('Hidden while you share your screen');
        const inner = panel()?.querySelector('doc-call-patient-record')?.parentElement;
        expect(inner?.hidden).toBe(true);
        const anyway = Array.from(panel()?.querySelectorAll('button') ?? []).find((b) => b.textContent?.includes('Show anyway'));
        anyway?.click();
        await tick(100);
        expect(inner?.hidden).toBe(false);
        expect(banner()?.textContent).toContain(wsShareBanner(false));
        expect(call.docAnnounce()).toBe(WS_RECORD_SHOWN);
        // Closing forgets it: reopened while still sharing, covered again.
        await closeIt();
        await openWs('record');
        expect(panel()?.textContent).toContain('Hidden while you share your screen');
        Array.from(panel()?.querySelectorAll('button') ?? []).find((b) => b.textContent?.includes('Show anyway'))?.click();
        await tick();
        expect(internals().recordRevealed()).toBe(true);
        // Stopping sharing forgets it too, and takes the banner away.
        call.screenOn.set(false);
        await tick();
        expect(internals().recordRevealed()).toBe(false);
        expect(banner()).toBeNull();
      });

      it('Stop sharing never starts a share', async () => {
        await setup([doc('a')]);
        agora.module.createScreenVideoTrack.mockClear();
        const c = call as unknown as { stopSharingFromWorkspace(): void };
        c.stopSharingFromWorkspace();
        expect(agora.module.createScreenVideoTrack).not.toHaveBeenCalled();
      });
    });

    it('teardown closes the workspace and the viewer; nothing attaches to the stage after', async () => {
      await setup([doc('a')]);
      await patientJoins();
      await openWs('notes');
      el.querySelector<HTMLElement>('[data-doc-id="a"]')?.click();
      await tick();
      const stage = fixture.debugElement.query(By.directive(CallTilesComponent)).componentInstance as CallTilesComponent;
      const attach = vi.spyOn(stage, 'attach');
      await internals().teardown();
      await tick();
      await tick();
      expect(internals().wsOpen()).toBe(false);
      expect(viewer.session()).toBeNull();
      expect(attach).not.toHaveBeenCalled();
    });

    it('signing out while open: the workspace stays, the EMR asks to sign in and has dropped its data, the viewer closed', async () => {
      await setup([doc('a')]);
      await openWs('record');
      await tick();
      expect(el.querySelector('#ws-panel-record')?.textContent).toContain('bola@example.test');
      el.querySelector<HTMLElement>('[data-doc-id="a"]')?.click();
      await tick();
      signedIn.set(false);
      await tick();
      await tick();
      expect(internals().wsOpen()).toBe(true);
      expect(viewer.session()).toBeNull();
      const text = el.querySelector('#ws-panel-record')?.textContent ?? '';
      expect(text).not.toContain('bola@example.test');
      expect(text).toContain('Sign in to the doctor portal');
    });

    describe('quick tools move focus', () => {
      const tool = (label: string) => Array.from(el.querySelectorAll<HTMLButtonElement>('#ws-panel-notes button')).find((b) => b.textContent?.trim() === label);

      it('ePrescription: the Prescriptions tab', async () => {
        await setup([doc('a')]);
        await openWs('notes');
        tool('ePrescription')?.focus();
        tool('ePrescription')?.click();
        await tick();
        expect(document.activeElement?.id).toBe('ws-tab-prescriptions');
      });

      it('Referral: the Follow-ups tab, #call-referral scrolled into view, focus on its heading', async () => {
        await setup([doc('a')]);
        await openWs('notes');
        const spy = vi.fn();
        const scroll = Element.prototype.scrollIntoView;
        Element.prototype.scrollIntoView = spy;
        try {
          tool('Referral')?.click();
          await tick();
          await tick();
          expect(internals().wsTab()).toBe('followup');
          expect(spy).toHaveBeenCalled();
          expect(document.activeElement?.closest('#call-referral')).not.toBeNull();
          expect(document.activeElement?.hasAttribute('data-ws-focus')).toBe(true);
          expect(document.activeElement?.closest('[hidden]')).toBeNull();
        } finally {
          Element.prototype.scrollIntoView = scroll;
        }
      });

      it('Use in SOAP note: the Consultation Notes tab', async () => {
        await setup([doc('a')]);
        await tick();
        internals().copilotDraft.set({ diagnoses: [], medications: [], assessment: 'A', plan: 'P' });
        await openWs('copilot');
        const use = Array.from(el.querySelectorAll<HTMLButtonElement>('#ws-panel-copilot button')).find((b) => b.textContent?.includes('Use in SOAP note'));
        expect(use).toBeTruthy();
        expect(use?.disabled).toBe(false);
        use?.focus();
        use?.click();
        await tick();
        await tick();
        expect(internals().wsTab()).toBe('notes');
        expect(document.activeElement?.id).toBe('ws-tab-notes');
      });
    });

    it('Esc in the Follow-ups withdraw confirm closes the confirm; the workspace stays', async () => {
      vi.stubGlobal('CSS', { escape: (id: string) => id });
      await setup([doc('a')]);
      followUps = [
        {
          id: 'f1',
          patient_id: 'p1',
          patient_name: 'Bola Ade',
          specialist: { id: 'd1', name: 'Dr Ada Obi' },
          scheduled_at: '2026-12-01T10:00:00Z',
          expires_at: '2026-11-20T10:00:00Z',
          type: 'video',
          type_label: 'Video follow-up',
          status: 'proposed',
          status_label: 'Proposed',
          amount: '0',
          proposed_by: 'doctor',
          created_at: '2026-11-01T10:00:00Z',
        },
      ];
      await openWs('followup');
      await tick();
      const withdraw = Array.from(el.querySelectorAll<HTMLButtonElement>('#ws-panel-followup button')).find((b) => /withdraw/i.test(b.textContent ?? ''));
      withdraw?.click();
      await tick();
      const group = el.querySelector('#ws-panel-followup [role="group"]');
      expect(group?.textContent).toContain('Withdraw this proposal?');
      esc(group?.querySelector('p') ?? null);
      await tick();
      expect(el.querySelector('#ws-panel-followup [role="group"]')?.textContent ?? '').not.toContain('Withdraw this proposal?');
      expect(internals().wsOpen()).toBe(true);
    });

    it('Follow-ups: a referral’s View PDF opens it in the viewer, Print only', async () => {
      await setup([doc('a')]);
      await tick();
      internals().referrals.set([{ id: 'r1', referral_type: 'specialist', target: 'Cardiology', reason: 'Palpitations', priority: 'routine', created_at: '2026-11-01T10:00:00Z' }]);
      await openWs('followup');
      el.querySelector<HTMLButtonElement>('[aria-label="View PDF of the referral to Cardiology"]')?.click();
      expect(viewer.open).toHaveBeenCalledTimes(1);
      const [source] = viewer.open.mock.calls[0] as [ViewerSource];
      expect(source.key).toBe('referral:r1');
      expect(source.policy).toBe('authored_print');
    });

    describe('Follow-ups fields', () => {
      const panel = () => el.querySelector('#ws-panel-followup') as HTMLElement;
      const field = <T extends HTMLElement>(id: string) => panel().querySelector<T>('#' + id) as T;
      /** A field's visible label, without the aria-hidden required mark. */
      const labelOf = (id: string) => {
        const label = (field<HTMLInputElement>(id).labels?.[0]?.cloneNode(true) ?? null) as HTMLElement | null;
        label?.querySelectorAll('[aria-hidden="true"]').forEach((m) => m.remove());
        return label?.textContent?.trim();
      };
      const button = (label: string) => Array.from(panel().querySelectorAll('button')).find((b) => b.textContent?.includes(label)) as HTMLButtonElement;
      const set = (id: string, value: string, event: 'input' | 'change') => {
        const f = field<HTMLInputElement>(id);
        f.value = value;
        f.dispatchEvent(new Event(event, { bubbles: true }));
      };

      it('every field is labelled, the required ones marked; the leave dates are a group; the sections are h3 headings', async () => {
        await setup([doc('a')]);
        await openWs('followup');
        expect(panel().querySelectorAll('option').length).toBe(9);
        // NP1: the lists are painted by the theme's Canvas/CanvasText rule, never by option classes.
        expect(Array.from(panel().querySelectorAll('option')).filter((o) => o.hasAttribute('class'))).toEqual([]);
        expect(['call-ref-type', 'call-ref-priority', 'call-cert-type'].map((id) => field(id).tagName + ' ' + labelOf(id))).toEqual([
          'SELECT Referral type',
          'SELECT Priority',
          'SELECT Certificate type',
        ]);
        expect(['call-ref-target', 'call-ref-reason', 'call-cert-diagnosis', 'call-cert-statement'].map(labelOf)).toEqual([
          'Refer to',
          'Reason for referral',
          'Diagnosis (optional)',
          'Certifying statement',
        ]);
        for (const id of ['call-ref-target', 'call-ref-reason', 'call-cert-statement']) expect(field(id).getAttribute('aria-required')).toBe('true');
        expect(field('call-cert-diagnosis').hasAttribute('aria-required')).toBe(false);
        // The asterisk is decoration: the attribute says "required".
        expect(field<HTMLInputElement>('call-ref-target').labels?.[0]?.querySelector('[aria-hidden="true"]')?.textContent).toBe('*');
        const dates = Array.from(panel().querySelectorAll<HTMLInputElement>('input[type="date"]'));
        expect(dates.length).toBe(2);
        const group = dates[0].closest('fieldset');
        expect(group?.querySelector('legend')?.textContent?.trim().startsWith('Leave period')).toBe(true);
        expect(dates.every((d) => d.closest('fieldset') === group && d.getAttribute('aria-required') === 'true')).toBe(true);
        expect(dates.map((d) => d.closest('label')?.querySelector('span')?.textContent?.trim())).toEqual(['From', 'To']);
        const items = Array.from(panel().querySelectorAll<HTMLInputElement>('input[placeholder="e.g. Monitor blood pressure daily"]'));
        expect(items.length).toBeGreaterThan(0);
        expect(items.map((i) => i.getAttribute('aria-label'))).toEqual(items.map((_, n) => `Care plan item ${n + 1}`));
        const headings = Array.from(panel().querySelectorAll('h3')).map((h) => h.textContent?.trim());
        expect(headings).toEqual(expect.arrayContaining(['Care Plan', 'Referral', 'Medical Certificate']));
        for (const id of ['call-referral', 'call-certificate']) {
          const h = panel().querySelector(`#${id} > h3`);
          expect(h?.hasAttribute('data-ws-focus')).toBe(true);
          expect(h?.getAttribute('tabindex')).toBe('-1');
        }
      });

      it('the fields: the call-field box and ws-ring, no dimming or placeholder utilities; drawn chevrons; container columns', async () => {
        await setup([doc('a')]);
        await openWs('followup');
        const fields = Array.from(panel().querySelectorAll<HTMLElement>('.call-field'));
        // 3 selects, 4 text fields, the 2 dates, at least one Care Plan item.
        expect(fields.length).toBeGreaterThanOrEqual(10);
        for (const f of fields) {
          const cls = Array.from(f.classList);
          expect(cls.filter((c) => c.startsWith('read-only:') || c.startsWith('placeholder:') || c.includes('opacity') || c === 'focus:outline-none')).toEqual([]);
          expect(cls).toContain('ws-ring');
        }
        for (const id of ['call-ref-type', 'call-ref-priority', 'call-cert-type']) {
          const s = field<HTMLSelectElement>(id);
          for (const c of ['block', 'appearance-none', 'call-field', 'ws-ring']) expect(s.classList.contains(c)).toBe(true);
          const chevron = s.nextElementSibling;
          expect(chevron?.matches('sd-icon[name="chevron-down"][aria-hidden="true"]')).toBe(true);
        }
        for (const id of ['call-referral', 'call-certificate']) {
          const section = panel().querySelector(`#${id}`) as HTMLElement;
          expect(section.classList.contains('@container')).toBe(true);
          const grid = section.querySelector(':scope > .grid') as HTMLElement;
          expect(grid.classList.contains('@md:grid-cols-2')).toBe(true);
          expect(section.querySelector('.sm\\:grid-cols-2')).toBeNull();
        }
        expect(button('Create referral').classList.contains('call-row-btn')).toBe(true);
        expect(button('Issue certificate').classList.contains('call-row-btn')).toBe(true);
        const css = callStyles().replace(/\s+/g, '');
        for (const s of ['.call-field', 'min-height:38px', '::placeholder', ':read-only:not(select)', '.call-error', '#ff8a80', 'var(--color-alert-ink)', '.call-row-btn']) {
          expect(css).toContain(s);
        }
      });

      it('empty required fields: an announced error naming them by their labels, and nothing sent', async () => {
        await setup([doc('a')]);
        await openWs('followup');
        portal = [];
        button('Create referral').click();
        await tick();
        const refAlert = panel().querySelector('#call-referral p[role="alert"].call-error');
        expect(refAlert?.textContent?.trim()).toBe('Add who to refer to and the reason for referral.');
        button('Issue certificate').click();
        await tick();
        const certAlert = panel().querySelector('#call-certificate p[role="alert"].call-error');
        expect(certAlert?.textContent?.trim()).toBe('Add a certifying statement.');
        // The empty required fields are marked invalid and described by their section's error.
        for (const [id, err] of [['call-ref-target', 'call-ref-error'], ['call-ref-reason', 'call-ref-error'], ['call-cert-statement', 'call-cert-error']]) {
          const f = panel().querySelector(`#${id}`) as HTMLElement;
          expect(f.getAttribute('aria-invalid')).toBe('true');
          expect(f.getAttribute('aria-describedby')).toBe(err);
          expect(panel().querySelector(`#${err}`)?.getAttribute('role')).toBe('alert');
        }
        for (const d of Array.from(panel().querySelectorAll('#call-certificate input[type="date"]'))) {
          expect(d.getAttribute('aria-invalid')).toBe('true');
          expect(d.getAttribute('aria-describedby')).toBe('call-cert-error');
        }
        expect(panel().querySelector('#call-cert-diagnosis')?.hasAttribute('aria-invalid')).toBe(false);
        // Pressed again with the same gap: the same words, but a NEW alert element (a screen reader
        // announces an inserted alert; unchanged text in the old one would be silent). Only the form
        // pressed again is re-created: the other section's alert stays as it was.
        button('Create referral').click();
        await tick();
        const refAgain = panel().querySelector('#call-referral p[role="alert"].call-error');
        expect(refAgain?.textContent?.trim()).toBe('Add who to refer to and the reason for referral.');
        expect(refAgain).not.toBe(refAlert);
        expect(refAgain?.id).toBe('call-ref-error');
        expect(panel().querySelector('#call-certificate p[role="alert"].call-error')).toBe(certAlert);
        button('Issue certificate').click();
        await tick();
        const certAgain = panel().querySelector('#call-certificate p[role="alert"].call-error');
        expect(certAgain?.textContent?.trim()).toBe('Add a certifying statement.');
        expect(certAgain).not.toBe(certAlert);
        expect(panel().querySelectorAll('#call-cert-error')).toHaveLength(1);
        expect(portal.filter((r) => r.method === 'POST')).toEqual([]);
        expect(dialogConfirm).not.toHaveBeenCalled();
      });

      it('the chosen type and priority are what is sent; the priority resets to Routine afterwards', async () => {
        await setup([doc('a')]);
        await openWs('followup');
        set('call-ref-type', 'imaging', 'change');
        set('call-ref-priority', 'urgent', 'change');
        set('call-ref-target', 'Radiology', 'input');
        set('call-ref-reason', 'Chest X-ray', 'input');
        await tick();
        portal = [];
        button('Create referral').click();
        await tick();
        await tick();
        const post = portal.find((r) => r.method === 'POST' && r.path.endsWith('/referrals'));
        expect(post?.body).toMatchObject({ referral_type: 'imaging', priority: 'urgent', target: 'Radiology', reason: 'Chest X-ray' });
        expect(field<HTMLSelectElement>('call-ref-priority').value).toBe('routine');
      });

      it('the leave period shows for a sick-leave certificate only', async () => {
        await setup([doc('a')]);
        await openWs('followup');
        set('call-cert-type', 'general', 'change');
        await tick();
        expect(panel().querySelectorAll('#call-certificate input[type="date"]').length).toBe(0);
        expect(panel().querySelector('#call-certificate fieldset')).toBeNull();
        set('call-cert-type', 'sick_leave', 'change');
        await tick();
        expect(panel().querySelectorAll('#call-certificate fieldset input[type="date"]').length).toBe(2);
      });

      it('the planner in the call has no record link (LD6): the visit type shows in the row instead', async () => {
        vi.stubGlobal('CSS', { escape: (id: string) => id });
        const opened = vi.spyOn(window, 'open').mockImplementation(() => null);
        await setup([doc('a')]);
        followUps = [
          {
            id: 'f1',
            patient_id: 'p1',
            patient_name: 'Bola Ade',
            specialist: { id: 'd1', name: 'Dr Ada Obi' },
            scheduled_at: '2026-12-01T10:00:00Z',
            expires_at: '2026-11-20T10:00:00Z',
            type: 'video',
            type_label: 'Video follow-up',
            status: 'proposed',
            status_label: 'Proposed',
            amount: '0',
            proposed_by: 'doctor',
            created_at: '2026-11-01T10:00:00Z',
          },
        ];
        await openWs('followup');
        await tick();
        const planner = panel().querySelector('doc-follow-up-planner') as HTMLElement;
        expect(planner.querySelector('li')?.textContent).toContain('Video follow-up');
        expect(planner.querySelectorAll('a[target="_blank"], a[href]').length).toBe(0);
        expect(opened).not.toHaveBeenCalled();
        opened.mockRestore();
      });
    });

    describe('announcements in the band', () => {
      it('a new document: the band’s live region inside the dialog', async () => {
        await setup([doc('a')]);
        await openWs('notes');
        answer = () => of({ data: access([doc('b', { title: 'Lab report' }), doc('a')]) });
        call.loadDocumentAccess('refresh');
        await tick(100);
        const region = wsDialog()?.querySelector('.ws-band [aria-live="polite"]');
        expect(region?.textContent).toContain('Bola shared a new document');
        // The cockpit's copy is outside the dialog.
        const cockpit = Array.from(el.querySelectorAll('[aria-live="polite"]')).filter((p) => !p.closest('dialog') && p.textContent?.includes('Bola shared'));
        expect(cockpit.length).toBe(1);
      });

      it('joined, and a guest’s left; the patient’s left is said once, by its own line', async () => {
        await setup([doc('a')]);
        await openWs('notes');
        const live = () => Array.from(wsDialog()?.querySelectorAll('.ws-band .sr-only[role="status"]') ?? []).map((p) => p.textContent).join(' | ');
        const list = (...uids: number[]) => uids.map((uid) => ({ uid, hasVideo: false, hasAudio: true, speaking: false }));
        internals().freshRoster.set([
          { uid: 1, role: 'patient', name: 'Bola Ade' },
          { uid: 3, role: 'guest', name: 'Tunde', consented: true, id: 'g1' },
        ]);
        await tick();
        internals().remoteList.set(list(1));
        await tick();
        expect(live()).toContain('Bola Ade joined the call.');
        internals().remoteList.set(list(1, 3));
        await tick();
        expect(live()).toContain('Tunde joined the call.');
        internals().remoteList.set(list(1));
        await tick();
        expect(live()).toContain('Tunde left the call.');
        internals().remoteList.set(list());
        await tick();
        // Said by the band's own line; the presence note has not changed to a second copy.
        expect(live()).toContain('Bola Ade left the call');
        expect(live().match(/Bola Ade left the call/g)?.length).toBe(1);
      });

      it('the patient coming back is said again; no "joined" lingers beside their "left"', async () => {
        await setup([doc('a')]);
        await openWs('notes');
        const live = () => Array.from(wsDialog()?.querySelectorAll('.ws-band .sr-only[role="status"]') ?? []).map((p) => p.textContent).join(' | ');
        const list = (...uids: number[]) => uids.map((uid) => ({ uid, hasVideo: false, hasAudio: true, speaking: false }));
        internals().freshRoster.set([{ uid: 1, role: 'patient', name: 'Bola Ade' }]);
        await tick();
        for (let round = 0; round < 2; round++) {
          internals().remoteList.set(list(1));
          await tick();
          expect(live()).toContain('Bola Ade joined the call.');
          expect(live()).not.toContain('left the call');
          internals().remoteList.set(list());
          await tick();
          expect(live()).toContain('Bola Ade left the call');
          expect(live()).not.toContain('joined the call');
        }
      });

      it('the very same line again (back under a new uid in one tick) still changes the region, so it is read out', async () => {
        await setup([doc('a')]);
        await openWs('notes');
        const note = () => Array.from(wsDialog()?.querySelectorAll('.ws-band .sr-only[role="status"]') ?? []).find((p) => p.textContent?.includes('joined the call'));
        const list = (...uids: number[]) => uids.map((uid) => ({ uid, hasVideo: false, hasAudio: true, speaking: false }));
        internals().freshRoster.set([
          { uid: 1, role: 'patient', name: 'Bola Ade' },
          { uid: 4, role: 'patient', name: 'Bola Ade' },
        ]);
        await tick();
        internals().remoteList.set(list(1));
        await tick();
        const first = note()?.textContent;
        expect(first).toContain('Bola Ade joined the call.');
        internals().remoteList.set(list(4));
        await tick();
        expect(note()?.textContent).toContain('Bola Ade joined the call.');
        expect(note()?.textContent).not.toBe(first);
      });
    });

    it('labs: closed, a focus reads nothing; reopened, one active read; a focus then, a passive one', async () => {
      const list = vi.fn<(q: unknown, o?: { passive?: boolean }) => Observable<{ data: never[] }>>(() => of({ data: [] }));
      await setup([doc('a')]);
      TestBed.inject(LabRequestsApi).list = list as never;
      await openWs('labs');
      expect(list).toHaveBeenCalledTimes(1);
      await closeIt();
      list.mockClear();
      window.dispatchEvent(new Event('focus'));
      await tick();
      expect(list).not.toHaveBeenCalled();
      await openWs('labs');
      expect(list).toHaveBeenCalledTimes(1);
      expect(list.mock.calls[0]?.[1]).toBeUndefined();
      window.dispatchEvent(new Event('focus'));
      await tick();
      expect(list).toHaveBeenCalledTimes(2);
      expect(list.mock.calls[1]?.[1]).toEqual({ passive: true });
    });

    describe('lab requests in the workspace (item 2) and the Full EMR’s composers (LD3)', () => {
      const labComposer = () => fixture.debugElement.query(By.directive(CallLabComposer))?.componentInstance as CallLabComposer | undefined;
      const labField = () => document.getElementById('lab-question') as HTMLInputElement | null;
      const typeIn = async (field: HTMLInputElement | HTMLTextAreaElement | null, value: string) => {
        if (!field) throw new Error('no field');
        field.value = value;
        field.dispatchEvent(new Event('input'));
        await tick();
      };
      const newLabRequest = async () => {
        await openWs('labs');
        el.querySelector<HTMLButtonElement>('#call-lab-new button')?.click();
        await tick();
        await tick();
      };
      const emrButton = (label: string) => Array.from(el.querySelectorAll<HTMLButtonElement>('#ws-panel-record button')).find((b) => b.textContent?.trim() === label);
      const toEmr = async () => {
        el.querySelector<HTMLButtonElement>('#ws-tab-record')?.click();
        await tick();
        await tick();
      };
      const fillValid = async () => {
        document.getElementById('lab-quick')?.click();
        await tick();
        Array.from(document.querySelectorAll<HTMLElement>('#lab-quick-listbox [role="option"]')).find((o) => o.textContent?.trim() === 'FBC')?.click();
        await tick();
        await typeIn(labField(), 'Suspected iron-deficiency anaemia');
      };
      const openPreview = async () => {
        document.getElementById('lab-preview-button')?.click();
        await tick();
        await tick();
      };
      const openDialogs = () => Array.from(el.querySelectorAll<HTMLDialogElement>('#ws-panel-labs dialog')).filter((d) => d.open);

      it('a lab request in progress: closing asks nothing, the launcher and the tab say "Not sent", the same composer comes back; End and canLeave ask once', async () => {
        const opened = vi.spyOn(window, 'open').mockImplementation(() => null);
        const confirmLeave = vi.fn<(copy?: unknown) => Promise<boolean>>(async () => true);
        await setup([doc('a')]);
        TestBed.inject(DialogService).confirmLeave = confirmLeave as never;
        await newLabRequest();
        expect(el.querySelector('#ws-panel-labs .sd-rx-zone doc-call-lab-requests doc-call-lab-composer')).not.toBeNull();
        expect(document.activeElement?.id).toBe('call-lab-compose-title');
        const instance = labComposer();
        await typeIn(labField(), 'Fatigue for 3 weeks');
        expect(el.querySelector('#ws-tab-labs')?.textContent).toContain(', not sent');
        expect(el.querySelector('#ws-tab-labs .ws-flag-unsaved')).not.toBeNull();
        await closeIt();
        expect(confirmLeave).not.toHaveBeenCalled();
        expect(internals().wsOpen()).toBe(false);
        expect(launcher('labs')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Lab requests, Not sent — lab request in progress');
        await openWs('labs');
        expect(labComposer()).toBe(instance);
        expect(labField()?.value).toBe('Fatigue for 3 weeks');
        await closeIt();
        await call.askEnd();
        expect(confirmLeave).toHaveBeenCalledTimes(1);
        expect(confirmLeave).toHaveBeenLastCalledWith(UNSAVED_LAB_LEAVE);
        internals().endOpen.set(false);
        await tick();
        await internals().canLeave();
        expect(confirmLeave).toHaveBeenCalledTimes(2);
        expect(confirmLeave.mock.calls[1]?.[0]).toMatchObject({ title: 'Leave the call with an unsent lab request?', confirmLabel: 'Leave without sending' });
        expect(opened).not.toHaveBeenCalled();
        opened.mockRestore();
      });

      it('sent, or closed: the tab mark and the launcher status go', async () => {
        const confirmLeave = vi.fn<(copy?: unknown) => Promise<boolean>>(async () => true);
        await setup([doc('a')]);
        TestBed.inject(DialogService).confirmLeave = confirmLeave as never;
        await newLabRequest();
        await typeIn(labField(), 'Fatigue');
        expect(el.querySelector('#ws-tab-labs')?.textContent).toContain(', not sent');
        Array.from(el.querySelectorAll<HTMLButtonElement>('#ws-panel-labs button')).find((b) => b.textContent?.trim() === 'Cancel')?.click();
        await tick();
        await tick();
        expect(confirmLeave).toHaveBeenCalledTimes(1);
        expect(el.querySelector('#ws-tab-labs')?.textContent).not.toContain(', not sent');
        expect(launcher('labs')?.textContent).not.toContain('Not sent');
      });

      it('a prescription and a lab request both unsaved: canLeave asks exactly once, naming both', async () => {
        const confirmLeave = vi.fn<(copy?: unknown) => Promise<boolean>>(async () => false);
        await setup([doc('a')]);
        TestBed.inject(DialogService).confirmLeave = confirmLeave as never;
        await openWs('prescriptions');
        Array.from(el.querySelectorAll<HTMLButtonElement>('#ws-panel-prescriptions button')).find((b) => b.textContent?.includes('New prescription'))?.click();
        await tick();
        await tick();
        await typeIn(el.querySelector<HTMLTextAreaElement>('#ws-panel-prescriptions doc-rx-composer textarea'), 'Asthma flare');
        await newLabRequest();
        await typeIn(labField(), 'Fatigue');
        expect(await internals().canLeave()).toBe(false);
        expect(confirmLeave).toHaveBeenCalledTimes(1);
        expect(confirmLeave.mock.calls[0]?.[0]).toMatchObject({ title: 'Leave the call with unsaved work?', confirmLabel: 'Leave anyway', cancelLabel: 'Stay in the call' });
      });

      it('a lab request on its way: Leave stays without a prompt, End opens nothing; its preview dialog keeps the workspace open', async () => {
        const confirmLeave = vi.fn<(copy?: unknown) => Promise<boolean>>(async () => true);
        await setup([doc('a')]);
        TestBed.inject(DialogService).confirmLeave = confirmLeave as never;
        const reply = new Subject<unknown>();
        TestBed.inject(LabRequestsApi).create = (() => reply) as never;
        await newLabRequest();
        await fillValid();
        await openPreview();
        expect(openDialogs().length).toBe(1);
        // A nested dialog: neither Esc's close nor the band's Back to call closes the workspace.
        internals().closeWorkspace();
        await tick();
        internals().backToCall();
        await tick();
        expect(internals().wsOpen()).toBe(true);
        (document.getElementById('lab-attest') as HTMLInputElement | null)?.click();
        await tick();
        Array.from(openDialogs()[0]?.querySelectorAll<HTMLButtonElement>('button') ?? []).find((b) => b.textContent?.trim() === 'Send to Patient')?.click();
        await tick();
        expect(labComposer()?.sending()).toBe(true);
        expect(await internals().canLeave()).toBe(false);
        await call.askEnd();
        expect(internals().endOpen()).toBe(false);
        expect(confirmLeave).not.toHaveBeenCalled();
        reply.complete();
      });

      it('the Full EMR’s "New lab request": the composer on the Lab requests tab, focus on its title; again with a draft, the same one, focus on the tab', async () => {
        await setup([doc('a')]);
        await openWs('record');
        await tick();
        emrButton('New lab request')?.click();
        await tick();
        await tick();
        expect(internals().wsTab()).toBe('labs');
        expect(labComposer()).toBeDefined();
        expect(document.activeElement?.id).toBe('call-lab-compose-title');
        const instance = labComposer();
        await typeIn(labField(), 'Fatigue');
        await toEmr();
        emrButton('New lab request')?.click();
        await tick();
        await tick();
        expect(internals().wsTab()).toBe('labs');
        expect(labComposer()).toBe(instance);
        expect(labField()?.value).toBe('Fatigue');
        expect(document.activeElement?.id).toBe('ws-tab-labs');
      });

      it('signed out: composing keeps the zone with the banner above it; not composing, the placeholder and the zone hidden; the tab stays mounted', async () => {
        await setup([doc('a')]);
        await newLabRequest();
        signedIn.set(false);
        await tick();
        const panel = () => el.querySelector<HTMLElement>('#ws-panel-labs');
        const zone = () => panel()?.querySelector<HTMLElement>('.sd-rx-zone');
        expect(panel()?.querySelector('[role="alert"]')?.textContent).toContain('Your lab request is kept here');
        expect(zone()?.hidden).toBe(false);
        expect(labComposer()).toBeDefined();
        panel()?.querySelector<HTMLButtonElement>('[aria-label="Back to lab requests"]')?.click();
        await tick();
        await tick();
        expect(labComposer()).toBeUndefined();
        expect(zone()?.hidden).toBe(true);
        expect(panel()?.textContent).toContain('Sign in to the doctor portal to request lab tests');
        expect(panel()?.querySelector('doc-call-lab-requests')).not.toBeNull();
        expect(document.activeElement?.id).toBe('ws-tab-labs');
      });

      it('(LD3) the Full EMR’s "Write prescription": a new prescription, focus on its title; again with one being written, the same composer, focus on the tab', async () => {
        const opened = vi.spyOn(window, 'open').mockImplementation(() => null);
        await setup([doc('a')]);
        const path = location.pathname;
        await openWs('record');
        await tick();
        emrButton('Write prescription')?.click();
        await tick();
        await tick();
        expect(internals().wsTab()).toBe('prescriptions');
        const composer = fixture.debugElement.query(By.directive(RxComposer))?.componentInstance;
        expect(composer).toBeDefined();
        expect(document.activeElement?.id).toBe('rx-compose-title');
        await typeIn(el.querySelector<HTMLTextAreaElement>('#ws-panel-prescriptions doc-rx-composer textarea'), 'Asthma flare');
        await toEmr();
        emrButton('Write prescription')?.click();
        await tick();
        await tick();
        expect(internals().wsTab()).toBe('prescriptions');
        expect(fixture.debugElement.queryAll(By.directive(RxComposer)).length).toBe(1);
        expect(fixture.debugElement.query(By.directive(RxComposer))?.componentInstance).toBe(composer);
        expect(el.querySelector<HTMLTextAreaElement>('#ws-panel-prescriptions doc-rx-composer textarea')?.value).toBe('Asthma flare');
        expect(document.activeElement?.id).toBe('ws-tab-prescriptions');
        expect(opened).not.toHaveBeenCalled();
        expect(location.pathname).toBe(path);
        opened.mockRestore();
      });

      it('(LD3) a saved draft opened with Continue, then "Write prescription": the same composer and draft, its edits kept, focus on the tab', async () => {
        await setup([doc('a')]);
        const doctorApi = TestBed.inject(DoctorApi) as unknown as Record<string, unknown>;
        doctorApi['listPrescriptions'] = () =>
          of({
            data: [
              {
                id: 'rx-d1',
                number: 'GVM-RX-20261104-00007',
                status: 'draft',
                appointment_id: 'ap-1',
                patient_id: 'p1',
                prescriber: 'Dr Ada Obi',
                patient_name: 'Bola Ade',
                items_count: 0,
                valid_until: null,
                allows_repeats: false,
                sent_at: null,
                cancelled_at: null,
                created_at: '2026-11-04T14:00:00Z',
              },
            ],
          });
        doctorApi['getPrescription'] = (id: string) =>
          of({ data: { id, number: 'GVM-RX-20261104-00007', status: 'draft', items: [], readings: {}, reason: '' } });
        await openWs('prescriptions');
        Array.from(el.querySelectorAll<HTMLButtonElement>('#ws-panel-prescriptions button')).find((b) => b.textContent?.trim() === 'Continue')?.click();
        await tick();
        await tick();
        const composer = fixture.debugElement.query(By.directive(RxComposer))?.componentInstance;
        expect(composer).toBeDefined();
        expect(el.querySelector('#rx-compose-title')?.textContent?.trim()).toBe('GVM-RX-20261104-00007');
        await typeIn(el.querySelector<HTMLTextAreaElement>('#ws-panel-prescriptions doc-rx-composer textarea'), 'Asthma flare');
        await toEmr();
        emrButton('Write prescription')?.click();
        await tick();
        await tick();
        expect(internals().wsTab()).toBe('prescriptions');
        expect(fixture.debugElement.queryAll(By.directive(RxComposer)).length).toBe(1);
        expect(fixture.debugElement.query(By.directive(RxComposer))?.componentInstance).toBe(composer);
        expect(el.querySelector('#rx-compose-title')?.textContent?.trim()).toBe('GVM-RX-20261104-00007');
        expect(el.querySelector<HTMLTextAreaElement>('#ws-panel-prescriptions doc-rx-composer textarea')?.value).toBe('Asthma flare');
        expect(document.activeElement?.id).toBe('ws-tab-prescriptions');
      });

      it('(LD3) the panel’s own rules: a compose request while paused is consumed (signing in opens nothing); after an EMR compose, the list’s own "New prescription" does not take focus to the title', async () => {
        await setup([doc('a')]);
        await openWs('prescriptions');
        expect(el.querySelector('#ws-panel-prescriptions doc-rx-panel')).not.toBeNull();
        signedIn.set(false);
        await tick();
        // Straight to the panel (doc-call itself never bumps while signed out).
        (call as unknown as { rxComposeSeq: WritableSignal<number> }).rxComposeSeq.update((n) => n + 1);
        await tick();
        await tick();
        expect(el.querySelector('#ws-panel-prescriptions doc-rx-composer')).toBeNull();
        signedIn.set(true);
        await tick();
        await tick();
        expect(el.querySelector('#ws-panel-prescriptions doc-rx-composer')).toBeNull();
        // The EMR path focuses the title once…
        await toEmr();
        emrButton('Write prescription')?.click();
        await tick();
        await tick();
        expect(document.activeElement?.id).toBe('rx-compose-title');
        Array.from(el.querySelectorAll<HTMLButtonElement>('#ws-panel-prescriptions doc-rx-composer button')).find((b) => b.textContent?.trim() === 'Close')?.click();
        await tick();
        await tick();
        expect(el.querySelector('#ws-panel-prescriptions doc-rx-composer')).toBeNull();
        // …the list's own button keeps today's behaviour.
        const newRx = Array.from(el.querySelectorAll<HTMLButtonElement>('#ws-panel-prescriptions button')).find((b) => b.textContent?.includes('New prescription'));
        newRx?.focus();
        newRx?.click();
        await tick();
        await tick();
        expect(el.querySelector('#ws-panel-prescriptions doc-rx-composer')).not.toBeNull();
        expect(document.activeElement?.id).not.toBe('rx-compose-title');
      });

      it('(LD3) signed out: no composer, the placeholder, focus on the tab; signing in later opens nothing', async () => {
        await setup([doc('a')]);
        await openWs('notes');
        signedIn.set(false);
        await tick();
        internals().openRxComposer();
        await tick();
        await tick();
        expect(internals().wsTab()).toBe('prescriptions');
        expect(el.querySelector('#ws-panel-prescriptions doc-rx-composer')).toBeNull();
        expect(el.querySelector('#ws-panel-prescriptions')?.textContent).toContain('Sign in to the doctor portal to write prescriptions');
        expect(document.activeElement?.id).toBe('ws-tab-prescriptions');
        signedIn.set(true);
        await tick();
        await tick();
        expect(el.querySelector('#ws-panel-prescriptions doc-rx-panel')).not.toBeNull();
        expect(el.querySelector('#ws-panel-prescriptions doc-rx-composer')).toBeNull();
      });
    });

    it('the Full EMR’s Documents ignore the cockpit’s filter', async () => {
      await setup([doc('a', { document_type: 'xray_report' }), doc('b')]);
      internals().recordsTab.set('imaging');
      await tick();
      await openWs('record');
      await tick();
      el.querySelector<HTMLButtonElement>('#ws-emr-tab-documents')?.click();
      await tick();
      const views = Array.from(el.querySelectorAll<HTMLButtonElement>('#ws-emr-panel-documents [data-doc-id]'));
      expect(views.map((b) => b.getAttribute('data-doc-id')).sort()).toEqual(['a', 'b']);
      views.find((b) => b.getAttribute('data-doc-id') === 'b')?.click();
      expect(viewer.open).toHaveBeenCalledTimes(1);
      const [sources, options] = viewer.open.mock.calls[0] as [ViewerSource[], ViewerOpenOptions];
      expect(sources.map((s) => s.key).sort()).toEqual(['doc:a', 'doc:b']);
      expect(sources.every((s) => s.policy === 'view_only')).toBe(true);
      expect(options.watermark).toBeTruthy();
    });
  });

  describe('a phone held sideways (the control rail)', () => {
    /** The viewport `matchMedia` answers for; `turn()` changes it and tells the listeners. */
    const vp = { w: 375, h: 812 };
    type Listener = (e: { matches: boolean; media: string }) => void;
    const lists: Array<{ media: string; listeners: Set<Listener> }> = [];

    /** The media features the cockpit asks about (anything else: no match). */
    function evaluate(query: string): boolean {
      return query.split(/\s+and\s+/).every((part) => {
        const m = /^\(\s*([a-z-]+)\s*:\s*([^)]+?)\s*\)$/.exec(part.trim());
        if (!m) return false;
        const [, feature, value] = m;
        const px = parseFloat(value);
        switch (feature) {
          case 'min-width':
            return vp.w >= px;
          case 'max-width':
            return vp.w <= px;
          case 'max-height':
            return vp.h <= px;
          case 'orientation':
            return value === (vp.w > vp.h ? 'landscape' : 'portrait');
          default:
            return false;
        }
      });
    }

    function viewport(w: number, h: number) {
      vp.w = w;
      vp.h = h;
      lists.length = 0;
      window.matchMedia = ((query: string) => {
        const listeners = new Set<Listener>();
        lists.push({ media: query, listeners });
        return {
          media: query,
          get matches() {
            return evaluate(query);
          },
          addEventListener: (_type: string, cb: Listener) => listeners.add(cb),
          removeEventListener: (_type: string, cb: Listener) => listeners.delete(cb),
        };
      }) as unknown as typeof window.matchMedia;
    }

    /** Turn the phone: every query whose answer changed tells its listeners. */
    function turn(w: number, h: number) {
      const before = lists.map((l) => evaluate(l.media));
      vp.w = w;
      vp.h = h;
      lists.forEach((l, i) => {
        const matches = evaluate(l.media);
        if (matches !== before[i]) for (const cb of l.listeners) cb({ matches, media: l.media });
      });
    }

    const tilesCmp = () => fixture.debugElement.query(By.directive(CallTilesComponent)).componentInstance as CallTilesComponent;
    const controlsCmp = () => fixture.debugElement.query(By.directive(CallControlsComponent)).componentInstance as CallControlsComponent;
    const rowTile = () => fixture.debugElement.query(By.directive(CallSelfTileComponent));
    const dock = () => el.querySelector<HTMLElement>('section[aria-label="Video call"]');
    const stage = () => el.querySelector<HTMLElement>('.sd-stage');
    /** The doctor's camera (the faked Agora track). */
    const camera = () =>
      (call as unknown as { selfTrack: () => { play: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } | null }).selfTrack();
    const lastOrder = (fn: ReturnType<typeof vi.fn>) => Math.max(0, ...fn.mock.invocationCallOrder);
    /** The rail's stage column: the video, then (while it shows) the new-document alert. */
    const column = () => stage()?.parentElement ?? null;
    /** The dock's settings, as the bar emits them. */
    const choose = (id: string, value: string) => (call as unknown as { onChoice(c: { id: string; value: string }): void }).onChoice({ id, value });
    const press = (id: string) => (call as unknown as { onControl(id: string): void }).onControl(id);
    /** The rail's column heights (RAIL_COLUMN): Medium / Large, and Small. */
    const FULL = 'h-[max(13.625rem,calc(100dvh_-_4.5rem_-_var(--rail-above,0px)))]';
    const SMALL = 'h-[max(13.625rem,calc(100dvh_-_10rem_-_var(--rail-above,0px)))]';

    afterEach(() => {
      try {
        localStorage.removeItem('videomed.call.video-size');
        localStorage.removeItem('videomed.call.self');
      } catch {
        /* storage blocked */
      }
    });

    it('812×375: the controls are a rail beside the video, the self view is the picture-in-picture, no row tile', async () => {
      viewport(812, 375);
      await setup([doc('a')]);
      expect(controlsCmp().layout()).toBe('rail');
      expect(rowTile()).toBeNull();
      expect(tilesCmp().selfView()).toBe('pip');
      // A row, not sticky: the stage fills the height under the 48px top bar, the rail outside it.
      expect(dock()?.className).toContain('flex-row');
      expect(dock()?.className).not.toContain('sticky');
      // The stage's column has a fixed height (the screen under the top bar and any
      // banner); the stage fills it (no letterbox: the video fills it by default), the rail beside it.
      expect(column()?.className).toContain('grid');
      expect(column()?.className).toContain(FULL);
      expect(stage()?.className).toContain('h-full');
      expect(stage()?.className).toContain('w-full');
      expect(stage()?.className).not.toContain('aspect-');
      expect(tilesCmp().mainFit()).toBe('cover');
      // The rail is as wide as its columns, every control and setting in it (no More).
      const rail = el.querySelector('sd-call-controls')?.closest<HTMLElement>('.rounded-card');
      expect(rail?.className).not.toContain('w-[4.5rem]');
      // ...and exactly as tall as the stage's column, not its content: the controls measure
      // that height and pack into as many columns as it needs, so End stays on the screen.
      expect(rail?.className).toContain(FULL);
      expect(rail?.className.split(/\s+/)).toContain('min-h-0');
      expect(el.querySelector('sd-call-controls [data-control="more"]')).toBeNull();
      expect(el.querySelectorAll('sd-call-controls [role="radiogroup"]')).toHaveLength(2);
      expect(column()?.querySelector('sd-call-controls')).toBeNull();
      expect(stage()?.querySelector('sd-call-controls')).toBeNull();
      expect(dock()?.querySelector('sd-call-controls')).not.toBeNull();
      // The top bar is one 48px row and keeps the allergies and the timer.
      const header = el.querySelector('header');
      expect(header?.className).toContain('h-12');
      expect(header?.className).toContain('flex-nowrap');
      expect(header?.textContent).toContain('Allergies: Penicillin');
      expect(header?.querySelector('[role="timer"]')).not.toBeNull();
      // Still the narrow cockpit below: the section switcher, then the panels.
      expect(el.querySelector('[role="tablist"][aria-label="Sections"]')).not.toBeNull();
    });

    it('568×320 (under 640px): still the rail, and the camera is the picture-in-picture (no room for the row tile)', async () => {
      viewport(568, 320);
      await setup([doc('a')]);
      expect(controlsCmp().layout()).toBe('rail');
      expect(rowTile()).toBeNull();
      expect(tilesCmp().selfView()).toBe('pip');
    });

    it('Small video: a shorter column in the rail (floored at one column of four controls, 218px); Large goes back to the full height', async () => {
      viewport(812, 375);
      await setup([doc('a')]);
      choose('size', 's');
      await tick();
      // 13.625rem = a rail column: 4 × 44px controls + 3 × 8px gaps + py-2 + the border.
      expect(column()?.className).toContain(SMALL);
      expect(column()?.className).not.toContain(FULL);
      // The rail follows it (its bottom lines up with the video's; the controls pack to it).
      const rail = () => el.querySelector('sd-call-controls')?.closest<HTMLElement>('.rounded-card');
      expect(rail()?.className).toContain(SMALL);
      expect(rail()?.className).not.toContain(FULL);
      choose('size', 'l');
      await tick();
      expect(column()?.className).toContain(FULL);
      expect(rail()?.className).toContain(FULL);
    });

    it('375×812 (held upright): not a rail — the bar under the video with the row tile, the dock sticky', async () => {
      viewport(375, 812);
      await setup([doc('a')]);
      expect(controlsCmp().layout()).toBe('bar');
      expect(rowTile()).not.toBeNull();
      expect(tilesCmp().selfView()).toBe('external');
      expect(dock()?.className).toContain('flex-col');
      expect(dock()?.className).toContain('sticky');
      expect(el.querySelector('header')?.className).toContain('min-h-14');
    });

    it('1024×450 (landscape, but 1024px wide): not a rail', async () => {
      viewport(1024, 450);
      await setup([doc('a')]);
      expect(controlsCmp().layout()).toBe('bar');
      expect(rowTile()).toBeNull();
      expect(tilesCmp().selfView()).toBe('pip');
      expect(dock()?.className).toContain('[grid-area:dock]');
    });

    it('a new document: the alert is under the video in the stage column (the dock and the rail stay put), not floating', async () => {
      viewport(812, 375);
      await setup([doc('a')]);
      const d = dock();
      const before = d?.previousElementSibling ?? null;
      answer = () => of({ data: access([doc('a'), doc('b')]) });
      call.loadDocumentAccess('refresh');
      await tick();
      const alert = el.querySelector<HTMLElement>('[role="group"][aria-label="New document"]');
      expect(alert).not.toBeNull();
      expect(alert?.className).not.toContain('fixed');
      // In the fixed-height column, after the video: it takes its room from the video,
      // so nothing is added above the dock (the rail and its End stay where they were).
      expect(dock()).toBe(d);
      expect(d?.previousElementSibling ?? null).toBe(before);
      expect(column()?.contains(alert)).toBe(true);
      expect(column()?.className).toContain(FULL);
      const s = stage();
      expect(s && alert ? s.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING : 0).toBeTruthy();
      expect(alert?.closest('.sd-stage')).toBeNull(); // never on the video
      expect(alert?.closest('.sd-dock')).toBe(d); // dark in both cockpit themes
      expect(el.querySelector(':scope > .sd-dock')).toBeNull(); // no floating copy
      expect(document.documentElement.style.scrollPaddingBottom).toBe('');
    });

    it('a banner under the top bar (here: reconnecting) is measured as --rail-above, which the column takes off its height', async () => {
      // A ResizeObserver that reports the sizes this test gives it.
      const observers: Array<{ el: Element; report: (height: number) => void }> = [];
      vi.stubGlobal(
        'ResizeObserver',
        class {
          constructor(private readonly cb: ResizeObserverCallback) {}
          observe(target: Element) {
            observers.push({
              el: target,
              report: (height) => this.cb([{ target, contentRect: { height } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver),
            });
          }
          unobserve() {
            /* not needed */
          }
          disconnect() {
            /* not needed */
          }
        },
      );
      viewport(812, 375);
      await setup([doc('a')]);
      const header = el.querySelector('header');
      const banners = header?.nextElementSibling ?? null;
      const page = banners?.parentElement ?? null;
      const watch = observers.find((o) => o.el === banners);
      expect(watch).toBeTruthy();
      (call as unknown as { rejoining: WritableSignal<boolean> }).rejoining.set(true);
      await tick();
      expect(banners?.textContent).toContain('Reconnecting to the call');
      watch?.report(32.4);
      expect(page?.style.getPropertyValue('--rail-above')).toBe('33px');
      expect(column()?.className).toContain('var(--rail-above,0px)');
      expect(page?.contains(column())).toBe(true);
      (call as unknown as { rejoining: WritableSignal<boolean> }).rejoining.set(false);
      await tick();
      watch?.report(0);
      expect(page?.style.getPropertyValue('--rail-above')).toBe('0px');
    });

    it('held upright, a dock taller than 60% of the screen scrolls with the page (no scroll padding); shorter, it sticks', async () => {
      const observers: Array<{ el: Element; report: () => void }> = [];
      vi.stubGlobal(
        'ResizeObserver',
        class {
          constructor(private readonly cb: ResizeObserverCallback) {}
          observe(target: Element) {
            observers.push({ el: target, report: () => this.cb([], this as unknown as ResizeObserver) });
          }
          unobserve() {
            /* not needed */
          }
          disconnect() {
            /* not needed */
          }
        },
      );
      // As the stylesheet lays it out (jsdom loads none): the dock's `sticky` class.
      const sheet = document.createElement('style');
      sheet.textContent = '.sticky { position: sticky; }';
      document.head.appendChild(sheet);
      let room = 667;
      const clientHeight = vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
        return this === document.documentElement ? room : 0;
      });
      try {
        viewport(375, 667);
        await setup([doc('a')]);
        const section = dock() as HTMLElement;
        let height = 450;
        vi.spyOn(section, 'getBoundingClientRect').mockImplementation(
          () => ({ x: 0, y: 0, top: 0, left: 0, width: 351, right: 351, height, bottom: height, toJSON: () => ({}) }) as DOMRect,
        );
        const watch = observers.find((o) => o.el === section);
        expect(watch).toBeTruthy();
        // 450px of a 667px screen (67%: the bar on three rows): it scrolls away, nothing to pad.
        watch?.report();
        expect(section.style.position).toBe('static');
        expect(section.className).toContain('sticky');
        expect(document.documentElement.style.scrollPaddingTop).toBe('');
        // 380px (57%): it sticks, and focus is kept clear of it (2.4.11).
        height = 380;
        watch?.report();
        expect(section.style.position).toBe('');
        expect(document.documentElement.style.scrollPaddingTop).toBe('380px');
        // A shorter window (the dock unchanged): checked again on resize.
        room = 600;
        window.dispatchEvent(new Event('resize'));
        expect(section.style.position).toBe('static');
        expect(document.documentElement.style.scrollPaddingTop).toBe('');
      } finally {
        sheet.remove();
        clientHeight.mockRestore();
      }
    });

    it('sideways the dock is not watched (the banners resize it: no ResizeObserver loop); upright it is again', async () => {
      const live = new Set<{ el: Element }>();
      vi.stubGlobal(
        'ResizeObserver',
        class {
          private readonly mine: Array<{ el: Element }> = [];
          observe(target: Element) {
            const o = { el: target };
            this.mine.push(o);
            live.add(o);
          }
          unobserve() {
            /* not needed */
          }
          disconnect() {
            for (const o of this.mine) live.delete(o);
          }
        },
      );
      const dockWatched = () => [...live].some((o) => o.el === dock());
      viewport(375, 812);
      await setup([doc('a')]);
      expect(dockWatched()).toBe(true);
      turn(812, 375);
      await tick();
      expect(dockWatched()).toBe(false);
      expect(document.documentElement.style.scrollPaddingTop).toBe('');
      turn(375, 812);
      await tick();
      expect(dockWatched()).toBe(true);
    });

    it('Hide my preview, then show it: the picture-in-picture lets go of the camera, then plays it again', async () => {
      viewport(812, 375);
      await setup([doc('a')]);
      const cam = camera();
      expect(cam).not.toBeNull();
      if (!cam) return;
      const tiles = tilesCmp();
      expect(tiles.selfView()).toBe('pip');
      expect(cam.play.mock.lastCall?.[0]).toBe(tiles.elementFor(2));
      const attach = vi.spyOn(tiles, 'attach');
      const detach = vi.spyOn(tiles, 'detach');

      // Hide: the stage stops it at once and forgets it.
      const stops = cam.stop.mock.calls.length;
      press('self');
      expect(detach).toHaveBeenCalledWith(2);
      expect(cam.stop.mock.calls.length).toBe(stops + 1);
      await tick();
      expect(tiles.selfView()).toBe('hidden');
      expect(tiles.elementFor(2)).toBeNull();

      // Show: handed back (camera: no play config), and played in the new picture-in-picture.
      const plays = cam.play.mock.calls.length;
      press('self');
      expect(attach).toHaveBeenLastCalledWith(2, cam, undefined);
      await tick();
      expect(tiles.selfView()).toBe('pip');
      const pip = tiles.elementFor(2);
      expect(pip).not.toBeNull();
      expect(cam.play.mock.calls.length).toBe(plays + 1);
      expect(cam.play.mock.lastCall?.[0]).toBe(pip);
      expect(lastOrder(cam.stop)).toBeLessThan(lastOrder(cam.play));
    });

    it('Hide my preview while sharing the screen: shown again, the shared screen plays whole (fit: contain)', async () => {
      viewport(812, 375);
      await setup([doc('a')]);
      const screen = { kind: 'video', enabled: true, play: vi.fn(), stop: vi.fn(), close: vi.fn(), on: vi.fn(), setEnabled: vi.fn(async () => undefined) };
      agora.module.createScreenVideoTrack.mockResolvedValueOnce(screen);
      await (call as unknown as { toggleScreen(): Promise<void> }).toggleScreen();
      await tick();
      expect(call.screenOn()).toBe(true);
      const tiles = tilesCmp();
      expect(screen.play.mock.lastCall).toEqual([tiles.elementFor(2), { fit: 'contain' }]);
      const attach = vi.spyOn(tiles, 'attach');

      press('self');
      expect(screen.stop).toHaveBeenCalledTimes(1);
      await tick();
      press('self');
      expect(attach).toHaveBeenLastCalledWith(2, screen, { fit: 'contain' });
      await tick();
      const pip = tiles.elementFor(2);
      expect(pip).not.toBeNull();
      expect(screen.play.mock.lastCall).toEqual([pip, { fit: 'contain' }]);
      expect(lastOrder(screen.stop)).toBeLessThan(lastOrder(screen.play));
    });

    it('turning the phone hands the camera between the row tile and the picture-in-picture, never in two places', async () => {
      viewport(375, 812);
      await setup([doc('a')]);
      const cam = camera();
      expect(cam).not.toBeNull();
      if (!cam) return;
      const rowVideo = () => el.querySelector('sd-call-self-tile [data-sd-self-video]');
      expect(rowVideo()).not.toBeNull();
      expect(cam.play.mock.lastCall?.[0]).toBe(rowVideo());

      const tiles = tilesCmp();
      const attach = vi.spyOn(tiles, 'attach');
      const detach = vi.spyOn(tiles, 'detach');

      // Sideways: the stage gets the camera before the page re-renders …
      turn(812, 375);
      expect(attach).toHaveBeenCalledWith(2, cam, undefined);
      expect(detach).not.toHaveBeenCalled();
      await tick();
      // … and plays it in the picture-in-picture once the row tile has stopped it.
      expect(controlsCmp().layout()).toBe('rail');
      expect(rowTile()).toBeNull();
      const pip = tiles.elementFor(2);
      expect(pip).not.toBeNull();
      expect(cam.play.mock.lastCall?.[0]).toBe(pip);
      expect(lastOrder(cam.stop)).toBeLessThan(lastOrder(cam.play));

      // Upright again: the stage lets go of it at once (stopped there) …
      const stops = cam.stop.mock.calls.length;
      turn(375, 812);
      expect(detach).toHaveBeenCalledWith(2);
      expect(cam.stop.mock.calls.length).toBe(stops + 1);
      await tick();
      // … and the row tile plays it; nothing stops it after that.
      expect(controlsCmp().layout()).toBe('bar');
      expect(tiles.elementFor(2)).toBeNull();
      expect(rowVideo()).not.toBeNull();
      expect(cam.play.mock.lastCall?.[0]).toBe(rowVideo());
      expect(lastOrder(cam.stop)).toBeLessThan(lastOrder(cam.play));
    });
  });
});
