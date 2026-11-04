import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  untracked,
  viewChild,
  viewChildren,
} from '@angular/core';
import { IconComponent } from '../icon/icon';
import {
  CallTile,
  CallTileRole,
  callTileInitials,
  CallTilesLayout,
  callTilesMode,
  CallUid,
} from './call-tiles.model';

/** Agora's `VideoPlayerConfig`. */
export interface CallVideoPlayConfig {
  mirror?: boolean;
  fit?: 'cover' | 'contain' | 'fill';
}

/** Any Agora video track (local camera, screen share, remote video). */
export interface CallVideoTrack {
  play(element: HTMLElement, config?: CallVideoPlayConfig): void;
  stop(): void;
}

export interface CallTileReadyEvent {
  readonly uid: CallUid;
  /** Where the uid's video goes: `track.play(element)`. */
  readonly element: HTMLElement;
}

/**
 * The self-view picture-in-picture, bottom-right of the stage (the controls
 * sit below the stage now, so no offset for a control bar). Must set a width
 * and height (the tile is a size container).
 */
export const CALL_SELF_VIEW_CLASS =
  'right-2 bottom-2 h-20 w-[3.75rem] rounded-xl border border-white/15 bg-abyss shadow-lg roomy:right-3 roomy:bottom-3 roomy:h-[6.75rem] roomy:w-36';

/** The doctor's self view (a little larger on a roomy stage). */
export const CALL_SELF_VIEW_CLASS_DOCTOR =
  'right-2 bottom-2 h-20 w-[3.75rem] rounded-xl border border-white/15 bg-abyss shadow-lg roomy:right-3 roomy:bottom-3 roomy:h-[7.5rem] roomy:w-40';

/** Grid insets (the controls sit below the stage, so no bottom allowance). */
export const CALL_GRID_CLASS = 'p-1.5 roomy:p-2';

/**
 * Where the viewer's own camera shows in 1:1 (and on the grid):
 * `pip` — the picture-in-picture on the stage; `external` — not on the stage,
 * the host shows `<sd-call-self-tile>` elsewhere (a phone's control row);
 * `hidden` — not shown ("Hide my preview"). With `external` / `hidden` the
 * self track stays attached here (`attach()`), it just isn't played.
 */
export type CallSelfViewMode = 'pip' | 'hidden' | 'external';

/** How the 1:1 main video fills its tile: `contain` (whole picture, never cropped) or `cover`. */
export type CallVideoFit = 'contain' | 'cover';

const ROLE_TEXT: Record<CallTileRole, string> = {
  patient: 'Patient',
  doctor: 'Doctor',
  guest: 'Guest',
};

const AVATAR_TONE: Record<CallTileRole, string> = {
  doctor: 'bg-teal',
  patient: 'bg-ocean',
  guest: 'bg-white/15',
};

interface Attachment {
  readonly track: CallVideoTrack;
  readonly config?: CallVideoPlayConfig;
  /** The tile element it is playing in, if any. */
  el: HTMLElement | null;
}

interface TileView {
  readonly key: string;
  readonly tile: CallTile;
  readonly kind: 'main' | 'pip' | 'grid';
  readonly order: number;
  readonly label: string;
  readonly initials: string;
  readonly tone: string;
  readonly a11y: string;
}

