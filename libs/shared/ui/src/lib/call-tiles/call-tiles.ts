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
 * Today's patient self view: top-right on a small stage, above the controls on
 * a roomy one. Must set a width and height (the tile is a size container).
 */
export const CALL_SELF_VIEW_CLASS =
  'right-3 top-3 h-24 w-[4.5rem] rounded-2xl border border-white/15 bg-abyss shadow-lg roomy:top-auto roomy:right-4 roomy:bottom-32 roomy:h-32 roomy:w-24';

/** Today's doctor self view (a little larger, lower controls). */
export const CALL_SELF_VIEW_CLASS_DOCTOR =
  'right-3 top-3 h-24 w-[4.5rem] rounded-2xl border border-white/15 bg-abyss shadow-lg roomy:top-auto roomy:right-4 roomy:bottom-28 roomy:h-40 roomy:w-28';

/** Grid insets that keep the tiles clear of the stage's bottom control bar. */
export const CALL_GRID_CLASS = 'p-1.5 pb-[4.5rem] roomy:p-2 roomy:pb-[7rem]';

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
 *   <sd-call-tiles [tiles]="tiles()" [selfViewClass]="selfView" />  <!-- doctor: CALL_SELF_VIEW_CLASS_DOCTOR -->
 *   @if (waiting()) { …overlay… }  <!-- controls etc. stay as they are -->
 * </div>
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
          <div #video class="absolute inset-0" [attr.data-key]="v.key"></div>

          @if (!v.tile.hasVideo) {
            @switch (v.kind) {
              @case ('pip') {
                <div class="absolute inset-0 flex items-center justify-center bg-abyss text-white/60" aria-hidden="true">
                  <sd-icon name="video-off" [size]="22" />
                </div>
              }
              @case ('main') {
                <div
                  class="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-ink pb-16 pl-6 pt-12 text-center text-white/75 roomy:pb-32 roomy:pt-24"
                  [class]="hasPip() ? 'pr-[5.5rem] roomy:pr-36' : 'pr-6'"
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

  /** A uid's tile was rendered: its video element is ready for `track.play()`. */
  readonly tileReady = output<CallTileReadyEvent>();

  /** What the stage is showing: `spotlight` (1:1) or `grid`. */
  readonly mode = computed(() => callTilesMode(this.tiles(), this.layout()));

  private readonly readyKeys = signal<ReadonlySet<string>>(new Set());
  /** `String(uid)` of every tile whose video element is in the page. */
  readonly ready = this.readyKeys.asReadonly();

  protected readonly isGrid = computed(() => this.mode() === 'grid');
  protected readonly hasPip = computed(() => !this.isGrid() && this.tiles().some((t) => t.self));
  protected readonly countAttr = computed(() => {
    if (!this.isGrid()) return null;
    const n = this.domOrder().length;
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
    const main = grid ? undefined : tiles.find((t) => !t.self);
    const byKey = new Map<string, { tile: CallTile; order: number }>();
    tiles.forEach((tile, order) => byKey.set(String(tile.uid), { tile, order }));
    return this.domOrder().flatMap((key) => {
      const hit = byKey.get(key);
      if (!hit) return [];
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
    if (a.el === el) return;
    a.track.play(el, a.config);
    a.el = el;
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
