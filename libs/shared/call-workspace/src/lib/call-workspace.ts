import { DOCUMENT, NgTemplateOutlet } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  Directive,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  model,
  output,
  type Provider,
  type Signal,
  signal,
  type TemplateRef,
  untracked,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';
import { LUCIDE_ICONS, type LucideIconData } from '@lucide/angular';
import { DialogComponent, IconComponent } from '@supadoc/ui';
import { DETAILS_HIDDEN, HIDE_VIDEO, moveVideoLabel, SHOW_VIDEO, STOP_SHARING, videoMoved } from '@supadoc/viewer';
import type { WorkspaceFlag, WorkspaceTabDef } from './workspace-types';

/*
 * A call page's workspace: one large modal over the call cockpit holding the
 * page's tools (the doctor's: the five consultation tools and the Full EMR),
 * with the call band on top and the peer's live video as its
 * picture-in-picture, like the shared document viewer. A presentational shell:
 * the panels are declared in the call page's template and projected here
 * (`[sdWsPanel]`), so they live with the page and closing the modal destroys
 * none of their state. Apart from the viewer's own copy, every word it shows
 * comes from its inputs (kicker, title, close label, share text, tabs, marks).
 */

/** The layouts: `desktop` ≥ 1024 px, `tablet` 640–1023, `phone` < 640, `compact` a phone held sideways, whatever its width. */
export type WorkspaceLayout = 'desktop' | 'tablet' | 'phone' | 'compact';

const COMPACT_QUERY = '(orientation: landscape) and (max-height: 500px)';
const DESKTOP_QUERY = '(min-width: 1024px)';
const TABLET_QUERY = '(min-width: 640px)';

/** The current layout as a signal (desktop where `matchMedia` is missing). A local copy of the viewer's queries: its helper is not in the light entry. */
function workspaceLayout(): Signal<WorkspaceLayout> {
  const view = inject(DOCUMENT).defaultView;
  const mm = view && typeof view.matchMedia === 'function' ? view.matchMedia.bind(view) : null;
  if (!mm) return signal<WorkspaceLayout>('desktop').asReadonly();
  const queries = [mm(COMPACT_QUERY), mm(DESKTOP_QUERY), mm(TABLET_QUERY)];
  const read = (): WorkspaceLayout => {
    if (queries[0]?.matches) return 'compact';
    if (queries[1]?.matches) return 'desktop';
    if (queries[2]?.matches) return 'tablet';
    return 'phone';
  };
  const layout = signal<WorkspaceLayout>(read());
  const update = () => layout.set(read());
  for (const q of queries) q?.addEventListener?.('change', update);
  inject(DestroyRef).onDestroy(() => {
    for (const q of queries) q?.removeEventListener?.('change', update);
  });
  return layout.asReadonly();
}

/**
 * The one icon only the workspace (and the viewer) uses, as icon DATA (Lucide
 * 1.23.0, ISC licence: https://lucide.dev/license), never a `Lucide…` class: those
 * land in the initial bundle. A merging provider: `LUCIDE_ICONS` is not multi.
 */
const PIP_ICON: LucideIconData = {
  name: 'picture-in-picture-2',
  node: [
    ['path', { d: 'M21 9V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10c0 1.1.9 2 2 2h4' }],
    ['rect', { width: '10', height: '7', x: '12', y: '13', rx: '2' }],
  ],
};

function provideWorkspaceIcons(): Provider {
  return {
    provide: LUCIDE_ICONS,
    useFactory: () => ({ ...inject(LUCIDE_ICONS, { skipSelf: true }), [PIP_ICON.name]: PIP_ICON }),
  };
}

type Corner = 'br' | 'bl' | 'tl' | 'tr';
const NEXT_CORNER: Record<Corner, Corner> = { br: 'bl', bl: 'tl', tl: 'tr', tr: 'br' };
const CORNER_TEXT: Record<Corner, string> = { br: 'bottom right', bl: 'bottom left', tl: 'top left', tr: 'top right' };

let nextId = 0;

/** Between a control that took focus and a panel's sticky bar. */
const STICKY_BAR_GAP = 8;

/*
 * Component styles (never new Tailwind utilities: those land in the initial
 * styles.css), with the theme variables the app builds emit. The literal
 * colours are the viewer's own values, so the two bands and PiPs match.
 * Its emitted stylesheet stays under 4,000 bytes (the component budget): a
 * byte added here is offset in the same change.
 */