/**
 * The call stage's video tiles: today's 1:1 layout (the other person filling
 * the stage, the viewer's own camera small) and, from three people, an even
 * grid that adapts to the stage's shape (container queries). Every tile has
 * its name label, a camera-off placeholder (initials) and a muted badge, and
 * is keyed by uid — tiles are never rebuilt when someone else joins, leaves,
 * mutes or reorders, so a playing video keeps playing.
 *
 * Presentational: the client owns Agora. It renders this absolutely inside its
 * stage (`[container-name:stage]`, positioned) in place of the old
 * `#remoteVideo` + self-view divs, with its own overlays (waiting, ended,
 * controls) as later siblings, and hands each video track over by uid —
 * `attach()` plays it as soon as that uid's tile exists, so a track that
 * arrives before its tile (or a tile re-rendered later) is never lost:
 *
 * ```ts
 * // component
 * private readonly stage = viewChild.required(CallTilesComponent);
 * protected readonly remoteList = signal<readonly RemoteParticipant[]>([]);
 * private readonly remotes = new RemoteParticipants((list) => this.remoteList.set(list));
 * protected readonly tiles = computed(() => buildCallTiles({
 *   remotes: this.remoteList(),
 *   roster: this.info()?.participants,      // [{ uid, role, name }]
 *   self: this.status() === 'in-call'
 *     ? { uid: this.uid ?? 'self', role: 'patient', name: this.myName(),
 *         hasVideo: this.camOn(), muted: !this.micOn() }
 *     : null,
 * }));
 *
 * // joining
 * const unbind = this.remotes.bind(client);
 * client.on('user-published', async (user, kind) => {
 *   await client.subscribe(user, kind);
 *   if (kind === 'video' && user.videoTrack) this.stage().attach(user.uid, user.videoTrack);
 *   if (kind === 'audio') user.audioTrack?.play();
 * });
 * client.on('user-left', (user) => this.stage().detach(user.uid));
 * await client.join(appId, channel, token, uid);
 * const [mic, cam] = await AgoraRTC.createMicrophoneAndCameraTracks();
 * this.stage().attach(this.uid ?? 'self', cam);   // plays once the self tile renders
 * // leaving / before a rejoin: unbind(); this.remotes.clear();
 * ```
 * ```html
 * <!-- Always rendered (not inside an @if) so attach() has somewhere to go. -->
 * <div class="sd-stage relative [container-name:stage] [container-type:size] …">
 *   <sd-call-tiles [tiles]="tiles()" [selfViewClass]="selfView" [mainFit]="fit()"
 *     [selfView]="hidePreview() ? 'hidden' : wide() ? 'pip' : 'external'" />  <!-- doctor: CALL_SELF_VIEW_CLASS_DOCTOR -->
 *   @if (waiting()) { …overlay… }
 * </div>
 * <!-- the control row, below the stage; below 640px the self view lives here -->
 * @if (!wide() && selfTile(); as me) { <sd-call-self-tile [tile]="me" [track]="camTrack()" [hidden]="hidePreview()" /> }
 * ```
 * The host's own overlays can follow the layout with `callTilesMode(tiles())`
 * (e.g. drop its name tag on the grid, or pass `[spotlightLabel]="false"` to
 * keep its own 1:1 name tag). Screen sharing: `attach(selfUid, screenTrack,
 * { fit: 'contain' })`, then `attach(selfUid, camTrack)` again — the previous
 * track's playback stops.
 */
