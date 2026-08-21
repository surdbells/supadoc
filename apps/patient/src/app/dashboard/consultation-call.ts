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
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import AgoraRTC, {
  IAgoraRTCClient,
  ICameraVideoTrack,
  IMicrophoneAudioTrack,
} from 'agora-rtc-sdk-ng';
import { AppointmentsApi } from '@supadoc/data-access';
import { IconComponent } from '@supadoc/ui';

/**
 * Live consultation (Agora RTC). Fetches a scoped call token, joins the
 * appointment channel, publishes the local camera/mic and renders the remote
 * participant. Route: /dashboard/call/:id.
 */
@Component({
  selector: 'pat-consultation-call',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    <div
      class="relative flex h-[calc(100vh-6rem)] min-h-[520px] w-full flex-col overflow-hidden rounded-card bg-abyss"
    >
      <!-- Remote (main stage) -->
      <div #remoteVideo class="absolute inset-0 bg-abyss"></div>

      @if (!remoteJoined() && status() === 'in-call') {
        <div
          class="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center text-white/80"
        >
          <span
            class="flex size-16 items-center justify-center rounded-full bg-white/10"
          >
            <sd-icon name="user-round" [size]="30" />
          </span>
          <p class="font-sans text-body">Waiting for the other participant to join…</p>
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
          <button
            type="button"
            class="rounded-field bg-white/10 px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-white/20"
            (click)="leave()"
          >
            Back to appointments
          </button>
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
            [class]="micOn() ? 'bg-white/15 hover:bg-white/25' : 'bg-alert hover:bg-alert/80'"
            [attr.aria-label]="micOn() ? 'Mute microphone' : 'Unmute microphone'"
            (click)="toggleMic()"
          >
            <sd-icon [name]="micOn() ? 'mic' : 'mic-off'" [size]="22" />
          </button>
          <button
            type="button"
            class="flex size-12 items-center justify-center rounded-full text-white transition-colors"
            [class]="camOn() ? 'bg-white/15 hover:bg-white/25' : 'bg-alert hover:bg-alert/80'"
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
  `,
})
export class ConsultationCall implements AfterViewInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly appointments = inject(AppointmentsApi);

  private readonly localVideo = viewChild<ElementRef<HTMLDivElement>>('localVideo');
  private readonly remoteVideo = viewChild<ElementRef<HTMLDivElement>>('remoteVideo');

  protected readonly status = signal<'loading' | 'in-call' | 'error'>('loading');
  protected readonly errorMessage = signal('');
  protected readonly micOn = signal(true);
  protected readonly camOn = signal(true);
  protected readonly remoteJoined = signal(false);

  private client?: IAgoraRTCClient;
  private micTrack?: IMicrophoneAudioTrack;
  private camTrack?: ICameraVideoTrack;
  private left = false;

  ngAfterViewInit(): void {
    void this.start();
  }

  private async start(): Promise<void> {
    const id = this.route.snapshot.paramMap.get('id') ?? '';
    try {
      const { data } = await firstValueFrom(this.appointments.callToken(id));

      // Diagnostic: exactly what we hand the SDK, to compare against a token
      // that joins Agora's own demo. Safe to log — appId is public, token is
      // short-lived. Remove once calls are stable.
      console.info('[videomed:call] join params', {
        appId: data.app_id,
        channel: data.channel,
        uid: data.uid,
        tokenLength: data.token?.length ?? 0,
        tokenHead: data.token?.slice(0, 24) ?? '',
        tokenTail: data.token?.slice(-12) ?? '',
        expiresIn: data.expires_in,
        sdk: AgoraRTC.VERSION,
      });

      const client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
      this.client = client;

      client.on('user-published', async (user, mediaType) => {
        await client.subscribe(user, mediaType);
        if (mediaType === 'video') {
          const el = this.remoteVideo()?.nativeElement;
          if (el) user.videoTrack?.play(el);
          this.remoteJoined.set(true);
        } else if (mediaType === 'audio') {
          user.audioTrack?.play();
        }
      });
      client.on('user-unpublished', (_user, mediaType) => {
        if (mediaType === 'video') this.remoteJoined.set(false);
      });

      await client.join(data.app_id, data.channel, data.token, data.uid || null);
      if (this.left) return; // component destroyed mid-join

      const [mic, cam] = await AgoraRTC.createMicrophoneAndCameraTracks();
      this.micTrack = mic;
      this.camTrack = cam;

      const localEl = this.localVideo()?.nativeElement;
      if (localEl) cam.play(localEl);
      await client.publish([mic, cam]);

      this.status.set('in-call');
    } catch (err) {
      console.error('[videomed:call] join failed', err);
      const message = (err as { message?: string })?.message;
      this.errorMessage.set(
        message ?? 'We couldn’t start the call. Please try again.',
      );
      this.status.set('error');
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

  protected async leave(): Promise<void> {
    await this.teardown();
    void this.router.navigate(['/dashboard/appointments']);
  }

  private async teardown(): Promise<void> {
    this.left = true;
    try {
      this.micTrack?.close();
      this.camTrack?.close();
      await this.client?.leave();
    } catch {
      /* releasing devices — nothing actionable on failure */
    }
    this.client = undefined;
    this.micTrack = undefined;
    this.camTrack = undefined;
  }

  ngOnDestroy(): void {
    void this.teardown();
  }
}