export const WS_CSS = `
@media print { sd-call-workspace dialog { display: none !important; } }
.ws-frame { --ws-ring: var(--color-frost); --ws-pip-w: 224px; --ws-pip-h: 168px; --ws-inset: 16px; }
.ws-frame[data-tone='light'] { --ws-ring: var(--color-cerulean); }
/* The shell's OWN chrome only: the projected panels keep their own focus styles (frost is about 1.3:1 on the glacier paper zones). */
:is(.ws-top, .ws-share, .ws-pip) :is(button, [tabindex]):focus-visible { outline: 2px solid var(--ws-ring); outline-offset: 2px; }
.ws-band :focus-visible, .ws-pip :focus-visible { outline-color: var(--color-frost) !important; }
/* The strip scrolls sideways, so a ring outside the tab would be cut. */
.ws-tabs :focus-visible { outline-offset: -2px !important; }
.ws-flag-unsaved { background: var(--color-warning); }
.ws-frame[data-tone='light'] .ws-flag-unsaved { background: var(--color-warning-ink); }
/* Warning text already in the moved panels (no light remap in theme.css): about 2:1 on the light surfaces. */
.ws-frame[data-tone='light'] .ws-inner .text-warning { color: var(--color-warning-ink); }
/* The band = the viewer's band, pixel for pixel (so a viewer opening over it cross-fades into the same band). */
.ws-band { min-height: 56px; padding-top: max(6px, env(safe-area-inset-top)); background: var(--color-ink); border-bottom: 1px solid rgb(255 255 255 / 0.1); color: #fff; }
.ws-band .ws-hbtn:hover { background: rgb(255 255 255 / 0.1); }
.ws-head { min-height: 64px; padding-left: max(16px, env(safe-area-inset-left)); padding-right: max(12px, env(safe-area-inset-right)); }
.ws-scroll { padding: 16px; scroll-padding: 16px; }
.ws-inner { width: 100%; max-width: 76rem; margin-inline: auto; }
/* The viewer's own share banner in the cockpit tones. */
.ws-share { background: rgb(242 169 0 / 0.18); color: #fff; }
.ws-frame[data-tone='light'] .ws-share { background: rgb(242 169 0 / 0.16); color: var(--color-warning-ink); }
.ws-pip-layer { position: absolute; inset: 0; z-index: 10; pointer-events: none; }
.ws-pip { position: absolute; pointer-events: auto; width: var(--ws-pip-w); height: var(--ws-pip-h); overflow: hidden; border-radius: var(--radius-card); border: 1px solid rgb(255 255 255 / 0.16); background: var(--color-abyss); box-shadow: var(--sd-elev-overlay); touch-action: none; }
.ws-pip--br { right: var(--ws-inset); bottom: var(--ws-inset); }
.ws-pip--bl { left: var(--ws-inset); bottom: var(--ws-inset); }
.ws-pip--tl { left: var(--ws-inset); top: var(--ws-inset); }
.ws-pip--tr { right: var(--ws-inset); top: var(--ws-inset); }
.ws-pip--hidden { visibility: hidden; width: 1px !important; height: 1px !important; border: 0; }
.ws-pip-tile { position: absolute; inset: 0; }
.ws-pill { position: absolute; top: 6px; right: 6px; display: flex; gap: 2px; padding: 2px; border-radius: 999px; background: rgb(10 22 40 / 0.6); }
.ws-pill button { display: flex; width: 36px; height: 36px; align-items: center; justify-content: center; border-radius: 999px; color: #fff; }
.ws-peer-wait { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: var(--color-abyss); color: #fff; }
.ws-peer-wait span { display: flex; width: 48px; height: 48px; align-items: center; justify-content: center; border-radius: 50%; background: var(--color-ocean); }
/* The gutter on the PiP's side, so it never covers content (desktop, tablet, compact: beside; phone: below/above). */
.ws-frame:not([data-layout='phone']) .ws-scroll:is([data-pip='br'], [data-pip='tr']) { padding-right: calc(var(--ws-pip-w) + 2 * var(--ws-inset)); }
.ws-frame:not([data-layout='phone']) .ws-scroll:is([data-pip='bl'], [data-pip='tl']) { padding-left: calc(var(--ws-pip-w) + 2 * var(--ws-inset)); }
.ws-frame[data-layout='phone'] .ws-scroll:is([data-pip='br'], [data-pip='bl']) { padding-bottom: calc(var(--ws-pip-h) + 24px); scroll-padding-bottom: calc(var(--ws-pip-h) + 24px); }
.ws-frame[data-layout='phone'] .ws-scroll:is([data-pip='tr'], [data-pip='tl']) { padding-top: calc(var(--ws-pip-h) + 24px); scroll-padding-top: calc(var(--ws-pip-h) + 24px); }
.ws-frame[data-layout='tablet'] { --ws-pip-w: 176px; --ws-pip-h: 132px; }
.ws-frame[data-layout='phone'] { --ws-pip-w: 104px; --ws-pip-h: 138px; --ws-inset: 12px; }
.ws-frame[data-layout='phone'] .ws-band { min-height: 52px; }
.ws-frame[data-layout='phone'] .ws-head { min-height: 56px; }
.ws-frame[data-layout='phone'] .ws-scroll { padding: 12px; }
.ws-frame[data-layout='compact'] { --ws-pip-w: 112px; --ws-pip-h: 84px; --ws-inset: 8px; }
.ws-frame[data-layout='compact'] .ws-band { flex-wrap: nowrap; min-height: 48px; padding: 0 max(4px, env(safe-area-inset-right)) 0 max(4px, env(safe-area-inset-left)); }
.ws-frame[data-layout='compact'] .ws-band [data-band-label] { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.ws-frame[data-layout='compact'] .ws-pill { top: 4px; right: 4px; }
.ws-frame[data-layout='compact'] .ws-pill button { width: 28px; height: 28px; }
@media (prefers-reduced-motion: reduce) { .ws-frame * { transition: none !important; } }
`;