@Component({
  selector: 'sd-call-tiles',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'absolute inset-0 block' },
  styles: [
    `
      .sd-call-tiles {
        container: sd-call-grid / size;
      }
      /* The grid: wrapped rows, the last one centred; columns × rows by count
         and by the shape of the area (narrowest first, wider overrides below). */
      .is-grid {
        display: flex;
        flex-wrap: wrap;
        align-content: center;
        justify-content: center;
        gap: 0.375rem;
      }
      .is-grid > .sd-tile {
        --sd-cols: 1;
        --sd-rows: 1;
        flex: none;
        width: calc((100% - (var(--sd-cols) - 1) * 0.375rem) / var(--sd-cols));
        height: calc((100% - (var(--sd-rows) - 1) * 0.375rem) / var(--sd-rows));
      }
      .is-grid[data-count='2'] > .sd-tile { --sd-rows: 2; }
      .is-grid[data-count='3'] > .sd-tile { --sd-rows: 3; }
      .is-grid[data-count='4'] > .sd-tile { --sd-rows: 4; }
      .is-grid[data-count='5'] > .sd-tile { --sd-rows: 5; }
      .is-grid[data-count='6'] > .sd-tile { --sd-cols: 2; --sd-rows: 3; }
      .is-grid[data-count='many'] > .sd-tile { --sd-cols: 3; --sd-rows: 3; }
      @container sd-call-grid (aspect-ratio >= 8 / 15) {
        .is-grid[data-count='5'] > .sd-tile { --sd-cols: 2; --sd-rows: 3; }
      }
      @container sd-call-grid (aspect-ratio >= 2 / 3) {
        .is-grid[data-count='4'] > .sd-tile { --sd-cols: 2; --sd-rows: 2; }
      }
      @container sd-call-grid (aspect-ratio >= 8 / 9) {
        .is-grid[data-count='3'] > .sd-tile { --sd-cols: 2; --sd-rows: 2; }
      }
      @container sd-call-grid (aspect-ratio >= 4 / 3) {
        .is-grid[data-count='2'] > .sd-tile { --sd-cols: 2; --sd-rows: 1; }
        .is-grid[data-count='5'] > .sd-tile,
        .is-grid[data-count='6'] > .sd-tile { --sd-cols: 3; --sd-rows: 2; }
      }
      @container sd-call-grid (aspect-ratio >= 2 / 1) {
        .is-grid[data-count='3'] > .sd-tile { --sd-cols: 3; --sd-rows: 1; }
      }
      @container sd-call-grid (aspect-ratio >= 8 / 3) {
        .is-grid[data-count='4'] > .sd-tile { --sd-cols: 4; --sd-rows: 1; }
      }
      @container sd-call-grid (aspect-ratio >= 10 / 3) {
        .is-grid[data-count='5'] > .sd-tile { --sd-cols: 5; --sd-rows: 1; }
      }
    `,
  ],
  template: `
    <div
      class="sd-call-tiles absolute inset-0"
      [class]="isGrid() ? 'is-grid ' + gridClass() : ''"
      [attr.data-count]="countAttr()"
      role="list"
      aria-label="Call video"
    >
      @for (v of view(); track v.key) {
        <div
          class="sd-tile overflow-hidden [container-type:size]"
          [class]="tileClass(v)"
          [style.order]="v.order"
          role="listitem"
          [attr.aria-label]="v.a11y"
        >
          <!-- The uid's video plays in here (track.play) -->
          <div
            #video
            class="absolute inset-0"
            [attr.data-key]="v.key"
            [attr.data-sd-fit]="v.kind === 'main' ? mainFit() : null"
          ></div>

          @if (!v.tile.hasVideo) {
            @switch (v.kind) {
              @case ('pip') {
                <div class="absolute inset-0 flex items-center justify-center bg-abyss text-white/60" aria-hidden="true">
                  <sd-icon name="video-off" [size]="22" />
                </div>
              }
              @case ('main') {
                <div
                  class="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-ink p-6 text-center text-white/75"
                  aria-hidden="true"
                >
                  <span
                    class="flex size-[clamp(2.75rem,22cqmin,4.5rem)] shrink-0 items-center justify-center rounded-full font-heading text-[length:clamp(1rem,8cqmin,1.5rem)] font-semibold text-white"
                    [class]="v.tone"
                  >
                    {{ v.initials }}
                  </span>
                  <p class="font-sans text-body-sm roomy:text-body">{{ v.tile.name }}’s camera is off</p>
                </div>
              }
              @default {
                <div class="absolute inset-0 flex items-center justify-center bg-abyss" aria-hidden="true">
                  <span
                    class="flex size-[clamp(2rem,36cqmin,5.5rem)] items-center justify-center rounded-full font-heading text-[length:clamp(0.75rem,13cqmin,1.75rem)] font-semibold text-white"
                    [class]="v.tone"
                  >
                    {{ v.initials }}
                  </span>
                </div>
              }
            }
          }

          <!-- Name label, with the muted badge -->
          @switch (v.kind) {
            @case ('pip') {
              <span
                class="absolute bottom-1.5 left-1.5 flex max-w-[calc(100%-0.75rem)] items-center gap-1 rounded bg-abyss/70 px-1.5 py-0.5 font-sans text-[10px] text-white/80"
                aria-hidden="true"
              >
                @if (v.tile.muted) {
                  <sd-icon name="mic-off" [size]="10" class="shrink-0 text-alert" />
                }
                <span class="truncate">{{ v.label }}</span>
              </span>
            }
            @case ('main') {
              @if (spotlightLabel()) {
                <div
                  class="absolute left-4 top-4 z-10 flex max-w-[calc(100%-7rem)] items-center gap-1.5 rounded-pill bg-abyss/60 px-3 py-1.5 backdrop-blur roomy:max-w-[calc(100%-8rem)]"
                  aria-hidden="true"
                >
                  @if (v.tile.muted) {
                    <span class="flex size-5 shrink-0 items-center justify-center rounded-full bg-alert text-white">
                      <sd-icon name="mic-off" [size]="12" />
                    </span>
                  }
                  <span class="truncate font-sans text-body-sm font-medium text-white">{{ v.label }}</span>
                  @if (showRole()) {
                    <span class="shrink-0 font-sans text-caption text-white/60">· {{ roleText(v.tile.role) }}</span>
                  }
                </div>
              }
            }
            @default {
              <span
                class="absolute bottom-1.5 left-1.5 flex max-w-[calc(100%-0.75rem)] items-center gap-1 rounded-pill bg-abyss/70 px-2 py-0.5 font-sans text-caption text-white backdrop-blur"
                aria-hidden="true"
              >
                @if (v.tile.muted) {
                  <span class="-ml-1 flex size-4 shrink-0 items-center justify-center rounded-full bg-alert">
                    <sd-icon name="mic-off" [size]="10" />
                  </span>
                }
                <span class="truncate">{{ v.label }}</span>
                @if (showRole() && !v.tile.self) {
                  <span class="shrink-0 text-white/60">· {{ roleText(v.tile.role) }}</span>
                }
              </span>
            }
          }
        </div>
      }
    </div>
    <p class="sr-only" aria-live="polite" aria-atomic="true">{{ announcement() }}</p>
  `,
})
export class CallTilesComponent {
  /** Everyone on the stage, in display order (see `buildCallTiles`). */
  readonly tiles = input.required<readonly CallTile[]>();
  readonly layout = input<CallTilesLayout>('auto');
  /** Position + size of the 1:1 self view (it always gets `absolute z-10`). */
  readonly selfViewClass = input(CALL_SELF_VIEW_CLASS);
  /** Padding of the grid (keep clear of the controls). */
  readonly gridClass = input(CALL_GRID_CLASS);
  /** Name label on the 1:1 main tile; off when the host shows its own name tag there. */
  readonly spotlightLabel = input(true);
  /** "· Guest" / "· Patient" after other people's names. */
  readonly showRole = input(false);
  /** Announce people joining and leaving to screen readers. */
  readonly announce = input(true);
  /**
   * How the 1:1 main video fills the stage: `contain` (default — the whole
   * picture on a dark backdrop, never cropped; a portrait phone camera shows
   * the whole face) or `cover`. Grid tiles always cover.
   */
  readonly mainFit = input<CallVideoFit>('contain');
  /**
   * Where the viewer's own camera shows: `pip` (default), `external` (the host
   * renders `<sd-call-self-tile>` instead — pick one with a single
   * `matchMedia` signal so the camera never plays in two places) or `hidden`.
   * With `external` / `hidden` there is no self tile on the stage at all (1:1
   * or grid); its track stays attached and plays again once it is back.
   */
  readonly selfView = input<CallSelfViewMode>('pip');

