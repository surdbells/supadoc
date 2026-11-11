import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { type Observable, of, throwError } from 'rxjs';
import { SessionTimeoutService } from '@supadoc/auth';
import { API_CONFIG, AppointmentsApi } from '@supadoc/data-access';
import type { CallMeetingDto, JoinInfoDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { CallJoin } from './call-join';

const agora = vi.hoisted(() => {
  const track = () => ({ play: vi.fn(), stop: vi.fn(), close: vi.fn(), setEnabled: vi.fn(async () => undefined), getVolumeLevel: () => 0, getMediaStreamTrack: () => ({ getSettings: () => ({}) }) });
  return {
    module: {
      createClient: vi.fn(),
      createMicrophoneAndCameraTracks: vi.fn(async () => [track(), track()]),
      createMicrophoneAudioTrack: vi.fn(async () => track()),
      createCameraVideoTrack: vi.fn(async () => track()),
      getCameras: vi.fn(async () => []),
      getMicrophones: vi.fn(async () => []),
    },
  };
});
vi.mock('agora-rtc-sdk-ng', () => ({ default: agora.module }));

const meeting = (role: 'doctor' | 'patient' | 'guest'): CallMeetingDto =>
  ({
    appointment_id: 'ap-1',
    scheduled_at: '2026-11-04T15:00:00Z',
    specialist: { id: 'sp-1', name: 'Bayo Ade', specialty: 'Cardiology' },
    you: { uid: role === 'doctor' ? 2 : 1, role, name: role === 'doctor' ? 'Dr Bayo Ade' : 'Ada Obi' },
    participants: [],
    can_join: true,
  }) as unknown as CallMeetingDto;

const info = (role: 'doctor' | 'patient', url?: string): JoinInfoDto =>
  ({
    ...meeting(role),
    configured: true,
    app_id: 'app',
    channel: 'ap-1',
    token: null,
    uid: role === 'doctor' ? 2 : 1,
    ...(url !== undefined ? { doctor_portal_url: url } : {}),
  }) as unknown as JoinInfoDto;

/** A lobby from an API that sends the doctor portal's address with it. */
const lobbyWith = (role: 'doctor' | 'patient', url: string): CallMeetingDto =>
  ({ ...meeting(role), server_time: '2026-11-04T14:00:00Z', doctor_portal_url: url }) as unknown as CallMeetingDto;

const ok = <T,>(data: T) => of({ status: 'success', message: 'OK', data });

describe('CallJoin (a join link)', () => {
  let fixture: ComponentFixture<CallJoin>;
  let el: HTMLElement;
  let joinInfo: ReturnType<typeof vi.fn<(token: string) => unknown>>;
  let joinLobby: ReturnType<typeof vi.fn<(token: string) => Observable<unknown>>>;
  let lobby: CallMeetingDto;
  let replace: ReturnType<typeof vi.spyOn>;

  const settle = async () => {
    // Not whenStable(): the lobby's level meter keeps an interval running.
    for (let i = 0; i < 8; i++) {
      fixture.detectChanges();
      await new Promise((r) => setTimeout(r));
    }
  };
  const create = async () => {
    fixture = TestBed.createComponent(CallJoin);
    el = fixture.nativeElement;
    document.body.appendChild(el);
    await settle();
  };

  beforeEach(async () => {
    agora.module.createClient.mockClear();
    joinInfo = vi.fn<(token: string) => unknown>();
    joinLobby = vi.fn<(token: string) => Observable<unknown>>(() => ok(lobby));
    lobby = meeting('doctor');
    replace = vi.spyOn(CallJoin.prototype as unknown as { navigateAway: (url: string) => void }, 'navigateAway').mockImplementation(() => undefined);
    await TestBed.configureTestingModule({
      imports: [CallJoin],
      providers: [
        provideSupadocIcons(),
        { provide: API_CONFIG, useValue: { baseUrl: 'http://api.test' } },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ token: 'tok-123' }) } } },
        { provide: SessionTimeoutService, useValue: { hold: vi.fn(), release: vi.fn() } },
        {
          provide: AppointmentsApi,
          useValue: { joinLobby: (token: string) => joinLobby(token), joinInfo: (token: string) => joinInfo(token) },
        },
      ],
    }).compileComponents();
  });

  afterEach(() => {
    fixture?.destroy();
    el?.remove();
    vi.restoreAllMocks();
  });

  it("sends a doctor's link straight on to the doctor portal from the lobby, without asking the join", async () => {
    lobby = lobbyWith('doctor', 'https://doctor.example.test/call/tok-123');
    await create();
    expect(replace).toHaveBeenCalledWith('https://doctor.example.test/call/tok-123');
    // No join request, so no Agora credentials minted for a page that leaves.
    expect(joinInfo).not.toHaveBeenCalled();
    expect(agora.module.createClient).not.toHaveBeenCalled();
    expect(agora.module.createMicrophoneAndCameraTracks).not.toHaveBeenCalled();
  });

  it('on an older API whose lobby lacks the address, asks the join payload for it', async () => {
    joinInfo.mockReturnValue(ok(info('doctor', 'https://doctor.example.test/call/tok-123')));
    await create();
    expect(joinInfo).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('https://doctor.example.test/call/tok-123');
    expect(agora.module.createClient).not.toHaveBeenCalled();
    expect(agora.module.createMicrophoneAndCameraTracks).not.toHaveBeenCalled();
  });

  it('on an API without a lobby, reads the address from the join payload standing in for it — once', async () => {
    joinLobby.mockReturnValue(throwError(() => ({ statusCode: 404, message: 'Not found' })));
    joinInfo.mockReturnValue(ok(info('doctor', 'https://doctor.example.test/call/tok-123')));
    await create();
    expect(replace).toHaveBeenCalledWith('https://doctor.example.test/call/tok-123');
    expect(joinInfo).toHaveBeenCalledTimes(1);

    // …and one too old to carry it stays in the lobby without asking again.
    fixture.destroy();
    replace.mockClear();
    joinInfo.mockClear();
    joinInfo.mockReturnValue(ok(info('doctor')));
    await create();
    expect(replace).not.toHaveBeenCalled();
    expect(joinInfo).toHaveBeenCalledTimes(1);
  });

  it('redirects a doctor-role join response (location.replace) and does not join Agora', async () => {
    // Too early for the join payload while in the lobby: the lobby shows as before…
    joinInfo.mockReturnValueOnce(throwError(() => ({ statusCode: 425, message: 'Too early' })));
    await create();
    expect(replace).not.toHaveBeenCalled();
    // …and joining (which reads it again) goes on to the doctor portal instead.
    joinInfo.mockReturnValue(ok(info('doctor', 'https://doctor.example.test/call/tok-123')));
    await (fixture.componentInstance as unknown as { join: () => Promise<void> }).join();
    await settle();
    expect(replace).toHaveBeenCalledWith('https://doctor.example.test/call/tok-123');
    expect(agora.module.createClient).not.toHaveBeenCalled();
  });

  it('puts your camera in the picture-in-picture on a phone held sideways, the row tile only when upright', async () => {
    const original = window.matchMedia;
    let landscape = true;
    window.matchMedia = vi.fn((query: string) => ({
      matches: query.includes('(orientation: landscape)') ? landscape : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    try {
      lobby = meeting('patient');
      joinInfo.mockReturnValue(ok(info('patient')));
      await create();
      const view = () => (fixture.componentInstance as unknown as { selfMode: () => string }).selfMode();
      // Under 640px wide, but the rail has no room for the 64px tile above the controls.
      expect(view()).toBe('pip');
      fixture.destroy();
      landscape = false;
      await create();
      expect(view()).toBe('external');
    } finally {
      window.matchMedia = original;
    }
  });

  it('never follows anything but an http(s) address, nor a patient token', async () => {
    joinInfo.mockReturnValue(ok(info('doctor', 'javascript:alert(1)')));
    await create();
    expect(replace).not.toHaveBeenCalled();

    fixture.destroy();
    lobby = meeting('patient');
    joinInfo.mockReturnValue(ok(info('patient', 'https://doctor.example.test/call/tok-123')));
    await create();
    expect(replace).not.toHaveBeenCalled();

    // The same from the lobby — and its answer stands: no second look at the join.
    fixture.destroy();
    joinInfo.mockClear();
    lobby = lobbyWith('doctor', 'javascript:alert(1)');
    await create();
    expect(replace).not.toHaveBeenCalled();
    expect(joinInfo).not.toHaveBeenCalled();

    fixture.destroy();
    lobby = lobbyWith('patient', 'https://doctor.example.test/call/tok-123');
    await create();
    expect(replace).not.toHaveBeenCalled();
    expect(joinInfo).not.toHaveBeenCalled();
  });

  it('declares the dark colour scheme on its always-dark host, so the device lists and checkbox are dark (NP2)', () => {
    // The pickers' options carry no colour (the patient native-select guard checks the markup).
    const css = (CallJoin as unknown as { ɵcmp: { styles: string[] } }).ɵcmp.styles.join('').replace(/\s+/g, '');
    expect(css).toContain('color-scheme:dark');
  });
});