/** The shell itself: see the file's comment. `K` is the call page's tab keys. */
@Component({
  selector: 'sd-call-workspace',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Styles the band template's nodes ([data-band-label]) and the PiP placeholder; every class is ws-prefixed.
  encapsulation: ViewEncapsulation.None,
  imports: [DialogComponent, IconComponent, NgTemplateOutlet],
  providers: [provideWorkspaceIcons()],
  styles: [WS_CSS],
  host: { class: 'contents' },
  template: `
    <sd-dialog
      [open]="open()"
      size="viewer"
      layout="plain"
      [labelledBy]="kickerId + ' ' + titleId"
      [describedBy]="metaId"
      [closeOnBackdrop]="true"
      (closed)="closed.emit()"
      (afterClose)="onAfterClose()"
    >
      @if (shown()) {
        <div
          #frame
          role="presentation"
          class="ws-frame relative flex h-full min-h-0 w-full flex-1 flex-col bg-abyss text-white"
          [attr.data-layout]="layout()"
          [attr.data-tone]="tone()"
          (keydown)="onFrameKeydown($event)"
        >
          <div class="ws-top flex min-w-0 shrink-0 flex-col">
            <!-- The call band: always dark (.sd-dock re-asserts the dark utilities in the light cockpit). -->
            <div
              #bandEl
              class="sd-dock ws-band flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5"
              (focusin)="onBandFocusIn($event)"
              (focusout)="onBandFocusOut($event)"
            >
              <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                @if (peer() && pipHidden()) {
                  <button
                    #showVideoBtn
                    type="button"
                    class="ws-hbtn inline-flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-field px-2.5 font-sans text-caption font-semibold"
                    [attr.aria-label]="compact() ? c$.SHOW_VIDEO : null"
                    (click)="showPip()"
                  >
                    <sd-icon name="picture-in-picture-2" [size]="18" />
                    @if (!compact()) {
                      <span>{{ c$.SHOW_VIDEO }}</span>
                    }
                  </button>
                }
                <ng-container [ngTemplateOutlet]="band()" />
              </div>
              @if (compact()) {
                <!-- The allergy chip (icon + count; full list sr-only) and ✕ join the 48px row. The band is
                     always dark, so the chip always takes the dark variant here (text-white, re-asserted white
                     by .sd-dock in the light cockpit). -->
                @if (allergies().length && !sharing()) {
                  <span class="inline-flex shrink-0 items-center gap-1 rounded-pill border border-alert/60 bg-alert/15 px-2 py-1 font-sans text-caption font-semibold text-white">
                    <sd-icon name="triangle-alert" [size]="14" class="shrink-0 text-alert" />
                    <span aria-hidden="true">{{ allergies().length }}</span>
                    <span class="sr-only">Allergies: {{ allergies().join(', ') }}</span>
                  </span>
                }
                <button type="button" class="ws-hbtn inline-flex size-11 shrink-0 items-center justify-center rounded-field" [attr.aria-label]="closeLabel()" (click)="closed.emit()">
                  <sd-icon name="x" [size]="22" />
                </button>
              }
            </div>
            @if (!compact()) {
              <header class="ws-head flex items-center gap-3 border-b border-white/10 py-2">
                @if (!phone()) {
                  <span class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-cerulean/15 text-frost" aria-hidden="true">
                    <sd-icon name="stethoscope" [size]="20" />
                  </span>
                }
                <div class="min-w-0 flex-1">
                  <p [id]="kickerId" class="font-sans text-caption font-semibold uppercase tracking-wide text-white/70" [class.sr-only]="phone()">{{ kicker() }}</p>
                  <h2 [id]="titleId" class="truncate font-heading text-body-lg font-semibold text-white" [attr.title]="title()">{{ title() }}</h2>
                  <p [id]="metaId" class="truncate font-sans text-caption text-white/70">{{ sharing() ? c$.DETAILS_HIDDEN : meta() }}</p>
                </div>
                @if (allergies().length && !sharing()) {
                  <!-- The cockpit header's allergy pill, on the header's own surface (its tone switch applies); phones: icon + count. -->
                  <span
                    class="inline-flex min-w-0 max-w-[9rem] shrink items-center gap-1 rounded-pill border border-alert/60 bg-alert/15 px-2.5 py-1 font-sans text-caption font-semibold sm:max-w-[18rem]"
                    [class.text-white]="tone() !== 'light'"
                    [class.text-alert-ink]="tone() === 'light'"
                  >
                    <sd-icon name="triangle-alert" [size]="14" class="shrink-0 text-alert" />
                    @if (phone()) {
                      <span aria-hidden="true">{{ allergies().length }}</span>
                    } @else {
                      <span class="truncate" aria-hidden="true">Allergies: {{ allergies().join(', ') }}</span>
                    }
                    <span class="sr-only">Allergies: {{ allergies().join(', ') }}</span>
                  </span>
                }
                <button type="button" class="ws-hbtn inline-flex size-11 shrink-0 items-center justify-center rounded-field transition-colors hover:bg-white/10" [attr.aria-label]="closeLabel()" (click)="closed.emit()">
                  <sd-icon name="x" [size]="22" />
                </button>
              </header>
            } @else {
              <!-- Compact: the same kicker, title and meta, sr-only (they still name and describe the dialog). -->
              <div class="sr-only">
                <p [id]="kickerId">{{ kicker() }}</p>
                <h2 [id]="titleId">{{ title() }}</h2>
                <p [id]="metaId">{{ sharing() ? c$.DETAILS_HIDDEN : meta() }}</p>
              </div>
            }
            <div class="ws-tabs flex border-b border-white/10 px-2">
              <div #strip role="tablist" [attr.aria-label]="tablistLabel() || kicker()" class="flex min-w-0 flex-1 gap-1 overflow-x-auto">
                @for (t of tabs(); track t.key) {
                  <button
                    type="button"
                    role="tab"
                    [id]="'ws-tab-' + t.key"
                    class="relative flex min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap px-3 font-sans text-body-sm transition-colors"
                    [class]="tab() === t.key ? 'text-white' : 'text-white/70 hover:text-white'"
                    [attr.aria-selected]="tab() === t.key"
                    [attr.aria-controls]="panels().has(t.key) ? 'ws-panel-' + t.key : null"
                    [attr.tabindex]="tab() === t.key ? 0 : -1"
                    [attr.data-autofocus]="tab() === t.key ? '' : null"
                    (click)="select(t.key)"
                    (keydown)="onTabKey($event)"
                  >
                    <sd-icon [name]="t.icon" [size]="16" class="shrink-0" />{{ t.label }}
                    @if (flags()[t.key]; as f) {
                      <!-- The dot by mark (.ws-flag-unsaved is the warning dot); the app's own words after it. -->
                      @switch (f.mark) {
                        @case ('warn') {
                          <span class="ws-flag-unsaved size-1.5 rounded-full" aria-hidden="true"></span>
                        }
                        @case ('live') {
                          <span class="size-1.5 rounded-full bg-alert motion-safe:animate-pulse" aria-hidden="true"></span>
                        }
                        @case ('new') {
                          <span class="size-1.5 rounded-full bg-cerulean" aria-hidden="true"></span>
                        }
                      }
                      <span class="sr-only">{{ f.sr }}</span>
                    }
                    @if (tab() === t.key) {
                      <span class="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-cerulean"></span>
                    }
                  </button>
                }
              </div>
            </div>
          </div>
          @if (shareBanner()) {
            <div class="ws-share flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2" role="status">
              <sd-icon name="triangle-alert" [size]="16" class="shrink-0" />
              <span class="min-w-0 flex-1 font-sans text-caption">{{ shareText() }}</span>
              <button type="button" class="ws-share-btn min-h-11 rounded-field px-3 font-sans text-caption font-semibold underline underline-offset-2" (click)="stopSharing.emit()">{{ c$.STOP_SHARING }}</button>
            </div>
          }
          <div class="ws-content relative flex min-h-0 flex-1 flex-col">
            <div #scroller class="ws-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain" [attr.data-pip]="peer() && !pipHidden() ? corner() : 'none'" (focusin)="onContentFocusIn($event)">
              <div class="ws-inner"><ng-content /></div>
            </div>
            @if (peer(); as tpl) {
              <div class="sd-dock ws-pip-layer">
                <div #pip [class]="'ws-pip ws-pip--' + corner()" [class.ws-pip--hidden]="pipHidden()" [style.transform]="drag()" (pointerdown)="dragStart($event)">
                  <div class="ws-pip-tile"><ng-container [ngTemplateOutlet]="tpl" /></div>
                  <div class="ws-pill">
                    <button type="button" [attr.aria-label]="c$.moveVideoLabel(peerName())" (click)="moveCorner()"><sd-icon name="picture-in-picture-2" [size]="16" /></button>
                    <button type="button" [attr.aria-label]="c$.HIDE_VIDEO" (click)="hidePip()"><sd-icon name="eye-off" [size]="16" /></button>
                  </div>
                </div>
              </div>
            }
          </div>
          <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">{{ announcement() }}</p>
        </div>
      }
    </sd-dialog>
  `,
})
export class CallWorkspace<K extends string = string> {
  private readonly doc = inject(DOCUMENT);
  private readonly injector = inject(Injector);

