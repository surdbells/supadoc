import { DOCUMENT, NgTemplateOutlet } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  type ComponentRef,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  signal,
  type Type,
  untracked,
  viewChild,
  ViewContainerRef,
  ViewEncapsulation,
} from '@angular/core';
import { DialogComponent, IconComponent } from '@supadoc/ui';
import type { DocumentViewerComponent } from './document-viewer';
import { DocumentViewerService, VIEWER_CHUNKS } from './document-viewer.service';
import { applyViewerTokens, pageTheme, resolveTone, viewerTokens } from './theme-observer';
import * as copy from './viewer-copy';
import { provideViewerIcons } from './viewer-icons';
import { viewerLayout } from './viewer-layout';
import { isViewerPolicyId, VIEWER_POLICIES } from './viewer-policy';
import type { ViewerInsets, ViewerSource, ViewerState } from './viewer-types';

/** Navigation settles (and is announced) after this long (§1.7). */
const SETTLE_MS = 400;
let nextId = 0;

type Corner = 'br' | 'bl' | 'tl' | 'tr';
const NEXT_CORNER: Record<Corner, Corner> = { br: 'bl', bl: 'tl', tl: 'tr', tr: 'br' };
const CORNER_TEXT: Record<Corner, string> = { br: 'bottom right', bl: 'bottom left', tl: 'top left', tr: 'top right' };

/*
 * The browser's own print (its menu; Ctrl/Cmd+P is the viewer's) prints none of
 * the viewer: header, call band and PiP live here, outside the body's print-hidden
 * host (§1.8.1). The dialog goes too, so its top-layer box and backdrop never print.
 */
const OUTLET_CSS = `
@media print{sd-document-viewer-outlet,sd-document-viewer-outlet dialog{display:none!important}}
.sd-viewer-frame{background:var(--sd-viewer-chrome);color:var(--sd-viewer-text)}
.sd-viewer-frame:fullscreen{width:100vw;height:100vh}
.sd-viewer-frame :is(button,[tabindex]):focus-visible{outline:2px solid var(--sd-viewer-ring);outline-offset:2px}
.sdv-band :focus-visible,.sdv-pip :focus-visible{outline-color:#bbdefb!important}
.sdv-band{min-height:56px;padding-top:max(6px,env(safe-area-inset-top));background:var(--sd-viewer-band);border-bottom:1px solid var(--sd-viewer-band-border);color:#fff}
.sdv-head{min-height:64px;padding:12px max(12px,env(safe-area-inset-right)) 10px max(16px,env(safe-area-inset-left));border-bottom:1px solid var(--sd-viewer-border)}
.sdv-c{background:var(--sd-viewer-chrome)}
.sdv-l{border-color:var(--sd-viewer-border)}
.sdv-p{background:var(--sd-viewer-pressed-bg);color:var(--sd-viewer-pressed-fg)}
.sdv-muted{color:var(--sd-viewer-muted)}
.sdv-hbtn{color:var(--sd-viewer-control)}
.sdv-hbtn:hover:not(:disabled){background:var(--sd-viewer-hover);color:var(--sd-viewer-text)}
.sdv-hbtn:disabled{opacity:.4}
.sdv-band .sdv-hbtn{color:#fff}
.sdv-band .sdv-hbtn:hover{background:rgb(255 255 255/.1)}
.sdv-wait{background:var(--sd-viewer-stage)}
.sdv-wait i{display:block;width:min(34rem,82%);aspect-ratio:1/1.414;border-radius:4px;background:var(--sd-viewer-skeleton)}
.sdv-pip-layer{pointer-events:none}
.sdv-pip{pointer-events:auto;width:224px;height:168px;border-color:var(--sd-viewer-pip-border);background:var(--sd-viewer-pip-bg);touch-action:none}
.sdv-pip--br{right:16px;bottom:16px}.sdv-pip--bl{left:16px;bottom:16px}.sdv-pip--tl{left:16px;top:16px}.sdv-pip--tr{right:16px;top:16px}
.sdv-pip--hidden{visibility:hidden;width:1px!important;height:1px!important;border:0}
.sdv-pill{top:6px;right:6px;background:var(--sd-viewer-pip-pill)}
.sdv-pill button{color:#fff}
[data-layout=tablet] .sdv-pip{width:176px;height:132px}
[data-layout=phone] .sdv-pip{width:104px;height:138px;margin:-4px}
[data-layout=phone] .sdv-band{min-height:52px}
[data-layout=phone] .sdv-head{min-height:56px;padding-top:8px;padding-bottom:8px}
[data-layout=compact] .sdv-top{flex-direction:row;align-items:center;min-height:48px;border-bottom:1px solid var(--sd-viewer-border);background:var(--sd-viewer-band)}
[data-layout=compact] .sdv-band,[data-layout=compact] .sdv-head{flex-wrap:nowrap;min-height:48px;padding:0 4px;border:0}
[data-layout=compact] .sdv-head{flex:1 1 auto;min-width:0;align-items:center;padding-right:max(4px,env(safe-area-inset-right))}
[data-layout=compact] .sdv-pip{width:112px;height:84px}
`;

