import { ApplicationRef, Component, DestroyRef, inject, signal, TemplateRef, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { GuardsCheckEnd, NavigationStart, Router } from '@angular/router';
import { DialogService, provideSupadocIcons } from '@supadoc/ui';
import { of, Subject } from 'rxjs';
import { DocumentViewerService, VIEWER_CHUNKS, type ViewerChunks } from './document-viewer.service';
import { PDF_LOADER, type PdfLoader } from './pdf-loader';
import { TEXT_LAYER_RENDERER } from './text-layer';
import { provideViewerDefaults } from './viewer-defaults';
import { blobSource, viewOnlySource } from './viewer-sources';
import type { ViewerCallContext, ViewerSource } from './viewer-types';

const noop = (): void => undefined;

const log: string[] = [];

@Component({ selector: 'sd-fake-tile', template: `<div role="img" aria-label="Ada Obi, live video"></div>` })
class FakeTileComponent {
  constructor() {
    inject(DestroyRef).onDestroy(() => log.push('tile stopped'));
  }
}

@Component({
  imports: [FakeTileComponent],
  template: `
    <ng-template #bar><button type="button" class="band-back">Back to call</button></ng-template>
    <ng-template #peer><sd-fake-tile /></ng-template>
  `,
})
class CallHostComponent {
  readonly bar = viewChild.required('bar', { read: TemplateRef });
  readonly peer = viewChild.required('peer', { read: TemplateRef });
}

const loader: PdfLoader = async () => ({
  promise: Promise.resolve({
    numPages: 1,
    getPage: async () => ({
      getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale, scale }),
      render: () => ({ promise: Promise.resolve(), cancel: () => undefined }),
      cleanup: () => undefined,
    }),
  }),
  destroy: () => Promise.resolve(),
});

function owner(key: string, title = key): ViewerSource {
  return blobSource({ key, title, typeLabel: 'Report', extension: 'pdf', policy: 'owner', fetch: () => of(new Blob(['%PDF'], { type: 'application/pdf' })) });
}