  /** A uid's tile was rendered: its video element is ready for `track.play()`. */
  readonly tileReady = output<CallTileReadyEvent>();

  /** What the stage is showing: `spotlight` (1:1) or `grid`. */
  readonly mode = computed(() => callTilesMode(this.tiles(), this.layout()));

  private readonly readyKeys = signal<ReadonlySet<string>>(new Set());
  /** `String(uid)` of every tile whose video element is in the page. */
  readonly ready = this.readyKeys.asReadonly();

  protected readonly isGrid = computed(() => this.mode() === 'grid');
  protected readonly countAttr = computed(() => {
    if (!this.isGrid()) return null;
    const n = this.view().length;
    return n > 6 ? 'many' : String(n);
  });
  protected readonly announcement = signal('');

  /**
   * Tile keys in first-seen order: the DOM order never changes (a moved
   * `<video>` can stall); the display order is CSS `order`.
   */
  private readonly domOrder = linkedSignal<readonly CallTile[], readonly string[]>({
    source: this.tiles,
    computation: (tiles, previous) => {
      const keys = new Set(tiles.map((t) => String(t.uid)));
      const kept = (previous?.value ?? []).filter((k) => keys.has(k));
      return [...new Set([...kept, ...keys])];
    },
  });

  protected readonly view = computed<readonly TileView[]>(() => {
    const tiles = this.tiles();
    const grid = this.isGrid();
    const showSelf = this.selfView() === 'pip';
    const main = grid ? undefined : tiles.find((t) => !t.self);
    const byKey = new Map<string, { tile: CallTile; order: number }>();
    tiles.forEach((tile, order) => byKey.set(String(tile.uid), { tile, order }));
    return this.domOrder().flatMap((key) => {
      const hit = byKey.get(key);
      if (!hit || (hit.tile.self && !showSelf)) return [];
      const { tile, order } = hit;
      const kind: TileView['kind'] = grid ? 'grid' : tile.self ? 'pip' : tile === main ? 'main' : 'grid';
      return [
        {
          key,
          tile,
          kind,
          order,
          label: tile.self ? 'You' : tile.name,
          initials: callTileInitials(tile.name),
          tone: AVATAR_TONE[tile.role] ?? AVATAR_TONE.guest,
          a11y: this.describe(tile),
        },
      ];
    });
  });

