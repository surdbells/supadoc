import { ApplicationRef, type EmbeddedViewRef, signal, type WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { Observable, of, Subject, timer } from 'rxjs';
import { map } from 'rxjs/operators';
import { SessionTimeoutService, StaffAuthService } from '@supadoc/auth';
import { ApiService, DoctorApi, LabRequestsApi } from '@supadoc/data-access';
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
import { DoctorCall } from './doctor-call';

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
  readonly viewerPeerTrack: () => unknown;
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

describe('DoctorCall — documents in the call', () => {
  let fixture: ComponentFixture<DoctorCall>;
  let call: CallInternals;
  let el: HTMLElement;
  let reads: { at: number; passive: boolean }[];
  let answer: () => Observable<{ data: DoctorDocumentAccessDto }>;
  let t0: number;
  let viewer: ReturnType<typeof fakeViewer>;
  let dialogConfirm: ReturnType<typeof vi.fn>;
  /** Every portal request made through ApiService.request (the clinical panels, transcript, metrics). */
  let portal: { method: string; path: string; passive: boolean }[];
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
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ token: 'tok' }) } } },
        {
          provide: StaffAuthService,
          useValue: { isAuthenticated: signedIn, subject: signal('doc-1'), displayName: () => 'Dr Ada Obi', clockOffset: () => 0 },
        },
        {
          provide: ApiService,
          useValue: {
            request: (method: string, path: string, _body?: unknown, opts?: { passive?: boolean }) => {
              portal.push({ method: method.toUpperCase(), path, passive: !!opts?.passive });
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
          },
        },
        // The Lab requests tab lists this consultation's requests.
        { provide: LabRequestsApi, useValue: { list: () => of({ data: [] }) } },
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
      const tabs = Array.from(el.querySelectorAll('[role="tablist"][aria-label="Consultation tools"] [role="tab"]')).map((t) => t.textContent?.trim());
      expect(tabs).toEqual(['Consultation Notes', 'Prescriptions', 'Lab requests', 'Follow-ups', 'Transcript & AI']);
      expect(el.querySelector('[aria-label="Close document"]')).toBeNull();
      expect(el.querySelector('doc-protected-document-viewer, sd-document-viewer')).toBeNull();
      expect(el.querySelector('.fixed.inset-0.z-50')).toBeNull();
      expect(el.querySelector('[inert]')).toBeNull();
      fixture.destroy();
      el.remove();
      TestBed.resetTestingModule();
      vi.useRealTimers();
      agora.clients.length = 0;
    }
  });

  it('the Lab request tool selects Lab requests and scrolls only the tab strip so the tab shows in full', async () => {
    await setup([doc('a')]);
    const strip = el.querySelector<HTMLElement>('[role="tablist"][aria-label="Consultation tools"]');
    const tab = el.querySelector<HTMLElement>('#call-tab-labs');
    if (!strip || !tab) throw new Error('no tools tab strip');
    // A phone-width strip (300 px) with Lab requests starting 20 px before its right edge.
    let left = 0;
    Object.defineProperty(strip, 'scrollLeft', { configurable: true, get: () => left, set: (v: number) => (left = v) });
    strip.getBoundingClientRect = () => ({ left: 10, right: 310 }) as DOMRect;
    tab.getBoundingClientRect = () => ({ left: 290 - left, right: 390 - left }) as DOMRect;
    const tool = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Lab request');
    if (!tool) throw new Error('no Lab request tool');
    tool.click();
    await tick();
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(left).toBe(80);
    expect(tab.getBoundingClientRect().right).toBe(310);
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

    it('wide and mid: the stage fills the tools column’s width, its height giving way before the tools row’s 8rem', async () => {
      media(WIDE);
      await setup([doc('a')]);
      const tools = el.querySelector<HTMLElement>('#call-tools');
      expect(dock()?.className).toContain('[grid-area:dock]');
      expect(tools?.className).toContain('[grid-area:tools]');
      expect(el.querySelector('main')?.className).toContain('grid-rows-[minmax(0,auto)_minmax(8rem,1fr)]');
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
        order.push(`detach:${uid}:${call.viewerPeerTrack() ? 'tile-has-track' : 'tile-empty'}`);
      });
      el.querySelector<HTMLButtonElement>('[data-doc-id="a"]')?.click();
      order.push(`tile:${(call.viewerPeerTrack() as { name?: string } | null)?.name ?? 'none'}`);
      expect(order).toEqual(['detach:1:tile-empty', 'tile:v1']);
      expect(call.viewerPeerTrack()).toBe(track);
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
        order.push(`attach:${uid}:${call.viewerPeerTrack() === null ? 'tile-cleared' : 'tile-still-set'}`);
      });
      viewer.close();
      expect(call.viewerPeerTrack()).toBeNull();
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
      expect(call.viewerPeerTrack()).toBe(again);
      expect(attach).not.toHaveBeenCalled();
      await client().handlers['user-unpublished']?.({ uid: 1 }, 'video');
      expect(call.viewerPeerTrack()).toBeNull();
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
      expect(call.viewerPeerTrack()).not.toBeNull();
      const stage = tilesCmp();
      const detach = vi.spyOn(stage, 'detach');
      const rejoined = call.rejoin();
      await tick();
      await rejoined;
      expect(call.viewerPeerTrack()).toBeNull();
      expect(detach).not.toHaveBeenCalledWith(1);
      const back = remoteTrack('v3');
      client().remoteUsers = [{ uid: 1, videoTrack: back }];
      await client().handlers['user-published']?.({ uid: 1, videoTrack: back }, 'video');
      expect(call.viewerPeerTrack()).toBe(back);
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