/**
 * The viewer's modal (lazy chunk, mounted by `DocumentViewerService` on the
 * first open): `sd-dialog size="viewer"`, the full-screen frame, the header
 * (type tile, title, meta, the policy notice, document navigation, Close),
 * the call band and the picture-in-picture layer of a registered call (§3),
 * and the body — its own lazy chunk, loaded as soon as this outlet is (and
 * prefetched by the service), and only ever created inside `@if (session())`,
 * so never without a source (D2). The body is created with a
 * `ViewContainerRef` rather than `@defer`: the first `@defer` in an app pulls
 * Angular's deferred-loading runtime (about 15 kB) into its initial bundle.
 */
@Component({
  selector: 'sd-document-viewer-outlet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [DialogComponent, IconComponent, NgTemplateOutlet],
  providers: [provideViewerIcons()],
  styles: [OUTLET_CSS],
  host: { class: 'contents' },
  template: `
    <sd-dialog
      [open]="open()"
      size="viewer"
      layout="plain"
      [labelledBy]="titleId"
      [describedBy]="metaId"
      [closeOnBackdrop]="true"
      (closed)="svc.close()"
      (afterClose)="svc.afterClosed()"
    >
      <!-- Keys bubble here after the frame (where the body handles its own Esc) and before sd-dialog: an Esc nobody took closes Details first. -->
      <div class="contents" role="presentation" (keydown)="onKeydown($event)">
      <div #frame class="sd-viewer-frame relative flex h-full min-h-0 w-full flex-1 flex-col" [attr.data-layout]="layout()" [attr.data-policy]="head()?.policy ?? null">
        <div class="sdv-top flex min-w-0 shrink-0 flex-col">
          @if (call(); as c) {
            <div class="sd-call sdv-band flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5" data-theme="dark">
              <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1"><ng-container [ngTemplateOutlet]="c.bar" /></div>
              @if (c.peer && pipHidden()) {
                <button type="button" class="sdv-hbtn inline-flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-field px-2.5 font-sans text-caption font-semibold" [attr.aria-label]="compact() ? c$.SHOW_VIDEO : null" (click)="showPip()">
                  <sd-icon name="picture-in-picture-2" [size]="18" />
                  @if (!compact()) {
                    <span>{{ c$.SHOW_VIDEO }}</span>
                  }
                </button>
              }
            </div>
          }
          @if (head(); as h) {
            <header class="sdv-head sdv-c relative flex items-start gap-3">
              @if (!(compact() && call())) {
                <span class="sdv-p flex size-10 shrink-0 items-center justify-center rounded-xl" aria-hidden="true"><sd-icon [name]="h.icon" [size]="20" /></span>
              }
              <div class="min-w-0 flex-1">
                <h2 #title [id]="titleId" tabindex="-1" data-autofocus class="truncate font-heading text-body-lg font-semibold outline-none" [attr.title]="h.title">{{ h.title }}</h2>
                <p [id]="metaId" class="truncate font-sans text-caption sdv-muted" [class.sr-only]="compact()">{{ metaText() }}</p>
                @if (h.notice && !compact()) {
                  <p class="sdv-notice sdv-muted mt-0.5 flex items-start gap-1.5 font-sans text-caption">
                    <sd-icon [name]="h.noticeIcon ?? 'lock'" [size]="13" class="mt-px shrink-0" />{{ h.notice }}
                  </p>
                }
                @if (listText()) {
                  <span class="sr-only">{{ listText() }}</span>
                }
              </div>
              @if (compact()) {
                @if (h.notice && h.policy === 'view_only') {
                  <span class="sdv-muted inline-flex size-11 shrink-0 items-center justify-center" role="img" [attr.aria-label]="h.notice"><sd-icon name="lock" [size]="16" /></span>
                }
                <button #detailsBtn type="button" class="sdv-hbtn inline-flex size-11 shrink-0 items-center justify-center rounded-field" [attr.aria-label]="c$.DETAILS" [attr.aria-expanded]="detailsOpen()" (click)="detailsOpen.set(!detailsOpen())">
                  <sd-icon name="info" [size]="18" />
                </button>
              }
              @if (total() >= 2) {
                <div class="flex shrink-0 items-center">
                  <button #prevBtn type="button" class="sdv-hbtn inline-flex size-11 shrink-0 items-center justify-center rounded-field" [disabled]="index() <= 0" [attr.aria-label]="prevLabel()" (click)="prev()">
                    <sd-icon name="chevron-left" [size]="20" />
                  </button>
                  <span class="px-1 font-sans text-caption tabular-nums sdv-muted" [class.sr-only]="compact()"><span class="sr-only">Document </span>{{ index() + 1 }} of {{ total() }}</span>
                  <button #nextBtn type="button" class="sdv-hbtn inline-flex size-11 shrink-0 items-center justify-center rounded-field" [disabled]="index() >= total() - 1" [attr.aria-label]="nextLabel()" (click)="next()">
                    <sd-icon name="chevron-right" [size]="20" />
                  </button>
                </div>
              }
              <button type="button" class="sdv-hbtn inline-flex size-11 shrink-0 items-center justify-center rounded-field" [attr.aria-label]="c$.CLOSE_DOCUMENT" (click)="svc.close()"><sd-icon name="x" [size]="22" /></button>
              @if (compact() && detailsOpen()) {
                <div class="sdv-details sdv-c sdv-l absolute inset-x-2 z-30 mt-12 max-w-sm rounded-xl border p-3 font-sans text-caption shadow-overlay" role="dialog" [attr.aria-label]="c$.DETAILS">
                  <p>{{ metaText() }}</p>
                  @if (h.notice) {
                    <p class="sdv-notice sdv-muted mt-0.5 flex items-start gap-1.5"><sd-icon [name]="h.noticeIcon ?? 'lock'" [size]="13" class="mt-px shrink-0" />{{ h.notice }}</p>
                  }
                </div>
              }
            </header>
          }
        </div>
        <div #content class="sdv-content relative flex min-h-0 flex-1 flex-col">
          @if (session(); as s) {
            @switch (body()) {
              @case ('loading') {
                <div class="sdv-wait flex flex-1 flex-col items-center gap-4 px-4 py-6">
                  <i></i>
                  <p class="font-sans text-body-sm sdv-muted" role="status">{{ c$.OPENING }}</p>
                </div>
              }
              @case ('failed') {
                <div class="sdv-wait flex flex-1 flex-col items-center gap-4 px-4 py-6">
                  <div class="sdv-ocard sdv-c sdv-l mt-8 flex max-w-md flex-col items-center gap-3 rounded-card border px-6 py-6 text-center">
                    <sd-icon name="triangle-alert" [size]="28" class="sdv-muted" />
                    <p class="font-sans text-body-sm" role="alert">{{ live() ? c$.UPDATE_IN_CALL : c$.CHUNK_RELOAD }}</p>
                    @if (!live()) {
                      <button type="button" class="sdv-p h-10 rounded-field px-4 font-sans text-body-sm font-semibold" (click)="reload()">{{ c$.RELOAD }}</button>
                    }
                  </div>
                </div>
              }
            }
            <!-- The body (sd-document-viewer, its own lazy chunk) is created here, before the PiP layer. -->
            <ng-container #bodyHost />
            @if (call()?.peer; as peer) {
              <div
                class="sd-call sdv-pip-layer absolute z-10"
                data-theme="dark"
                [style.top.px]="insets().top"
                [style.right.px]="insets().right"
                [style.bottom.px]="insets().bottom"
                [style.left.px]="insets().left"
              >
                <div
                  #pip
                  [class]="'sdv-pip absolute overflow-hidden rounded-card border shadow-overlay sdv-pip--' + corner()"
                  [class.sdv-pip--hidden]="pipHidden()"
                  [style.transform]="drag()"
                  (pointerdown)="dragStart($event)"
                >
                  <div class="absolute inset-0"><ng-container [ngTemplateOutlet]="peer" /></div>
                  <div class="sdv-pill absolute flex gap-0.5 rounded-full p-0.5">
                    <button type="button" class="flex size-9 items-center justify-center rounded-full" [attr.aria-label]="c$.moveVideoLabel(peerName())" (click)="moveCorner()"><sd-icon name="picture-in-picture-2" [size]="16" /></button>
                    <button type="button" class="flex size-9 items-center justify-center rounded-full" [attr.aria-label]="c$.HIDE_VIDEO" (click)="hidePip()"><sd-icon name="eye-off" [size]="16" /></button>
                  </div>
                </div>
              </div>
            }
          }
        </div>
        <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">{{ announcement() }}</p>
      </div>
      </div>
    </sd-dialog>
  `,
})
export class DocumentViewerOutletComponent {
  protected readonly svc = inject(DocumentViewerService);
  private readonly doc = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  /** The copy the template reads, by name (no namespace object; see the body). */
  protected readonly c$ = {
    CHUNK_RELOAD: copy.CHUNK_RELOAD,
    CLOSE_DOCUMENT: copy.CLOSE_DOCUMENT,
    DETAILS: copy.DETAILS,
    HIDE_VIDEO: copy.HIDE_VIDEO,
    OPENING: copy.OPENING,
    RELOAD: copy.RELOAD,
    SHOW_VIDEO: copy.SHOW_VIDEO,
    UPDATE_IN_CALL: copy.UPDATE_IN_CALL,
    moveVideoLabel: copy.moveVideoLabel,
  } as const;

