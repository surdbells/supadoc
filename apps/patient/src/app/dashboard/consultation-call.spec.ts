import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { AuthService, SessionTimeoutService } from '@supadoc/auth';
import {
  API_CONFIG,
  AppointmentsApi,
  DocumentsApi,
  DocumentSharingApi,
  PatientApi,
  PrescriptionsApi,
} from '@supadoc/data-access';
import type { AppointmentDocumentAccessDto, AppointmentDto, UploadedDocumentDto } from '@supadoc/models';
import {
  CallControlsComponent,
  CallSelfTileComponent,
  CallTilesComponent,
  provideSupadocIcons,
} from '@supadoc/ui';
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

/** An API service whose every other method answers an empty list. */
function apiStub(overrides: Record<string, unknown>): unknown {
  return new Proxy(overrides, {
    get: (target, prop: string) => (prop in target ? target[prop] : () => ok([])),
  });
}

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
          useValue: apiStub({
            getMine: () => ok(appointment),
            callToken: () =>
              ok({ app_id: 'app', channel: 'ap-1', uid: 1, token: null, expires_in: null, participants: [{ uid: 2, role: 'doctor', name: 'Bayo Ade' }] }),
            consents: () =>
              ok([{ type: 'ai_transcription', granted: true, by_role: 'patient', by_name: null, version: '1', decided_at: null }]),
            recordings: () => ok({ active: false }),
            presenceUrl: () => 'http://api.test/presence',
            consultationSummary: () => ok({ available: false }),
            carePlan: () => ok({ available: false, items: [] }),
          }),
        },
        { provide: PatientApi, useValue: apiStub({ me: () => ok({ id: 'p-1', first_name: 'Ada', last_name: 'Obi' }), vitals: () => ok({ latest: [] }), healthProfile: () => ok({}) }) },
        { provide: DocumentsApi, useValue: apiStub({}) },
        { provide: PrescriptionsApi, useValue: apiStub({}) },
        { provide: DocumentSharingApi, useValue: apiStub({ forAppointment: () => ok(access) }) },
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
    expect(controlLabels()).toEqual(['Mute', 'Stop video', 'Captions', 'More', 'End call']);
    expect(el.textContent).not.toContain('Chat');
    // Below sm: the self tile starts the row, and the stage has no picture-in-picture.
    expect(row?.firstElementChild?.tagName.toLowerCase()).toBe('sd-call-self-tile');
    const tiles = fixture.debugElement.query(By.directive(CallTilesComponent)).componentInstance as CallTilesComponent;
    expect(tiles.selfView()).toBe('external');
    expect(tiles.mainFit()).toBe('contain');
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
      expect(stage?.className).toContain('h-full');
      expect(stage?.className).toContain('aspect-video');
      expect(stage?.className).not.toContain('100dvh');
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

  it('sizes the lg stage from the column reserve: 20rem, 24.5rem with captions on', async () => {
    await create();
    await enter();
    expect(left()?.style.getPropertyValue('--reserve')).toBe('20rem');
    const dock = el.querySelector('[data-testid="call-dock"]');
    expect(dock?.className).toContain('lg:w-[min(100%,calc((100dvh_-_var(--reserve))*16/9))]');
    cmp()['onControl']('captions');
    await settle();
    expect(left()?.style.getPropertyValue('--reserve')).toBe('24.5rem');
    expect(el.querySelector('[data-testid="call-captions"]')).toBeTruthy();
  });

  it('More holds Invite (below sm), the video fit, the preview and Privacy & consent', async () => {
    await create();
    await enter();
    const controls = fixture.debugElement.query(By.directive(CallControlsComponent)).componentInstance as CallControlsComponent;
    const items = controls.menu().map((m) => m.id);
    expect(items).toEqual(['invite', 'fit-contain', 'fit-cover', 'self', 'theme', 'privacy']);
    cmp()['onMenu']('fit-cover');
    await settle();
    const tiles = fixture.debugElement.query(By.directive(CallTilesComponent)).componentInstance as CallTilesComponent;
    expect(tiles.mainFit()).toBe('cover');
    cmp()['onMenu']('self');
    await settle();
    expect(tiles.selfView()).toBe('hidden');
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
});