  private readonly videoHosts = viewChildren<ElementRef<HTMLElement>>('video');
  private readonly elements = new Map<string, HTMLElement>();
  private readonly attached = new Map<string, Attachment>();

  constructor() {
    // Hand out each tile's video element once it is in the page, play any track
    // that was attached before it existed, and stop playback into removed ones.
    afterRenderEffect(() => {
      const hosts = this.videoHosts();
      untracked(() => this.syncElements(hosts));
    });

    let previous: Map<string, string> | null = null;
    effect(() => {
      const tiles = this.tiles();
      const announce = this.announce();
      const current = new Map(tiles.filter((t) => !t.self).map((t) => [String(t.uid), t.name]));
      const before = previous;
      previous = current;
      // Nothing to say on the first render, or when the host clears the stage (left / ended).
      if (!before || !announce || !tiles.length) return;
      const lines = [
        ...[...current].filter(([k]) => !before.has(k)).map(([, name]) => `${name} joined the call.`),
        ...[...before].filter(([k]) => !current.has(k)).map(([, name]) => `${name} left the call.`),
      ];
      if (lines.length) this.announcement.set(lines.join(' '));
    });

    inject(DestroyRef).onDestroy(() => {
      for (const a of this.attached.values()) if (a.el) a.track.stop();
      this.attached.clear();
      this.elements.clear();
    });
  }

  /** The element a uid's video plays in, once its tile has rendered (else `null`). */
  elementFor(uid: CallUid): HTMLElement | null {
    return this.elements.get(String(uid)) ?? null;
  }