  protected readonly titleId = `sd-viewer-title-${++nextId}`;
  protected readonly metaId = `sd-viewer-meta-${nextId}`;

  private readonly theme = pageTheme();
  protected readonly layout = viewerLayout();
  protected readonly compact = computed(() => this.layout() === 'compact');

  protected readonly session = this.svc.session;
  protected readonly open = computed(() => this.session() !== null);
  protected readonly index = this.svc.index;
  protected readonly call = this.svc.call;
  protected readonly total = computed(() => this.session()?.sources.length ?? 0);
  protected readonly current = computed<ViewerSource | null>(() => this.session()?.sources[this.index()] ?? null);
  protected readonly live = computed(() => this.call()?.live() ?? false);
  protected readonly sharing = computed(() => this.call()?.sharingScreen() ?? false);
  protected readonly recording = computed(() => this.call()?.recording() ?? false);
  protected readonly peerName = computed(() => this.call()?.peerName() ?? '');

  /** A registered call overrides the open's tone with the cockpit's (§1.9). */
  protected readonly tone = computed(() => {
    const c = this.call();
    if (c) return c.tone() === 'light' ? 'light' : 'dark';
    return this.session()?.options.tone ?? 'light';
  });
  private readonly lastTone = signal<'light' | 'dark' | 'auto'>('light');
  protected readonly tokens = computed(() => viewerTokens(resolveTone(this.open() ? this.tone() : this.lastTone(), this.theme())));

