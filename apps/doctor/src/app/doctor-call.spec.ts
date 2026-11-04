import { ApplicationRef, signal, type WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { Observable, of, Subject, timer } from 'rxjs';
import { map } from 'rxjs/operators';
import { SessionTimeoutService, StaffAuthService } from '@supadoc/auth';
import { ApiService, DoctorApi } from '@supadoc/data-access';
import type { DoctorDocumentAccessDto, DoctorSharedDocumentDto } from '@supadoc/models';
import { DialogService, provideSupadocIcons } from '@supadoc/ui';
import { NOT_SHARED } from './appointment/document-access';
import { NoteDraftStore } from './appointment/note-draft';
import { DoctorCall } from './doctor-call';
import { PDF_LOADER } from './viewer/pdf-loader';

/** Agora, faked: a client that joins and keeps its event handlers (the nudge arrives on 'stream-message'). */
const agora = vi.hoisted(() => {
  const clients: Array<{ handlers: Record<string, (...a: unknown[]) => void> }> = [];
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
      const handlers: Record<string, (...a: unknown[]) => void> = {};
      const client = {
        handlers,
        on: vi.fn((event: string, cb: (...a: unknown[]) => void) => {
          handlers[event] = cb;
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
  readonly viewerDoc: () => DoctorSharedDocumentDto | null;
  loadDocumentAccess(mode: 'load' | 'refresh' | 'poll' | 'nudge'): void;
  closeViewer(refocus?: boolean): void;
}

describe('DoctorCall — documents in the call', () => {
  let fixture: ComponentFixture<DoctorCall>;
  let call: CallInternals;
  let el: HTMLElement;
  let reads: { at: number; passive: boolean }[];
  let answer: () => Observable<{ data: DoctorDocumentAccessDto }>;
  let t0: number;
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
    answer = () => of({ data: access(docs) });
    signedIn.set(true);
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
        { provide: ApiService, useValue: { request: () => of({ data: {} }) } },
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
          },
        },
        { provide: SessionTimeoutService, useValue: { hold: vi.fn(), release: vi.fn() } },
        { provide: NoteDraftStore, useValue: { take: () => null, clear: () => undefined, save: () => true } },
        {
          provide: DialogService,
          useValue: { confirm: async () => ({ confirmed: true }), confirmLeave: async () => true, requests: () => [] },
        },
        { provide: PDF_LOADER, useValue: async () => ({ promise: new Promise(() => undefined), destroy: () => undefined }) },
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

  it('closing the viewer after the alert went focuses the Medical Records heading', async () => {
    await setup([doc('a')]);
    answer = () => of({ data: access([doc('a'), doc('b', { viewable: false })]) });
    call.loadDocumentAccess('refresh');
    await tick();
    // Show in records is there; View isn't for a type the viewer can't show — open it from the list.
    const row = el.querySelector<HTMLButtonElement>('[data-doc-id="b"]');
    expect(row).not.toBeNull();
    row?.click();
    await tick();
    expect(call.viewerDoc()?.id).toBe('b');
    await tick(16_000); // the alert has hidden itself meanwhile
    expect(call.docAlert()).toBeNull();
    row?.remove(); // the list re-rendered: the opener is gone
    call.closeViewer();
    await tick();
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

  it('narrow: the viewer sheet makes the cockpit and the floating alert inert until it closes', async () => {
    await setup([doc('a')]);
    answer = () => of({ data: access([doc('a'), doc('b')]) });
    call.loadDocumentAccess('refresh');
    await tick();
    const cockpit = el.querySelector('main')?.parentElement;
    const alertWrap = el.querySelector(':scope > .sd-dock');
    expect(cockpit?.hasAttribute('inert')).toBe(false);
    expect(alertWrap?.hasAttribute('inert')).toBe(false);
    el.querySelector<HTMLButtonElement>('[data-doc-id="b"]')?.click();
    await tick();
    expect(call.viewerDoc()?.id).toBe('b');
    expect(cockpit?.getAttribute('inert')).toBe('');
    expect(el.querySelector(':scope > .sd-dock')?.getAttribute('inert')).toBe('');
    call.closeViewer();
    await tick();
    expect(cockpit?.hasAttribute('inert')).toBe(false);
  });

  it('a document in the viewer that stops being shared: closed, the reason shown, focus on Medical Records (mid)', async () => {
    media(['(min-width: 1024px)']);
    await setup([doc('a'), doc('b')]);
    el.querySelector<HTMLButtonElement>('[data-doc-id="b"]')?.click();
    await tick();
    expect(call.viewerDoc()?.id).toBe('b');
    answer = () => of({ data: access([doc('a')]) });
    call.loadDocumentAccess('refresh');
    await tick();
    expect(call.viewerDoc()).toBeNull();
    expect(el.querySelector<HTMLElement>('#call-records')?.hidden).toBe(false); // the Documents side tab
    expect(document.activeElement?.id).toBe('call-records-heading');
    expect(text()).toContain(NOT_SHARED);
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
});