  /** Whether a uid's tile has rendered (reactive). */
  isReady(uid: CallUid): boolean {
    return this.ready().has(String(uid));
  }

  /**
   * Plays a uid's video track in its tile — now, or as soon as the tile
   * renders (and again if it is re-rendered). Replaces (and stops) a different
   * track attached to the same uid.
   */
  attach(uid: CallUid, track: CallVideoTrack, config?: CallVideoPlayConfig): void {
    const key = String(uid);
    const prev = this.attached.get(key);
    if (prev && prev.track === track && sameConfig(prev.config, config)) {
      const el = this.elements.get(key);
      if (el) this.play(prev, el);
      return;
    }
    if (prev?.el) prev.track.stop();
    const next: Attachment = { track, config, el: null };
    this.attached.set(key, next);
    const el = this.elements.get(key);
    if (el) this.play(next, el);
  }

  /** Stops playing a uid's track here and forgets it (user-left / unpublished). */
  detach(uid: CallUid): void {
    const key = String(uid);
    const a = this.attached.get(key);
    if (!a) return;
    if (a.el) a.track.stop();
    this.attached.delete(key);
  }

  protected tileClass(v: TileView): string {
    switch (v.kind) {
      case 'main':
        return 'absolute inset-0 bg-ink';
      case 'pip':
        return `absolute z-10 ${this.selfViewClass()}`;
      default:
        return `relative rounded-xl bg-abyss ring-2 transition-shadow ${v.tile.speaking ? 'ring-success' : 'ring-transparent'}`;
    }
  }

  protected roleText(role: CallTileRole): string {
    return ROLE_TEXT[role] ?? ROLE_TEXT.guest;
  }

  private describe(t: CallTile): string {
    const parts = [t.self ? 'You' : `${t.name}, ${this.roleText(t.role).toLowerCase()}`];
    if (!t.hasVideo) parts.push('camera off');
    if (t.muted) parts.push('microphone muted');
    if (t.speaking) parts.push('speaking');
    return parts.join(', ');
  }

  private play(a: Attachment, el: HTMLElement): void {
    playAttachment(a, el);
  }

  private syncElements(hosts: readonly ElementRef<HTMLElement>[]): void {
    const live = new Map<string, HTMLElement>();
    for (const { nativeElement: el } of hosts) {
      const key = el.dataset['key'];
      if (key) live.set(key, el);
    }
    let changed = false;
    for (const [key, el] of this.elements) {
      if (live.get(key) === el) continue;
      this.elements.delete(key);
      const a = this.attached.get(key);
      if (a?.el === el) {
        a.track.stop();
        a.el = null;
      }
      changed = true;
    }
    const added: HTMLElement[] = [];
    for (const [key, el] of live) {
      if (this.elements.get(key) === el) continue;
      this.elements.set(key, el);
      added.push(el);
      changed = true;
      const a = this.attached.get(key);
      if (a) this.play(a, el);
    }
    if (!changed) return;
    this.readyKeys.set(new Set(this.elements.keys()));
    const tiles = this.tiles();
    for (const el of added) {
      const tile = tiles.find((t) => String(t.uid) === el.dataset['key']);
      if (tile) this.tileReady.emit({ uid: tile.uid, element: el });
    }
  }
}

function sameConfig(a?: CallVideoPlayConfig, b?: CallVideoPlayConfig): boolean {
  return a?.mirror === b?.mirror && a?.fit === b?.fit;
}

/** Plays an attachment's track in `el` (once: a no-op when it already plays there). */
function playAttachment(a: Attachment, el: HTMLElement): void {
  if (a.el === el) return;
  a.track.play(el, a.config);
  a.el = el;
}