  protected readonly shareGuard = computed<'none' | 'warn' | 'cover'>(() => {
    const src = this.current();
    if (!this.sharing() || !src) return 'none';
    return isViewerPolicyId(src.policy) ? VIEWER_POLICIES[src.policy].shareGuard : 'cover';
  });
  protected readonly revokedText = computed(() => {
    const src = this.current();
    return src ? (this.svc.revoked().get(src.key) ?? null) : null;
  });
  protected readonly resume = computed(() => {
    const src = this.current();
    return src ? this.svc.resumeFor(src.key) : null;
  });
  protected readonly autoPrint = computed(() => !!this.session()?.options.autoPrint && !this.svc.navigated());

  /** The header: the current document, or a snapshot of the closing one while the dialog fades (title and type only). */
  private readonly snapshot = signal<{
    title: string;
    icon: string;
    notice: string | null;
    noticeIcon: string | null;
    policy: string;
  } | null>(null);
  protected readonly head = computed(() => this.snapshot());
  protected readonly metaText = computed(() => {
    const src = this.current();
    if (!src) return '';
    if (this.sharing()) return copy.DETAILS_HIDDEN;
    const ext = (src.extension ?? '').replace(/^\.+/, '').toUpperCase();
    return [src.typeLabel, ext, src.sizeLabel ?? '', ...(src.meta ?? [])].filter((p) => !!p && p.trim()).join(' · ');
  });
  protected readonly listText = computed(() => {
    const s = this.session();
    const label = s?.options.listLabel;
    if (!s || !label || s.sources.length < 2 || this.sharing()) return '';
    return `Document ${this.index() + 1} of ${s.sources.length} in ${label}`;
  });
  protected readonly prevLabel = computed(() => {
    const t = this.session()?.sources[this.index() - 1]?.title;
    return t ? `${copy.PREVIOUS_DOCUMENT}: ${t}` : copy.PREVIOUS_DOCUMENT;
  });
  protected readonly nextLabel = computed(() => {
    const t = this.session()?.sources[this.index() + 1]?.title;
    return t ? `${copy.NEXT_DOCUMENT}: ${t}` : copy.NEXT_DOCUMENT;
  });

