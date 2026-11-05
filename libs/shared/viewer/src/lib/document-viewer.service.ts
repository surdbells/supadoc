import { DOCUMENT } from '@angular/common';
import {
  afterNextRender,
  type AfterRenderRef,
  ApplicationRef,
  type ComponentRef,
  computed,
  createComponent,
  DestroyRef,
  EnvironmentInjector,
  inject,
  Injectable,
  InjectionToken,
  signal,
  type Type,
} from '@angular/core';
import { GuardsCheckEnd, Router } from '@angular/router';
import { DialogService } from '@supadoc/ui';
import { CHUNK_RELOAD, UPDATE_IN_CALL } from './viewer-copy';
import { VIEWER_DEFAULTS } from './viewer-defaults';
import { sourceProblem } from './viewer-policy';
import type {
  ViewerCallContext,
  ViewerOpenOptions,
  ViewerRef,
  ViewerResumeState,
  ViewerSession,
  ViewerSource,
} from './viewer-types';

/**
 * The viewer's lazy chunks. Relative dynamic imports inside the lib, never a
 * barrel: the outlet and the body are each their own chunk, outside every
 * app's initial bundle (D2). Tests provide spies.
 */
export interface ViewerChunks {
  outlet(): Promise<{ readonly DocumentViewerOutletComponent: Type<unknown> }>;
  body(): Promise<{ readonly DocumentViewerComponent: Type<unknown> }>;
}

export const VIEWER_CHUNKS = new InjectionToken<ViewerChunks>('VIEWER_CHUNKS', {
  providedIn: 'root',
  factory: () => ({
    outlet: () => import('./document-viewer-outlet'),
    body: () => import('./document-viewer'),
  }),
});

/** The prefetch waits for an idle moment (or this long where there is no requestIdleCallback). */
export const PREFETCH_FALLBACK_MS = 2000;