  readonly open = input(false);
  readonly tab = model.required<K>();
  readonly tabs = input.required<readonly WorkspaceTabDef<K>[]>();
  /** The call page's band template (#viewerBar). */
  readonly band = input<TemplateRef<unknown> | null>(null);
  /** The call page's tile template (#workspacePeer). */
  readonly peer = input<TemplateRef<unknown> | null>(null);
  /** The peer's name (the PiP's Move label). */
  readonly peerName = input('');
  /** The dialog's title (the doctor: the patient's name). */
  readonly title = input('');
  /** The small line above the title; with the title, it names the dialog ("Consultation tools"). */
  readonly kicker = input.required<string>();
  /** The ✕ button's name ("Close consultation tools"). */
  readonly closeLabel = input.required<string>();
  /** The tab strip's name; the kicker when empty. */
  readonly tablistLabel = input('');
  /** Under the title, e.g. "Female · 34 yrs". */
  readonly meta = input('');
  readonly allergies = input<readonly string[]>([]);
  /** Hides the meta and the allergies (the page shares its screen and they are private). */
  readonly sharing = input(false);
  /** The share banner's words (the page's own, e.g. with the recording). */
  readonly shareText = input('');
  /** The share banner shows (false while the Full EMR shows its own cover). */
  readonly shareBanner = input(false);
  readonly tone = input<'dark' | 'light'>('dark');
  /** Small marks on tabs, each with the app's own screen-reader words (see WorkspaceFlag). */
  readonly flags = input<Partial<Record<K, WorkspaceFlag>>>({});

