import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  input,
  untracked,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';
import { type CallTile, callTileInitials, type CallVideoPlayConfig, type CallVideoTrack, IconComponent } from '@supadoc/ui';

/** The avatar fill per role (theme.css teal / ocean; a guest is a light tint). */
const TONE: Record<string, string> = { doctor: '#00796c', patient: '#0a3d80', guest: 'rgb(255 255 255 / 0.15)' };

const CSS = `
sd-call-peer-tile{display:block;width:100%;height:100%}
.sdv-peer{position:relative;width:100%;height:100%;overflow:hidden;background:var(--sd-viewer-pip-bg,#0a1628);color:#fff}
.sdv-peer-video,.sdv-peer-off{position:absolute;inset:0}
.sdv-peer-off{display:flex;align-items:center;justify-content:center}
.sdv-peer-off span{display:flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:50%}
.sdv-peer-muted{position:absolute;right:6px;bottom:6px;display:flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:#e53935}
.sdv-peer-name{position:absolute;left:6px;bottom:6px;max-width:calc(100% - 12px);padding:2px 8px;border-radius:999px;background:var(--sd-viewer-pip-pill,rgb(10 22 40/.6));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
`;

interface Playing {
  readonly track: CallVideoTrack;
  readonly config: CallVideoPlayConfig;
  readonly el: HTMLElement;
}

/**
 * The other person's live video as the picture-in-picture of the document
 * viewer during a call (`sd-call-peer-tile`, §1.13). The call page renders it
 * in the template it registers as `ViewerCallContext.peer`; the viewer's PiP
 * layer gives it its box. It holds no interactive element: "Move video" /
 * "Hide video" are the viewer's buttons beside it, never inside this
 * `role="img"`. Initials when the camera is off, a badge when muted.
 *
 * Playback: plays `[track]` once in its element, stops when the track goes,
 * and stops synchronously on destroy — so the call page can play the track on
 * its stage again right after the viewer's PiP has gone (never two places).
 *
 * Lives in the viewer's light entry (lazy call pages import it), not in
 * `@supadoc/ui`, whose components all land in every app's initial bundle.
 */
@Component({
  selector: 'sd-call-peer-tile',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [IconComponent],
  styles: [CSS],
  template: `
    <div class="sdv-peer" role="img" [attr.aria-label]="label()">
      <div #video class="sdv-peer-video" data-sd-peer-video></div>
      @if (!tile().hasVideo) {
        <div class="sdv-peer-off" aria-hidden="true">
          <span class="font-heading text-body font-semibold" [style.background]="tone()">{{ initials() }}</span>
        </div>
      }
      @if (tile().muted) {
        <span class="sdv-peer-muted" aria-hidden="true"><sd-icon name="mic-off" [size]="12" /></span>
      }
      <span class="sdv-peer-name font-sans text-caption" aria-hidden="true">{{ tile().name }}</span>
    </div>
  `,
})
export class CallPeerTileComponent {
  /** The other person (name, role, camera and microphone state). */
  readonly tile = input.required<CallTile>();
  /** Their remote video track (null: none, or not handed over yet). */
  readonly track = input<CallVideoTrack | null>(null);
  /** Agora play options: the whole picture, never mirrored (a remote video). */
  readonly playConfig = input<CallVideoPlayConfig>({ fit: 'contain', mirror: false });

  protected readonly initials = computed(() => callTileInitials(this.tile().name));
  protected readonly tone = computed(() => TONE[this.tile().role] ?? TONE['guest']);
  protected readonly label = computed(() => `${this.tile().name}, live video${this.tile().hasVideo ? '' : '. Camera off'}`);

  private readonly videoHost = viewChild<ElementRef<HTMLElement>>('video');
  private playing: Playing | null = null;

  constructor() {
    afterRenderEffect(() => {
      const el = this.videoHost()?.nativeElement ?? null;
      const track = this.track();
      const config = this.playConfig();
      untracked(() => this.sync(track, config, el));
    });
    // Synchronously, so the host may play the track on its stage right after.
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  private sync(track: CallVideoTrack | null, config: CallVideoPlayConfig, el: HTMLElement | null): void {
    const p = this.playing;
    if (track && el && p && p.track === track && p.el === el && p.config.fit === config.fit && p.config.mirror === config.mirror) return;
    this.stop();
    if (!track || !el) return;
    track.play(el, config);
    this.playing = { track, config, el };
  }

  private stop(): void {
    this.playing?.track.stop();
    this.playing = null;
  }
}