/** The path of a URL, without its query string or fragment. */
function pathOf(url: string): string {
  return url.split(/[?#]/)[0] ?? '';
}

interface OpenRecord {
  readonly seq: number;
  resolve(): void;
}

/**
 * Opens documents in the shared viewer: one modal for every app (U1). Hosts
 * describe documents as `ViewerSource`s and call `open()`; the service mounts
 * the outlet itself on the first open (no element in any `app.html`), keeps
 * one session at a time, closes it on a real route change, restores page and
 * zoom per document, and hands the other person's video between a registered
 * call page and the viewer's picture-in-picture (§3).
 */
@Injectable({ providedIn: 'root' })
export class DocumentViewerService {
  private readonly appRef = inject(ApplicationRef);
  private readonly env = inject(EnvironmentInjector);
  private readonly doc = inject(DOCUMENT);
  private readonly defaults = inject(VIEWER_DEFAULTS);
  private readonly chunks = inject(VIEWER_CHUNKS);
  private readonly dialogs = inject(DialogService);
  private readonly router = inject(Router, { optional: true });

  private readonly sessionState = signal<ViewerSession | null>(null);
  /** The open session (read by the outlet). */
  readonly session = this.sessionState.asReadonly();
  readonly isOpen = computed(() => this.sessionState() !== null);
  private readonly indexState = signal(0);
  /** The document on screen, in `session().sources`. */
  readonly index = this.indexState.asReadonly();
  private readonly navigatedState = signal(false);
  /** The current document was reached by ‹ / › (its load is debounced, §1.7). */
  readonly navigated = this.navigatedState.asReadonly();
  private readonly revokedState = signal<ReadonlyMap<string, string>>(new Map());
  /** Documents no longer shared during this session: key → the text shown in place. */
  readonly revoked = this.revokedState.asReadonly();
  private readonly callState = signal<ViewerCallContext | null>(null);
  /** The registered call page, if any (§3.2). */
  readonly call = this.callState.asReadonly();

  private readonly resumes = new Map<string, ViewerResumeState>();
  private opener: HTMLElement | null = null;
  private fallbackFocus: (() => HTMLElement | null) | null = null;
  private current: OpenRecord | null = null;
  private seq = 0;
  /** The call context `willOpen()` ran for (handed back on close). */
  private handedTo: ViewerCallContext | null = null;
  /** A hand-back scheduled by close(), with the context it is for (an open() before it runs takes the peer back over). */
  private pendingDidClose: { readonly ref: AfterRenderRef; readonly ctx: ViewerCallContext } | null = null;
  private outlet: ComponentRef<unknown> | null = null;
  private mounting: Promise<void> | null = null;
  /** The app (or test) is gone: a late chunk must not mount anything. */
  private destroyed = false;

  constructor() {
    const destroyRef = inject(DestroyRef);
    const sub = this.router?.events.subscribe((e) => {
      if (!(e instanceof GuardsCheckEnd) || !e.shouldActivate || !this.sessionState()) return;
      if (pathOf(e.urlAfterRedirects ?? e.url) !== pathOf(this.router?.url ?? '')) this.close();
    });
    destroyRef.onDestroy(() => {
      this.destroyed = true;
      sub?.unsubscribe();
      this.outlet?.destroy();
      this.outlet = null;
    });
    this.prefetch();
  }

  /**
   * Open one document or a list (at `options.index`). Opening while open
   * replaces the document in place, keeping the first opener. Every source is
   * checked first (§1.16): a refused one is kept in the list, shows "This
   * document can't be shown here." and is never loaded.
   */
  open(sources: ViewerSource | readonly ViewerSource[], options: ViewerOpenOptions = {}): ViewerRef {
    const list: readonly ViewerSource[] = Array.isArray(sources) ? [...(sources as readonly ViewerSource[])] : [sources as ViewerSource];
    // (1) Every check, before anything else happens.
    const refused = list.map((s) => {
      const reason = sourceProblem(s, options);
      if (reason) console.error('[sd-viewer] refused source', s?.key, reason);
      return reason;
    });
    const wasOpen = this.sessionState() !== null;
    if (!wasOpen) {
      const active = this.doc.activeElement;
      this.opener = options.opener ?? (active instanceof HTMLElement && active !== this.doc.body ? active : null);
      this.fallbackFocus = options.fallbackFocus ?? null;
    } else if (options.fallbackFocus) {
      this.fallbackFocus = options.fallbackFocus;
    }
    this.current?.resolve();
    let resolve!: () => void;
    const closed = new Promise<void>((r) => (resolve = r));
    const record: OpenRecord = { seq: ++this.seq, resolve };
    this.current = record;
    const session: ViewerSession = {
      seq: record.seq,
      sources: list,
      refused,
      options: { ...options, tone: options.tone ?? this.defaults.tone },
    };
    const index = Math.min(Math.max(0, Math.floor(options.index ?? 0)), Math.max(0, list.length - 1));
    // (2) The outlet (lazy) on the first open; (3) the session; (4) the call hand-over.
    const mounted = this.outlet !== null;
    const ready = mounted ? null : this.mount();
    this.indexState.set(index);
    this.navigatedState.set(false);
    this.revokedState.set(new Map());
    this.sessionState.set(session);
    if (!wasOpen) {
      const pending = this.pendingDidClose;
      this.pendingDidClose = null;
      pending?.ref.destroy();
      if (pending && this.callState() === pending.ctx) {
        // Closed and opened again before the hand-back ran: the peer never left the viewer,
        // and the next close() hands it back to the same context.
        this.handedTo = pending.ctx;
      } else if (mounted) {
        this.handOver();
      } else {
        // Whatever session is open once the outlet is mounted (a second open() may have
        // replaced this one meanwhile) takes the peer; handOver() runs at most once.
        void ready?.then(
          () => {
            if (!this.destroyed && this.outlet && this.sessionState()) this.handOver();
          },
          (err: unknown) => this.mountFailed(record.seq, err),
        );
      }
    } else if (ready) {
      void ready.catch((err: unknown) => this.mountFailed(record.seq, err));
    }
    return {
      closed,
      close: () => {
        if (this.current === record) this.close();
      },
    };
  }

  /** Close the viewer (✕, Esc, scrim, a route change). The session ends at once; the body and PiP go with the next render. */
  close(): void {
    if (!this.sessionState()) return;
    this.sessionState.set(null);
    this.navigatedState.set(false);
    this.revokedState.set(new Map());
    this.current?.resolve();
    this.current = null;
    const ctx = this.handedTo;
    this.handedTo = null;
    if (ctx) {
      // After the render that destroyed the peer tile (its DestroyRef stopped the track): never from afterClose.
      const ref = afterNextRender(
        () => {
          this.pendingDidClose = null;
          if (this.callState() === ctx) ctx.didClose();
        },
        { injector: this.env },
      );
      this.pendingDidClose = { ref, ctx };
    }
  }

  /** The dialog has finished closing (the outlet's `afterClose`): focus back to the opener, else the fallback. */
  afterClosed(): void {
    if (this.sessionState()) return;
    const opener = this.opener;
    const fallback = this.fallbackFocus;
    this.opener = null;
    this.fallbackFocus = null;
    // After sd-dialog's own focus restore (a setTimeout of its own).
    setTimeout(() => {
      if (this.sessionState()) return;
      const active = this.doc.activeElement;
      const lost = !active || active === this.doc.body;
      if (opener?.isConnected) {
        if (lost) opener.focus();
        return;
      }
      if (lost || !active?.isConnected) fallback?.()?.focus();
    });
  }

  /** The document is no longer shared: drop its bytes at once and show `text` (role=alert) in place. */
  revoke(key: string, text: string): void {
    const s = this.sessionState();
    if (!s || !s.sources.some((src) => src.key === key)) return;
    const next = new Map(this.revokedState());
    next.set(key, text);
    this.revokedState.set(next);
  }

  /** Is `key` the document on screen? (hosts use it before revoke) */
  isShowing(key: string): boolean {
    const s = this.sessionState();
    return !!s && s.sources[this.indexState()]?.key === key;
  }

  /** A call page registers while it lives; every open() during that time gets the call band (§3). */
  registerCall(ctx: ViewerCallContext): () => void {
    this.callState.set(ctx);
    return () => {
      if (this.callState() !== ctx) return;
      this.pendingDidClose?.ref.destroy();
      this.pendingDidClose = null;
      if (this.handedTo === ctx) this.handedTo = null;
      if (this.sessionState()) this.close();
      this.callState.set(null);
    };
  }

  // ----- used by the outlet -----

  /** Move to another document of the list (‹ / ›, [ / ]): its load waits for navigation to settle. */
  go(index: number): void {
    const s = this.sessionState();
    if (!s) return;
    const next = Math.min(Math.max(0, index), s.sources.length - 1);
    if (next === this.indexState()) return;
    this.navigatedState.set(true);
    this.indexState.set(next);
  }

  resumeFor(key: string): ViewerResumeState | null {
    return this.resumes.get(key) ?? null;
  }

  /** Kept in memory for the SPA session only, never stored. */
  saveResume(key: string, state: ViewerResumeState): void {
    this.resumes.set(key, { page: state.page, zoomMode: state.zoomMode, zoom: state.zoom, rotation: state.rotation });
  }

  // ----- internals -----

  private handOver(): void {
    const ctx = this.callState();
    if (!ctx || this.handedTo) return;
    this.handedTo = ctx;
    // Last: nothing that can throw runs after it.
    ctx.willOpen();
  }

  private mount(): Promise<void> {
    if (this.outlet) return Promise.resolve();
    this.mounting ??= this.chunks.outlet().then(
      ({ DocumentViewerOutletComponent }) => {
        if (this.outlet || this.destroyed) return;
        const ref = createComponent(DocumentViewerOutletComponent, { environmentInjector: this.env });
        this.appRef.attachView(ref.hostView);
        this.doc.body.appendChild(ref.location.nativeElement as HTMLElement);
        this.outlet = ref;
      },
      (err: unknown) => {
        this.mounting = null;
        throw err;
      },
    );
    return this.mounting;
  }

  /** The outlet chunk did not load (e.g. old hashes after a deploy): end the session and say so. */
  private mountFailed(seq: number, err: unknown): void {
    if (this.destroyed || this.sessionState()?.seq !== seq) return;
    console.error('[sd-viewer] the viewer could not load', err instanceof Error ? err.name : 'error');
    const live = this.callState()?.live() ?? false;
    this.close();
    void this.dialogs
      .confirm({
        tone: 'warning',
        title: "Couldn't open the document",
        message: live ? UPDATE_IN_CALL : CHUNK_RELOAD,
        confirmLabel: live ? 'OK' : 'Reload',
        cancelLabel: 'Close',
      })
      .then(({ confirmed }) => {
        if (confirmed && !live) this.doc.defaultView?.location.reload();
      });
  }

  /** Once, at an idle moment: the outlet and body chunks (about 40 kB), so the first open is instant. */
  private prefetch(): void {
    const view = this.doc.defaultView as (Window & { requestIdleCallback?: (cb: () => void) => number }) | null;
    if (!view) return;
    const run = () => {
      this.chunks.outlet().catch(() => undefined);
      this.chunks.body().catch(() => undefined);
    };
    if (typeof view.requestIdleCallback === 'function') view.requestIdleCallback(run);
    else view.setTimeout(run, PREFETCH_FALLBACK_MS);
  }
}