  readonly closed = output<void>();
  readonly afterClose = output<void>();
  readonly stopSharing = output<void>();

  /** desktop ≥1024, tablet 640–1023, phone <640, compact (sideways phone). */
  readonly layout = workspaceLayout();
  /** Phones and phones held sideways: the rx panel uses its stacked layout there. */
  readonly narrow = computed(() => this.layout() === 'phone' || this.layout() === 'compact');
  protected readonly compact = computed(() => this.layout() === 'compact');
  protected readonly phone = computed(() => this.layout() === 'phone');

  /** The viewer's copy the template reads, by name (no namespace object: the viewer's bundle rule). */
  protected readonly c$ = { DETAILS_HIDDEN, HIDE_VIDEO, moveVideoLabel, SHOW_VIDEO, STOP_SHARING } as const;
  protected readonly kickerId = `ws-kicker-${++nextId}`;
  protected readonly titleId = `ws-title-${nextId}`;
  protected readonly metaId = `ws-meta-${nextId}`;

  /** Open, or fading out. */
  protected readonly shown = signal(false);
  // The picture-in-picture: kept for the call (the shell lives as long as the page).
  protected readonly corner = signal<Corner>('br');
  protected readonly pipHidden = signal(false);
  protected readonly drag = signal<string | null>(null);
  protected readonly announcement = signal('');
  /** Registered by sdWsPanel. */
  protected readonly panels = signal<ReadonlySet<string>>(new Set());

