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
} from 'agora-rtc-sdk-ng';
import { AppointmentsApi } from '@supadoc/data-access';
import type { JoinInfoDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';

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
            class="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center text-white/80"
          >
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

  private readonly localVideo = viewChild<ElementRef<HTMLDivElement>>('localVideo');
  private readonly remoteVideo = viewChild<ElementRef<HTMLDivElement>>('remoteVideo');

  protected readonly status = signal<
    'loading' | 'in-call' | 'not-configured' | 'error'
  >('loading');
  protected readonly errorMessage = signal('');
  protected readonly micOn = signal(true);
  protected readonly camOn = signal(true);
  protected readonly remoteJoined = signal(false);
  protected readonly info = signal<JoinInfoDto | null>(null);

  private client?: IAgoraRTCClient;
  private micTrack?: IMicrophoneAudioTrack;
  private camTrack?: ICameraVideoTrack;
  private left = false;

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
    try {
      const { data } = await firstValueFrom(this.appointments.joinInfo(token));
      this.info.set(data);

      if (!data.configured || !data.app_id || !data.channel || !data.token) {
        this.status.set('not-configured');
        return;
      }

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

      await client.join(data.app_id, data.channel, data.token, data.uid ?? null);
      if (this.left) return; // component destroyed mid-join

      const [mic, cam] = await AgoraRTC.createMicrophoneAndCameraTracks();
      this.micTrack = mic;
      this.camTrack = cam;

      const localEl = this.localVideo()?.nativeElement;
      if (localEl) cam.play(localEl);
      await client.publish([mic, cam]);

      this.status.set('in-call');
    } catch (err) {
      const message = (err as { message?: string })?.message;
      this.errorMessage.set(
        message ?? 'This join link is invalid or has expired.',
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
    this.status.set('not-configured');
    this.remoteJoined.set(false);
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