/**
 * The viewer's own camera as a small 48×64 tile OUTSIDE the stage — at the
 * start of a phone's control row, where a picture-in-picture would cover the
 * other person's face. Plays the local video track given as `[track]` (or
 * `attach()`), with the initials when the camera is off.
 *
 * Render either this (with `<sd-call-tiles selfView="external">`) or the
 * tiles' own picture-in-picture (`selfView="pip"`), switched by one
 * `matchMedia('(min-width: 640px)')` signal, never both: an Agora track plays
 * in one element at a time, and stopping one playback stops the other.
 */
@Component({
  selector: 'sd-call-self-tile',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block shrink-0', '[class.hidden]': 'hidden()' },
  template: `
    @if (!hidden()) {
      <div
        role="img"
        aria-label="Your camera preview"
        class="relative h-16 w-12 shrink-0 overflow-hidden rounded-xl border border-white/15 bg-abyss"
      >
        <div #video class="absolute inset-0" data-sd-self-video></div>
        @if (!tile().hasVideo) {
          <div class="absolute inset-0 flex flex-col items-center justify-center gap-0.5 bg-abyss" aria-hidden="true">
            <span
              class="flex size-8 items-center justify-center rounded-full font-heading text-caption font-semibold text-white"
              [class]="tone()"
            >
              {{ initials() }}
            </span>
            <sd-icon name="video-off" [size]="12" class="text-white/70" />
          </div>
        }
        @if (tile().muted) {
          <span
            class="absolute bottom-1 left-1 flex size-4 items-center justify-center rounded-full bg-alert text-white"
            aria-hidden="true"
          >
            <sd-icon name="mic-off" [size]="10" />
          </span>
        }
      </div>
    }
  `,
})
export class CallSelfTileComponent {
  /** The viewer's own tile (from `buildCallTiles`: the one with `self`). */
  readonly tile = input.required<CallTile>();
  /** "Hide my preview": nothing shows and the track stops playing here. */
  readonly hidden = input(false);
  /** The local camera track to play (null: none yet). `attach()` does the same imperatively. */
  readonly track = input<CallVideoTrack | null>(null);
  /** Agora play options for it (local video mirrors by default). */
  readonly playConfig = input<CallVideoPlayConfig | undefined>(undefined);

  protected readonly initials = computed(() => callTileInitials(this.tile().name));
  protected readonly tone = computed(() => AVATAR_TONE[this.tile().role] ?? AVATAR_TONE.guest);

  /** What should play: the input, unless `attach()` / `detach()` said otherwise since. */
  private readonly wanted = linkedSignal<{ track: CallVideoTrack; config?: CallVideoPlayConfig } | null>(() => {
    const track = this.track();
    return track ? { track, config: this.playConfig() } : null;
  });
  private readonly videoHost = viewChild<ElementRef<HTMLElement>>('video');
  private playing: Attachment | null = null;

  constructor() {
    afterRenderEffect(() => {
      const el = this.videoHost()?.nativeElement ?? null;
      const wanted = this.wanted();
      untracked(() => this.sync(wanted, el));
    });
    inject(DestroyRef).onDestroy(() => this.stopPlaying());
  }

  /** Plays `track` here (replacing, and stopping, a different one). */
  attach(track: CallVideoTrack, config?: CallVideoPlayConfig): void {
    this.wanted.set({ track, config });
  }

  /** Stops playing here and forgets the track. */
  detach(): void {
    this.wanted.set(null);
  }

  private sync(wanted: { track: CallVideoTrack; config?: CallVideoPlayConfig } | null, el: HTMLElement | null): void {
    const p = this.playing;
    if (wanted && el && p && p.track === wanted.track && sameConfig(p.config, wanted.config) && p.el === el) return;
    this.stopPlaying();
    if (!wanted || !el) return;
    const next: Attachment = { track: wanted.track, config: wanted.config, el: null };
    playAttachment(next, el);
    this.playing = next;
  }

  private stopPlaying(): void {
    if (this.playing?.el) this.playing.track.stop();
    this.playing = null;
  }
}