  protected readonly insets = signal<ViewerInsets>({ top: 0, right: 0, bottom: 0, left: 0 });
  protected readonly announcement = signal('');
  protected readonly detailsOpen = signal(false);
  // The picture-in-picture: kept for the call session (in memory only).
  protected readonly corner = signal<Corner>('br');
  protected readonly pipHidden = signal(false);
  protected readonly drag = signal<string | null>(null);

  private readonly chunks = inject(VIEWER_CHUNKS);
  private readonly bodyType = signal<Type<DocumentViewerComponent> | null>(null);
  private readonly bodyFailed = signal(false);
  /** The body chunk: still loading (the skeleton), failed (old hashes after a deploy), or ready. */
  protected readonly body = computed(() => (this.bodyFailed() ? 'failed' : this.bodyType() ? 'ready' : 'loading'));
  private readonly bodyHost = viewChild('bodyHost', { read: ViewContainerRef });
  private readonly bodyRef = signal<ComponentRef<DocumentViewerComponent> | null>(null);

  private readonly frameEl = viewChild<ElementRef<HTMLElement>>('frame');
  private readonly titleEl = viewChild<ElementRef<HTMLElement>>('title');
  private readonly detailsBtn = viewChild<ElementRef<HTMLElement>>('detailsBtn');
  private readonly pipEl = viewChild<ElementRef<HTMLElement>>('pip');
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private lastSeq = 0;
  private dragFrom: { x: number; y: number } | null = null;

