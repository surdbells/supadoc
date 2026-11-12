import { Component, computed, type EmbeddedViewRef, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { of } from 'rxjs';
import { AuthService, SessionTimeoutService } from '@supadoc/auth';
import {
  API_CONFIG,
  AppointmentsApi,
  DocumentsApi,
  DocumentSharingApi,
  LabRequestsApi,
  PatientApi,
  PrescriptionsApi,
} from '@supadoc/data-access';
import type {
  AppointmentDocumentAccessDto,
  AppointmentDto,
  ConsultationSummaryDto,
  DocumentAccessRequestDto,
  LabOrderDto,
  MedicalCertificateDto,
  MedicalDocumentDto,
  PatientCarePlanDto,
  PatientLabRequestSummaryDto,
  PrescriptionDto,
  ReferralDto,
  UploadedDocumentDto,
} from '@supadoc/models';
import {
  CallControlsComponent,
  CallSelfTileComponent,
  CallTilesComponent,
  provideSupadocIcons,
} from '@supadoc/ui';
import { CallPeerTileComponent, DocumentViewerService, type ViewerCallContext, type ViewerOpenOptions, type ViewerSource } from '@supadoc/viewer';
import { BAND_BACK, BAND_ENDED, NOTES_HINT_AFTER, notesHint, notesShareBanner } from './call-notes-copy';
import { ConsultationCall } from './consultation-call';

/** Agora, faked: a client that joins, publishes and records what it sends. */
const agora = vi.hoisted(() => {
  const clients: Array<{ handlers: Record<string, (...a: unknown[]) => void>; sendStreamMessage: ReturnType<typeof vi.fn> }> = [];
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
        join: vi.fn(async () => 1),
        publish: vi.fn(async () => undefined),
        unpublish: vi.fn(async () => undefined),
        leave: vi.fn(async () => undefined),
        subscribe: vi.fn(async () => undefined),
        renewToken: vi.fn(async () => undefined),
        enableAudioVolumeIndicator: vi.fn(),
        getRTCStats: vi.fn(() => ({})),
        sendStreamMessage: vi.fn(async () => undefined),
        localTracks: [] as unknown[],
      };
      clients.push(client as never);
      return client;
    }),
    createMicrophoneAndCameraTracks: vi.fn(async () => [track('audio'), track('video')]),
    createMicrophoneAudioTrack: vi.fn(async () => track('audio')),
    createCameraVideoTrack: vi.fn(async () => track('video')),
    createScreenVideoTrack: vi.fn(),
  };
  return { clients, module };
});
vi.mock('agora-rtc-sdk-ng', () => ({ default: agora.module }));

const realResolved = Intl.DateTimeFormat.prototype.resolvedOptions;

const appointment = {
  id: 'ap-1',
  scheduled_at: '2026-11-04T15:00:00Z',
  status: 'confirmed',
  type: 'video',
  type_label: 'Video consultation',
  notes: null,
  amount: '0',
  document_url: null,
  specialist: { id: 'sp-1', name: 'Bayo Ade', specialty: 'Cardiology', photo_url: null, timezone: 'America/Chicago' },
} as unknown as AppointmentDto;

const access: AppointmentDocumentAccessDto = {
  specialist: { id: 'sp-1', name: 'Bayo Ade', specialty: 'Cardiology', photo_url: null },
  appointment: { id: 'ap-1', scheduled_at: '2026-11-04T15:00:00Z', ends_at: '2026-11-04T15:30:00Z', after_options: { after_24h: null, after_7d: null, after_30d: null } },
  can_share: true,
  unavailable_reason: null,
  access: {
    state: 'none',
    scope: null,
    document_count: 0,
    until: null,
    until_label_at: null,
    indefinite: false,
    folder_until_label_at: null,
    folder_indefinite: false,
    next_change_at: null,
    last_viewed_at: null,
    active_grant_ids: [],
    hidden_count: 0,
    hidden_document_ids: [],
  },
  visible_documents: [],
  unshared_attachments: [],
  pending_request: null,
};

const ok = <T,>(data: T) => of({ status: 'success', message: 'OK', data });

/** Per test: the booking's legacy `document_url`, the prescriptions issued, the patient's library. */
let legacyUrl: string | null = null;
let issued: PrescriptionDto[] = [];
let library: MedicalDocumentDto[] = [];
/** Per test: the visit's legacy lab orders and its lab requests. */
let legacyLabs: LabOrderDto[] = [];
let labRequests: PatientLabRequestSummaryDto[] = [];
const labMine = vi.fn(() => ok(labRequests));
/** Per test: the visit's referrals, certificates, follow-ups, care plan and summary (as the API answers them). */
let referralsData: ReferralDto[] = [];
let certificatesData: MedicalCertificateDto[] = [];
let followUpsData: AppointmentDto[] = [];
let carePlanData: PatientCarePlanDto = { available: false, items: [] } as unknown as PatientCarePlanDto;
let summaryData: ConsultationSummaryDto = { available: false } as unknown as ConsultationSummaryDto;

/** An API service whose every other method answers an empty list. */
function apiStub(overrides: Record<string, unknown>): unknown {
  return new Proxy(overrides, {
    get: (target, prop: string) => (prop in target ? target[prop] : () => ok([])),
  });
}

/** Every call made to a {@link recorded} API: which one, which method, with what. */
const apiCalls: Array<{ api: string; method: string; args: unknown[] }> = [];

/** `stub`, with each method call written to {@link apiCalls}. */
function recorded(api: string, stub: unknown): unknown {
  return new Proxy(stub as object, {
    get: (target, prop: string) => {
      const value = (target as Record<string, unknown>)[prop];
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        apiCalls.push({ api, method: prop, args });
        return (value as (...a: unknown[]) => unknown)(...args);
      };
    },
  });
}

/** The call was handed `{ passive: true }` (the API then sends `X-SD-Passive: 1`). */
const isPassive = (c: { args: unknown[] }) => c.args.some((a) => JSON.stringify(a) === '{"passive":true}');

@Component({ template: '' })
class Blank {}