  private readonly frame = viewChild<ElementRef<HTMLElement>>('frame');
  private readonly bandEl = viewChild<ElementRef<HTMLElement>>('bandEl');
  private readonly strip = viewChild<ElementRef<HTMLElement>>('strip');
  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  private readonly pipEl = viewChild<ElementRef<HTMLElement>>('pip');
  private readonly showVideoBtn = viewChild<ElementRef<HTMLElement>>('showVideoBtn');
  /** `.ws-scroll`'s offset per tab, and each `[data-ws-keep-scroll]` element's by key. */
  private readonly scrollMemory = new Map<K, number>();
  private readonly keptScroll = new Map<string, number>();
  /** An explicit target for the next tab change (showTab): wins over the remembered scroll. */
  private pendingTarget: { readonly id?: string } | null = null;
  private dragFrom: { x: number; y: number } | null = null;
  /** The call-band control focus is on (null once focus has moved elsewhere). */
  private bandFocus: HTMLElement | null = null;
  private lastTab: K | null = null;

  constructor() {
    // Before sd-dialog's first focus (after render), so the selected tab is there to take it.
    effect(() => {
      if (this.open()) untracked(() => this.shown.set(true));
    });
    // Every tab change, whoever made it (a click, the keyboard, showTab, a model write from the page).
    effect(() => {
      const key = this.tab();
      untracked(() => {
        const previous = this.lastTab;
        this.lastTab = key;
        if (previous === null || previous === key || !this.shown()) return;
        afterNextRender(() => this.afterTabChange(key), { injector: this.injector });
      });
    });
    // While the frame exists: one recorder of the scroll offsets; on open, they come back.
    effect((onCleanup) => {
      const frame = this.frame()?.nativeElement;
      if (!frame) return;
      const record = (e: Event) => this.recordScroll(e);
      frame.addEventListener('scroll', record, { capture: true, passive: true });
      onCleanup(() => frame.removeEventListener('scroll', record, { capture: true }));
      untracked(() =>
        afterNextRender(
          () => {
            this.revealTab(this.tab());
            this.restoreScroll();
          },
          { injector: this.injector },
        ),
      );
    });
    // A band control removed while focused: not every browser fires focusout on removal.
    effect((onCleanup) => {
      const band = this.bandEl()?.nativeElement;
      const view = this.doc.defaultView as (Window & { MutationObserver?: typeof MutationObserver }) | null;
      if (!band || typeof view?.MutationObserver !== 'function') return;
      const observer = new view.MutationObserver(() => this.refocusIfBandControlGone());
      observer.observe(band, { childList: true, subtree: true });
      onCleanup(() => observer.disconnect());
    });
  }

  /** A tool's own dialog is open inside the frame (its own `<dialog>` is its ancestor, so only a tool's matches). */
  hasOpenNestedDialog(): boolean {
    return !!this.frame()?.nativeElement.querySelector('dialog[open]');
  }

  /**
   * Select a tab from outside the tablist: after render, focus and scroll to
   * `targetId` inside the frame, else focus the tab (the button that was pressed
   * is now in a hidden panel, and focus would fall to `<body>` inside a modal).
   */
  showTab(key: K, targetId?: string): void {
    this.pendingTarget = targetId === undefined ? {} : { id: targetId };
    if (this.tab() === key) {
      afterNextRender(() => this.afterTabChange(key), { injector: this.injector });
      return;
    }
    this.tab.set(key);
  }

  registerPanel(key: string): void {
    this.panels.update((s) => new Set([...s, key]));
  }

  unregisterPanel(key: string): void {
    this.panels.update((s) => new Set([...s].filter((k) => k !== key)));
  }

  protected onAfterClose(): void {
    if (!this.open()) this.shown.set(false);
    this.afterClose.emit();
  }