  constructor() {
    // The colour tokens on the frame (not a [style] map binding: see applyViewerTokens).
    effect(() => {
      const frame = this.frameEl()?.nativeElement;
      const tokens = this.tokens();
      if (frame) applyViewerTokens(frame, tokens);
    });
    // The header follows the document on screen and stays (title and type only) while the dialog fades out.
    effect(() => {
      const src = this.current();
      const tone = this.tone();
      if (!src) return;
      const p = isViewerPolicyId(src.policy) ? VIEWER_POLICIES[src.policy] : null;
      untracked(() => {
        this.lastTone.set(tone);
        this.snapshot.set({
          title: src.title,
          icon: iconFor(src),
          notice: p?.notice ?? null,
          noticeIcon: p?.noticeIcon ?? null,
          policy: src.policy,
        });
      });
    });
    // Replaced in place (another document opened while open): focus the title.
    effect(() => {
      const s = this.session();
      untracked(() => {
        if (s && this.lastSeq && s.seq !== this.lastSeq) this.focusTitle();
        this.lastSeq = s ? s.seq : 0;
        if (!s) {
          this.insets.set({ top: 0, right: 0, bottom: 0, left: 0 });
          this.detailsOpen.set(false);
          clearTimeout(this.settleTimer);
        }
      });
    });
    // A new call: the PiP starts bottom-right (top-left on a phone held sideways), shown.
    let lastCall: unknown = null;
    effect(() => {
      const c = this.call();
      untracked(() => {
        if (c === lastCall) return;
        lastCall = c;
        this.corner.set(this.compact() ? 'tl' : 'br');
        this.pipHidden.set(false);
      });
    });
    // The body: created in its host (inside the @if) once its chunk is here; it goes with the @if on close.
    this.chunks.body().then(
      (m) => this.bodyType.set(m.DocumentViewerComponent as Type<DocumentViewerComponent>),
      () => this.bodyFailed.set(true),
    );
    effect(() => {
      const host = this.bodyHost() ?? null;
      const type = this.bodyType();
      untracked(() => this.mountBody(host, type));
    });
    // Its inputs follow the session, the call and the document on screen.
    effect(() => {
      const ref = this.bodyRef();
      const src = this.current();
      if (!ref || !src) return;
      const inputs = this.bodyInputs(src);
      untracked(() => {
        for (const [name, value] of Object.entries(inputs)) ref.setInput(name, value);
      });
    });
    inject(DestroyRef).onDestroy(() => clearTimeout(this.settleTimer));
  }

  private bodyInputs(src: ViewerSource): Record<string, unknown> {
    const s = this.session();
    return {
      source: src,
      tone: this.tone(),
      watermark: s?.options.watermark ?? null,
      liveCall: this.live(),
      inCall: !!this.call(),
      shareGuard: this.shareGuard(),
      recording: this.recording(),
      autoPrint: this.autoPrint(),
      revokedText: this.revokedText(),
      resume: this.resume(),
      canPrevDoc: this.index() > 0,
      canNextDoc: this.index() < this.total() - 1,
      navigated: this.svc.navigated(),
    };
  }

  private mountBody(host: ViewContainerRef | null, type: Type<DocumentViewerComponent> | null): void {
    const current = this.bodyRef();
    if (current && (current.hostView.destroyed || !host || host.indexOf(current.hostView) < 0)) this.bodyRef.set(null);
    if (!host || !type || this.bodyRef()) return;
    const src = this.current();
    if (!src) return;
    const ref = host.createComponent(type);
    ref.setInput('mode', 'modal');
    for (const [name, value] of Object.entries(this.bodyInputs(src))) ref.setInput(name, value);
    const body = ref.instance;
    body.state.subscribe((st) => this.saveState(st));
    body.prevDoc.subscribe(() => this.prev());
    body.nextDoc.subscribe(() => this.next());
    body.stageInsets.subscribe((i) => this.insets.set(i));
    body.stopSharing.subscribe(() => this.stopSharing());
    this.bodyRef.set(ref);
  }