describe('DocumentViewerService', () => {
  let chunks: { outlet: ReturnType<typeof vi.fn>; body: ReturnType<typeof vi.fn> };
  let idle: (() => void)[];
  let routerEvents: Subject<unknown>;
  let router: { events: Subject<unknown>; url: string };
  const realIdle = (window as { requestIdleCallback?: unknown }).requestIdleCallback;
  const proto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
  const realGetContext = proto['getContext'];

  const svc = () => TestBed.inject(DocumentViewerService);
  const appRef = () => TestBed.inject(ApplicationRef);
  const render = async (rounds = 6) => {
    for (let i = 0; i < rounds; i++) {
      appRef().tick();
      await new Promise((r) => setTimeout(r));
    }
    appRef().tick();
  };
  const outlets = () => document.querySelectorAll('sd-document-viewer-outlet');
  /** The outlet chunk is a real dynamic import (transformed on first use): wait for it. */
  const mounted = () =>
    vi.waitFor(
      () => {
        appRef().tick();
        if (!outlets().length) throw new Error('outlet not mounted yet');
      },
      { timeout: 5000, interval: 10 },
    );

  function callContext(over: Partial<ViewerCallContext> = {}): ViewerCallContext & { host: CallHostComponent } {
    const f = TestBed.createComponent(CallHostComponent);
    f.detectChanges();
    const host = f.componentInstance;
    return {
      host,
      bar: host.bar(),
      peer: host.peer(),
      peerName: signal('Ada Obi'),
      tone: signal<'dark' | 'light'>('dark'),
      live: signal(true),
      sharingScreen: signal(false),
      recording: signal(false),
      stopSharing: vi.fn(),
      willOpen: vi.fn(() => log.push('willOpen')),
      didClose: vi.fn(() => log.push('didClose')),
      ...over,
    };
  }

  beforeAll(() => {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
  });
  afterAll(() => {
    delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal;
    delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close;
  });

  beforeEach(() => {
    log.length = 0;
    idle = [];
    (window as { requestIdleCallback?: unknown }).requestIdleCallback = (cb: () => void) => {
      idle.push(cb);
      return idle.length;
    };
    proto['getContext'] = () => ({ save: noop, restore: noop, translate: noop, rotate: noop, fillText: noop, strokeText: noop, drawImage: noop, fillRect: noop, measureText: () => ({ width: 10 }) });
    const real: ViewerChunks = { outlet: () => import('./document-viewer-outlet'), body: () => import('./document-viewer') };
    chunks = { outlet: vi.fn(() => real.outlet()), body: vi.fn(() => real.body()) };
    routerEvents = new Subject<unknown>();
    router = { events: routerEvents, url: '/appointments/1' };
    TestBed.configureTestingModule({
      providers: [
        provideSupadocIcons(),
        { provide: VIEWER_CHUNKS, useValue: chunks },
        { provide: PDF_LOADER, useValue: loader },
        { provide: TEXT_LAYER_RENDERER, useValue: () => ({ promise: Promise.resolve(), cancel: () => undefined }) },
        { provide: DialogService, useValue: { confirm: vi.fn(async () => ({ confirmed: false })), requests: () => [] } },
        { provide: Router, useValue: router },
      ],
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    outlets().forEach((o) => o.remove());
    (window as { requestIdleCallback?: unknown }).requestIdleCallback = realIdle;
    proto['getContext'] = realGetContext;
    vi.restoreAllMocks();
  });

  it('mounts the outlet lazily on the first open, once', async () => {
    const s = svc();
    expect(outlets().length).toBe(0);
    expect(chunks.outlet).not.toHaveBeenCalled();
    s.open(owner('a'));
    await mounted();
    await render();
    expect(chunks.outlet).toHaveBeenCalledTimes(1);
    expect(outlets().length).toBe(1);
    expect(document.querySelector('dialog.sd-dialog--viewer')).not.toBeNull();
    s.close();
    s.open(owner('b'));
    await render();
    expect(chunks.outlet).toHaveBeenCalledTimes(1);
    expect(outlets().length).toBe(1);
  });

  it('prefetches the outlet and body chunks once, at an idle moment', () => {
    svc();
    expect(chunks.outlet).not.toHaveBeenCalled();
    expect(idle.length).toBe(1);
    idle[0]();
    expect(chunks.outlet).toHaveBeenCalledTimes(1);
    expect(chunks.body).toHaveBeenCalledTimes(1);
    TestBed.inject(DocumentViewerService);
    expect(idle.length).toBe(1);
  });

  it('opens one source or a list at an index; a second open replaces the session and keeps the first opener', async () => {
    const s = svc();
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const first = s.open(owner('a'));
    expect(s.isOpen()).toBe(true);
    expect(s.session()?.sources.map((x) => x.key)).toEqual(['a']);
    const second = s.open([owner('x'), owner('y'), owner('z')], { index: 2 });
    let firstClosed = false;
    void first.closed.then(() => (firstClosed = true));
    await render();
    expect(firstClosed).toBe(true);
    expect(s.session()?.sources.map((x) => x.key)).toEqual(['x', 'y', 'z']);
    expect(s.index()).toBe(2);
    expect(s.isShowing('z')).toBe(true);
    expect(s.isShowing('x')).toBe(false);
    first.close();
    expect(s.isOpen()).toBe(true);
    second.close();
    expect(s.isOpen()).toBe(false);
    await render();
    await new Promise((r) => setTimeout(r));
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('focus goes to fallbackFocus when the opener is gone', async () => {
    const s = svc();
    const opener = document.createElement('button');
    const heading = document.createElement('h2');
    heading.tabIndex = -1;
    document.body.append(opener, heading);
    opener.focus();
    s.open(owner('a'), { fallbackFocus: () => heading });
    await mounted();
    await render();
    opener.remove();
    s.close();
    await render();
    await new Promise((r) => setTimeout(r));
    expect(document.activeElement).toBe(heading);
    heading.remove();
  });

  it('an opener still in the page but hidden (no box) counts as gone: focus goes to fallbackFocus; a shown one still gets it back', async () => {
    const box = [{ x: 0, y: 0, width: 10, height: 10 }] as unknown as DOMRectList;
    const none = [] as unknown as DOMRectList;
    // A DOM with layout: <html> has a box.
    vi.spyOn(document.documentElement, 'getClientRects').mockReturnValue(box);
    const s = svc();
    const opener = document.createElement('button');
    const heading = document.createElement('h2');
    heading.tabIndex = -1;
    document.body.append(opener, heading);
    const openerRects = vi.spyOn(opener, 'getClientRects').mockReturnValue(box);

    // Hidden while the viewer was open (e.g. its panel collapsed): the fallback, even though
    // sd-dialog put focus "on" it (a DOM without layout lets it; a browser would leave it on <body>).
    opener.focus();
    s.open(owner('a'), { fallbackFocus: () => heading });
    await mounted();
    await render();
    openerRects.mockReturnValue(none);
    s.close();
    await render();
    await new Promise((r) => setTimeout(r));
    expect(opener.isConnected).toBe(true);
    expect(document.activeElement).toBe(heading);

    // Shown: back to the opener, as before.
    openerRects.mockReturnValue(box);
    opener.focus();
    s.open(owner('b'), { fallbackFocus: () => heading });
    await render();
    s.close();
    await render();
    await new Promise((r) => setTimeout(r));
    expect(document.activeElement).toBe(opener);
    opener.remove();
    heading.remove();
  });

  it('closes on GuardsCheckEnd with shouldActivate and a path change — not on a query-only change, a cancelled guard or NavigationStart', () => {
    const s = svc();
    s.open(owner('a'));
    routerEvents.next(new NavigationStart(1, '/elsewhere'));
    expect(s.isOpen()).toBe(true);
    routerEvents.next(new GuardsCheckEnd(1, '/appointments/1?tab=docs', '/appointments/1?tab=docs', null as never, true));
    expect(s.isOpen()).toBe(true);
    routerEvents.next(new GuardsCheckEnd(1, '/elsewhere', '/elsewhere', null as never, false));
    expect(s.isOpen()).toBe(true);
    routerEvents.next(new GuardsCheckEnd(1, '/elsewhere', '/elsewhere#x', null as never, true));
    expect(s.isOpen()).toBe(false);
  });

  it('the tone defaults to auto (it follows html[data-theme]); provideViewerDefaults overrides it; an open can name one', () => {
    const s = svc();
    s.open(owner('a'));
    expect(s.session()?.options.tone).toBe('auto');
    s.open(owner('a'), { tone: 'light' });
    expect(s.session()?.options.tone).toBe('light');
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideViewerDefaults({ tone: 'light' }),
        { provide: VIEWER_CHUNKS, useValue: chunks },
        { provide: DialogService, useValue: { confirm: vi.fn(async () => ({ confirmed: false })), requests: () => [] } },
        { provide: Router, useValue: router },
      ],
    });
    const other = TestBed.inject(DocumentViewerService);
    other.open(owner('b'));
    expect(other.session()?.options.tone).toBe('light');
  });

  it('revoke affects only the matching key', () => {
    const s = svc();
    s.open([owner('a'), owner('b')]);
    s.revoke('b', 'No longer shared.');
    s.revoke('zzz', 'nope');
    expect([...s.revoked().entries()]).toEqual([['b', 'No longer shared.']]);
  });

  it('remembers page, zoom and rotation per key for the SPA session', () => {
    const s = svc();
    expect(s.resumeFor('a')).toBeNull();
    s.saveResume('a', { page: 3, zoomMode: 'custom', zoom: 1.5, rotation: 90 });
    expect(s.resumeFor('a')).toEqual({ page: 3, zoomMode: 'custom', zoom: 1.5, rotation: 90 });
  });

  it('a refused source still opens (with its error state); the refusal is logged before willOpen runs, once', async () => {
    const s = svc();
    const error = vi.spyOn(console, 'error').mockImplementation(() => log.push('refused'));
    const ctx = callContext();
    s.registerCall(ctx);
    const noWatermark = viewOnlySource({
      key: 'doc:1',
      title: 'Lab report',
      typeLabel: 'Lab',
      view: () => of({ blob: new Blob(), mime: 'application/pdf', viewRef: null, viewedAt: '' }),
      recordPrint: () => of(null),
      notSharedText: 'x',
    });
    s.open(noWatermark);
    expect(s.isOpen()).toBe(true);
    expect(s.session()?.refused[0]).toMatch(/watermark/);
    await mounted();
    await render();
    s.open(owner('b'));
    await render();
    expect(error).toHaveBeenCalled();
    expect(log.filter((l) => l === 'willOpen')).toHaveLength(1);
    expect(log.indexOf('refused')).toBeLessThan(log.indexOf('willOpen'));
    expect(ctx.willOpen).toHaveBeenCalledTimes(1);
  });

  for (const reduced of [false, true]) {
    it(`hands the peer back after the tile has stopped${reduced ? ' (reduced motion)' : ''}: willOpen once, close clears at once, didClose after the render`, async () => {
      const mm = window.matchMedia;
      window.matchMedia = ((q: string) => ({ matches: reduced && q.includes('reduce'), media: q, addEventListener: noop, removeEventListener: noop })) as unknown as typeof window.matchMedia;
      try {
        const s = svc();
        const ctx = callContext();
        s.registerCall(ctx);
        s.open(owner('a'));
        await mounted();
        await render();
        expect(log).toEqual(['willOpen']);
        expect(document.querySelector('sd-fake-tile')).not.toBeNull();
        s.close();
        expect(s.session()).toBeNull();
        expect(ctx.didClose).not.toHaveBeenCalled();
        await render(2);
        expect(log).toEqual(['willOpen', 'tile stopped', 'didClose']);
      } finally {
        window.matchMedia = mm;
      }
    });
  }

  it('unregistering cancels a pending didClose; a context no longer registered is skipped; unregistering while open closes without didClose', async () => {
    const s = svc();
    const ctx = callContext();
    const unregister = s.registerCall(ctx);
    s.open(owner('a'));
    await mounted();
    await render();
    s.close();
    unregister();
    await render();
    expect(ctx.didClose).not.toHaveBeenCalled();

    const other = callContext();
    s.registerCall(other);
    s.open(owner('b'));
    await render();
    const third = callContext();
    s.registerCall(third);
    s.close();
    await render();
    expect(other.didClose).not.toHaveBeenCalled();

    const fourth = callContext();
    const off = s.registerCall(fourth);
    s.open(owner('c'));
    await render();
    expect(fourth.willOpen).toHaveBeenCalledTimes(1);
    off();
    expect(s.isOpen()).toBe(false);
    await render();
    expect(fourth.didClose).not.toHaveBeenCalled();
  });

  it('closed then opened again before the hand-back: the peer stays with the viewer, and the next close hands it back once, after the tile stopped', async () => {
    const s = svc();
    const ctx = callContext();
    s.registerCall(ctx);
    s.open(owner('a'));
    await mounted();
    await render();
    s.close();
    s.open(owner('b'));
    await render();
    expect(ctx.willOpen).toHaveBeenCalledTimes(1);
    expect(ctx.didClose).not.toHaveBeenCalled();
    expect(document.querySelector('sd-fake-tile')).not.toBeNull();
    s.close();
    await render(2);
    expect(ctx.didClose).toHaveBeenCalledTimes(1);
    expect(log).toEqual(['willOpen', 'tile stopped', 'didClose']);
    // And a later open hands it over again.
    s.open(owner('c'));
    await render();
    expect(ctx.willOpen).toHaveBeenCalledTimes(2);
  });

  it('two opens before the outlet chunk has loaded: the session on screen once it mounts gets the peer (willOpen once)', async () => {
    const s = svc();
    const ctx = callContext();
    s.registerCall(ctx);
    s.open(owner('a'));
    s.open(owner('b'));
    expect(ctx.willOpen).not.toHaveBeenCalled();
    await mounted();
    await render();
    expect(s.session()?.sources[0]?.key).toBe('b');
    expect(ctx.willOpen).toHaveBeenCalledTimes(1);
    expect(document.querySelector('sd-fake-tile')).not.toBeNull();
    s.close();
    await render(2);
    expect(ctx.didClose).toHaveBeenCalledTimes(1);
  });

  it('closed before the outlet chunk has loaded: nobody is handed over', async () => {
    const s = svc();
    const ctx = callContext();
    s.registerCall(ctx);
    s.open(owner('a'));
    s.close();
    await mounted();
    await render();
    expect(ctx.willOpen).not.toHaveBeenCalled();
    expect(ctx.didClose).not.toHaveBeenCalled();
  });
});
