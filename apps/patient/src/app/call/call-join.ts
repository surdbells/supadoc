import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  OnDestroy,
  signal,
  viewChild,
} from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import AgoraRTC, {
  IAgoraRTCClient,
  ICameraVideoTrack,
  IMicrophoneAudioTrack,
  UID,
} from 'agora-rtc-sdk-ng';
import { SessionTimeoutService } from '@supadoc/auth';
import {
  apiErrorMessage,
  AppointmentsApi,
  sendCallPresence,
  startCallPresence,
} from '@supadoc/data-access';
import type { JoinInfoDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';

/** Idle-timer hold key while a consultation is actually going on. */
const CALL_HOLD = 'call';
/**
 * How long someone alone in the channel keeps the idle timer paused while
 * waiting for the other side to first arrive (ms).
 */
const FIRST_JOIN_WAIT_MS = 30 * 60_000;
/**
 * Agora retries a lost connection on its own (RECONNECTING) without a time
 * limit; give up after this long (ms) so a dead connection can't keep the idle
 * timer paused. The user can rejoin.
 */
const RECONNECT_GIVE_UP_MS = 2 * 60_000;

/**
 * Preauthenticated call join (Agora RTC). Public route `/call/join/:token` — the
 * signed token from the invite email IS the credential, so patient, doctor and
 * guests join the same appointment channel without logging in. Mirrors the
 * signed-in {@link ConsultationCall}, but sources credentials from the token.
 */
@Component({
  selector: 'pat-call-join',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block min-h-screen bg-abyss' },
  template: `
    <div class="mx-auto flex min-h-screen max-w-6xl flex-col gap-4 p-4">
      <!-- Brand + who -->
      <div class="flex items-center justify-between gap-4 text-white">
        <span class="font-heading text-h5 tracking-tight">
          <span class="text-frost">Video</span><span class="text-sage">Med</span>
        </span>
        @if (info(); as i) {
          <span class="font-sans text-caption text-white/70">
            {{ i.you.name }} · joining as {{ i.you.role }}
          </span>
        }
      </div>

      <div
        class="relative flex flex-1 flex-col overflow-hidden rounded-card bg-abyss"
      >
        <!-- Remote (main stage) -->
        <div #remoteVideo class="absolute inset-0 bg-abyss"></div>

        @if (!remoteJoined() && status() === 'in-call') {
          <div
            class="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-white/80"
          >
            @if (remoteLeft()) {
              <span
                class="flex size-16 items-center justify-center rounded-full bg-white/10"
              >
                <sd-icon name="user-x" [size]="30" />
              </span>
              <p class="font-sans text-body">The other participant has left the call.</p>
              <p class="max-w-sm font-sans text-caption text-white/60">
                If your consultation is finished, press the red button to leave.
              </p>
            } @else if (remotePresent()) {
              <span
                class="flex size-16 items-center justify-center rounded-full bg-white/10"
              >
                <sd-icon name="video-off" [size]="30" />
              </span>
              <p class="font-sans text-body">The other participant’s camera is off.</p>
            } @else {
              <span
                class="flex size-16 items-center justify-center rounded-full bg-white/10"
              >
                <sd-icon name="user-round" [size]="30" />
              </span>
              <p class="font-sans text-body">
                Waiting for the other participant to join…
              </p>
              @if (info(); as i) {
                <p class="font-sans text-caption text-white/60">
                  {{ i.specialist.name }} · {{ i.specialist.specialty }}
                </p>
              }
            }
          </div>
        }

        <!-- Left / dropped -->
        @if (status() === 'ended') {
          <div
            class="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center text-white/85"
            role="status"
          >
            <span
              class="flex size-16 items-center justify-center rounded-full bg-white/10"
            >
              <sd-icon [name]="endedReason() === 'left' ? 'phone-off' : 'wifi-off'" [size]="28" />
            </span>
            @if (endedReason() === 'left') {
              <p class="max-w-sm font-sans text-body">You left the call.</p>
            } @else {
              <p class="max-w-sm font-sans text-body">You were disconnected from the call.</p>
              <p class="max-w-sm font-sans text-caption text-white/60">
                Check your internet connection, then rejoin.
              </p>
            }
            <button
              type="button"
              class="flex items-center gap-2 rounded-field bg-white/10 px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-white/20"
              (click)="rejoin()"
            >
              <sd-icon name="refresh-cw" [size]="16" /> Rejoin call
            </button>
          </div>
        }

        <!-- Local (picture-in-picture) -->
        <div
          class="absolute right-5 top-5 h-40 w-28 overflow-hidden rounded-2xl border border-white/15 bg-ink shadow-lg sm:h-44 sm:w-32"
          [class.hidden]="status() !== 'in-call'"
        >
          <div #localVideo class="h-full w-full"></div>
          @if (!camOn()) {
            <div
              class="absolute inset-0 flex items-center justify-center bg-ink text-white/60"
            >
              <sd-icon name="video-off" [size]="22" />
            </div>
          }
        </div>

        <!-- Loading -->
        @if (status() === 'loading') {
          <div
            class="absolute inset-0 flex flex-col items-center justify-center gap-4 text-white/85"
          >
            <span
              class="size-10 animate-spin rounded-full border-2 border-white/20 border-t-white"
            ></span>
            <p class="font-sans text-body">Connecting to your consultation…</p>
          </div>
        }

        <!-- Not configured / info-only -->
        @if (status() === 'not-configured') {
          <div
            class="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center text-white/85"
          >
            <span
              class="flex size-16 items-center justify-center rounded-full bg-white/10"
            >
              <sd-icon name="calendar-check" [size]="28" />
            </span>
            @if (info(); as i) {
              <p class="font-sans text-body">
                You're confirmed for a consultation with
                <span class="font-semibold text-white">{{
                  i.specialist.name
                }}</span
                >.
              </p>
              <p class="font-sans text-body-sm text-white/70">
                {{ scheduledLabel() }}
              </p>
            }
            <p class="max-w-sm font-sans text-caption text-white/60">
              Video calling isn't enabled on this environment yet. Your join link
              stays valid — reopen it once video is live.
            </p>
          </div>
        }

        <!-- Error -->
        @if (status() === 'error') {
          <div
            class="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center text-white/85"
          >
            <span
              class="flex size-16 items-center justify-center rounded-full bg-white/10"
            >
              <sd-icon name="video-off" [size]="28" />
            </span>
            <p class="max-w-sm font-sans text-body">{{ errorMessage() }}</p>
          </div>
        }

        <!-- Controls -->
        @if (status() === 'in-call') {
          <div
            class="absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-4 rounded-pill bg-abyss/70 px-5 py-3 backdrop-blur"
          >
            <button
              type="button"
              class="flex size-12 items-center justify-center rounded-full text-white transition-colors"
              [class]="
                micOn() ? 'bg-white/15 hover:bg-white/25' : 'bg-alert hover:bg-alert/80'
              "
              [attr.aria-label]="micOn() ? 'Mute microphone' : 'Unmute microphone'"
              (click)="toggleMic()"
            >
              <sd-icon [name]="micOn() ? 'mic' : 'mic-off'" [size]="22" />
            </button>
            <button
              type="button"
              class="flex size-12 items-center justify-center rounded-full text-white transition-colors"
              [class]="
                camOn() ? 'bg-white/15 hover:bg-white/25' : 'bg-alert hover:bg-alert/80'
              "
              [attr.aria-label]="camOn() ? 'Turn camera off' : 'Turn camera on'"
              (click)="toggleCam()"
            >
              <sd-icon [name]="camOn() ? 'video' : 'video-off'" [size]="22" />
            </button>
            <button
              type="button"
              class="flex size-12 items-center justify-center rounded-full bg-alert text-white transition-colors hover:bg-alert/80"
              aria-label="Leave call"
              (click)="leave()"
            >
              <sd-icon name="phone-off" [size]="22" />
            </button>
          </div>
        }
      </div>
    </div>
  `,
})
export class CallJoin implements AfterViewInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly appointments = inject(AppointmentsApi);
  /**
   * Provided app-wide. A patient signed in to the portal in this browser must
   * not get the idle warning (or be signed out) over a live call; a no-op for
   * a guest who isn't signed in.
   */
  private readonly session = inject(SessionTimeoutService);

  private readonly localVideo = viewChild<ElementRef<HTMLDivElement>>('localVideo');
  private readonly remoteVideo = viewChild<ElementRef<HTMLDivElement>>('remoteVideo');

  protected readonly status = signal<
    'loading' | 'in-call' | 'ended' | 'not-configured' | 'error'
  >('loading');
  protected readonly errorMessage = signal('');
  /** How the call ended (set with status 'ended'). */
  protected readonly endedReason = signal<'left' | 'dropped'>('left');
  protected readonly micOn = signal(true);
  protected readonly camOn = signal(true);
  /** The other side's video is on the main stage. */
  protected readonly remoteJoined = signal(false);
  /** Someone else is in the channel, camera on or off. */
  protected readonly remotePresent = signal(false);
  /** Everyone else who was in the call has left it. */
  protected readonly remoteLeft = signal(false);
  protected readonly info = signal<JoinInfoDto | null>(null);

  private client?: IAgoraRTCClient;
  private micTrack?: IMicrophoneAudioTrack;
  private camTrack?: ICameraVideoTrack;
  /** This page is going away — final. */
  private destroyed = false;
  /** Joined to the channel (false again once the call is left or drops). */
  private connected = false;
  /** Whether this page currently holds the idle timer. */
  private holding = false;
  private readonly remoteUids = new Set<UID>();
  private remoteSeen = false;
  private firstWaitOver = false;
  private firstWaitTimer?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  /** Stops the "in the call" heartbeat; set only while one is running. */
  private heartbeatStop?: () => void;

  ngAfterViewInit(): void {
    void this.start();
  }

  protected scheduledLabel(): string {
    const iso = this.info()?.scheduled_at;
    if (!iso) return '';
    return new Intl.DateTimeFormat('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso));
  }

  private async start(): Promise<void> {
    const token = this.route.snapshot.paramMap.get('token') ?? '';
    this.resetPresence();
    let client: IAgoraRTCClient | undefined;
    try {
      const { data } = await firstValueFrom(this.appointments.joinInfo(token));
      if (this.destroyed) return; // page left while the link was checked
      this.info.set(data);

      // token may be null in App-ID-only mode — that's a valid token-less join.
      if (!data.configured || !data.app_id || !data.channel) {
        this.status.set('not-configured');
        return;
      }

      client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
      const self = client;
      this.client = self;

      // Presence, not just video: the other side may join with the camera off.
      self.on('user-joined', (user) => this.onRemoteJoined(self, user.uid));
      self.on('user-left', (user) => this.onRemoteLeft(self, user.uid));
      self.on('user-published', async (user, mediaType) => {
        this.onRemoteJoined(self, user.uid);
        await self.subscribe(user, mediaType);
        if (mediaType === 'video') {
          const el = this.remoteVideo()?.nativeElement;
          if (el) user.videoTrack?.play(el);
          this.remoteJoined.set(true);
        } else if (mediaType === 'audio') {
          user.audioTrack?.play();
        }
      });
      self.on('user-unpublished', (_user, mediaType) => {
        if (mediaType === 'video') this.remoteJoined.set(false);
      });
      // The token lapsed, or Agora dropped us for good (network blips it
      // retries itself, as RECONNECTING): the call is over on this side.
      self.on('token-privilege-did-expire', () => this.dropped(self));
      self.on('connection-state-change', (state) => {
        if (state === 'DISCONNECTED') this.dropped(self);
        else if (state === 'RECONNECTING') this.watchReconnect(self);
        else if (state === 'CONNECTED') this.clearReconnectWatch();
      });

      // uid 0 → wildcard token, join with null; any non-zero uid is honoured.
      const joinedUid = await self.join(
        data.app_id,
        data.channel,
        data.token ?? null,
        data.uid === 0 ? null : data.uid,
      );
      console.info('[videomed:call] joined', { joinedUid });
      if (this.destroyed || this.client !== self) return; // left / dropped mid-join
      // Connected: pause the idle timeout while the consultation is going on.
      this.connected = true;
      if (this.remoteUids.size === 0) this.startFirstWait();
      this.syncHold();

      const [mic, cam] = await AgoraRTC.createMicrophoneAndCameraTracks();
      if (this.destroyed || this.client !== self) {
        // The call ended while the browser asked for the camera — don't leave it on.
        mic.close();
        cam.close();
        return;
      }
      this.micTrack = mic;
      this.camTrack = cam;

      const localEl = this.localVideo()?.nativeElement;
      if (localEl) cam.play(localEl);
      await self.publish([mic, cam]);
      if (this.destroyed || this.client !== self) return;

      this.status.set('in-call');
      this.startHeartbeat(token);
    } catch (err) {
      if (this.destroyed || (client && this.client !== client)) return; // already handled
      // Not in a working call — let the idle timeout run again.
      this.connected = false;
      this.stopHeartbeat();
      this.syncHold();
      this.session.release(CALL_HOLD);
      this.clearFirstWait();
      this.clearReconnectWatch();
      const failed = this.client;
      this.client = undefined;
      void this.releaseMedia(failed);
      this.errorMessage.set(
        apiErrorMessage(err, 'This join link is invalid or has expired.'),
      );
      this.status.set('error');
    }
  }

  // ---- Is the consultation still going on? ----

  /**
   * Hold the idle timer only while a consultation is actually going on: joined
   * and someone else is in the call, or (for a bounded time) waiting for them
   * to first arrive. Released the moment the others leave, the call drops, the
   * user leaves or the page goes away.
   */
  private syncHold(): void {
    const want =
      this.connected &&
      !this.destroyed &&
      (this.remoteUids.size > 0 || (!this.remoteSeen && !this.firstWaitOver));
    if (want === this.holding) return;
    this.holding = want;
    if (want) this.session.hold(CALL_HOLD);
    else this.session.release(CALL_HOLD);
  }

  private onRemoteJoined(client: IAgoraRTCClient, uid: UID): void {
    if (client !== this.client || this.destroyed) return;
    this.remoteUids.add(uid);
    this.remoteSeen = true;
    this.remotePresent.set(true);
    this.remoteLeft.set(false);
    this.clearFirstWait();
    this.syncHold();
  }

  private onRemoteLeft(client: IAgoraRTCClient, uid: UID): void {
    if (client !== this.client || !this.remoteUids.delete(uid)) return;
    if (this.remoteUids.size > 0) return;
    // Everyone else has gone: the consultation is over unless they come back.
    this.remotePresent.set(false);
    this.remoteJoined.set(false);
    this.remoteLeft.set(true);
    this.syncHold();
  }

  private resetPresence(): void {
    this.remoteUids.clear();
    this.remoteSeen = false;
    this.firstWaitOver = false;
    this.remotePresent.set(false);
    this.remoteLeft.set(false);
    this.remoteJoined.set(false);
  }

  private startFirstWait(): void {
    this.clearFirstWait();
    this.firstWaitTimer = setTimeout(() => {
      this.firstWaitTimer = undefined;
      this.firstWaitOver = true;
      this.syncHold();
    }, FIRST_JOIN_WAIT_MS);
  }

  private clearFirstWait(): void {
    clearTimeout(this.firstWaitTimer);
    this.firstWaitTimer = undefined;
  }

  /** Agora is retrying a lost connection: end the call if it doesn't come back. */
  private watchReconnect(client: IAgoraRTCClient): void {
    if (client !== this.client || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.dropped(client);
    }, RECONNECT_GIVE_UP_MS);
  }

  private clearReconnectWatch(): void {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  /**
   * Tell the API this participant is in the call, so appointment lists can show
   * it (the server ignores guests). Restarted after a rejoin; never two at once.
   */
  private startHeartbeat(token: string): void {
    if (this.heartbeatStop) return;
    const url = this.appointments.joinPresenceUrl(token);
    this.heartbeatStop = startCallPresence((s) => sendCallPresence(url, s));
  }

  /** Stop the heartbeat, saying "out" (a no-op when none is running). */
  private stopHeartbeat(): void {
    this.heartbeatStop?.();
    this.heartbeatStop = undefined;
  }

  /** Agora dropped this client (or its token lapsed) while in the call. */
  private dropped(client: IAgoraRTCClient): void {
    if (client !== this.client || this.destroyed || !this.connected) return;
    this.endCall('dropped');
  }

  /** Out of the call: release the hold at once, free the devices, offer Rejoin. */
  private endCall(reason: 'left' | 'dropped'): void {
    this.connected = false;
    this.stopHeartbeat();
    this.syncHold();
    this.clearFirstWait();
    this.clearReconnectWatch();
    // Forget the client first, so its own DISCONNECTED event is ignored.
    const client = this.client;
    this.client = undefined;
    void this.releaseMedia(client);
    this.resetPresence();
    this.endedReason.set(reason);
    this.status.set('ended');
  }

  /** Close the local tracks and leave the channel (best-effort). */
  private async releaseMedia(client: IAgoraRTCClient | undefined): Promise<void> {
    const tracks = [this.micTrack, this.camTrack];
    this.micTrack = undefined;
    this.camTrack = undefined;
    try {
      for (const t of tracks) t?.close();
      await client?.leave();
    } catch {
      /* releasing devices — nothing actionable on failure */
    }
  }

  protected async toggleMic(): Promise<void> {
    if (!this.micTrack) return;
    const on = !this.micOn();
    await this.micTrack.setEnabled(on);
    this.micOn.set(on);
  }

  protected async toggleCam(): Promise<void> {
    if (!this.camTrack) return;
    const on = !this.camOn();
    await this.camTrack.setEnabled(on);
    this.camOn.set(on);
  }

  protected leave(): void {
    if (this.status() !== 'in-call') return;
    this.endCall('left');
  }

  /** "Rejoin call" after leaving or a dropped connection (the link stays valid). */
  protected rejoin(): void {
    if (this.destroyed || this.status() !== 'ended') return;
    this.micOn.set(true);
    this.camOn.set(true);
    this.errorMessage.set('');
    this.status.set('loading');
    void this.start();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.connected = false;
    this.stopHeartbeat();
    // Always drop the idle-timer hold, however the page is left.
    this.holding = false;
    this.session.release(CALL_HOLD);
    this.clearFirstWait();
    this.clearReconnectWatch();
    const client = this.client;
    this.client = undefined;
    void this.releaseMedia(client);
  }
}