  protected prev(): void {
    this.navigate(-1);
  }

  protected next(): void {
    this.navigate(1);
  }

  private navigate(dir: 1 | -1): void {
    const before = this.index();
    this.svc.go(before + dir);
    if (this.index() === before) return;
    this.detailsOpen.set(false);
    // Focus stays on the pressed button; at an end of the list (now disabled) it moves to the title.
    afterNextRender(
      () => {
        const active = this.doc.activeElement as HTMLButtonElement | null;
        if (!active || active === this.doc.body || (active.tagName === 'BUTTON' && active.disabled)) this.titleEl()?.nativeElement.focus();
      },
      { injector: this.injector },
    );
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      const src = this.current();
      if (src) this.announce(copy.documentOf(this.index() + 1, this.total(), src.title));
    }, SETTLE_MS);
  }

  protected saveState(state: ViewerState): void {
    const src = this.current();
    if (src) this.svc.saveResume(src.key, state);
  }

  protected stopSharing(): void {
    this.call()?.stopSharing();
  }

  protected reload(): void {
    this.doc.defaultView?.location.reload();
  }

  /**
   * Esc while the compact Details popover is open, and nothing inside the body
   * took it (its menus, page sheet and overlay rail prevent it first): the
   * popover closes and focus goes back to its button; the viewer stays open.
   */
  protected onKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || e.defaultPrevented || !this.detailsOpen()) return;
    e.preventDefault();
    e.stopPropagation();
    this.detailsOpen.set(false);
    afterNextRender(() => this.detailsBtn()?.nativeElement.focus(), { injector: this.injector });
  }

  // ----- picture-in-picture -----

  protected moveCorner(): void {
    const next = NEXT_CORNER[this.corner()];
    this.corner.set(next);
    this.announce(copy.videoMoved(CORNER_TEXT[next]));
  }

  protected hidePip(): void {
    this.pipHidden.set(true);
    afterNextRender(() => this.doc.querySelector<HTMLElement>('.sdv-band > button')?.focus(), { injector: this.injector });
  }

  protected showPip(): void {
    this.pipHidden.set(false);
    afterNextRender(() => this.pipEl()?.nativeElement.querySelector<HTMLElement>('.sdv-pill button')?.focus(), { injector: this.injector });
  }

  /** Drag the tile; on release it snaps to the nearest corner of the stage. */
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
      this.drag.set(null);
      const layer = pip.parentElement?.getBoundingClientRect();
      const r = pip.getBoundingClientRect();
      if (!from || !layer || (ev.clientX === from.x && ev.clientY === from.y)) return;
      const cx = (r.left + r.right) / 2 - layer.left;
      const cy = (r.top + r.bottom) / 2 - layer.top;
      const corner: Corner = `${cy < layer.height / 2 ? 't' : 'b'}${cx < layer.width / 2 ? 'l' : 'r'}` as Corner;
      if (corner !== this.corner()) {
        this.corner.set(corner);
        this.announce(copy.videoMoved(CORNER_TEXT[corner]));
      }
    };
    pip.addEventListener('pointermove', move);
    pip.addEventListener('pointerup', up);
    pip.addEventListener('pointercancel', up);
  }

  private focusTitle(): void {
    afterNextRender(() => this.titleEl()?.nativeElement.focus(), { injector: this.injector });
  }

  private announce(text: string): void {
    this.announcement.set(this.announcement() === text ? `${text}\u00a0` : text);
  }

}

/** The type tile's icon by kind: file-text (PDF or unknown), image, video. */
function iconFor(src: ViewerSource): string {
  const ext = (src.extension ?? '').toLowerCase();
  if (/^(jpe?g|png|webp|gif|heic)$/.test(ext)) return 'image';
  if (/^(mp4|webm|mov)$/.test(ext)) return 'video';
  return 'file-text';
}