  /** Esc during an IME composition cancels the composition only (sd-dialog ignores a prevented Esc). */
  protected onFrameKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && (e.isComposing || e.keyCode === 229)) e.preventDefault();
  }

  // ----- tabs -----

  protected select(key: K): void {
    this.tab.set(key);
  }

  /** APG tabs, automatic activation: arrows, Home and End move and select. */
  protected onTabKey(e: KeyboardEvent): void {
    const keys = this.tabs().map((t) => t.key);
    let i = keys.indexOf(this.tab());
    if (e.key === 'ArrowRight') i = (i + 1) % keys.length;
    else if (e.key === 'ArrowLeft') i = (i - 1 + keys.length) % keys.length;
    else if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = keys.length - 1;
    else return;
    e.preventDefault();
    const next = keys[i];
    this.tab.set(next);
    afterNextRender(() => this.tabEl(next)?.focus(), { injector: this.injector });
  }

  private tabEl(key: K): HTMLElement | null {
    return this.doc.getElementById('ws-tab-' + key);
  }

  private afterTabChange(key: K): void {
    this.revealTab(key);
    const pending = this.pendingTarget;
    this.pendingTarget = null;
    if (pending?.id) {
      // An explicit target wins: the remembered offset is not applied on this change.
      const el = this.frame()?.nativeElement.querySelector<HTMLElement>(`[id="${pending.id}"]`) ?? null;
      if (el) {
        el.scrollIntoView?.({ block: 'start', behavior: this.reducedMotion() ? 'auto' : 'smooth' });
        (el.querySelector<HTMLElement>('[data-ws-focus]') ?? el).focus({ preventScroll: true });
        return;
      }
    }
    this.restoreScroll();
    if (pending) this.tabEl(key)?.focus();
  }

  /** Only the strip scrolls sideways (never the page), so the selected tab shows in full. */
  private revealTab(key: K): void {
    const strip = this.strip()?.nativeElement;
    const tab = this.tabEl(key);
    if (!strip || !tab) return;
    const s = strip.getBoundingClientRect();
    const t = tab.getBoundingClientRect();
    // The panel may be mid entry (slightly scaled): the strip's own pixels.
    const scale = strip.offsetWidth && s.width ? s.width / strip.offsetWidth : 1;
    if (t.left < s.left) strip.scrollLeft -= (s.left - t.left) / scale;
    else if (t.right > s.right) strip.scrollLeft += (t.right - s.right) / scale;
  }

  private reducedMotion(): boolean {
    return !!this.doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  }

  // ----- scroll memory -----

  private recordScroll(e: Event): void {
    const el = e.target;
    if (!(el instanceof HTMLElement)) return;
    if (el === this.scroller()?.nativeElement) {
      this.scrollMemory.set(this.tab(), el.scrollTop);
      return;
    }
    const key = el.getAttribute('data-ws-keep-scroll');
    if (key) this.keptScroll.set(key, el.scrollTop);
  }

  private restoreScroll(): void {
    const scroller = this.scroller()?.nativeElement;
    if (scroller) scroller.scrollTop = this.scrollMemory.get(this.tab()) ?? 0;
    const kept = this.frame()?.nativeElement.querySelectorAll<HTMLElement>('[data-ws-keep-scroll]');
    kept?.forEach((el) => {
      const offset = this.keptScroll.get(el.getAttribute('data-ws-keep-scroll') ?? '');
      if (offset !== undefined) el.scrollTop = offset;
    });
  }

  // ----- a panel's sticky bar -----

  /** After the browser's own scroll into view, which comes after this event. */
  protected onContentFocusIn(e: FocusEvent): void {
    const el = e.target;
    if (el instanceof HTMLElement) setTimeout(() => this.keepClearOfStickyBar(el));
  }

  /**
   * WCAG 2.4.11: a control that takes focus never stays under a panel's own sticky
   * bar (the prescription composer's actions). The bar grows with the alerts in it
   * (64 px to 194 px), so no fixed scroll margin can promise this.
   */
  private keepClearOfStickyBar(el: HTMLElement): void {
    const scroller = this.scroller()?.nativeElement;
    if (!scroller || this.doc.activeElement !== el) return;
    // A tool's own dialog is in this subtree too, but in the top layer.
    if (el.closest('dialog') !== scroller.closest('dialog')) return;
    const bar = Array.from(scroller.querySelectorAll<HTMLElement>('.sticky.bottom-0')).find((b) => b.getClientRects().length > 0);
    if (!bar || bar.contains(el)) return;
    const box = el.getBoundingClientRect();
    const overlap = box.bottom + STICKY_BAR_GAP - bar.getBoundingClientRect().top;
    if (overlap <= 0) return;
    // Never past the control's own start: one taller than the room left still shows where it begins.
    const padding = parseFloat(this.doc.defaultView?.getComputedStyle(scroller).scrollPaddingTop ?? '') || 0;
    const room = box.top - scroller.getBoundingClientRect().top - padding;
    scroller.scrollTop += Math.max(0, Math.min(overlap, room));
  }

  // ----- picture-in-picture (the viewer's model) -----

  protected moveCorner(): void {
    const next = NEXT_CORNER[this.corner()];
    this.corner.set(next);
    this.announce(videoMoved(CORNER_TEXT[next]));
  }

  protected hidePip(): void {
    this.pipHidden.set(true);
    afterNextRender(() => this.showVideoBtn()?.nativeElement.focus(), { injector: this.injector });
  }

  protected showPip(): void {
    this.pipHidden.set(false);
    afterNextRender(() => this.pipEl()?.nativeElement.querySelector<HTMLElement>('.ws-pill button')?.focus(), { injector: this.injector });
  }

  /** Drag the tile; on release it snaps to the nearest corner of the content area. */
  protected dragStart(e: PointerEvent): void {
    if ((e.target as HTMLElement).closest('button') || e.button !== 0) return;
    const pip = this.pipEl()?.nativeElement;
    if (!pip) return;
    this.dragFrom = { x: e.clientX, y: e.clientY };
    pip.setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent) => {
      if (!this.dragFrom) return;
      this.drag.set(`translate(${ev.clientX - this.dragFrom.x}px, ${ev.clientY - this.dragFrom.y}px)`);
    };
    const up = (ev: PointerEvent) => {
      pip.removeEventListener('pointermove', move);
      pip.removeEventListener('pointerup', up);
      pip.removeEventListener('pointercancel', up);
      pip.releasePointerCapture?.(ev.pointerId);
      const from = this.dragFrom;
      this.dragFrom = null;
      const layer = pip.parentElement?.getBoundingClientRect();
      const r = pip.getBoundingClientRect();
      this.drag.set(null);
      if (!from || !layer || (ev.clientX === from.x && ev.clientY === from.y)) return;
      const cx = (r.left + r.right) / 2 - layer.left;
      const cy = (r.top + r.bottom) / 2 - layer.top;
      const corner: Corner = `${cy < layer.height / 2 ? 't' : 'b'}${cx < layer.width / 2 ? 'l' : 'r'}` as Corner;
      if (corner !== this.corner()) {
        this.corner.set(corner);
        this.announce(videoMoved(CORNER_TEXT[corner]));
      }
    };
    pip.addEventListener('pointermove', move);
    pip.addEventListener('pointerup', up);
    pip.addEventListener('pointercancel', up);
  }

  private announce(text: string): void {
    this.announcement.set(this.announcement() === text ? `${text}\u00a0` : text);
  }

  // ----- call band: when the focused control disappears -----

  protected onBandFocusIn(e: FocusEvent): void {
    this.bandFocus = e.target instanceof HTMLElement ? e.target : null;
  }

  protected onBandFocusOut(e: FocusEvent): void {
    if (e.relatedTarget) {
      // To another element: a focusin there takes over if it is in the band.
      if (this.bandFocus === e.target) this.bandFocus = null;
      return;
    }
    // To nothing: the control is being removed, the window lost focus, or a click landed on plain text.
    setTimeout(() => this.refocusIfBandControlGone());
  }

  /**
   * The band control focus was on has been removed and focus fell to nothing:
   * focus goes to the selected tab. Never while the workspace closes (its opener
   * takes focus), and never when something else already took focus.
   */
  private refocusIfBandControlGone(): void {
    const lost = this.bandFocus;
    if (!lost) return;
    const active = this.doc.activeElement;
    if (lost.isConnected) {
      // Still there: it keeps focus while the window is in the background; otherwise focus left it.
      if (active !== lost) this.bandFocus = null;
      return;
    }
    this.bandFocus = null;
    if (!this.open() || (active && active !== this.doc.body)) return;
    this.tabEl(this.tab())?.focus();
  }
}

/**
 * One projected panel of the workspace (`<div sdWsPanel="notes">`, declared in
 * the call page's template): a tabpanel, only hidden while another tab shows.
 * `.sd-tab-panel` is styled by the call page's component CSS (the host is an
 * element of its template). Not generic: a static attribute value gives the
 * compiler nothing to infer a key type from, and the shell registers strings.
 */
@Directive({
  selector: '[sdWsPanel]',
  host: {
    role: 'tabpanel',
    class: 'sd-tab-panel block',
    '[id]': "'ws-panel-' + key()",
    '[attr.aria-labelledby]': "'ws-tab-' + key()",
    '[hidden]': 'ws.tab() !== key()',
  },
})
export class WorkspacePanel {
  readonly key = input.required<string>({ alias: 'sdWsPanel' });
  /** Projected content injects the shell it is projected into. */
  protected readonly ws = inject(CallWorkspace);

  constructor() {
    afterNextRender(() => this.ws.registerPanel(this.key()));
    inject(DestroyRef).onDestroy(() => this.ws.unregisterPanel(this.key()));
  }
}