describe('ConsultationCall (the dock)', () => {
  let fixture: ComponentFixture<ConsultationCall>;
  let el: HTMLElement;
  let wide = false;
  /** A phone held sideways (the control rail). */
  let rail = false;
  const originalMatchMedia = window.matchMedia;

  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      fixture.detectChanges();
      await fixture.whenStable();
      await new Promise((r) => setTimeout(r));
    }
    fixture.detectChanges();
  };
  const cmp = () => fixture.componentInstance as unknown as Record<string, (...a: unknown[]) => unknown>;
  const enter = async () => {
    cmp()['enterConsultation']();
    await settle();
  };
  const left = () => el.querySelector<HTMLElement>('[data-testid="call-left"]');
  /** The banners above the dock (measured on a phone held sideways). */
  const banners = () => el.querySelector<HTMLElement>('[data-testid="call-banners"]');
  /** The stage's column: beside the rail on a phone held sideways (display: contents otherwise). */
  const stageColumn = () => el.querySelector<HTMLElement>('[data-testid="call-stage-column"]');
  /** The rail's column height (RAIL_COLUMN): the screen under the top bar, less the banners. */
  const RAIL_COLUMN = 'h-[max(13.625rem,calc(100dvh_-_4.5rem_-_var(--rail-above,0px)))]';
  const controlLabels = () =>
    Array.from(el.querySelectorAll<HTMLButtonElement>('sd-call-controls [data-control]')).map((b) => b.getAttribute('aria-label'));

  beforeEach(async () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
      return { ...realResolved.call(this), timeZone: 'Africa/Lagos' };
    });
    window.matchMedia = vi.fn((query: string) => ({
      matches: query === '(min-width: 640px)' ? wide : query.includes('(orientation: landscape)') ? rail : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));

    await TestBed.configureTestingModule({
      imports: [ConsultationCall],
      providers: [
        provideRouter([{ path: '**', component: Blank }]),
        provideSupadocIcons(),
        { provide: API_CONFIG, useValue: { baseUrl: 'http://api.test' } },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: 'ap-1' }) } } },
        { provide: AuthService, useValue: { isAuthenticated: () => true, token: () => 'tok' } },
        { provide: SessionTimeoutService, useValue: { hold: vi.fn(), release: vi.fn() } },
        {
          provide: AppointmentsApi,
          useValue: recorded('appointments', apiStub({
            getMine: () => ok({ ...appointment, document_url: legacyUrl }),
            prescriptions: () => ok(issued),
            callToken: () =>
              ok({ app_id: 'app', channel: 'ap-1', uid: 1, token: null, expires_in: null, participants: [{ uid: 2, role: 'doctor', name: 'Bayo Ade' }] }),
            consents: () =>
              ok([{ type: 'ai_transcription', granted: true, by_role: 'patient', by_name: null, version: '1', decided_at: null }]),
            recordings: () => ok({ active: false }),
            presenceUrl: () => 'http://api.test/presence',
            consultationSummary: () => ok(summaryData),
            carePlan: () => ok(carePlanData),
            labOrders: () => ok(legacyLabs),
            referrals: () => ok(referralsData),
            certificates: () => ok(certificatesData),
            followUps: () => ok(followUpsData),
          })),
        },
        { provide: PatientApi, useValue: apiStub({ me: () => ok({ id: 'p-1', first_name: 'Ada', last_name: 'Obi' }), vitals: () => ok({ latest: [] }), healthProfile: () => ok({}) }) },
        { provide: DocumentsApi, useValue: apiStub({ list: () => ok(library) }) },
        { provide: PrescriptionsApi, useValue: apiStub({}) },
        { provide: LabRequestsApi, useValue: recorded('labs', apiStub({ mine: labMine })) },
        { provide: DocumentSharingApi, useValue: apiStub({ forAppointment: () => ok(access) }) },
        // The shared viewer, stubbed (the real one schedules an idle prefetch of its chunks, a 2 s timer in jsdom).
        { provide: DocumentViewerService, useValue: { open: vi.fn(), close: vi.fn(), isOpen: signal(false), registerCall: vi.fn(() => () => undefined) } },
      ],
    }).compileComponents();
  });

  afterEach(() => {
    fixture?.destroy();
    el?.remove();
    window.matchMedia = originalMatchMedia;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    wide = false;
    rail = false;
    legacyUrl = null;
    issued = [];
    library = [];
    legacyLabs = [];
    labRequests = [];
    labMine.mockClear();
    referralsData = [];
    certificatesData = [];
    followUpsData = [];
    carePlanData = { available: false, items: [] } as unknown as PatientCarePlanDto;
    summaryData = { available: false } as unknown as ConsultationSummaryDto;
    apiCalls.length = 0;
    vi.useRealTimers();
  });

  const create = async () => {
    fixture = TestBed.createComponent(ConsultationCall);
    el = fixture.nativeElement;
    document.body.appendChild(el);
    await settle();
  };

  it("shows the doctor's own time in the lobby when their clock differs", async () => {
    await create();
    expect(el.textContent).toContain("· 9:00 AM CST Dr Ade's time");
  });

  it('puts the controls in a bar under the video (no Chat), with your camera as the row tile below 640px', async () => {
    await create();
    await enter();
    const stage = el.querySelector('[data-testid="call-stage"]');
    const row = el.querySelector('[data-testid="call-control-row"]');
    expect(stage).toBeTruthy();
    expect(row).toBeTruthy();
    // Nothing but tiles and the name tag on the stage: the controls are outside it.
    expect(stage?.querySelector('sd-call-controls')).toBeNull();
    expect(row?.querySelector('sd-call-controls')).toBeTruthy();
    // No More: the controls, then (below sm) every setting, Invite and the theme included.
    expect(controlLabels()).toEqual([
      'Mute',
      'Stop video',
      'Captions',
      'End call',
      'Hide my preview',
      'Privacy & consent',
      'Invite someone to this call',
      'Light cockpit',
    ]);
    expect(el.querySelector('sd-call-controls [data-control="more"], sd-call-controls [role="menu"]')).toBeNull();
    expect(el.textContent).not.toContain('Chat');
    // Below sm: the self tile starts the row, and the stage has no picture-in-picture.
    expect(row?.firstElementChild?.tagName.toLowerCase()).toBe('sd-call-self-tile');
    const tiles = fixture.debugElement.query(By.directive(CallTilesComponent)).componentInstance as CallTilesComponent;
    expect(tiles.selfView()).toBe('external');
    // Nothing chosen on this device: the video fills the frame.
    expect(tiles.mainFit()).toBe('cover');
  });

  it('keeps your camera on the stage (picture-in-picture) from 640px up', async () => {
    wide = true;
    await create();
    await enter();
    expect(fixture.debugElement.query(By.directive(CallSelfTileComponent))).toBeNull();
    const tiles = fixture.debugElement.query(By.directive(CallTilesComponent)).componentInstance as CallTilesComponent;
    expect(tiles.selfView()).toBe('pip');
  });

  it('a phone held sideways (under 640px): the controls are a rail and your camera is the picture-in-picture', async () => {
    rail = true;
    await create();
    await enter();
    // The rail has no room for the 64px tile above Mute, Stop video, More and End.
    expect(fixture.debugElement.query(By.directive(CallSelfTileComponent))).toBeNull();
    const tiles = fixture.debugElement.query(By.directive(CallTilesComponent)).componentInstance as CallTilesComponent;
    expect(tiles.selfView()).toBe('pip');
    const controls = fixture.debugElement.query(By.directive(CallControlsComponent)).componentInstance as CallControlsComponent;
    expect(controls.layout()).toBe('rail');
  });

  it('a new prescription never covers the video: a bottom toast, but under the video beside the rail when held sideways', async () => {
    await create();
    await enter();
    const rx = { text: 'Dr Bayo Ade sent you a prescription (RX-1).', rx: { id: 'rx-1' } };
    (cmp()['rxToast'] as unknown as { set: (v: unknown) => void }).set(rx);
    await settle();
    expect(el.querySelector('[data-testid="call-rx-toast"]')?.className).toContain('bottom-3');
    expect(el.querySelector('[data-testid="call-rx-inline"]')).toBeNull();
    fixture.destroy();
    el.remove();

    rail = true;
    await create();
    await enter();
    const dock = el.querySelector<HTMLElement>('[data-testid="call-dock"]');
    const above = dock?.previousElementSibling ?? null;
    (cmp()['rxToast'] as unknown as { set: (v: unknown) => void }).set(rx);
    await settle();
    expect(el.querySelector('[data-testid="call-rx-toast"]')).toBeNull();
    const inline = el.querySelector<HTMLElement>('[data-testid="call-rx-inline"]');
    expect(inline?.getAttribute('role')).toBe('status');
    expect(inline?.className).not.toContain('fixed');
    expect(inline?.textContent).toContain('Dr Bayo Ade sent you a prescription (RX-1).');
    // In the stage's fixed-height column, after the video: it takes its room from the
    // video, so the column doesn't grow and the rail (and its End) stays put.
    const column = stageColumn();
    const stage = el.querySelector<HTMLElement>('[data-testid="call-stage"]');
    expect(column?.contains(inline)).toBe(true);
    expect(column?.className).toContain(RAIL_COLUMN);
    expect(stage?.parentElement).toBe(column);
    expect(stage && inline ? stage.compareDocumentPosition(inline) & Node.DOCUMENT_POSITION_FOLLOWING : 0).toBeTruthy();
    expect(inline?.closest('[data-testid="call-stage"]')).toBeNull(); // never on the video
    expect(inline?.closest('[data-testid="call-control-row"]')).toBeNull();
    // Nothing is added above the dock (the banners stay empty).
    expect(el.querySelector('[data-testid="call-dock"]')).toBe(dock);
    expect(dock?.previousElementSibling ?? null).toBe(above);
    expect(banners()?.childElementCount).toBe(0);
    expect(dock?.contains(inline)).toBe(true);
    // Still the light card styles.css guards when the portal is dark.
    expect(inline?.classList.contains('sd-rx-card')).toBe(true);
    expect(inline?.closest('.sd-call')).not.toBeNull();
    // In the page flow, never along the bottom edge: no scroll padding for it.
    expect(document.documentElement.style.scrollPaddingBottom).toBe('');
  });

  describe('a phone held sideways (the control rail)', () => {
    /** A ResizeObserver that reports the sizes a test gives it. */
    const observers: Array<{ el: Element; report: (height: number) => void; disconnect: ReturnType<typeof vi.fn> }> = [];

    beforeEach(() => {
      observers.length = 0;
      vi.stubGlobal(
        'ResizeObserver',
        class {
          readonly disconnect = vi.fn();
          constructor(private readonly cb: ResizeObserverCallback) {}
          observe(target: Element) {
            observers.push({
              el: target,
              report: (height) =>
                this.cb([{ target, contentRect: { height } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver),
              disconnect: this.disconnect,
            });
          }
          unobserve() {
            /* not needed */
          }
        },
      );
    });

    /** The observers still watching `target` (not disconnected). */
    const watching = (target: Element | null | undefined) =>
      observers.filter((o) => o.el === target && o.disconnect.mock.calls.length === 0);
    /** Turns the phone: the change the page listens for on the rail's media query. */
    const turn = async (sideways: boolean) => {
      rail = sideways;
      for (const { value } of vi.mocked(window.matchMedia).mock.results) {
        const mql = value as { media: string; addEventListener: ReturnType<typeof vi.fn> };
        if (!mql.media.includes('(orientation: landscape)')) continue;
        for (const [, onChange] of mql.addEventListener.mock.calls) (onChange as (e: { matches: boolean }) => void)({ matches: sideways });
      }
      await settle();
    };

    it('812×375: the video is in a fixed-height column with the rail beside it, captions under the video', async () => {
      rail = true;
      wide = true;
      await create();
      await enter();
      const dock = el.querySelector<HTMLElement>('[data-testid="call-dock"]');
      const column = stageColumn();
      const stage = el.querySelector<HTMLElement>('[data-testid="call-stage"]');
      const row = el.querySelector<HTMLElement>('[data-testid="call-control-row"]');
      // A row, not sticky: the stage's column, then the rail.
      expect(dock?.className).toContain('flex-row');
      expect(dock?.className).not.toContain('sticky');
      expect(column?.parentElement).toBe(dock);
      expect(column?.nextElementSibling).toBe(row);
      // A fixed height (the screen under the top bar, less any banner); the video fills its first row.
      expect(column?.className).toContain('grid');
      expect(column?.className).toContain('grid-rows-[minmax(0,1fr)]');
      expect(column?.className).toContain(RAIL_COLUMN);
      expect(stage?.parentElement).toBe(column);
      // The whole first row, beside the rail: no letterbox (the video fills it by default).
      expect(stage?.className).toContain('h-full');
      expect(stage?.className).toContain('w-full');
      expect(stage?.className).not.toContain('aspect-');
      expect(stage?.className).not.toContain('100dvh');
      // The rail is as wide as its columns (not a fixed 4.5rem), and its box is no inline-size container.
      expect(row?.className).not.toContain('w-[4.5rem]');
      // ...and exactly as tall as the stage's column, not its content: the controls measure
      // that height and pack into as many columns as it needs, so End stays on the screen.
      expect(row?.className).toContain(RAIL_COLUMN);
      expect(row?.className.split(/\s+/)).toContain('min-h-0');
      expect(row?.querySelector('sd-call-controls')?.parentElement?.className).not.toContain('container-type');
      expect(column?.querySelector('sd-call-controls')).toBeNull();
      expect(row?.querySelector('sd-call-controls')).not.toBeNull();
      // Nothing above the dock but the (empty, hidden) banners.
      expect(dock?.previousElementSibling).toBe(banners());
      expect(banners()?.className).toContain('empty:hidden');
      expect(banners()?.childElementCount).toBe(0);
      // Captions take a row under the video, in the same column (the column doesn't grow).
      cmp()['onControl']('captions');
      await settle();
      const captions = el.querySelector<HTMLElement>('[data-testid="call-captions"]');
      expect(captions?.parentElement).toBe(column);
      expect(stage && captions ? stage.compareDocumentPosition(captions) & Node.DOCUMENT_POSITION_FOLLOWING : 0).toBeTruthy();
      expect(column?.className).toContain(RAIL_COLUMN);
    });

    it('a banner above the dock (the device notice) is measured as --rail-above, which the column takes off its height', async () => {
      rail = true;
      wide = true;
      await create();
      await enter();
      const box = banners();
      const watch = observers.find((o) => o.el === box);
      expect(watch).toBeTruthy();
      // As the stylesheet lays it out (jsdom loads none): the left column is box-less
      // below lg, so the banners sit in the page's flex column, 12px (gap-3) apart.
      const column = left();
      const page = column?.parentElement;
      if (column) column.style.display = 'contents';
      if (page) page.style.rowGap = '12px';
      const notice = 'Your camera is blocked. Allow it in your browser to be seen.';
      (cmp()['deviceNotice'] as unknown as { set: (v: string) => void }).set(notice);
      await settle();
      // Above the dock, outside it (never over a tile).
      expect(box?.textContent).toContain(notice);
      expect(box?.nextElementSibling).toBe(el.querySelector('[data-testid="call-dock"]'));
      // Their height and the gap after them (the box-less left column skipped), rounded up.
      watch?.report(32.4);
      expect(left()?.style.getPropertyValue('--rail-above')).toBe('45px');
      expect(stageColumn()?.className).toContain('var(--rail-above,0px)');
      expect(left()?.contains(stageColumn())).toBe(true);
      (cmp()['deviceNotice'] as unknown as { set: (v: string) => void }).set('');
      await settle();
      expect(box?.childElementCount).toBe(0);
      watch?.report(0);
      expect(left()?.style.getPropertyValue('--rail-above')).toBe('0px');
      // The observer goes with the page.
      expect(watch?.disconnect).not.toHaveBeenCalled();
      fixture.destroy();
      expect(watch?.disconnect).toHaveBeenCalled();
    });

    it('sideways the dock is not watched, as the banners resize it (no ResizeObserver loop); upright it is again', async () => {
      await create();
      await enter();
      const dock = el.querySelector<HTMLElement>('[data-testid="call-dock"]');
      // Upright: the sticky dock's height is the page's scroll padding (2.4.11).
      expect(watching(dock)).toHaveLength(1);
      document.documentElement.style.scrollPaddingTop = '99px';
      await turn(true);
      expect(el.querySelector('[data-testid="call-dock"]')).toBe(dock);
      expect(dock?.className).toContain('flex-row');
      // Sideways: --rail-above (from the banners) resizes the dock, their sibling, so
      // a second observer on it would be skipped at that depth: a loop error on every
      // banner. It isn't sticky there, so there is nothing to pad.
      expect(watching(dock)).toHaveLength(0);
      expect(watching(banners())).toHaveLength(1);
      expect(document.documentElement.style.scrollPaddingTop).toBe('');
      await turn(false);
      expect(dock?.className).toContain('sticky');
      expect(watching(dock)).toHaveLength(1);
    });

    it('held upright, a dock taller than 60% of the screen scrolls with the page (no scroll padding); shorter, it sticks', async () => {
      // As the stylesheet lays it out (jsdom loads none): the dock's `sticky` class.
      const sheet = document.createElement('style');
      sheet.textContent = '.sticky { position: sticky; }';
      document.head.appendChild(sheet);
      vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
        return this === document.documentElement ? 667 : 0;
      });
      try {
        await create();
        await enter();
        const dock = el.querySelector<HTMLElement>('[data-testid="call-dock"]') as HTMLElement;
        let height = 454;
        vi.spyOn(dock, 'getBoundingClientRect').mockImplementation(
          () => ({ x: 0, y: 0, top: 0, left: 0, width: 351, right: 351, height, bottom: height, toJSON: () => ({}) }) as DOMRect,
        );
        const watch = watching(dock)[0];
        expect(watch).toBeTruthy();
        // 454px of a 667px screen (68%: the bar on three rows): it scrolls away, nothing to pad.
        watch.report(height);
        expect(dock.style.position).toBe('static');
        expect(dock.className).toContain('sticky');
        expect(document.documentElement.style.scrollPaddingTop).toBe('');
        // 380px (57%): it sticks, and focus is kept clear of it (2.4.11).
        height = 380;
        watch.report(height);
        expect(dock.style.position).toBe('');
        expect(document.documentElement.style.scrollPaddingTop).toBe('380px');
        // Turned sideways (a rail, never sticky): the dock is let go of.
        height = 454;
        watch.report(height);
        await turn(true);
        expect(dock.style.position).toBe('');
      } finally {
        sheet.remove();
      }
    });

    it('held upright: the banners and the stage column have no box (the layout is as before)', async () => {
      await create();
      await enter();
      (cmp()['deviceNotice'] as unknown as { set: (v: string) => void }).set('Your microphone is blocked.');
      await settle();
      expect(banners()?.className).toBe('contents');
      expect(stageColumn()?.className).toBe('contents');
      const dock = el.querySelector<HTMLElement>('[data-testid="call-dock"]');
      expect(dock?.className).toContain('sticky');
      expect(el.querySelector('[data-testid="call-stage"]')?.className).toContain('aspect-[4/3]');
      const notice = banners()?.querySelector('p[role="status"]');
      expect(notice?.textContent).toContain('Your microphone is blocked.');
      expect(notice && dock ? notice.compareDocumentPosition(dock) & Node.DOCUMENT_POSITION_FOLLOWING : 0).toBeTruthy();
    });
  });

  it('asks to check a latest reading above its usual range on the vitals tiles', async () => {
    await create();
    await enter();
    (cmp()['vitals'] as unknown as { set: (v: unknown[]) => void }).set([
      {
        key: 'temperature', label: 'Temperature', value: '46', unit: '°C', taken_at: new Date().toISOString(),
        source: 'self_reported', source_label: 'Self-reported', recorded_by: 'patient', stale: false,
        flag: { level: 'critical', label: 'Very high', advice: 'Seek urgent medical attention', out_of_range: true, usual_max: '45' },
      },
      {
        key: 'heart_rate', label: 'Heart rate', value: '72', unit: 'beats/min', taken_at: new Date().toISOString(),
        source: 'self_reported', source_label: 'Self-reported', recorded_by: 'patient', stale: false,
        flag: { level: 'normal', label: 'Normal', advice: null, out_of_range: false, usual_max: null },
      },
    ]);
    await settle();
    const section = el.querySelector('[aria-labelledby="call-vitals-title"]');
    expect(section?.textContent).toContain('46');
    expect(section?.textContent?.match(/Higher than usual — please check/g)?.length).toBe(1);
  });

  it('announces recording in words from a status region that is always there', async () => {
    await create();
    await enter();
    const region = el.querySelector('[data-testid="call-recording-status"]');
    expect(region?.getAttribute('role')).toBe('status');
    expect(region?.textContent?.trim()).toBe('');
    (cmp()['recordingActive'] as unknown as { set: (v: boolean) => void }).set(true);
    await settle();
    expect(el.querySelector('[data-testid="call-recording-status"]')).toBe(region);
    expect(region?.textContent?.trim()).toBe('This consultation is being recorded.');
  });

  it('makes the stage and its bar as wide as the notes card below: no 16:9 cap, no centring', async () => {
    await create();
    await enter();
    const dock = el.querySelector<HTMLElement>('[data-testid="call-dock"]');
    const stage = el.querySelector<HTMLElement>('[data-testid="call-stage"]');
    const row = el.querySelector<HTMLElement>('[data-testid="call-control-row"]');
    const notes = el.querySelector<HTMLElement>('section#call-notes');
    // The dock and the notes card share the left column (the page's content below lg).
    expect(dock?.parentElement).toBe(left());
    expect(notes?.parentElement).toBe(left());
    for (const c of ['mx-auto', 'lg:mx-auto', 'max-w-', 'lg:w-[min(']) expect(dock?.className).not.toContain(c);
    // Full width; 4:3 (16:9 from sm) of it up to 45dvh, and from lg 16:9 giving way to the notes card.
    expect(stage?.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['w-full', 'aspect-[4/3]', 'max-h-[45dvh]', 'sm:aspect-video', 'lg:max-h-none', 'lg:min-h-0']),
    );
    expect(stage?.className).not.toContain('max-w-');
    expect(stage?.className).not.toContain('mx-auto');
    expect(dock?.className).toContain('lg:min-h-0');
    // The launcher card keeps its own height (it no longer stretches or scrolls).
    expect(notes?.className.split(/\s+/)).toContain('shrink-0');
    for (const c of ['lg:flex-1', 'lg:min-h-[8rem]', 'lg:overflow-y-auto']) expect(notes?.className).not.toContain(c);
    expect(row?.className).toContain('shrink-0');
    expect(left()?.style.getPropertyValue('--reserve')).toBe('');
    // Captions keep their strip (the stage gives way).
    cmp()['onControl']('captions');
    await settle();
    expect(el.querySelector('[data-testid="call-captions"]')?.className).toContain('shrink-0');
  });

  describe('the dock’s settings (no More)', () => {
    const controlsCmp = () => fixture.debugElement.query(By.directive(CallControlsComponent)).componentInstance as CallControlsComponent;
    const tiles = () => fixture.debugElement.query(By.directive(CallTilesComponent)).componentInstance as CallTilesComponent;
    const button = (id: string) => el.querySelector<HTMLButtonElement>(`sd-call-controls [data-control="${id}"]`) as HTMLButtonElement;
    const radio = (value: string) => el.querySelector<HTMLButtonElement>(`sd-call-controls [data-choice="fit"][data-value="${value}"]`) as HTMLButtonElement;
    const clear = () => {
      for (const k of ['videomed.call.fit', 'videomed.call.self', 'videomed.call.theme']) localStorage.removeItem(k);
    };
    beforeEach(clear);
    afterEach(clear);

    it('lists the video fit, your preview and Privacy, with Invite and the theme below sm', async () => {
      await create();
      await enter();
      expect(controlsCmp().settings().map((s) => s.id)).toEqual(['fit', 'self', 'privacy', 'invite', 'theme']);
      expect(controlsCmp().controls().some((c) => (c.id as string) === 'more')).toBe(false);
      const group = el.querySelector('sd-call-controls [role="radiogroup"]');
      expect(group?.getAttribute('aria-label')).toBe('Video fit');
      expect([...(group?.querySelectorAll('[role="radio"]') ?? [])].map((r) => [r.getAttribute('aria-label'), r.getAttribute('aria-checked')])).toEqual([
        ['Fit whole picture', 'false'],
        ['Fill the frame', 'true'],
      ]);
      expect(button('self').getAttribute('aria-pressed')).toBe('false');
      expect(button('theme').getAttribute('aria-pressed')).toBe('false');
      expect(button('privacy').hasAttribute('aria-pressed')).toBe(false);
    });

    it('from sm the top bar has Invite and the theme: the dock does not repeat them', async () => {
      wide = true;
      await create();
      await enter();
      expect(controlsCmp().settings().map((s) => s.id)).toEqual(['fit', 'self', 'privacy']);
    });

    it('Fit / Fill switch the video fit and remember it; a saved choice is honoured', async () => {
      await create();
      await enter();
      expect(tiles().mainFit()).toBe('cover');
      radio('contain').click();
      await settle();
      expect(tiles().mainFit()).toBe('contain');
      expect(radio('contain').getAttribute('aria-checked')).toBe('true');
      expect(localStorage.getItem('videomed.call.fit')).toBe('contain');
      // A new call on this device keeps it.
      fixture.destroy();
      el.remove();
      await create();
      await enter();
      expect(tiles().mainFit()).toBe('contain');
      radio('cover').click();
      await settle();
      expect(tiles().mainFit()).toBe('cover');
      expect(localStorage.getItem('videomed.call.fit')).toBe('cover');
    });

    it('Hide my preview, Light cockpit, Privacy and Invite are buttons in the bar', async () => {
      await create();
      await enter();
      button('self').click();
      await settle();
      expect(tiles().selfView()).toBe('hidden');
      expect(button('self').getAttribute('aria-pressed')).toBe('true');
      expect(button('self').getAttribute('aria-label')).toBe('Hide my preview');
      button('theme').click();
      await settle();
      expect(el.querySelector('.sd-call')?.getAttribute('data-theme')).toBe('light');
      expect(button('theme').getAttribute('aria-pressed')).toBe('true');
      button('privacy').click();
      await settle();
      expect(document.activeElement?.id).toBe('call-privacy-title');
      // (The invite dialog itself is tested on its own: here, that Invite opens it.)
      const invite = vi.spyOn(fixture.componentInstance as unknown as { invite: () => void }, 'invite').mockImplementation(() => undefined);
      button('invite').click();
      expect(invite).toHaveBeenCalledTimes(1);
    });
  });

  it('shows real connection quality from Agora (the worse of up and down)', async () => {
    await create();
    await enter();
    const client = agora.clients[agora.clients.length - 1];
    expect(el.querySelector('sd-call-quality [role="img"]')?.getAttribute('aria-label')).toBe('Connection: Checking…');
    client.handlers['network-quality']({ uplinkNetworkQuality: 1, downlinkNetworkQuality: 4 });
    await settle();
    expect(el.querySelector('sd-call-quality [role="img"]')?.getAttribute('aria-label')).toBe('Connection: Poor');
    expect(el.textContent).toContain('Encrypted');
    expect(el.textContent).not.toContain('Secure & Encrypted');
  });

  it('Upload & share: the file shows as shared, is announced, and the doctor is nudged over Agora', async () => {
    await create();
    await enter();
    const upload = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Upload & share'));
    expect(upload).toBeTruthy();
    const doc = {
      id: 'd-9',
      title: 'Scan',
      extension: 'pdf',
      document_type: 'lab',
      type_label: 'Lab result',
      created_at: '2026-11-04T15:05:00Z',
      share_outcome: 'shared',
      shared_with: [],
      share_ended_for: [],
    } as unknown as UploadedDocumentDto;
    cmp()['onCallUpload'](doc);
    await settle();
    expect(el.textContent).toContain('Dr Bayo Ade can now see “Scan”.');
    const client = agora.clients[agora.clients.length - 1];
    expect(client.sendStreamMessage).toHaveBeenCalledTimes(1);
    const payload = client.sendStreamMessage.mock.calls[0][0] as Uint8Array;
    expect(new TextDecoder().decode(payload)).toBe('sd:v1:docs');
  });

  it('does not nudge when the upload was kept private', async () => {
    await create();
    await enter();
    cmp()['onCallUpload']({ id: 'd-8', title: 'Note', extension: 'pdf', share_outcome: 'sharing_unavailable', shared_with: [], share_ended_for: [], created_at: '2026-11-04T15:05:00Z', document_type: 'lab' } as unknown as UploadedDocumentDto);
    await settle();
    expect(el.textContent).toContain("Saved to your records. Sharing is unavailable right now, so Dr Bayo Ade can't see it yet.");
    expect(agora.clients[agora.clients.length - 1].sendStreamMessage).not.toHaveBeenCalled();
  });

  describe('background requests are passive; the call hold keeps a live call alive', () => {
    const session = () => TestBed.inject(SessionTimeoutService) as unknown as { hold: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
    /** The fetches (heartbeats) made since `from`, with their headers. */
    const beats = (from: number) =>
      (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
        .slice(from)
        .map((c) => ({ url: String(c[0]), headers: ((c[1] as RequestInit | undefined)?.headers ?? {}) as Record<string, string> }));
    const fetchCount = () => (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    const client = () => agora.clients[agora.clients.length - 1];
    /** Requests (not URL builders) recorded since `from`. */
    const requestsSince = (from: number) => apiCalls.slice(from).filter((c) => c.method !== 'presenceUrl');

    it('the page’s first loads count; every timed in-call request (polls, metrics, heartbeat, token renewal) is passive', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      await create();
      // Opening the consultation is the patient's own doing: those loads count.
      expect(apiCalls.some((c) => c.method === 'getMine')).toBe(true);
      expect(apiCalls.some((c) => c.method === 'prescriptions')).toBe(true);
      expect(apiCalls.filter(isPassive)).toEqual([]);

      await enter();
      expect(session().hold).toHaveBeenCalledWith('call');
      const from = apiCalls.length;
      const fromFetch = fetchCount();
      vi.advanceTimersByTime(30_000);
      await settle();

      const timed = requestsSince(from);
      const methods = new Set(timed.map((c) => c.method));
      for (const m of ['recordings', 'reportMetric', 'prescriptions', 'labOrders', 'carePlan', 'referrals', 'certificates', 'followUps', 'consultationSummary', 'getMine', 'mine']) {
        expect(methods.has(m)).toBe(true);
      }
      expect(timed.filter((c) => !isPassive(c))).toEqual([]);

      // The heartbeat: the patient's bearer token, and passive.
      const hb = beats(fromFetch).filter((b) => b.url === 'http://api.test/presence');
      expect(hb.length).toBe(2); // 15 and 30 s
      expect(hb.every((b) => b.headers['X-SD-Passive'] === '1' && b.headers['Authorization'] === 'Bearer tok')).toBe(true);

      // Agora's hourly token renewal is the SDK's, not the patient's: passive.
      const before = apiCalls.length;
      await client().handlers['token-privilege-will-expire']();
      await settle();
      expect(requestsSince(before)).toEqual([{ api: 'appointments', method: 'callToken', args: ['ap-1', { passive: true }] }]);
    });

    it('captions: turning them on reads at once (the patient’s request); the 6 s poll is passive', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      await create();
      await enter();
      const from = apiCalls.length;
      cmp()['onControl']('captions');
      await settle();
      expect(requestsSince(from).filter((c) => c.method === 'transcript')).toEqual([{ api: 'appointments', method: 'transcript', args: ['ap-1', undefined] }]);
      const polls = apiCalls.length;
      vi.advanceTimersByTime(12_000);
      await settle();
      const transcript = requestsSince(polls).filter((c) => c.method === 'transcript');
      expect(transcript.length).toBe(2);
      expect(transcript.every(isPassive)).toBe(true);
    });

    it('the doctor leaving releases the hold and stops the in-call polls; the heartbeat goes on, passive', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      await create();
      await enter();
      client().handlers['user-joined']({ uid: 2 });
      await settle();
      expect(session().release).not.toHaveBeenCalled();
      client().handlers['user-left']({ uid: 2 });
      await settle();
      expect(session().release).toHaveBeenCalledWith('call');

      const from = apiCalls.length;
      const fromFetch = fetchCount();
      vi.advanceTimersByTime(60_000);
      await settle();
      // No more recording / clinical / metrics polls once the consultation is over…
      expect(requestsSince(from).filter((c) => ['recordings', 'reportMetric', 'prescriptions'].includes(c.method))).toEqual([]);
      // …and nothing timed counts as activity: an ended call left open idles out.
      expect(requestsSince(from).filter((c) => !isPassive(c))).toEqual([]);
      const hb = beats(fromFetch).filter((b) => b.url === 'http://api.test/presence');
      expect(hb.length).toBeGreaterThan(0);
      expect(hb.every((b) => b.headers['X-SD-Passive'] === '1')).toBe(true);
    });
  });

  describe('documents in the shared viewer (§3)', () => {
    /** The shared viewer, stubbed: what the page opens and registers. */
    const viewer = {
      open: vi.fn(),
      close: vi.fn(),
      registerCall: vi.fn(),
      isOpen: signal(false),
    };
    const unregister = vi.fn();
    let ctx: ViewerCallContext | null = null;

    const libDoc = (id: string, title: string, type: string): MedicalDocumentDto =>
      ({
        id,
        patient_id: 'p-1',
        uploader_role: 'patient',
        uploader_name: 'Ada Obi',
        appointment_id: null,
        document_type: type,
        custom_type: null,
        type_label: 'Report',
        title,
        extension: 'pdf',
        mime_type: 'application/pdf',
        size_bytes: 100,
        size_label: '100 B',
        created_at: '2026-11-03T10:00:00Z',
      }) as MedicalDocumentDto;
    const prescription = (id: string): PrescriptionDto =>
      ({
        id,
        number: `GVM-RX-${id}`,
        status: 'active',
        appointment_id: 'ap-1',
        patient_id: 'p-1',
        prescriber: 'Dr Bayo Ade',
        items_count: 1,
        valid_until: null,
        sent_at: '2026-11-04T15:10:00Z',
        created_at: '2026-11-04T15:05:00Z',
        items: [],
      }) as unknown as PrescriptionDto;
    const lastOpen = () => viewer.open.mock.calls[viewer.open.mock.calls.length - 1] as [readonly ViewerSource[], ViewerOpenOptions];
    const sig = <T,>(name: string) => cmp()[name] as unknown as { (): T; set(v: T): void };
    const peerTrack = () => (cmp()['peer'] as unknown as { track(): unknown }).track();
    /** A fake Agora remote video track. */
    const track = (name: string) => ({ name, play: vi.fn(), stop: vi.fn() });
    const stage = () => fixture.debugElement.query(By.directive(CallTilesComponent)).componentInstance as CallTilesComponent;
    /** Renders a registered template (the band or the PiP) the way the viewer's outlet does. */
    const render = (tpl: ViewerCallContext['bar'] | null): EmbeddedViewRef<unknown> => {
      const view = (tpl as ViewerCallContext['bar']).createEmbeddedView({});
      view.detectChanges();
      return view;
    };
    const nodesOf = (view: EmbeddedViewRef<unknown>) => view.rootNodes.filter((n): n is HTMLElement => n instanceof HTMLElement);
    const textOf = (view: EmbeddedViewRef<unknown>) =>
      nodesOf(view)
        .map((n) => n.textContent ?? '')
        .join(' ')
        .replace(/\s+/g, ' ');
    const query = (view: EmbeddedViewRef<unknown>, sel: string) =>
      nodesOf(view)
        .map((n) => (n.matches(sel) ? n : n.querySelector<HTMLElement>(sel)))
        .find((n): n is HTMLElement => !!n);

    beforeEach(() => {
      viewer.open.mockReset();
      viewer.isOpen.set(false);
      viewer.close.mockReset().mockImplementation(() => viewer.isOpen.set(false));
      unregister.mockReset();
      ctx = null;
      viewer.registerCall.mockReset().mockImplementation((c: ViewerCallContext) => {
        ctx = c;
        return unregister;
      });
      TestBed.overrideProvider(DocumentViewerService, { useValue: viewer });
      vi.spyOn(window, 'open').mockReturnValue(null);
    });

    it('registers the call once (live = in the call), and unregisters with the page', async () => {
      await create();
      expect(viewer.registerCall).toHaveBeenCalledTimes(1);
      const c = ctx as unknown as ViewerCallContext;
      expect(c.peerName()).toBe('Dr Ade');
      expect(c.tone()).toBe('dark');
      expect(c.live()).toBe(false);
      expect(c.sharingScreen()).toBe(false);
      expect(c.recording()).toBe(false);
      await enter();
      expect(c.live()).toBe(true);
      sig<boolean>('screenOn').set(true);
      sig<boolean>('recordingActive').set(true);
      expect(c.sharingScreen()).toBe(true);
      expect(c.recording()).toBe(true);
      sig<boolean>('left').set(true);
      expect(c.live()).toBe(false);
      expect(unregister).not.toHaveBeenCalled();
      fixture.destroy();
      expect(unregister).toHaveBeenCalledTimes(1);
    });

    it('a record’s eye opens the viewer over the filtered records list (never a tab)', async () => {
      library = [
        libDoc('d-1', 'Chest X-ray', 'xray_report'),
        libDoc('d-2', 'Blood count', 'blood_test_report'),
        libDoc('d-3', 'Lipids', 'laboratory_test_report'),
      ];
      await create();
      await enter();
      sig<string>('docsTab').set('labs');
      await settle();
      expect(el.querySelector('button[aria-label="Open Chest X-ray"]')).toBeNull();
      const eye = el.querySelector<HTMLButtonElement>('button[aria-label="Open Lipids"]') as HTMLButtonElement;
      eye.click();
      expect(viewer.open).toHaveBeenCalledTimes(1);
      const [sources, options] = lastOpen();
      expect(sources.map((s) => s.key)).toEqual(['doc:d-2', 'doc:d-3']);
      expect(sources.every((s) => s.policy === 'owner')).toBe(true);
      expect(options.index).toBe(1);
      expect(options.opener).toBe(eye);
      // Opener gone: the Documents & Records heading.
      expect(options.fallbackFocus?.()?.id).toBe('call-docs-title');
      expect(window.open).not.toHaveBeenCalled();
    });

    it('pills (item 5): the "Show documents" filter is the S pill with the solid look, state from aria-pressed (the same pill as the doctor’s)', async () => {
      library = [libDoc('d-1', 'Chest X-ray', 'xray_report'), libDoc('d-2', 'Blood count', 'blood_test_report')];
      await create();
      await enter();
      const row = el.querySelector<HTMLElement>('[role="group"][aria-label="Show documents"]');
      expect(row?.className).toBe('sd-pill-row-wrap mb-3');
      const pills = Array.from(row?.querySelectorAll<HTMLButtonElement>('button') ?? []);
      expect(pills.length).toBeGreaterThan(1);
      for (const p of pills) expect(p.className.split(/\s+/).sort()).toEqual(['sd-filter-solid', 'sd-pill', 'sd-pill-s']);
      expect(pills.map((p) => p.getAttribute('aria-pressed'))).toEqual(pills.map((_, i) => String(i === 0)));
      pills[1].click();
      await settle();
      expect(pills.map((p) => p.getAttribute('aria-pressed'))).toEqual(pills.map((_, i) => String(i === 1)));
      // The cockpit keeps no pill-radius element outside the standard (role f icon capsules use rounded-full).
      expect(el.querySelector('.rounded-pill')).toBeNull();
    });

    it('an older url-only booking attachment has no eye and says how to get a copy', async () => {
      legacyUrl = '/uploads/other/legacy.pdf';
      library = [libDoc('d-1', 'Chest X-ray', 'xray_report')];
      await create();
      await enter();
      expect(el.textContent).toContain('Booking attachment');
      expect(el.querySelector('button[aria-label="Open Booking attachment"]')).toBeNull();
      expect(el.textContent).toContain("This older attachment can't be opened here. Contact support for a copy.");
      expect(el.querySelector('button[aria-label="Open Chest X-ray"]')).not.toBeNull();
      expect(window.open).not.toHaveBeenCalled();
    });

    it('a prescription’s View and the new-prescription toast open the viewer (no fallback link)', async () => {
      issued = [prescription('1'), prescription('2')];
      await create();
      await enter();
      el.querySelector<HTMLButtonElement>('[data-ws-launcher="prescriptions"]')?.click();
      await settle();
      const view = el.querySelector<HTMLButtonElement>('button[aria-label="View prescription GVM-RX-2"]') as HTMLButtonElement;
      view.click();
      let [sources, options] = lastOpen();
      expect(sources.map((s) => s.key)).toEqual(['rx:1', 'rx:2']);
      expect(options.index).toBe(1);
      expect(options.opener).toBe(view);
      expect(typeof sources[1].download).toBe('function');
      sig<unknown>('rxToast').set({ text: 'Dr Bayo Ade sent you prescription GVM-RX-1', rx: issued[0] });
      await settle();
      Array.from(el.querySelectorAll<HTMLButtonElement>('[data-testid="call-rx-toast"] button'))
        .find((b) => b.textContent?.includes('View prescription'))
        ?.click();
      expect(viewer.open).toHaveBeenCalledTimes(2);
      [sources, options] = lastOpen();
      expect(options.index).toBe(0);
      expect(el.textContent).not.toContain('Open the prescription');
      expect(el.querySelector('a[target="_blank"][href*="prescriptions"]')).toBeNull();
      expect(window.open).not.toHaveBeenCalled();
    });

    it('the band: Back to call, who and how long, Mute and End, and the call’s alerts', async () => {
      await create();
      await enter();
      const c = ctx as unknown as ViewerCallContext;
      let band = render(c.bar);
      let text = textOf(band);
      expect(text).toContain('Back to call');
      expect(text).toContain('Dr Ade ·');
      expect(text).toContain('Mute');
      // Their labels are screen-reader-only in the viewer's one-row band on a phone held sideways (§1.3.5).
      expect(nodesOf(band).flatMap((n) => Array.from(n.querySelectorAll('[data-band-label]'))).map((l) => l.textContent?.trim())).toEqual(['Back to call', 'Mute']);
      expect(query(band, 'button[aria-label="End call"]')).toBeTruthy();
      nodesOf(band)
        .find((n) => n.textContent?.includes('Back to call'))
        ?.click();
      expect(viewer.close).toHaveBeenCalledTimes(1);
      band.destroy();
      sig<boolean>('recordingActive').set(true);
      sig<boolean>('reconnecting').set(true);
      sig<unknown>('rxToast').set({ text: 'x', rx: prescription('7') });
      band = render(c.bar);
      text = textOf(band);
      expect(text).toContain('Recording');
      expect(text).toContain('Reconnecting to the call…');
      expect(text).toContain('New prescription');
      expect(query(band, 'button[aria-label="View prescription GVM-RX-7"]')).toBeTruthy();
      band.destroy();
      // Out of the live call: no Mute or End.
      sig<boolean>('left').set(true);
      band = render(c.bar);
      expect(textOf(band)).not.toContain('Mute');
      expect(query(band, 'button[aria-label="End call"]')).toBeUndefined();
      band.destroy();
      // The PiP template is the doctor's peer tile.
      const pip = render(c.peer);
      expect(nodesOf(pip).some((n) => n.tagName.toLowerCase() === 'sd-call-peer-tile')).toBe(true);
      expect(CallPeerTileComponent).toBeTruthy();
      // Under the doctor's full name, as on the stage: initials "BA", not "A" from the band's "Dr Ade".
      expect(query(pip, '.sdv-peer-off span')?.textContent?.trim()).toBe('BA');
      expect(query(pip, '[role="img"]')?.getAttribute('aria-label')).toBe('Dr Bayo Ade, live video. Camera off');
      pip.destroy();
    });

    it('hands the doctor’s video to the PiP (stage first), routes re-publishes to it, and takes it back on close', async () => {
      await create();
      await enter();
      const client = agora.clients[agora.clients.length - 1];
      const doctorCam = track('doctor-1');
      const guestCam = track('guest');
      await client.handlers['user-published']({ uid: 2, videoTrack: doctorCam }, 'video');
      await client.handlers['user-published']({ uid: 3, videoTrack: guestCam }, 'video');
      await settle();
      const tiles = stage();
      const log: string[] = [];
      vi.spyOn(tiles, 'detach').mockImplementation((uid) => {
        log.push(`detach:${uid}:${peerTrack() ? 'tile' : 'none'}`);
      });
      const attach = vi.spyOn(tiles, 'attach').mockImplementation((uid, t) => {
        log.push(`attach:${uid}:${(t as unknown as { name: string }).name}`);
      });
      const c = ctx as unknown as ViewerCallContext;
      c.willOpen();
      // Off the stage before the tile gets it: never in two places.
      expect(log).toEqual(['detach:2:none']);
      expect(peerTrack()).toBe(doctorCam);

      // A re-publish while open goes to the tile, not the stage.
      const doctorCam2 = track('doctor-2');
      await client.handlers['user-published']({ uid: 2, videoTrack: doctorCam2 }, 'video');
      expect(peerTrack()).toBe(doctorCam2);
      expect(attach).not.toHaveBeenCalled();

      // The stage tiles re-created while open (rotation, the rail): every video but the doctor's.
      const recreated = { attach: vi.fn() };
      cmp()['replayOnStage'](recreated);
      const replayed = recreated.attach.mock.calls.map((a) => String(a[0]));
      expect(replayed).not.toContain('2');
      expect(replayed).toContain('3');

      // An unpublish while open clears the tile's track (the stage is not touched).
      client.handlers['user-unpublished']({ uid: 2 }, 'video');
      expect(peerTrack()).toBeNull();
      expect(log).toEqual(['detach:2:none']);
      await client.handlers['user-published']({ uid: 2, videoTrack: doctorCam2 }, 'video');

      // Close: the tile is gone (and stopped), then the stage plays the current track, once.
      c.didClose();
      expect(peerTrack()).toBeNull();
      expect(log).toEqual(['detach:2:none', 'attach:2:doctor-2']);
      // From now on the stage gets the doctor again.
      await client.handlers['user-published']({ uid: 2, videoTrack: doctorCam }, 'video');
      expect(log[log.length - 1]).toBe('attach:2:doctor-1');
    });

    it('the call ending closes the viewer: the other side ending it, or the patient leaving', async () => {
      await create();
      await enter();
      expect(viewer.close).not.toHaveBeenCalled();
      sig<string>('status').set('ended');
      await settle();
      expect(viewer.close).toHaveBeenCalledTimes(1);
      sig<string>('status').set('in-call');
      await settle();
      sig<boolean>('left').set(true);
      await settle();
      expect(viewer.close).toHaveBeenCalledTimes(2);
    });

    it('the call ending under the viewer focuses the ended screen, though the opener is still on the page (§3.5)', async () => {
      library = [libDoc('d-3', 'Lipids', 'laboratory_test_report')];
      await create();
      await enter();
      const eye = el.querySelector<HTMLButtonElement>('button[aria-label="Open Lipids"]') as HTMLButtonElement;
      eye.focus();
      eye.click();
      expect(viewer.open).toHaveBeenCalledTimes(1);
      viewer.isOpen.set(true);
      // The doctor ends the consultation while the patient reads.
      sig<string>('endedReason').set('completed');
      sig<string>('status').set('ended');
      await settle();
      expect(viewer.close).toHaveBeenCalledTimes(1);
      expect(eye.isConnected).toBe(true);
      const ended = el.querySelector<HTMLElement>('[data-testid="call-ended"]') as HTMLElement;
      expect(document.activeElement).toBe(ended);
      // Its name is the ended message, so focusing it says what happened.
      const label = document.getElementById(ended.getAttribute('aria-labelledby') ?? '');
      expect(label?.textContent?.trim()).toBe('Your consultation has ended.');
    });

    it('the call ending with no viewer open leaves focus where it is', async () => {
      library = [libDoc('d-3', 'Lipids', 'laboratory_test_report')];
      await create();
      await enter();
      const eye = el.querySelector<HTMLButtonElement>('button[aria-label="Open Lipids"]') as HTMLButtonElement;
      eye.focus();
      sig<string>('status').set('ended');
      await settle();
      expect(document.activeElement).toBe(eye);
    });

    it('the band’s new-prescription View and End meet contrast on the ink band', async () => {
      await create();
      await enter();
      sig<unknown>('rxToast').set({ text: 'x', rx: prescription('7') });
      const band = render((ctx as unknown as ViewerCallContext).bar);
      const view = query(band, 'button[aria-label="View prescription GVM-RX-7"]') as HTMLElement;
      // frost on #1c2b3a is 10.27:1 (sky was 4.46:1, under 4.5 for its caption text).
      expect(view.classList).toContain('text-frost');
      expect(view.classList).not.toContain('text-sky');
      // End is icon-only: a white "End" on bg-alert would be 4.23:1; the white icon needs 3:1.
      const end = query(band, 'button[aria-label="End call"]') as HTMLElement;
      expect(end.classList).toContain('bg-alert');
      expect(end.textContent?.trim()).toBe('');
      band.destroy();
    });
  });

  describe('the labs tab (lab requests)', () => {
    const labRow = (over: Partial<PatientLabRequestSummaryDto> = {}): PatientLabRequestSummaryDto =>
      ({
        id: 'lr-1',
        number: 'GVM-REQ-20261101-00001',
        status: 'awaiting_consent',
        priority: 'urgent',
        doctor: { id: 'sp-1', name: 'Bayo Ade', specialty: 'Cardiology' },
        items_count: 3,
        results_count: 0,
        reviewed: false,
        awaiting_review: false,
        appointment_id: 'ap-1',
        sent_at: '2026-11-01T15:30:00Z',
        valid_until: '2026-12-01',
        expires_at: '2026-12-01T23:00:00Z',
        last_activity_at: '2026-11-01T15:30:00Z',
        ...over,
      }) as PatientLabRequestSummaryDto;

    it('is "Lab requests": the visit’s requests (number, chip, test count); legacy orders read "Ordered"', async () => {
      labRequests = [labRow()];
      legacyLabs = [
        { id: 'lo-1', appointment_id: 'ap-1', tests: ['FBC'], notes: null, status: 'pending', author: 'Bayo Ade', created_at: '2026-10-01T10:00:00Z' } as unknown as LabOrderDto,
      ];
      await create();
      await enter();
      expect(el.textContent).toContain('Lab requests');
      expect(el.textContent).not.toContain('Lab Orders');
      el.querySelector<HTMLButtonElement>('[data-ws-launcher="labs"]')?.click();
      await settle();
      // The page's first load: no options (active).
      expect(labMine).toHaveBeenCalledWith({ appointment_id: 'ap-1', per_page: 50 }, undefined);
      const row = el.querySelector<HTMLElement>('[data-testid="call-lab-request"]') as HTMLElement;
      expect(row.textContent).toContain('GVM-REQ-20261101-00001');
      expect(row.textContent).toContain('Action needed');
      expect(row.textContent).toContain('3 tests');
      expect(el.textContent).toContain('Open Lab Tests after your call to review and accept.');
      // No way out of the call from here: the row is not a link.
      expect(row.querySelector('a')).toBeNull();
      const legacy = el.querySelector<HTMLElement>('[data-testid="call-lab-order-status"]') as HTMLElement;
      expect(legacy.textContent?.trim()).toBe('Ordered');
      expect(legacy.textContent).not.toContain('pending');
    });

    it('says so when the visit has no lab requests', async () => {
      await create();
      await enter();
      el.querySelector<HTMLButtonElement>('[data-ws-launcher="labs"]')?.click();
      await settle();
      expect(el.textContent).toContain('No lab requests for this consultation yet.');
    });
  });

  describe('the consultation notes: four launchers and one workspace (items 1 and 3)', () => {
    /** The shared viewer, faked as the real one hands the doctor's video over (willOpen on open, didClose on close). */
    let ctx: ViewerCallContext | null = null;
    const session = signal<{ sources: readonly ViewerSource[]; options: ViewerOpenOptions } | null>(null);
    const viewer = {
      isOpen: computed(() => session() !== null),
      registerCall: vi.fn((c: ViewerCallContext) => {
        ctx = c;
        return () => {
          ctx = null;
        };
      }),
      open: vi.fn((sources: ViewerSource | readonly ViewerSource[], options: ViewerOpenOptions = {}) => {
        const list = Array.isArray(sources) ? (sources as readonly ViewerSource[]) : [sources as ViewerSource];
        const was = session() !== null;
        session.set({ sources: list, options });
        if (!was) ctx?.willOpen();
        return { closed: Promise.resolve(), close: () => viewer.close() };
      }),
      close: vi.fn(() => {
        if (!session()) return;
        session.set(null);
        ctx?.didClose();
      }),
    };
    const sig = <T,>(name: string) => cmp()[name] as unknown as { (): T; set(v: T): void };
    const peer = () => cmp()['peer'] as unknown as { holder(): string; track(): unknown };
    const launcher = (key: string) => el.querySelector<HTMLButtonElement>(`#call-notes [data-ws-launcher="${key}"]`) as HTMLButtonElement;
    const nameOf = (e: Element | null) => e?.textContent?.replace(/\s+/g, ' ').trim();
    const panel = (key: string) => el.querySelector<HTMLElement>(`#ws-panel-${key}`) as HTMLElement;
    const isOpen = () => sig<boolean>('wsOpen')();
    const openTab = async (key: string) => {
      launcher(key).click();
      await settle();
    };
    const closeWs = async () => {
      cmp()['closeWorkspace']();
      await settle();
    };
    const refresh = async () => {
      await (cmp()['refreshClinical'] as (passive: boolean) => Promise<void>)(true);
      await settle();
    };
    const lastOpen = () => viewer.open.mock.calls[viewer.open.mock.calls.length - 1] as unknown as [readonly ViewerSource[], ViewerOpenOptions];
    const bandButton = (text: string) =>
      Array.from(el.querySelectorAll<HTMLButtonElement>('.ws-band button')).find((b) => b.textContent?.includes(text)) as HTMLButtonElement;

    const rx = (id: string): PrescriptionDto =>
      ({
        id,
        number: `GVM-RX-${id}`,
        status: 'active',
        appointment_id: 'ap-1',
        patient_id: 'p-1',
        prescriber: 'Dr Bayo Ade',
        items_count: 1,
        valid_until: null,
        sent_at: '2026-11-04T15:10:00Z',
        created_at: '2026-11-04T15:05:00Z',
        items: [],
      }) as unknown as PrescriptionDto;
    const lab = (id: string, status: PatientLabRequestSummaryDto['status'] = 'awaiting_consent'): PatientLabRequestSummaryDto =>
      ({
        id,
        number: `GVM-REQ-20261104-0000${id.slice(-1)}`,
        status,
        priority: 'routine',
        doctor: { id: 'sp-1', name: 'Bayo Ade', specialty: 'Cardiology' },
        items_count: 2,
        results_count: 0,
        reviewed: false,
        awaiting_review: false,
        appointment_id: 'ap-1',
        sent_at: '2026-11-04T15:30:00Z',
        valid_until: '2026-12-04',
        expires_at: '2026-12-04T23:00:00Z',
        last_activity_at: '2026-11-04T15:30:00Z',
      }) as PatientLabRequestSummaryDto;
    const referral = (id: string): ReferralDto => ({
      id,
      appointment_id: 'ap-1',
      referral_type: 'specialist',
      target: 'Cardiology clinic',
      reason: 'Chest pain review',
      clinical_summary: null,
      priority: 'routine',
      status: 'sent',
      author: 'Bayo Ade',
      created_at: '2026-11-04T15:20:00Z',
    });
    const certificate = (id: string, over: Partial<MedicalCertificateDto> = {}): MedicalCertificateDto => ({
      id,
      appointment_id: 'ap-1',
      type: 'sick_leave',
      type_label: 'Sick leave certificate',
      diagnosis: 'SECRET-DIAGNOSIS',
      statement: 'SECRET-STATEMENT',
      from_date: '2026-11-04',
      to_date: '2026-11-06',
      days: 3,
      author: 'Bayo Ade',
      created_at: '2026-11-04T15:25:00Z',
      ...over,
    });
    const proposal = (id: string): AppointmentDto =>
      ({ ...appointment, id, status: 'proposed', scheduled_at: '2026-11-20T15:00:00Z', expires_at: '2099-01-01T00:00:00Z' }) as unknown as AppointmentDto;
    const summary = { available: true, subjective: 'Feeling better.', assessment: 'Improving.', plan: 'Rest. Drink water.', author: 'Dr Bayo Ade' } as ConsultationSummaryDto;
    /** Everything the four tabs can hold. */
    const everything = () => {
      issued = [rx('1')];
      labRequests = [lab('lr-1', 'awaiting_consent'), lab('lr-2', 'booked')];
      legacyLabs = [{ id: 'lo-1', appointment_id: 'ap-1', tests: ['FBC'], notes: null, status: 'pending', author: 'Bayo Ade', created_at: '2026-10-01T10:00:00Z' } as unknown as LabOrderDto];
      referralsData = [referral('rf-1')];
      certificatesData = [certificate('mc-1'), certificate('mc-2', { type: 'general', type_label: 'Medical certificate', from_date: null, to_date: null })];
      followUpsData = [proposal('fu-1'), proposal('fu-2')];
      carePlanData = { available: true, items: ['Walk daily'] };
      summaryData = summary;
    };

    beforeEach(() => {
      session.set(null);
      ctx = null;
      viewer.open.mockClear();
      viewer.close.mockClear();
      viewer.registerCall.mockClear();
      TestBed.overrideProvider(DocumentViewerService, { useValue: viewer });
      vi.spyOn(window, 'open').mockReturnValue(null);
    });

    it('1. four launchers with the exact labels open the workspace on their tab; no notes tablist while closed', async () => {
      await create();
      await enter();
      const buttons = Array.from(el.querySelectorAll<HTMLButtonElement>('#call-notes sd-call-launchers [data-ws-launcher]'));
      expect(buttons.map((b) => b.textContent?.trim())).toEqual(['Consultation Notes', 'Prescriptions', 'Lab requests', 'Follow-up Plan']);
      expect(buttons.every((b) => b.getAttribute('aria-haspopup') === 'dialog')).toBe(true);
      expect(el.querySelector('#call-notes')?.getAttribute('aria-labelledby')).toBe('call-notes-heading');
      expect(el.querySelector('[role="tablist"][aria-label="Consultation notes"]')).toBeNull();
      for (const key of ['notes', 'prescriptions', 'labs', 'followup']) {
        await openTab(key);
        expect(isOpen()).toBe(true);
        expect(sig<string>('wsTab')()).toBe(key);
        expect(el.querySelector('#ws-tab-' + key)?.getAttribute('aria-selected')).toBe('true');
        expect(el.querySelectorAll('dialog.sd-dialog--viewer [role="tab"]').length).toBe(4);
        await closeWs();
        expect(isOpen()).toBe(false);
      }
    });

    it('the dialog is named by its kicker and the doctor, described by the specialty; its ✕ says what it closes', async () => {
      await create();
      await enter();
      await openTab('notes');
      const dialog = el.querySelector('dialog.sd-dialog--viewer') as HTMLDialogElement;
      const named = (dialog.getAttribute('aria-labelledby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent?.trim());
      expect(named).toEqual(['Consultation notes', 'Dr Bayo Ade']);
      expect(document.getElementById(dialog.getAttribute('aria-describedby') ?? '')?.textContent?.trim()).toBe('Cardiology');
      expect(dialog.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe('Consultation notes');
      expect(dialog.querySelector('button[aria-label="Close consultation notes"]')).not.toBeNull();
      // The doctor's video corner while the call is on.
      expect(dialog.querySelector('.ws-pip')).not.toBeNull();
    });

    it('2. never leaves the call: no button in any panel navigates or opens a window; the appointment card is not a button', async () => {
      everything();
      await create();
      await enter();
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate');
      for (const key of ['notes', 'prescriptions', 'labs', 'followup']) {
        await openTab(key);
        const buttons = Array.from(panel(key).querySelectorAll<HTMLButtonElement>('button'));
        expect(buttons.length).toBeGreaterThan(0);
        for (const b of buttons) {
          b.click();
          await settle();
          viewer.close();
          await settle();
        }
        expect(panel(key).querySelector('a')).toBeNull();
      }
      expect(navigate).not.toHaveBeenCalled();
      expect(window.open).not.toHaveBeenCalled();
      await openTab('notes');
      const card = Array.from(panel('notes').querySelectorAll<HTMLElement>('.rounded-2xl')).find((d) => d.textContent?.includes('Video consultation')) as HTMLElement;
      expect(card.tagName).toBe('DIV');
      expect(card.closest('button')).toBeNull();
      expect(card.className).not.toContain('bg-cerulean/10');
      expect(card.className).not.toContain('hover:');
    });

    it('3a. a fresh prescription (after the baseline): "New" on the launcher and the tab; opening Prescriptions clears it; while it shows, none', async () => {
      issued = [rx('1')];
      await create();
      await enter();
      expect(nameOf(launcher('prescriptions'))).toBe('Prescriptions, 1 prescription');
      expect(sig<boolean>('newRx')()).toBe(false);
      issued = [rx('1'), rx('2')];
      await refresh();
      expect(nameOf(launcher('prescriptions'))).toBe('Prescriptions, New prescription');
      await openTab('labs');
      const tab = el.querySelector('#ws-tab-prescriptions') as HTMLElement;
      expect(tab.querySelector('span[class~="size-1.5"][class~="bg-cerulean"]')).not.toBeNull();
      expect(nameOf(tab)).toContain(', new');
      expect(tab.querySelector('.sr-only')?.textContent).toBe(', new');
      await openTab('prescriptions');
      expect(sig<boolean>('newRx')()).toBe(false);
      expect(nameOf(el.querySelector('#ws-tab-prescriptions'))).not.toContain(', new');
      expect(el.querySelector('#ws-tab-prescriptions span[class~="size-1.5"][class~="bg-cerulean"]')).toBeNull();
      expect(nameOf(launcher('prescriptions'))).toBe('Prescriptions, 2 prescriptions');
      // Showing Prescriptions: a fresh one is seen at once (the toast still says so).
      issued = [rx('1'), rx('2'), rx('3')];
      await refresh();
      expect(sig<boolean>('newRx')()).toBe(false);
      expect(sig<unknown>('rxToast')()).not.toBeNull();
    });

    it('3b. counts, "Proposed", and "New" for a fresh lab request, referral or certificate (cleared by its tab)', async () => {
      labRequests = [lab('lr-1')];
      legacyLabs = [{ id: 'lo-1', appointment_id: 'ap-1', tests: ['FBC'], notes: null, status: 'pending', author: null, created_at: '2026-10-01T10:00:00Z' } as unknown as LabOrderDto];
      await create();
      await enter();
      expect(nameOf(launcher('labs'))).toBe('Lab requests, 2 requests');
      expect(nameOf(launcher('followup'))).toBe('Follow-up Plan');
      expect(nameOf(launcher('notes'))).toBe('Consultation Notes');
      labRequests = [lab('lr-1'), lab('lr-2')];
      await refresh();
      expect(nameOf(launcher('labs'))).toBe('Lab requests, New lab request');
      referralsData = [referral('rf-1')];
      await refresh();
      expect(nameOf(launcher('followup'))).toBe('Follow-up Plan, New in your follow-up plan');
      await openTab('followup');
      expect(sig<boolean>('newFollowUp')()).toBe(false);
      // While Follow-up Plan shows, a new certificate is seen at once.
      certificatesData = [certificate('mc-1')];
      await refresh();
      expect(sig<boolean>('newFollowUp')()).toBe(false);
      await closeWs();
      certificatesData = [certificate('mc-1'), certificate('mc-2')];
      await refresh();
      expect(nameOf(launcher('followup'))).toBe('Follow-up Plan, New in your follow-up plan');
      followUpsData = [proposal('fu-1')];
      await refresh();
      expect(nameOf(launcher('followup'))).toBe('Follow-up Plan, Proposed follow-up — answer it after your call');
      expect(launcher('followup').querySelector('.ws-launcher-status--new')).not.toBeNull();
    });

    it('3c. "Finalized" once the summary is available; statuses come from typed state, never the words', async () => {
      issued = [rx('1')];
      await create();
      await enter();
      summaryData = summary;
      await refresh();
      expect(nameOf(launcher('notes'))).toBe('Consultation Notes, Finalized — your visit summary is ready');
      // A load error with prescriptions shown: the count, not "Not loaded".
      sig<string>('rxLoadError').set('Could not load your prescriptions.');
      await settle();
      expect(nameOf(launcher('prescriptions'))).toBe('Prescriptions, 1 prescription');
      sig<PrescriptionDto[]>('issuedRx').set([]);
      await settle();
      expect(nameOf(launcher('prescriptions'))).toBe('Prescriptions, Not loaded — open to see why');
      expect(launcher('prescriptions').querySelector('.ws-launcher-status--warn')).not.toBeNull();
    });

    it('3d. separate baselines: what the first load returns is never new; the next poll’s certificate is', async () => {
      referralsData = [referral('rf-1')];
      certificatesData = [certificate('mc-1')];
      carePlanData = { available: true, items: ['Walk daily'] };
      labRequests = [lab('lr-1')];
      summaryData = summary;
      await create();
      await enter();
      expect(sig<boolean>('newLab')()).toBe(false);
      expect(sig<boolean>('newFollowUp')()).toBe(false);
      expect(sig<string>('clinicalNote')()).toBe('');
      expect(nameOf(launcher('followup'))).toBe('Follow-up Plan');
      certificatesData = [certificate('mc-1'), certificate('mc-2')];
      await refresh();
      expect(sig<boolean>('newFollowUp')()).toBe(true);
      expect(nameOf(launcher('followup'))).toBe('Follow-up Plan, New in your follow-up plan');
      expect(sig<boolean>('newLab')()).toBe(false);
      expect(sig<string>('clinicalNote')()).toBe('Dr Ade updated your follow-up plan.');
    });

    it('3e. one poll bringing a lab request and a referral announces once, both sentences, never what they are', async () => {
      await create();
      await enter();
      labRequests = [lab('lr-1')];
      referralsData = [referral('rf-1')];
      await refresh();
      const note = sig<string>('clinicalNote')();
      expect(note).toBe('Dr Ade sent you a lab request. Dr Ade updated your follow-up plan.');
      for (const secret of ['GVM-REQ', 'Cardiology clinic', 'Chest pain']) expect(note).not.toContain(secret);
      // The card's polite region says it (and the band's, under a modal).
      expect(el.querySelector('#call-notes p[aria-live="polite"]')?.textContent?.trim()).toBe(note);
      await openTab('notes');
      expect(Array.from(el.querySelectorAll('.ws-band [aria-live="polite"]')).some((n) => n.textContent?.trim() === note)).toBe(true);
    });

    it('4a. the toast’s "Show in call notes" opens the workspace on Prescriptions and dismisses the toast', async () => {
      issued = [rx('1')];
      await create();
      await enter();
      sig<unknown>('rxToast').set({ text: 'Dr Bayo Ade sent you prescription GVM-RX-1', rx: issued[0] });
      await settle();
      Array.from(el.querySelectorAll<HTMLButtonElement>('[data-testid="call-rx-toast"] button'))
        .find((b) => b.textContent?.includes('Show in call notes'))
        ?.click();
      await settle();
      expect(isOpen()).toBe(true);
      expect(sig<string>('wsTab')()).toBe('prescriptions');
      expect(sig<unknown>('rxToast')()).toBeNull();
    });

    it('4b. "View prescription" over the workspace: the viewer, Prescriptions under it without a focus move, "New" cleared; a closed workspace stays closed', async () => {
      issued = [rx('1')];
      await create();
      await enter();
      sig<boolean>('newRx').set(true);
      await openTab('notes');
      const focused = document.activeElement;
      expect(focused?.id).toBe('ws-tab-notes');
      (cmp()['viewRxFromToast'] as (r: PrescriptionDto) => void)(issued[0]);
      await settle();
      expect(viewer.open).toHaveBeenCalledTimes(1);
      expect(lastOpen()[0].map((s) => s.key)).toEqual(['rx:1']);
      expect(sig<string>('wsTab')()).toBe('prescriptions');
      expect(sig<boolean>('newRx')()).toBe(false);
      expect(document.activeElement).toBe(focused);
      viewer.close();
      await closeWs();
      sig<boolean>('newRx').set(true);
      (cmp()['viewRxFromToast'] as (r: PrescriptionDto) => void)(issued[0]);
      await settle();
      expect(isOpen()).toBe(false);
      expect(sig<boolean>('newRx')()).toBe(false);
    });

    it('5a. Prescriptions View: the viewer over the visit’s prescriptions at the row; falls back to the tab while open, else the launcher', async () => {
      issued = [rx('1'), rx('2')];
      await create();
      await enter();
      await openTab('prescriptions');
      const view = panel('prescriptions').querySelector<HTMLButtonElement>('button[aria-label="View prescription GVM-RX-2"]') as HTMLButtonElement;
      expect(view.textContent?.trim()).toBe('View');
      expect(view.className).toContain('min-h-11');
      view.click();
      const [sources, options] = lastOpen();
      expect(sources.map((s) => s.key)).toEqual(['rx:1', 'rx:2']);
      expect(sources.every((s) => s.policy === 'owner')).toBe(true);
      expect(options.index).toBe(1);
      expect(options.opener).toBe(view);
      expect(options.fallbackFocus?.()?.id).toBe('ws-tab-prescriptions');
      viewer.close();
      await closeWs();
      expect(options.fallbackFocus?.()).toBe(launcher('prescriptions'));
    });

    it('5b. a lab request’s View only for booked / in lab / result ready; none for one awaiting consent (the note shows) or a legacy order', async () => {
      labRequests = [lab('lr-1', 'awaiting_consent'), lab('lr-2', 'booked'), lab('lr-3', 'in_lab'), lab('lr-4', 'result_ready'), lab('lr-5', 'cancelled')];
      legacyLabs = [{ id: 'lo-1', appointment_id: 'ap-1', tests: ['FBC'], notes: null, status: 'pending', author: null, created_at: '2026-10-01T10:00:00Z' } as unknown as LabOrderDto];
      await create();
      await enter();
      await openTab('labs');
      const rows = Array.from(panel('labs').querySelectorAll<HTMLElement>('[data-testid="call-lab-request"]'));
      expect(rows.map((r) => !!r.querySelector('button'))).toEqual([false, true, true, true, false]);
      const views = Array.from(panel('labs').querySelectorAll<HTMLButtonElement>('button'));
      expect(views.map((b) => b.textContent?.trim())).toEqual(['View', 'View', 'View']);
      expect(views.every((b) => b.getAttribute('aria-label')?.startsWith('View lab request GVM-REQ-'))).toBe(true);
      expect(panel('labs').textContent).toContain('Open Lab Tests after your call to review and accept.');
      views[1].click();
      const [sources, options] = lastOpen();
      expect(sources.map((s) => s.key)).toEqual(['lab:lr-2', 'lab:lr-3', 'lab:lr-4']);
      expect(sources.every((s) => s.policy === 'owner')).toBe(true);
      expect(options.index).toBe(1);
      expect(options.fallbackFocus?.()?.id).toBe('ws-tab-labs');
      viewer.close();
      await settle();
      // No request waiting for an answer: no "review and accept" note.
      labRequests = [lab('lr-2', 'booked')];
      await refresh();
      expect(panel('labs').textContent).not.toContain('review and accept');
    });

    it('5c. referral and certificate Views: one list (referrals, then certificates), at the row pressed', async () => {
      referralsData = [referral('rf-1')];
      certificatesData = [certificate('mc-1'), certificate('mc-2', { type: 'general', type_label: 'Medical certificate', from_date: null, to_date: null })];
      await create();
      await enter();
      await openTab('followup');
      const cert = panel('followup').querySelector<HTMLButtonElement>('button[aria-label="View Medical certificate"]') as HTMLButtonElement;
      cert.click();
      let [sources, options] = lastOpen();
      expect(sources.map((s) => s.key)).toEqual(['referral:rf-1', 'certificate:mc-1', 'certificate:mc-2']);
      expect(sources.map((s) => s.title)).toEqual(['Referral · Cardiology clinic', 'Sick leave certificate', 'Medical certificate']);
      expect(options.index).toBe(2);
      expect(options.opener).toBe(cert);
      expect(options.fallbackFocus?.()?.id).toBe('ws-tab-followup');
      viewer.close();
      await settle();
      panel('followup').querySelector<HTMLButtonElement>('button[aria-label="View referral letter to Cardiology clinic"]')?.click();
      [sources, options] = lastOpen();
      expect(options.index).toBe(0);
      expect(window.open).not.toHaveBeenCalled();
    });

    it('7a. the workspace takes the doctor’s video off the stage first, gets its re-publishes, and gives it back once on close', async () => {
      await create();
      await enter();
      const client = agora.clients[agora.clients.length - 1];
      const cam = { name: 'doctor-1', play: vi.fn(), stop: vi.fn() };
      await client.handlers['user-published']({ uid: 2, videoTrack: cam }, 'video');
      await client.handlers['user-published']({ uid: 3, videoTrack: { name: 'guest', play: vi.fn(), stop: vi.fn() } }, 'video');
      await settle();
      const tiles = fixture.debugElement.query(By.directive(CallTilesComponent)).componentInstance as CallTilesComponent;
      const log: string[] = [];
      vi.spyOn(tiles, 'detach').mockImplementation((uid) => {
        log.push(`detach:${uid}:${peer().track() ? 'tile' : 'none'}`);
      });
      vi.spyOn(tiles, 'attach').mockImplementation((uid, t) => {
        log.push(`attach:${uid}:${(t as unknown as { name: string }).name}`);
      });
      await openTab('notes');
      expect(log).toEqual(['detach:2:none']);
      expect(peer().holder()).toBe('workspace');
      expect(peer().track()).toBe(cam);
      expect(el.querySelector('.ws-pip sd-call-peer-tile')).not.toBeNull();
      expect(el.querySelectorAll('sd-call-peer-tile').length).toBe(1);
      const cam2 = { name: 'doctor-2', play: vi.fn(), stop: vi.fn() };
      await client.handlers['user-published']({ uid: 2, videoTrack: cam2 }, 'video');
      expect(peer().track()).toBe(cam2);
      expect(log).toEqual(['detach:2:none']);
      cmp()['closeWorkspace']();
      expect(peer().holder()).toBe('returning');
      await settle();
      expect(peer().holder()).toBe('stage');
      expect(log).toEqual(['detach:2:none', 'attach:2:doctor-2']);
    });

    it('7b. the viewer over the workspace holds the video; its close gives it back to the workspace; the band’s Back to call closes both and the stage plays', async () => {
      issued = [rx('1')];
      await create();
      await enter();
      const client = agora.clients[agora.clients.length - 1];
      await client.handlers['user-published']({ uid: 2, videoTrack: { name: 'doctor-1', play: vi.fn(), stop: vi.fn() } }, 'video');
      await settle();
      const tiles = fixture.debugElement.query(By.directive(CallTilesComponent)).componentInstance as CallTilesComponent;
      const attach = vi.spyOn(tiles, 'attach');
      await openTab('prescriptions');
      panel('prescriptions').querySelector<HTMLButtonElement>('button[aria-label="View prescription GVM-RX-1"]')?.click();
      await settle();
      expect(peer().holder()).toBe('viewer');
      expect(el.querySelector('.ws-pip .ws-peer-wait')?.textContent?.trim()).toBe('BA');
      viewer.close();
      await settle();
      expect(peer().holder()).toBe('workspace');
      expect(isOpen()).toBe(true);
      panel('prescriptions').querySelector<HTMLButtonElement>('button[aria-label="View prescription GVM-RX-1"]')?.click();
      await settle();
      bandButton('Back to call').click();
      await settle();
      expect(isOpen()).toBe(false);
      expect(viewer.isOpen()).toBe(false);
      expect(peer().holder()).toBe('stage');
      expect(attach).toHaveBeenCalledTimes(1);
      expect(String(attach.mock.calls[0][0])).toBe('2');
    });

    it('8a. the call ending closes the workspace and the viewer, focus on the ended screen; reopened: no PiP, the band says it ended', async () => {
      issued = [rx('1')];
      await create();
      await enter();
      await openTab('prescriptions');
      panel('prescriptions').querySelector<HTMLButtonElement>('button[aria-label="View prescription GVM-RX-1"]')?.click();
      await settle();
      expect(viewer.isOpen()).toBe(true);
      sig<string>('endedReason').set('completed');
      sig<string>('status').set('ended');
      await settle();
      expect(isOpen()).toBe(false);
      expect(viewer.isOpen()).toBe(false);
      expect(document.activeElement).toBe(el.querySelector('[data-testid="call-ended"]'));
      // The notes stay readable after the call.
      await openTab('notes');
      expect(isOpen()).toBe(true);
      expect(el.querySelector('.ws-pip')).toBeNull();
      const ended = Array.from(el.querySelectorAll('.ws-band [role="status"]')).find((n) => n.textContent?.trim() === BAND_ENDED.completed);
      expect(ended).toBeTruthy();
      // There is no call to go back to: the band's first button says what it closes (and still just closes).
      expect(bandButton(BAND_BACK.live)).toBeUndefined();
      const close = bandButton(BAND_BACK.notes);
      expect(close.querySelector('[data-band-label]')?.textContent?.trim()).toBe('Close notes');
      close.click();
      await settle();
      expect(isOpen()).toBe(false);
      // A document open alone after the call: "Close document".
      expect(sig<string>('bandBackLabel')()).toBe(BAND_BACK.document);
    });

    it('8b. the patient leaving: the hand-over stops (callLeft) and the workspace closes for good', async () => {
      await create();
      await enter();
      await openTab('notes');
      sig<boolean>('left').set(true);
      await settle();
      expect(isOpen()).toBe(false);
      expect(peer().holder()).toBe('stage');
      await openTab('labs');
      expect(isOpen()).toBe(false);
    });

    it('9. screen sharing: the banner with the notes’ words on every tab, Stop sharing stops it; the specialty stays', async () => {
      await create();
      await enter();
      const toggle = vi.spyOn(fixture.componentInstance as unknown as { toggleScreen: () => Promise<void> }, 'toggleScreen').mockResolvedValue();
      await openTab('labs');
      sig<boolean>('screenOn').set(true);
      await settle();
      const banner = el.querySelector('.ws-share') as HTMLElement;
      expect(banner.getAttribute('role')).toBe('status');
      expect(banner.textContent).toContain(notesShareBanner(false));
      const dialog = el.querySelector('dialog.sd-dialog--viewer') as HTMLDialogElement;
      expect(document.getElementById(dialog.getAttribute('aria-describedby') ?? '')?.textContent?.trim()).toBe('Cardiology');
      Array.from(banner.querySelectorAll('button'))
        .find((b) => b.textContent?.includes('Stop sharing'))
        ?.click();
      expect(toggle).toHaveBeenCalledTimes(1);
    });

    it('10a. the band: Back to call closes the workspace and focus returns to the launcher', async () => {
      await create();
      await enter();
      launcher('labs').focus();
      await openTab('labs');
      expect(document.activeElement?.id).toBe('ws-tab-labs');
      bandButton('Back to call').click();
      await settle();
      expect(isOpen()).toBe(false);
      expect(document.activeElement).toBe(launcher('labs'));
    });

    it('10b. the band: the doctor’s request for documents (Review / Not now), who joined, and what arrived', async () => {
      await create();
      await enter();
      const request = { id: 'req-1', status: 'pending', kind: 'documents', message: null, created_at: '2026-11-04T15:00:00Z', expires_at: '2099-01-01T00:00:00Z' } as unknown as DocumentAccessRequestDto;
      sig<AppointmentDto | null>('appointment').set({ ...appointment, pending_document_request: request } as AppointmentDto);
      await openTab('notes');
      const band = el.querySelector('.ws-band') as HTMLElement;
      expect(band.textContent).toContain('Dr Ade asked to see your documents');
      const review = bandButton('Review');
      const set = vi.spyOn(sig<unknown>('reviewDocRequest') as unknown as { set: (v: unknown) => void }, 'set').mockImplementation(() => undefined);
      review.click();
      expect(set).toHaveBeenCalledWith(request);
      set.mockRestore();
      bandButton('Not now').click();
      await settle();
      expect(el.querySelector('.ws-band')?.textContent).not.toContain('asked to see your documents');
      // Someone joins: the band's own live region says who.
      sig<unknown[]>('remoteList').set([{ uid: 2, hasVideo: false, hasAudio: true, speaking: false }]);
      await settle();
      expect(sig<string>('bandPresenceNote')()).toBe('Bayo Ade joined the call.');
      expect(Array.from(el.querySelectorAll('.ws-band p.sr-only[role="status"]')).some((p) => p.textContent?.includes('Bayo Ade joined the call.'))).toBe(true);
      // What arrived: never what it is.
      labRequests = [lab('lr-1')];
      await refresh();
      expect(sig<string>('clinicalNote')()).toBe('Dr Ade sent you a lab request.');
    });

    it('10c. the request answered from the band: its Review is gone, so focus goes to the open document, else the tab, else the Documents heading', async () => {
      issued = [rx('1')];
      await create();
      await enter();
      const request = { id: 'req-1', status: 'pending', kind: 'documents', message: null, created_at: '2026-11-04T15:00:00Z', expires_at: '2099-01-01T00:00:00Z' } as unknown as DocumentAccessRequestDto;
      sig<AppointmentDto | null>('appointment').set({ ...appointment, pending_document_request: request } as AppointmentDto);
      await openTab('prescriptions');
      // Review and Not now stay together (one group, under the words where the row is narrow), each ≥ 44 px.
      const review = bandButton('Review');
      const notNow = bandButton('Not now');
      expect(review.parentElement).toBe(notNow.parentElement);
      expect(review.parentElement?.classList).toContain('shrink-0');
      expect(review.className).toContain('min-h-11');
      expect(notNow.className).toContain('min-h-11');
      const closed = () => cmp()['docRequestClosed']();
      const lose = () => (document.activeElement as HTMLElement | null)?.blur();
      // Approved or declined in the dialog: the row (and its Review) is gone; the dialog then closes, focus on the page.
      sig<string | null>('dismissedRequest').set('req-1');
      await settle();
      expect(bandButton('Review')).toBeUndefined();
      lose();
      closed();
      await settle();
      expect(document.activeElement?.id).toBe('ws-tab-prescriptions');
      expect(sig<unknown>('reviewDocRequest')()).toBeNull();
      // Focus the dialog's closing already placed somewhere stays there.
      bandButton(BAND_BACK.live).focus();
      closed();
      await settle();
      expect(document.activeElement).toBe(bandButton(BAND_BACK.live));
      // A document open over the workspace: its title.
      panel('prescriptions').querySelector<HTMLButtonElement>('button[aria-label="View prescription GVM-RX-1"]')?.click();
      await settle();
      const frame = document.createElement('div');
      frame.className = 'sd-viewer-frame';
      const title = document.createElement('h2');
      title.tabIndex = -1;
      title.setAttribute('data-autofocus', '');
      frame.append(title);
      document.body.append(frame);
      lose();
      closed();
      await settle();
      expect(document.activeElement).toBe(title);
      frame.remove();
      viewer.close();
      await closeWs();
      // In the cockpit (the Documents card's own Review is gone too): the Documents heading.
      lose();
      closed();
      await settle();
      expect(document.activeElement?.id).toBe('call-docs-title');
    });

    it('12. the panels’ markup: h3 headings, one proposals block with one focus target, neutral appointment card, readable captions, no certificate content', async () => {
      everything();
      await create();
      await enter();
      for (const key of ['notes', 'prescriptions', 'labs', 'followup']) {
        await openTab(key);
        expect(panel(key).classList).toContain('sd-share');
        expect(panel(key).querySelector('h2')).toBeNull();
        // Label in name: every panel button's name starts with its visible word.
        for (const b of Array.from(panel(key).querySelectorAll<HTMLButtonElement>('button'))) {
          const label = b.getAttribute('aria-label');
          if (label) expect(label.startsWith(b.textContent?.trim() ?? '')).toBe(true);
        }
      }
      expect(el.querySelectorAll('[id^="ws-panel-"] h3').length).toBeGreaterThan(0);
      expect(panel('notes').querySelector('.grid')?.className).toContain('lg:grid-cols-2');
      expect(panel('notes').querySelector('.grid')?.className).not.toContain('sm:grid-cols-2');
      expect(el.querySelectorAll('#pat-ws-proposals').length).toBe(1);
      const proposals = el.querySelector('#pat-ws-proposals') as HTMLElement;
      expect(proposals.querySelectorAll('[class~="bg-teal-bright/10"]').length).toBe(2);
      expect(proposals.querySelectorAll('[data-ws-focus]').length).toBe(1);
      expect(proposals.querySelector('[data-ws-focus]')?.getAttribute('tabindex')).toBe('-1');
      expect(Array.from(proposals.querySelectorAll('p')).filter((p) => p.textContent?.includes('After the call')).every((p) => p.classList.contains('text-white/85'))).toBe(true);
      const certs = Array.from(panel('followup').querySelectorAll<HTMLElement>('[data-testid="call-certificate"]'));
      expect(certs.map((c) => c.querySelector('p')?.textContent?.trim())).toEqual(['Sick leave certificate', 'Medical certificate']);
      expect(certs[0].textContent).toContain('4 Nov 2026 – 6 Nov 2026');
      expect(certs[1].textContent).toContain('Issued 4 Nov 2026');
      expect(panel('followup').textContent).not.toContain('SECRET-DIAGNOSIS');
      expect(panel('followup').textContent).not.toContain('SECRET-STATEMENT');
      // "See your follow-up plan": the Follow-up Plan tab, focus on the first proposal.
      await openTab('notes');
      Array.from(panel('notes').querySelectorAll('button'))
        .find((b) => b.textContent?.includes('See your follow-up plan'))
        ?.click();
      await settle();
      expect(sig<string>('wsTab')()).toBe('followup');
      expect(document.activeElement).toBe(proposals.querySelector('[data-ws-focus]'));
    });

    it('13. the dark cockpit’s "Active" chip rule is in the component’s styles', () => {
      const styles = (ConsultationCall as unknown as { ɵcmp: { styles: string[] } }).ɵcmp.styles.join('');
      expect(styles).toMatch(/\.sd-call\[data-theme=["']?dark["']?\]\S*\s+\.sd-share\S*\s+\.text-success[^{]*\{[^}]*#6fdc8c/);
    });

    it('15. pills (item 5): the rx status chip takes a cockpit tone; the lab chips are neutral chips', async () => {
      issued = [rx('1'), { ...rx('2'), status: 'cancelled' } as PrescriptionDto];
      await create();
      await enter();
      await openTab('prescriptions');
      const chips = Array.from(panel('prescriptions').querySelectorAll<HTMLElement>('.sd-chip'));
      const byLabel = (t: string) => chips.find((c) => c.textContent?.trim() === t);
      expect(byLabel('Active')?.className).toBe('sd-chip sd-tone-success');
      expect(byLabel('Cancelled')?.className).toBe('sd-chip sd-tone-danger');
      // No raw colour pair or pill radius is left on a chip in the workspace (the tones resolve per cockpit tone).
      expect(panel('prescriptions').querySelector('.rounded-pill, .text-success, .text-alert')).toBeNull();
    });

    it('14. the card’s hint follows the call', async () => {
      await create();
      await enter();
      expect(el.querySelector('#call-notes')?.textContent).toContain(notesHint('Dr Ade'));
      sig<string>('status').set('ended');
      await settle();
      expect(el.querySelector('#call-notes')?.textContent).toContain(NOTES_HINT_AFTER);
      expect(el.querySelector('#call-notes')?.textContent).not.toContain('stays in view');
    });

    describe("the patient's own record, in place (View Full Record, Manage sharing)", () => {
      const forAppointment = vi.fn(() => ok(access));
      beforeEach(() => {
        forAppointment.mockClear();
        TestBed.overrideProvider(PatientApi, {
          useValue: apiStub({
            me: () => ok({ id: 'p-1', first_name: 'Ada', last_name: 'Obi' }),
            healthProfile: () =>
              ok({
                emergency_contact: { full_name: '', relationship: '', phone: '', email: '' },
                insurance: { provider: '', plan: '', policy_number: '', coverage_status: '', expiry_date: '' },
                medical: {
                  history: [{ condition: 'Appendectomy', year: '2016', note: '' }],
                  allergies: [{ allergen: 'Penicillin', severity: 'severe', reaction: 'Hives' }],
                  medications: [{ name: 'Lisinopril', dosage: '10 mg', frequency: 'Daily' }],
                  conditions: [{ condition: 'Hypertension', status: 'Managed', since: '2020' }],
                },
              }),
            vitals: () => ok({ latest: [], fields: [], sources: {}, patient_sources: [], reminder: { due: false } }),
          }),
        });
        TestBed.overrideProvider(DocumentSharingApi, {
          useValue: apiStub({
            forAppointment,
            history: () => of({ status: 'success', message: 'OK', data: [], meta: { page: 1, per_page: 20, total: 0, total_pages: 1 } }),
          }),
        });
        // The embedded portal components read the (call's) query string: it has none.
        const empty = convertToParamMap({});
        TestBed.overrideProvider(ActivatedRoute, {
          useValue: { snapshot: { paramMap: convertToParamMap({ id: 'ap-1' }), queryParamMap: empty }, queryParamMap: of(empty) },
        });
      });
      const control = (text: string) =>
        Array.from(el.querySelectorAll<HTMLButtonElement>('pat-consultation-call button, button')).find((b) => b.textContent?.trim().startsWith(text)) as HTMLButtonElement;
      const tabNames = () => Array.from(el.querySelectorAll('dialog.sd-dialog--viewer [role="tab"]')).map(nameOf);
      /** Renders until the record's zone chunk (a dynamic import) is in, at most ~5 s; `render` never waits on the zone. */
      const untilZone = async (render: () => Promise<void> = settle) => {
        for (let i = 0; i < 100 && !el.querySelector('.pat-call-zone'); i++) {
          await render();
          await new Promise((r) => setTimeout(r, 50));
        }
        await render();
      };
      const settleDeferred = () => untilZone();

      it('16. View Full Record opens the read-only record in the workspace: its own two tabs and words, the video in the corner, focus back on close', async () => {
        await create();
        await enter();
        const navigate = vi.spyOn(TestBed.inject(Router), 'navigate');
        const navigateByUrl = vi.spyOn(TestBed.inject(Router), 'navigateByUrl');
        const view = control('View Full Record');
        expect(view.tagName).toBe('BUTTON');
        view.focus();
        view.click();
        await settleDeferred();
        expect(isOpen()).toBe(true);
        expect(sig<string>('wsTab')()).toBe('record');
        expect(tabNames()).toEqual(['Health record', 'Document sharing']);
        const dialog = el.querySelector('dialog.sd-dialog--viewer') as HTMLDialogElement;
        const named = (dialog.getAttribute('aria-labelledby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent?.trim());
        expect(named).toEqual(['Your health record', 'Ada Obi']);
        expect(dialog.querySelector('button[aria-label="Close your health record"]')).not.toBeNull();
        expect(dialog.querySelector('.ws-pip')).not.toBeNull();
        expect(document.activeElement?.id).toBe('ws-tab-record');
        // The portal's Medical Information, embedded: the record, no editing, nothing that navigates.
        const record = panel('record');
        expect(record.querySelector('.pat-call-zone pat-my-profile')).not.toBeNull();
        expect(record.textContent).toContain('Penicillin');
        expect(record.textContent).toContain('Lisinopril');
        expect(record.textContent).toContain('Hypertension');
        expect(record.textContent).toContain('Appendectomy');
        expect(Array.from(record.querySelectorAll('button')).some((b) => /Edit|Add Medical|Back/.test(b.textContent ?? ''))).toBe(false);
        expect(record.querySelector('a')).toBeNull();
        expect(record.textContent).not.toMatch(/abnormal/i);
        // The notes' launchers keep their four tools.
        expect(el.querySelectorAll('#call-notes sd-call-launchers [data-ws-launcher]').length).toBe(4);
        await closeWs();
        await new Promise((r) => setTimeout(r));
        expect(isOpen()).toBe(false);
        expect(navigate).not.toHaveBeenCalled();
        expect(navigateByUrl).not.toHaveBeenCalled();
        expect(window.open).not.toHaveBeenCalled();
        // Then the notes again from a launcher: the notes' four tabs and words.
        await openTab('notes');
        expect(tabNames()).toEqual(['Consultation Notes', 'Prescriptions', 'Lab requests', 'Follow-up Plan']);
        expect(el.querySelector('dialog.sd-dialog--viewer button[aria-label="Close consultation notes"]')).not.toBeNull();
      }, 20000);

      it('17. Manage opens sharing in the workspace (no link, no new tab); its sections switch in place; closing re-reads what this doctor can see', async () => {
        await create();
        await enter();
        expect(el.querySelector('a[target="_blank"]')).toBeNull();
        expect(el.querySelector('a[href*="/documents/sharing"]')).toBeNull();
        const navigate = vi.spyOn(TestBed.inject(Router), 'navigate');
        const navigateByUrl = vi.spyOn(TestBed.inject(Router), 'navigateByUrl');
        const manage = el.querySelector<HTMLButtonElement>('button[aria-label="Manage sharing"]') as HTMLButtonElement;
        expect(manage.textContent?.trim()).toBe('Manage');
        manage.focus();
        manage.click();
        // Manage sharing keeps a 15 s clock (its Undo window), so the app is never stable: render by hand.
        const flush = async () => {
          for (let i = 0; i < 8; i++) {
            fixture.detectChanges();
            await new Promise((r) => setTimeout(r, 10));
          }
        };
        await untilZone(flush);
        expect(isOpen()).toBe(true);
        expect(sig<string>('wsTab')()).toBe('sharing');
        expect(tabNames()).toEqual(['Health record', 'Document sharing']);
        const sharing = panel('sharing');
        expect(sharing.querySelector('.pat-call-zone pat-manage-sharing')).not.toBeNull();
        expect(sharing.querySelector('a')).toBeNull();
        expect(sharing.querySelector('h1')).toBeNull();
        const sections = Array.from(sharing.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Sharing sections"] button'));
        expect(sections.map((b) => [b.textContent?.trim(), b.getAttribute('aria-pressed')])).toEqual([
          ['Doctors', 'true'],
          ['Activity', 'false'],
        ]);
        sections[1].click();
        await flush();
        expect(sharing.querySelector('pat-access-history')).not.toBeNull();
        expect(sections[1].getAttribute('aria-pressed')).toBe('true');
        const reads = forAppointment.mock.calls.length;
        bandButton('Back to call').click();
        await flush();
        expect(isOpen()).toBe(false);
        expect(forAppointment.mock.calls.length).toBe(reads + 1);
        expect(isPassive({ args: forAppointment.mock.calls[reads] as unknown[] })).toBe(true);
        expect(document.activeElement).toBe(manage);
        expect(navigate).not.toHaveBeenCalled();
        expect(navigateByUrl).not.toHaveBeenCalled();
        expect(window.open).not.toHaveBeenCalled();
      }, 20000);

      it('18. once the call is over, the record opens with no video and its band says "Close record"', async () => {
        await create();
        await enter();
        sig<string>('status').set('ended');
        await settle();
        cmp()['openWorkspace']('record', null);
        await settleDeferred();
        expect(isOpen()).toBe(true);
        expect(el.querySelector('dialog.sd-dialog--viewer .ws-pip')).toBeNull();
        bandButton('Close record').click();
        await settle();
        expect(isOpen()).toBe(false);
      }, 20000);
    });
  });
});
