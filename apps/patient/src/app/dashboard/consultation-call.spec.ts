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

  it('a new prescription never covers the video: a bottom toast, but in the page above the dock when held sideways', async () => {
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
    (cmp()['rxToast'] as unknown as { set: (v: unknown) => void }).set(rx);
    await settle();
    expect(el.querySelector('[data-testid="call-rx-toast"]')).toBeNull();
    const inline = el.querySelector<HTMLElement>('[data-testid="call-rx-inline"]');
    expect(inline?.getAttribute('role')).toBe('status');
    expect(inline?.className).not.toContain('fixed');
    expect(inline?.textContent).toContain('Dr Bayo Ade sent you a prescription (RX-1).');
    // In the page flow, before the dock (it pushes the video down).
    const dock = el.querySelector('[data-testid="call-dock"]');
    expect(inline && dock ? inline.compareDocumentPosition(dock) & Node.DOCUMENT_POSITION_FOLLOWING : 0).toBeTruthy();
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
