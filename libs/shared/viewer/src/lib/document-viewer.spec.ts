import { Component, signal, viewChild } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { DialogService, provideSupadocIcons } from '@supadoc/ui';
import { NEVER, type Observable, of, Subject, throwError } from 'rxjs';
import { DocumentViewerComponent, KEYS_KEY, NAV_DEBOUNCE_MS, PAGES_KEY } from './document-viewer';
import { PDF_LOADER, type PdfLoader } from './pdf-loader';
import { PRINT_FAILED } from './print-pages';
import { TEXT_LAYER_RENDERER, type TextLayerRenderer } from './text-layer';
import * as copy from './viewer-copy';
import { markViewOnly } from './viewer-policy';
import { blobSource, signedLinkSource, viewOnlySource } from './viewer-sources';
import type { ViewerFile, ViewerSource, ViewerState, ViewerWatermark } from './viewer-types';

// ---------------------------------------------------------------- fakes

function fakeContext() {
  return {
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    textAlign: 'start',
    textBaseline: 'alphabetic',
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    fillRect: vi.fn(),
    drawImage: vi.fn(),
    fillText: vi.fn(),
    strokeText: vi.fn(),
    measureText: vi.fn((t: string) => ({ width: t.length * 7 })),
  };
}

interface PdfState {
  pages: number;
  renders: { n: number; scale: number; rotation: number; canvas: HTMLCanvasElement | null }[];
  destroyed: number;
  reject?: unknown;
  /** Page sizes in points by page number (default 600 × 800, portrait). */
  sizes?: Record<number, readonly [number, number]>;
}

function fakeLoader(state: PdfState): PdfLoader {
  return async () => ({
    promise: state.reject
      ? Promise.reject(state.reject)
      : Promise.resolve({
          numPages: state.pages,
          getPage: async (n: number) => ({
            rotate: 0,
            getViewport: ({ scale, rotation = 0 }: { scale: number; rotation?: number }) => {
              const [w, h] = state.sizes?.[n] ?? [600, 800];
              return { width: (rotation % 180 ? h : w) * scale, height: (rotation % 180 ? w : h) * scale, scale, rotation };
            },
            render: ({ canvas, viewport }: { canvas: HTMLCanvasElement | null; viewport: { scale?: number; rotation?: number } }) => {
              state.renders.push({ n, scale: viewport.scale ?? 0, rotation: viewport.rotation ?? 0, canvas });
              return { promise: Promise.resolve(), cancel: () => undefined };
            },
            cleanup: () => undefined,
            streamTextContent: () => ({}),
          }),
        }),
    destroy: () => {
      state.destroyed++;
      return Promise.resolve();
    },
  });
}

const WM: ViewerWatermark = { viewerName: 'Dr Ada Obi', timeZone: 'America/Chicago' };
const REF_TEXT = 'Dr Ada Obi · Wed 4 Nov 2026, 2:05 PM CST · VideoMed · Ref VM-7F3A2C1D';
const pdfBlob = () => new Blob(['%PDF-1.7'], { type: 'application/pdf' });

function viewOnly(over: { key?: string; title?: string; view?: () => Observable<{ blob: Blob; mime: string; viewRef: string | null; viewedAt: string }>; recordPrint?: (ref: string | null) => Observable<unknown>; extension?: string; viewable?: boolean } = {}) {
  return viewOnlySource({
    key: over.key ?? 'doc:1',
    title: over.title ?? 'Lab report',
    typeLabel: 'Laboratory test report',
    extension: over.extension ?? 'pdf',
    viewable: over.viewable,
    view: over.view ?? (() => of({ blob: pdfBlob(), mime: 'application/pdf', viewRef: 'VM-7F3A2C1D', viewedAt: '2026-11-04T20:05:09Z' })),
    recordPrint: over.recordPrint ?? (() => of({ recorded: true })),
    notSharedText: 'This document is no longer shared with you.',
  });
}

function owner(over: Partial<ViewerSource> & { fetch?: () => Observable<Blob> } = {}): ViewerSource {
  const { fetch, ...rest } = over;
  return blobSource({
    key: 'doc:2',
    title: 'My scan',
    typeLabel: 'Report',
    extension: 'pdf',
    policy: 'owner',
    ...(rest as object),
    fetch: fetch ?? (() => of(pdfBlob())),
  } as Parameters<typeof blobSource>[0]);
}

@Component({
  imports: [DocumentViewerComponent],
  template: `
    <div class="sd-viewer-frame">
      <sd-document-viewer
        [source]="source()"
        [mode]="mode()"
        [watermark]="watermark()"
        [liveCall]="liveCall()"
        [inCall]="inCall()"
        [shareGuard]="shareGuard()"
        [recording]="recording()"
        [autoPrint]="autoPrint()"
        [revokedText]="revoked()"
        [navigated]="navigated()"
        [canPrevDoc]="true"
        [canNextDoc]="true"
        (prevDoc)="prevs = prevs + 1"
        (nextDoc)="nexts = nexts + 1"
        (state)="states.push($event)"
        (stopSharing)="stops = stops + 1"
      />
    </div>
  `,
})
class HostComponent {
  readonly source = signal<ViewerSource>(viewOnly());
  readonly mode = signal<'modal' | 'embedded'>('modal');
  readonly watermark = signal<ViewerWatermark | null>(WM);
  readonly liveCall = signal(false);
  readonly inCall = signal(false);
  readonly shareGuard = signal<'none' | 'warn' | 'cover'>('none');
  readonly recording = signal(false);
  readonly autoPrint = signal(false);
  readonly revoked = signal<string | null>(null);
  readonly navigated = signal(false);
  readonly viewer = viewChild.required(DocumentViewerComponent);
  prevs = 0;
  nexts = 0;
  stops = 0;
  states: ViewerState[] = [];
}

// ---------------------------------------------------------------- suite

describe('DocumentViewerComponent (sd-document-viewer)', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;
  let el: HTMLElement;
  let pdf: PdfState;
  let contexts: ReturnType<typeof fakeContext>[];
  let made: string[];
  let revoked: string[];
  let confirmed: boolean;
  let confirm: ReturnType<typeof vi.fn>;
  let textCalls: { container: HTMLElement }[];
  let scannedText: boolean;
  let printSpy: ReturnType<typeof vi.spyOn>;
  let anchors: { href: string; download: string }[];
  const proto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
  const real = { getContext: proto['getContext'], toBlob: proto['toBlob'] };
  const realUrl = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  const realDecode = (HTMLImageElement.prototype as { decode?: unknown }).decode;

  const textLayer: TextLayerRenderer = ({ container }) => {
    textCalls.push({ container });
    if (!scannedText) {
      const span = document.createElement('span');
      span.textContent = 'Haemoglobin 13.5 g/dL';
      container.append(span);
    }
    return { promise: Promise.resolve(), cancel: vi.fn() };
  };

  const settle = async (rounds = 8) => {
    for (let i = 0; i < rounds; i++) {
      fixture.detectChanges();
      await new Promise((r) => setTimeout(r));
    }
    fixture.detectChanges();
  };
  const text = () => (el.textContent ?? '').replace(/\s+/g, ' ');
  const tool = (id: string) => el.querySelector<HTMLButtonElement>(`[data-tool="${id}"]`);
  const frame = () => el.querySelector<HTMLElement>('.sd-viewer-frame') as HTMLElement;
  const key = (k: string, init: KeyboardEventInit = {}, target: Element = el.querySelector('.sdv-stage') ?? frame()) => {
    const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(e);
    return e;
  };
  const allFillText = () => contexts.flatMap((c) => c.fillText.mock.calls.map((call) => call[0] as string));

  async function create(setup?: (h: HostComponent) => void) {
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    setup?.(host);
    el = fixture.nativeElement;
    document.body.appendChild(el);
    await settle();
  }

  beforeEach(async () => {
    pdf = { pages: 2, renders: [], destroyed: 0 };
    contexts = [];
    made = [];
    revoked = [];
    confirmed = true;
    textCalls = [];
    scannedText = false;
    anchors = [];
    try {
      localStorage.clear();
    } catch {
      /* none */
    }
    proto['getContext'] = function () {
      const c = fakeContext();
      contexts.push(c);
      return c;
    };
    proto['toBlob'] = function (cb: BlobCallback) {
      cb(new Blob(['jpeg'], { type: 'image/jpeg' }));
    };
    URL.createObjectURL = () => {
      const u = `blob:http://localhost/${made.length + 1}`;
      made.push(u);
      return u;
    };
    URL.revokeObjectURL = (u: string) => void revoked.push(u);
    (HTMLImageElement.prototype as { decode?: unknown }).decode = vi.fn(() => Promise.resolve());
    printSpy = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      anchors.push({ href: this.href, download: this.download });
    });
    confirm = vi.fn(async () => ({ confirmed }));
    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [
        provideSupadocIcons(),
        { provide: PDF_LOADER, useFactory: () => fakeLoader(pdf) },
        { provide: TEXT_LAYER_RENDERER, useValue: textLayer },
        { provide: DialogService, useValue: { confirm, requests: () => [] } },
      ],
    }).compileComponents();
  });

  afterEach(() => {
    fixture?.destroy();
    el?.remove();
    proto['getContext'] = real.getContext;
    proto['toBlob'] = real.toBlob;
    URL.createObjectURL = realUrl.create;
    URL.revokeObjectURL = realUrl.revoke;
    (HTMLImageElement.prototype as { decode?: unknown }).decode = realDecode;
    document.querySelectorAll('.sd-print-root, style[data-sd-print]').forEach((n) => n.remove());
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // ------------------------------------------------------------ rendering and navigation

  describe('rendering and navigation', () => {
    it('draws each page lazily onto a labelled canvas (view_only: role=img, no text layer)', async () => {
      await create();
      expect([...new Set(pdf.renders.map((r) => r.n))].sort()).toEqual([1, 2]);
      const canvases = Array.from(el.querySelectorAll('.sdv-page canvas'));
      expect(canvases.map((c) => [c.getAttribute('role'), c.getAttribute('aria-label')])).toEqual([
        ['img', 'Page 1 of 2, Lab report'],
        ['img', 'Page 2 of 2, Lab report'],
      ]);
      expect(textCalls).toEqual([]);
      expect(el.querySelector('.sd-text-layer')).toBeNull();
      expect(tool('page')?.textContent).toContain('Page 1 of 2');
      expect(el.querySelector('[role="toolbar"]')?.getAttribute('aria-label')).toBe('Document tools');
      expect(el.querySelector('.sdv-stage')?.getAttribute('aria-label')).toBe('Lab report, document');
    });

    it('PageDown / PageUp / Home / End move between pages and announce them', async () => {
      pdf.pages = 5;
      await create();
      key('PageDown');
      await settle(2);
      expect(tool('page')?.textContent).toContain('Page 2 of 5');
      expect(text()).toContain('Page 2 of 5');
      key('End');
      await settle(2);
      expect(tool('page')?.textContent).toContain('Page 5 of 5');
      key('PageUp');
      await settle(2);
      expect(tool('page')?.textContent).toContain('Page 4 of 5');
      key('Home');
      await settle(2);
      expect(tool('page')?.textContent).toContain('Page 1 of 5');
      expect(tool('prevPage')?.getAttribute('aria-disabled')).toBe('true');
    });

    it('Go to page: an invalid number says the range; a valid one jumps', async () => {
      pdf.pages = 3;
      await create();
      tool('page')?.click();
      await settle(2);
      const field = el.querySelector<HTMLInputElement>('.sdv-panel input') as HTMLInputElement;
      expect(el.querySelector('.sdv-panel')?.getAttribute('role')).toBe('dialog');
      expect(el.querySelector(`label[for="${field.id}"]`)?.textContent).toBe('Page number');
      expect(field.getAttribute('inputmode')).toBe('numeric');
      field.value = '9';
      field.dispatchEvent(new Event('input'));
      field.form?.dispatchEvent(new Event('submit', { cancelable: true }));
      await settle(2);
      expect(el.querySelector('.sdv-panel [role="alert"]')?.textContent).toBe('Enter a page from 1 to 3.');
      field.value = '3';
      field.dispatchEvent(new Event('input'));
      field.form?.dispatchEvent(new Event('submit', { cancelable: true }));
      await settle(2);
      expect(el.querySelector('.sdv-panel')).toBeNull();
      expect(tool('page')?.textContent).toContain('Page 3 of 3');
    });

    it('zoom presets, the zoom menu (menuitemradio) and fit width / fit page', async () => {
      await create();
      // auto: a portrait page fits the 800 px stage (768 / 800 = 96 %).
      expect(tool('zoom')?.textContent).toContain('96%');
      tool('zoomIn')?.click();
      await settle(2);
      expect(tool('zoom')?.textContent).toContain('100%');
      expect(tool('zoom')?.getAttribute('aria-label')).toBe('Zoom level 100%');
      tool('zoom')?.click();
      await settle(2);
      const menu = el.querySelector('.sdv-panel[role="menu"]') as HTMLElement;
      const items = Array.from(menu.querySelectorAll('[role="menuitemradio"]'));
      expect(items.map((i) => i.textContent?.trim())).toEqual(['Fit width', 'Fit page', '50%', '75%', '100%', '125%', '150%', '200%', '300%', '400%']);
      expect(items.find((i) => i.getAttribute('aria-checked') === 'true')?.textContent?.trim()).toBe('100%');
      (items[1] as HTMLElement).click();
      await settle(2);
      expect(el.querySelector('.sdv-panel')).toBeNull();
      expect(text()).toContain('Fit page');
      tool('zoom')?.click();
      await settle(2);
      expect(el.querySelector('[role="menuitemradio"][aria-checked="true"]')?.textContent?.trim()).toBe('Fit page');
      tool('zoomOut')?.click();
      await settle(2);
      expect(Number(tool('zoom')?.textContent?.match(/(\d+)%/)?.[1])).toBeLessThan(100);
    });

    it('rotation passes `rotation` to getViewport and swaps the page holder', async () => {
      await create();
      const holder = () => el.querySelector<HTMLElement>('[data-page="1"]') as HTMLElement;
      const before = [holder().style.width, holder().style.height];
      pdf.renders = [];
      tool('rotate')?.click();
      await settle();
      expect(pdf.renders.some((r) => r.rotation === 90)).toBe(true);
      expect(text()).toContain('Rotated to 90 degrees.');
      const w = parseFloat(holder().style.width);
      const h = parseFloat(holder().style.height);
      expect(w).toBeGreaterThan(h);
      expect(before.map(parseFloat)[0]).toBeLessThan(before.map(parseFloat)[1]);
    });

    it('thumbnails: open by default on desktop, toggle with Pages, mark the current page, remember the choice', async () => {
      await create();
      const rail = () => el.querySelector('sd-viewer-thumbnails.sdv-rail');
      expect(rail()).not.toBeNull();
      expect(rail()?.querySelector('nav')?.getAttribute('aria-label')).toBe('Pages');
      expect(rail()?.querySelector('[aria-current="page"]')?.getAttribute('aria-label')).toBe('Page 1');
      expect(tool('pages')?.getAttribute('aria-pressed')).toBe('true');
      tool('pages')?.click();
      await settle(2);
      expect(rail()).toBeNull();
      expect(localStorage.getItem(PAGES_KEY)).toBe('closed');
      tool('pages')?.click();
      await settle(2);
      (rail()?.querySelector('[data-thumb="2"]') as HTMLElement).click();
      await settle(2);
      expect(rail()?.querySelector('[aria-current="page"]')?.getAttribute('aria-label')).toBe('Page 2');
      expect(tool('page')?.textContent).toContain('Page 2 of 2');
    });

    it('thumbnails start closed while a call is registered (not remembered), and below 1024 px', async () => {
      await create((h) => h.inCall.set(true));
      expect(el.querySelector('sd-viewer-thumbnails')).toBeNull();
      tool('pages')?.click();
      await settle(2);
      expect(el.querySelector('sd-viewer-thumbnails')).not.toBeNull();
      expect(localStorage.getItem(PAGES_KEY)).toBeNull();
      fixture.destroy();

      vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('640px'), media: q, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
      await create();
      expect(el.querySelector('sd-viewer-thumbnails')).toBeNull();
    });

    it('the thumbnail raster is capped at 2× and blocked storage is survived', async () => {
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 3 });
      const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      try {
        await create();
        const thumbs = pdf.renders.filter((r) => r.canvas?.closest('sd-viewer-thumbnails'));
        expect(thumbs.length).toBeGreaterThan(0);
        expect(thumbs.every((r) => r.canvas?.width === 240)).toBe(true);
        expect(getItem).toHaveBeenCalled();
      } finally {
        Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
      }
    });

    it('thumbnails are drawn again after a rotation, never left blank', async () => {
      pdf.pages = 3;
      await create((h) => h.source.set(owner()));
      const thumbs = () => pdf.renders.filter((r) => r.canvas?.closest('sd-viewer-thumbnails'));
      expect(new Set(thumbs().map((r) => r.n))).toEqual(new Set([1, 2, 3]));
      pdf.renders = [];
      tool('rotate')?.click();
      await settle();
      const again = thumbs();
      expect(new Set(again.map((r) => r.n))).toEqual(new Set([1, 2, 3]));
      expect(again.every((r) => r.rotation === 90)).toBe(true);
      const canvases = Array.from(el.querySelectorAll<HTMLCanvasElement>('sd-viewer-thumbnails canvas'));
      expect(canvases.length).toBe(3);
      // Drawn (not zeroed by the reset), and turned: 120 × 90.
      expect(canvases.map((c) => [c.width, c.height])).toEqual([
        [120, 90],
        [120, 90],
        [120, 90],
      ]);
    });

    it('mixed orientations: each page is centred on the stage; a wider landscape page starts at the padding and never pushes the others right', async () => {
      pdf.pages = 3;
      pdf.sizes = { 2: [800, 600] };
      const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
        configurable: true,
        get(this: HTMLElement) {
          return this.classList.contains('sdv-stage') ? 1232 : 0;
        },
      });
      try {
        await create((h) => h.source.set(owner()));
        const holder = (n: number) => el.querySelector<HTMLElement>(`[data-page="${n}"]`) as HTMLElement;
        // auto: portrait pages min(fit width, 125 %) = 125 %, 1000 px wide; the landscape page is 1333 px.
        expect(holder(1).style.width).toBe('1000px');
        expect(holder(2).style.width).toBe('1333px');
        // (1232 − 2 × 16 − 1000) / 2: centred on the stage, not in the 1365 px column.
        expect(holder(1).style.marginLeft).toBe('100px');
        expect(holder(3).style.marginLeft).toBe('100px');
        expect(holder(2).style.marginLeft).toBe('0px');
        expect(el.querySelector('.sdv-col')?.classList.contains('items-center')).toBe(false);
      } finally {
        delete proto['clientWidth'];
      }
    });

    it('a large photo opens fitted below 25 %; zoom out stops there; zoom in goes to 25 % and zoom out back to the fit', async () => {
      vi.stubGlobal('createImageBitmap', async () => ({ width: 8000, height: 6000, close: () => undefined }));
      await create((h) =>
        h.source.set(viewOnly({ extension: 'jpg', view: () => of({ blob: new Blob(['j'], { type: 'image/jpeg' }), mime: 'image/jpeg', viewRef: 'VM-7F3A2C1D', viewedAt: '2026-11-04T20:05:09Z' }) })),
      );
      const canvas = () => el.querySelector('.sdv-image canvas') as HTMLCanvasElement;
      // The tests' 800 × 600 stage: min(768 / 8000, 568 / 6000) ≈ 9 %, where 25 % was 2000 px wide.
      expect(tool('zoom')?.textContent).toContain('9%');
      expect(parseFloat(canvas().style.width)).toBeLessThanOrEqual(768);
      expect(tool('zoomOut')?.getAttribute('aria-disabled')).toBe('true');
      key('-');
      await settle(2);
      expect(tool('zoom')?.textContent).toContain('9%');
      tool('zoomIn')?.click();
      await settle(2);
      expect(tool('zoom')?.textContent).toContain('25%');
      expect(tool('zoomOut')?.getAttribute('aria-disabled')).toBeNull();
      tool('zoomOut')?.click();
      await settle(2);
      expect(tool('zoom')?.textContent).toContain('9%');
      expect(parseFloat(canvas().style.width)).toBeLessThanOrEqual(768);
    });

    it('embedded on a phone: the phone tool set on top (n/N opens the page sheet; the rest under More options), no separators', async () => {
      vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
      await create((h) => {
        h.source.set(owner());
        h.mode.set('embedded');
      });
      const bar = el.querySelector('[role="toolbar"]') as HTMLElement;
      expect(bar.classList.contains('sdv-bar--bottom')).toBe(false);
      expect(bar.classList.contains('border-b')).toBe(true);
      const ids = Array.from(bar.querySelectorAll('[data-tool]')).map((b) => b.getAttribute('data-tool'));
      expect(ids).toEqual(['pages', 'zoomOut', 'zoom', 'zoomIn', 'page', 'more']);
      expect(bar.querySelector('.sdv-sep')).toBeNull();
      expect(tool('page')?.textContent?.trim()).toBe('1/2');
      tool('more')?.click();
      await settle(2);
      const items = Array.from(el.querySelectorAll('.sdv-panel[role="menu"] [role="menuitem"]')).map((i) => i.textContent?.trim());
      expect(items).toEqual(['Fit width', 'Fit page', 'Rotate', 'Print', 'Download My scan', 'Keyboard shortcuts']);
      key('Escape', {}, el.querySelector('[role="menuitem"]') as Element);
      await settle(2);
      tool('page')?.click();
      await settle(2);
      expect(el.querySelector('.sdv-sheet .sdv-thumbs--grid')).not.toBeNull();
    });

    it('an embedded viewer in full screen drops its host frame (border and radius)', async () => {
      await create((h) => h.mode.set('embedded'));
      const css = Array.from(document.querySelectorAll('style'))
        .map((s) => s.textContent ?? '')
        .join('\n');
      expect(css).toContain('sd-document-viewer:fullscreen{border:0;border-radius:0}');
      expect(css).toContain('sd-document-viewer:-webkit-full-screen{border:0;border-radius:0}');
    });

    it('Full screen takes .sd-viewer-frame (modal) or the host (embedded), and is hidden when unsupported', async () => {
      await create();
      expect(tool('fullscreen')).toBeNull();
      fixture.destroy();
      Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true });
      const calls: Element[] = [];
      Element.prototype.requestFullscreen = function (this: Element) {
        calls.push(this);
        return Promise.resolve();
      };
      try {
        await create();
        tool('fullscreen')?.click();
        await settle(2);
        expect(calls).toEqual([frame()]);
        fixture.destroy();
        await create((h) => h.mode.set('embedded'));
        tool('fullscreen')?.click();
        await settle(2);
        expect(calls[1]).toBe(el.querySelector('sd-document-viewer'));
        expect(calls.some((c) => c.tagName === 'DIALOG' || c.classList.contains('sdv-stage'))).toBe(false);
      } finally {
        delete (document as unknown as Record<string, unknown>)['fullscreenEnabled'];
        delete (Element.prototype as unknown as Record<string, unknown>)['requestFullscreen'];
      }
    });

    it('Ctrl+wheel zooms (redrawn after the gesture settles); double-click toggles 200 %', async () => {
      await create();
      const stage = el.querySelector('.sdv-stage') as HTMLElement;
      const wheel = new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true });
      stage.dispatchEvent(wheel);
      expect(wheel.defaultPrevented).toBe(true);
      await new Promise((r) => setTimeout(r, 200));
      await settle(2);
      expect(Number(tool('zoom')?.textContent?.match(/(\d+)%/)?.[1])).toBeGreaterThan(96);
      stage.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 10, clientY: 10 }));
      await settle(2);
      expect(tool('zoom')?.textContent).toContain('200%');
      stage.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 10, clientY: 10 }));
      await settle(2);
      expect(tool('zoom')?.textContent).toContain('96%');
    });

    it('single-key shortcuts: not in the page field or a menu, and none with the switch off (remembered); Ctrl+P and PageDown still work', async () => {
      await create();
      key('+');
      await settle(2);
      expect(tool('zoom')?.textContent).toContain('100%');
      tool('page')?.click();
      await settle(2);
      const field = el.querySelector('.sdv-panel input') as HTMLInputElement;
      key('+', {}, field);
      await settle(2);
      expect(tool('zoom')?.textContent).toContain('100%');
      key('Escape', {}, field);
      await settle(2);
      // The switch, in the Keyboard shortcuts popover.
      tool('keys')?.click();
      await settle(2);
      const sw = el.querySelector<HTMLButtonElement>('[role="switch"]') as HTMLButtonElement;
      expect(sw.getAttribute('aria-label')).toBe('Single-key shortcuts');
      expect(sw.getAttribute('aria-checked')).toBe('true');
      sw.click();
      await settle(2);
      expect(localStorage.getItem(KEYS_KEY)).toBe('off');
      key('Escape', {}, sw);
      await settle(2);
      key('+');
      key('r');
      await settle(2);
      expect(tool('zoom')?.textContent).toContain('100%');
      expect(text()).not.toContain('Rotated');
      key('PageDown');
      await settle(2);
      expect(tool('page')?.textContent).toContain('Page 2 of 2');
      const p = key('p', { ctrlKey: true });
      expect(p.defaultPrevented).toBe(true);
    });

    it('a blocked localStorage write for the switch is survived', async () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('quota');
      });
      await create();
      tool('keys')?.click();
      await settle(2);
      expect(() => el.querySelector<HTMLButtonElement>('[role="switch"]')?.click()).not.toThrow();
    });

    it('document navigation: three moves within 400 ms make one load, for the last; the first open loads at once', async () => {
      const loads: string[] = [];
      const make = (k: string, sink?: Subject<Blob>) =>
        owner({ key: k, title: k, fetch: () => (loads.push(k), sink ? sink.asObservable() : of(pdfBlob())) });
      await create((h) => h.source.set(make('first')));
      expect(loads).toEqual(['first']);
      vi.useFakeTimers();
      const inflight = new Subject<Blob>();
      host.navigated.set(true);
      host.source.set(make('a'));
      fixture.detectChanges();
      host.source.set(make('b'));
      fixture.detectChanges();
      host.source.set(make('c', inflight));
      fixture.detectChanges();
      vi.advanceTimersByTime(NAV_DEBOUNCE_MS - 1);
      expect(loads).toEqual(['first']);
      vi.advanceTimersByTime(1);
      expect(loads).toEqual(['first', 'c']);
      expect(inflight.observed).toBe(true);
      host.source.set(make('d'));
      fixture.detectChanges();
      // Moving on unsubscribes the request in flight.
      expect(inflight.observed).toBe(false);
      vi.advanceTimersByTime(NAV_DEBOUNCE_MS);
      expect(loads).toEqual(['first', 'c', 'd']);
    });

    it('phones: the toolbar at the bottom with a More options menu; the page button opens the page sheet', async () => {
      vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
      await create((h) => h.source.set(owner()));
      const bar = el.querySelector('[role="toolbar"]') as HTMLElement;
      expect(bar.classList.contains('sdv-bar--bottom')).toBe(true);
      const ids = Array.from(bar.querySelectorAll('[data-tool]')).map((b) => b.getAttribute('data-tool'));
      expect(ids).toEqual(['pages', 'zoomOut', 'zoom', 'zoomIn', 'page', 'more']);
      expect(tool('page')?.textContent?.trim()).toBe('1/2');
      expect(tool('page')?.getAttribute('aria-label')).toBe('Page 1 of 2. Go to page');
      tool('more')?.click();
      await settle(2);
      const items = Array.from(el.querySelectorAll('.sdv-panel[role="menu"] [role="menuitem"]')).map((i) => i.textContent?.trim());
      expect(items).toEqual(['Fit width', 'Fit page', 'Rotate', 'Print', 'Download My scan', 'Keyboard shortcuts']);
      key('Escape', {}, el.querySelector('[role="menuitem"]') as Element);
      await settle(2);
      expect(el.querySelector('.sdv-panel')).toBeNull();
      tool('page')?.click();
      await settle(2);
      const sheet = el.querySelector('.sdv-sheet') as HTMLElement;
      expect(sheet.getAttribute('role')).toBe('dialog');
      expect(sheet.querySelector('.sdv-thumbs--grid')).not.toBeNull();
      expect(sheet.querySelector('input[inputmode="numeric"]')).not.toBeNull();
      (sheet.querySelector('[data-thumb="2"]') as HTMLElement).click();
      await settle(2);
      expect(el.querySelector('.sdv-sheet')).toBeNull();
      expect(tool('page')?.textContent?.trim()).toBe('2/2');
    });

    it('the toolbar is one tab stop with roving focus (arrows, Home, End)', async () => {
      await create((h) => h.source.set(owner()));
      const buttons = () => Array.from(el.querySelectorAll<HTMLButtonElement>('[role="toolbar"] > button'));
      expect(buttons().filter((b) => b.getAttribute('tabindex') === '0').length).toBe(1);
      buttons()[0].focus();
      key('ArrowRight', {}, buttons()[0]);
      await settle(2);
      expect(document.activeElement).toBe(buttons()[1]);
      key('End', {}, buttons()[1]);
      await settle(2);
      expect(document.activeElement).toBe(buttons()[buttons().length - 1]);
      key('Home', {}, document.activeElement as Element);
      await settle(2);
      expect(document.activeElement).toBe(buttons()[0]);
      expect(tool('page')?.textContent).toContain('Page 1 of 2');
    });

    it('a shorter tool list (a 2-page PDF, then a photo) keeps exactly one tab stop', async () => {
      vi.stubGlobal('createImageBitmap', async () => ({ width: 400, height: 300, close: () => undefined }));
      const photo = () => owner({ key: 'doc:3', title: 'Photo', extension: 'jpg', fetch: () => of(new Blob(['j'], { type: 'image/jpeg' })) });
      await create((h) => h.source.set(owner()));
      const buttons = () => Array.from(el.querySelectorAll<HTMLButtonElement>('[role="toolbar"] > button'));
      const stops = () => Array.from(el.querySelectorAll<HTMLElement>('[data-tool][tabindex="0"]'));
      const pdfTools = buttons().length;
      expect(pdfTools).toBeGreaterThanOrEqual(11);
      buttons()[0].focus();
      key('End', {}, buttons()[0]);
      await settle(2);
      expect(document.activeElement?.getAttribute('data-tool')).toBe('keys');
      expect(stops().map((b) => b.dataset['tool'])).toEqual(['keys']);
      // Focus leaves the toolbar; the next document has fewer tools: the first one is the stop.
      (el.querySelector('.sdv-stage') as HTMLElement).focus();
      host.source.set(photo());
      await settle();
      expect(buttons().length).toBeLessThan(pdfTools);
      expect(stops()).toEqual([buttons()[0]]);
      // Focus on a late tool while the list shrinks (']' pressed from it): that tool keeps the stop,
      // and the arrows move on from it.
      host.source.set(owner());
      await settle();
      tool('keys')?.focus();
      host.source.set(photo());
      await settle();
      expect(document.activeElement?.getAttribute('data-tool')).toBe('keys');
      expect(stops().map((b) => b.dataset['tool'])).toEqual(['keys']);
      key('ArrowLeft', {}, tool('keys') as HTMLElement);
      await settle(2);
      expect(document.activeElement?.getAttribute('data-tool')).toBe('download');
      expect(stops().map((b) => b.dataset['tool'])).toEqual(['download']);
    });

    it('text layer (owner, authored, authored_print): rendered after the draw, canvas hidden, holder a group; an empty one is a scan', async () => {
      for (const policy of ['owner', 'authored', 'authored_print'] as const) {
        textCalls = [];
        await create((h) => h.source.set(owner({ policy, key: `k-${policy}` })));
        expect(textCalls.length).toBe(2);
        expect(textCalls[0].container.classList.contains('sd-text-layer')).toBe(true);
        expect(el.querySelector('.sd-text-layer')?.textContent).toContain('Haemoglobin');
        const holder = el.querySelector('[data-page="1"]') as HTMLElement;
        expect(holder.getAttribute('role')).toBe('group');
        expect(holder.getAttribute('aria-label')).toBe('Page 1 of 2');
        expect(holder.querySelector('canvas')?.getAttribute('aria-hidden')).toBe('true');
        expect(holder.querySelector('canvas')?.hasAttribute('role')).toBe(false);
        fixture.destroy();
      }
      scannedText = true;
      await create((h) => h.source.set(owner()));
      const canvas = el.querySelector('[data-page="1"] canvas') as HTMLCanvasElement;
      expect(canvas.getAttribute('role')).toBe('img');
      expect(canvas.getAttribute('aria-label')).toBe('Page 1 of 2, My scan, scanned image without text');
    });
  });

  // ------------------------------------------------------------ view_only

  describe('policy view_only', () => {
    it('has no Download, no download link and no on-screen blob image', async () => {
      await create();
      expect(tool('download')).toBeNull();
      expect(el.querySelector('a[download], [href^="blob:"], img[src^="blob:"]')).toBeNull();
      expect(text()).not.toContain('Download');
    });

    it('refuses the context menu, copying, cutting and dragging; Ctrl+S is prevented and saves nothing', async () => {
      await create();
      const root = el.querySelector('.sdv-root') as HTMLElement;
      for (const type of ['contextmenu', 'copy', 'cut', 'dragstart']) {
        const e = new Event(type, { bubbles: true, cancelable: true });
        (root.querySelector('canvas') ?? root).dispatchEvent(e);
        expect(e.defaultPrevented, type).toBe(true);
      }
      expect(root.classList.contains('sdv-deter')).toBe(true);
      const save = key('s', { ctrlKey: true });
      expect(save.defaultPrevented).toBe(true);
      expect(anchors).toEqual([]);
    });

    it('burns the watermark (with the reference) into every page and every thumbnail', async () => {
      await create();
      const pageCanvases = new Set(Array.from(el.querySelectorAll('.sdv-page canvas')));
      const thumbCanvases = new Set(Array.from(el.querySelectorAll('sd-viewer-thumbnails canvas')));
      expect(thumbCanvases.size).toBe(2);
      expect(new Set(allFillText())).toEqual(new Set([REF_TEXT]));
      // Both kinds of canvas were drawn and watermarked.
      expect(pdf.renders.filter((r) => r.canvas && pageCanvases.has(r.canvas)).length).toBeGreaterThan(0);
      expect(pdf.renders.filter((r) => r.canvas && thumbCanvases.has(r.canvas)).length).toBe(2);
    });

    it('video: no native fullscreen in the controls, and native fullscreen is left at once', async () => {
      await create((h) =>
        h.source.set(viewOnly({ extension: 'mp4', view: () => of({ blob: new Blob(['v'], { type: 'video/mp4' }), mime: 'video/mp4', viewRef: null, viewedAt: '2026-11-04T20:05:09Z' }) })),
      );
      const video = el.querySelector('video') as HTMLVideoElement;
      expect(video.getAttribute('controlslist')).toBe('nodownload noremoteplayback noplaybackrate nofullscreen');
      expect(video.hasAttribute('disablepictureinpicture')).toBe(true);
      expect(video.getAttribute('src')).toBe('blob:http://localhost/1');
      expect(tool('print')).toBeNull();
      const exit = vi.fn(async () => undefined);
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => video });
      Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit });
      try {
        document.dispatchEvent(new Event('fullscreenchange'));
        expect(exit).toHaveBeenCalledTimes(1);
      } finally {
        delete (document as unknown as Record<string, unknown>)['fullscreenElement'];
        delete (document as unknown as Record<string, unknown>)['exitFullscreen'];
      }
      fixture.destroy();
      expect(revoked).toContain('blob:http://localhost/1');
    });

    it('runtime guards with ngDevMode false: no watermark → never loaded, "can\'t be shown"; the builders throw', async () => {
      const g = globalThis as { ngDevMode?: unknown };
      const saved = g.ngDevMode;
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const view = vi.fn(() => of({ blob: pdfBlob(), mime: 'application/pdf', viewRef: null, viewedAt: '' }));
      g.ngDevMode = false;
      try {
        await create((h) => {
          h.watermark.set(null);
          h.source.set(viewOnly({ view }));
        });
        expect(view).not.toHaveBeenCalled();
        expect(el.querySelector('[role="alert"]')?.textContent).toBe(copy.REFUSED_TEXT);
        expect(tool('print')).toBeNull();
        expect(text()).not.toContain('Try again');
        expect(error).toHaveBeenCalledWith('[sd-viewer] refused source', 'doc:1', expect.any(String));
        expect(() => blobSource({ key: 'k', title: 't', typeLabel: 't', policy: 'view_only', fetch: () => of(pdfBlob()) })).toThrow();
        expect(() => signedLinkSource({ key: 'k', title: 't', typeLabel: 't', policy: 'view_only', link: () => of({ url: '', filename: '' }), fetch: () => of(pdfBlob()) })).toThrow();
        // A host-made copy of a view_only source is refused (not built by viewOnlySource): it never prints.
        fixture.destroy();
        const copyNoRecord = { ...viewOnly(), recordPrint: undefined } as ViewerSource;
        await create((h) => h.source.set(copyNoRecord));
        expect(el.querySelector('[role="alert"]')?.textContent).toBe(copy.REFUSED_TEXT);
        await host.viewer().print();
        expect(printSpy).not.toHaveBeenCalled();
        // The recordPrint rule on its own: marked as built by viewOnlySource, but no recordPrint.
        fixture.destroy();
        error.mockClear();
        const markedNoRecord = markViewOnly({ ...viewOnly({ view }), recordPrint: undefined }) as ViewerSource;
        await create((h) => h.source.set(markedNoRecord));
        expect(el.querySelector('[role="alert"]')?.textContent).toBe(copy.REFUSED_TEXT);
        expect(error).toHaveBeenCalledWith('[sd-viewer] refused source', 'doc:1', 'an audited print needs recordPrint');
        expect(view).not.toHaveBeenCalled();
        await host.viewer().print();
        expect(printSpy).not.toHaveBeenCalled();
      } finally {
        g.ngDevMode = saved;
      }
    });

    it('the watermark cleared after a view_only load: refused at once, nothing drawn again, nothing printed; given back, it loads again', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const view = vi.fn(() => of({ blob: pdfBlob(), mime: 'application/pdf', viewRef: 'VM-7F3A2C1D', viewedAt: '2026-11-04T20:05:09Z' }));
      const recordPrint = vi.fn(() => of({ recorded: true }));
      await create((h) => h.source.set(viewOnly({ view, recordPrint })));
      expect(el.querySelectorAll('.sdv-page canvas').length).toBe(2);
      const drawn = pdf.renders.length;
      expect(drawn).toBeGreaterThan(0);
      for (const cleared of [null, { viewerName: ' ', timeZone: 'America/Chicago' }]) {
        host.watermark.set(cleared);
        await settle();
        expect(el.querySelector('[role="alert"]')?.textContent).toBe(copy.REFUSED_TEXT);
        expect(el.querySelector('.sdv-page canvas')).toBeNull();
        expect(el.querySelector('sd-viewer-thumbnails')).toBeNull();
        expect(tool('print')).toBeNull();
        key('+');
        await host.viewer().print();
        await settle(2);
        expect(pdf.renders.length).toBe(drawn);
        expect(recordPrint).not.toHaveBeenCalled();
        expect(printSpy).not.toHaveBeenCalled();
      }
      expect(error).toHaveBeenCalledWith('[sd-viewer] refused source', 'doc:1', expect.stringMatching(/watermark/));
      host.watermark.set(WM);
      await settle();
      expect(view).toHaveBeenCalledTimes(2);
      expect(el.querySelectorAll('.sdv-page canvas').length).toBe(2);
      expect(pdf.renders.length).toBeGreaterThan(drawn);
      expect(new Set(allFillText())).toEqual(new Set([REF_TEXT]));
    });

    it('print re-checks the source after a valid load (embedded): a source that now breaks its policy is refused, not printed', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const src = owner({ policy: 'staff_record' });
      await create((h) => {
        h.mode.set('embedded');
        h.source.set(src);
      });
      expect(tool('print')).not.toBeNull();
      (src as { download?: unknown }).download = () => of({ blob: pdfBlob(), filename: 'x.pdf' });
      await host.viewer().print();
      await settle(2);
      expect(printSpy).not.toHaveBeenCalled();
      expect(el.querySelector('[role="alert"]')?.textContent).toBe(copy.REFUSED_TEXT);
      expect(error).toHaveBeenCalledWith('[sd-viewer] refused source', 'doc:2', 'this policy cannot download');
    });

    it('modal hosts fill the outlet (sdv-modal); embedded hosts are sized by their host; the tokens are on the host', async () => {
      await create();
      const body = el.querySelector('sd-document-viewer') as HTMLElement;
      expect(body.classList.contains('sdv-modal')).toBe(true);
      expect(body.style.getPropertyValue('--sd-viewer-chrome')).toBe('#ffffff');
      expect(body.style.getPropertyValue('--sd-viewer-page')).toBe('#ffffff');
      host.mode.set('embedded');
      await settle(2);
      expect(body.classList.contains('sdv-modal')).toBe(false);
      expect(body.style.getPropertyValue('--sd-viewer-chrome')).toBe('#ffffff');
    });

    it('screen sharing (cover): the cover card, pages hidden; Show anyway reveals with the banner; stopping forgets', async () => {
      await create((h) => h.shareGuard.set('cover'));
      expect(text()).toContain('Hidden while you share your screen');
      expect(text()).toContain('Everyone in the call can see your screen.');
      expect(text()).not.toContain('recording captures');
      expect((el.querySelector('.sdv-col') as HTMLElement).style.visibility).toBe('hidden');
      expect(el.querySelector('sd-viewer-thumbnails .sdv-thumb--hidden')).not.toBeNull();
      host.recording.set(true);
      await settle(2);
      expect(text()).toContain('Everyone in the call can see your screen, and the recording captures it.');
      const buttons = Array.from(el.querySelectorAll<HTMLButtonElement>('.sdv-cover button'));
      buttons.find((b) => b.textContent?.includes('Stop sharing'))?.click();
      expect(host.stops).toBe(1);
      buttons.find((b) => b.textContent?.includes('Show anyway'))?.click();
      await settle(2);
      expect(el.querySelector('.sdv-cover')).toBeNull();
      expect((el.querySelector('.sdv-col') as HTMLElement).style.visibility).toBe('');
      expect(el.querySelector('.sdv-banner')?.getAttribute('role')).toBe('status');
      expect(el.querySelector('.sdv-banner')?.textContent).toContain(copy.shareBanner(true));
      expect(text()).toContain('Document shown while you share your screen.');
      host.shareGuard.set('none');
      await settle(2);
      expect(el.querySelector('.sdv-banner')).toBeNull();
      host.shareGuard.set('cover');
      await settle(2);
      expect(el.querySelector('.sdv-cover')).not.toBeNull();
    });

    it('screen sharing (warn, other policies): the banner only, with Stop sharing', async () => {
      await create((h) => {
        h.source.set(owner());
        h.shareGuard.set('warn');
      });
      expect(el.querySelector('.sdv-cover')).toBeNull();
      expect(el.querySelector('.sdv-banner')?.textContent).toContain(copy.shareBanner(false));
      (el.querySelector('.sdv-banner button') as HTMLButtonElement).click();
      expect(host.stops).toBe(1);
    });
  });

  // ------------------------------------------------------------ owner, authored_print, link download

  describe('policy owner / authored_print / link download', () => {
    it('owner: Download saves the viewed bytes (Ctrl+S too); the context menu works; no watermark', async () => {
      await create((h) => h.source.set(owner({ filename: 'scan-2026.pdf' })));
      expect(tool('download')?.getAttribute('aria-label')).toBe('Download My scan');
      tool('download')?.click();
      await settle(2);
      expect(anchors).toEqual([{ href: 'blob:http://localhost/1', download: 'scan-2026.pdf' }]);
      expect(text()).toContain('Download started.');
      key('s', { metaKey: true });
      expect(anchors.length).toBe(2);
      const menu = new Event('contextmenu', { bubbles: true, cancelable: true });
      el.querySelector('.sdv-page canvas')?.dispatchEvent(menu);
      expect(menu.defaultPrevented).toBe(false);
      expect(allFillText().filter((t) => t.includes('VideoMed'))).toEqual([]);
    });

    it('authored_print: Print, no Download; Ctrl+S is prevented', async () => {
      await create((h) => h.source.set(owner({ policy: 'authored_print' })));
      expect(tool('print')).not.toBeNull();
      expect(tool('download')).toBeNull();
      const s = key('s', { ctrlKey: true });
      expect(s.defaultPrevented).toBe(true);
      expect(anchors).toEqual([]);
    });

    it('a signed link: Download calls source.download once and saves its blob; never an API href; a failure says so', async () => {
      const link = vi.fn((dl: boolean) => of({ url: `/api/public/prescriptions/file?token=${dl ? 'd' : 'v'}`, filename: 'GVM-RX-1.pdf' }));
      let fail = false;
      const fetch = vi.fn(() => (fail ? throwError(() => ({ statusCode: 500 })) : of(pdfBlob())));
      await create((h) =>
        h.source.set(signedLinkSource({ key: 'rx:1', title: 'Prescription GVM-RX-1', typeLabel: 'Prescription', extension: 'pdf', policy: 'authored', link, fetch })),
      );
      expect(link.mock.calls).toEqual([[false]]);
      tool('download')?.click();
      await settle(2);
      expect(link.mock.calls).toEqual([[false], [true]]);
      expect(anchors).toEqual([{ href: 'blob:http://localhost/1', download: 'GVM-RX-1.pdf' }]);
      expect(document.querySelector('[href*="/api/"]')).toBeNull();
      fail = true;
      tool('download')?.click();
      await settle(2);
      expect(el.querySelector('.sdv-alert[role="alert"]')?.textContent).toContain(copy.DOWNLOAD_FAILED);
    });
  });

  // ------------------------------------------------------------ print

  describe('print', () => {
    it('audited: records first, then prints; a failed record prints nothing and says so', async () => {
      const log: string[] = [];
      printSpy.mockImplementation(() => void log.push('print'));
      let failRecord = false;
      const record = vi.fn((ref: string | null) => {
        log.push(`record ${ref}`);
        return failRecord ? throwError(() => new Error('nope')) : of({ recorded: true });
      });
      await create((h) => h.source.set(viewOnly({ recordPrint: record })));
      tool('print')?.click();
      await settle();
      expect(log).toEqual(['record VM-7F3A2C1D', 'print']);
      expect(document.querySelector('body > .sd-print-root')).not.toBeNull();
      window.dispatchEvent(new Event('afterprint'));
      failRecord = true;
      log.length = 0;
      tool('print')?.click();
      await settle();
      expect(log).toEqual(['record VM-7F3A2C1D']);
      expect(el.querySelector('.sdv-alert[role="alert"]')?.textContent).toContain(PRINT_FAILED);
      expect(document.querySelector('.sd-print-root')).toBeNull();
    });

    it('open policies print at once, with no record; 200 DPI and no footer (view_only: 150 DPI with the footer)', async () => {
      await create((h) => h.source.set(owner()));
      pdf.renders = [];
      contexts = [];
      tool('print')?.click();
      await settle();
      expect(printSpy).toHaveBeenCalledTimes(1);
      const printScales = pdf.renders.filter((r) => !r.canvas?.isConnected).map((r) => r.scale);
      expect(printScales).toEqual([200 / 72, 200 / 72]);
      expect(allFillText()).toEqual([]);
      fixture.destroy();
      printSpy.mockClear();

      await create();
      pdf.renders = [];
      contexts = [];
      tool('print')?.click();
      await settle();
      expect(printSpy).toHaveBeenCalledTimes(1);
      expect(pdf.renders.filter((r) => !r.canvas?.isConnected).map((r) => r.scale)).toEqual([150 / 72, 150 / 72]);
      expect(allFillText().some((t) => t.startsWith('Printed by Dr Ada Obi'))).toBe(true);
      expect(allFillText()).toContain(REF_TEXT);
    });

    it('in a live call: asks first; Cancel prints nothing', async () => {
      await create((h) => {
        h.source.set(owner());
        h.liveCall.set(true);
      });
      confirmed = false;
      tool('print')?.click();
      await settle();
      expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Print during the call?', confirmLabel: 'Print', cancelLabel: 'Cancel' }));
      expect(printSpy).not.toHaveBeenCalled();
      confirmed = true;
      tool('print')?.click();
      await settle();
      expect(printSpy).toHaveBeenCalledTimes(1);
    });

    it('autoPrint prints once when ready', async () => {
      await create((h) => {
        h.source.set(owner());
        h.autoPrint.set(true);
      });
      await settle();
      expect(printSpy).toHaveBeenCalledTimes(1);
    });

    it('only the active (last mounted) instance answers window Ctrl+P; the two have different ids', async () => {
      await create((h) => h.source.set(owner()));
      const second = TestBed.createComponent(HostComponent);
      second.componentInstance.source.set(owner({ key: 'other' }));
      second.componentInstance.mode.set('embedded');
      document.body.appendChild(second.nativeElement);
      // TestBed removes earlier root elements when it creates a component: put the first back.
      document.body.appendChild(el);
      for (let i = 0; i < 6; i++) {
        second.detectChanges();
        fixture.detectChanges();
        await new Promise((r) => setTimeout(r));
      }
      const ids = Array.from(document.querySelectorAll('input.sdv-field')).map((n) => n.id);
      const one = el.querySelector('sd-document-viewer') as HTMLElement;
      const two = (second.nativeElement as HTMLElement).querySelector('sd-document-viewer') as HTMLElement;
      expect(one).not.toBe(two);
      expect(new Set(ids).size).toBe(ids.length);
      const idOf = (f: ComponentFixture<HostComponent>) => (f.componentInstance.viewer() as unknown as { fieldId: string }).fieldId;
      expect(idOf(fixture)).not.toBe(idOf(second));
      const spyFirst = vi.spyOn(host.viewer(), 'print');
      const spySecond = vi.spyOn(second.componentInstance.viewer(), 'print');
      const outside = document.createElement('button');
      document.body.appendChild(outside);
      const e = new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true, cancelable: true });
      outside.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(true);
      expect(spyFirst).not.toHaveBeenCalled();
      expect(spySecond).toHaveBeenCalledTimes(1);
      outside.remove();
      second.destroy();
      (second.nativeElement as HTMLElement).remove();
      const again = new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true, cancelable: true });
      document.body.dispatchEvent(again);
      expect(spyFirst).toHaveBeenCalledTimes(1);
    });
  });

  // ------------------------------------------------------------ states

  describe('states', () => {
    it('loading shows the skeleton and "Opening document…" with the controls disabled', async () => {
      await create((h) => h.source.set(owner({ fetch: () => NEVER })));
      expect(el.querySelector('.sdv-skel')).not.toBeNull();
      expect(text()).toContain('Opening document…');
      expect(tool('zoomIn')?.getAttribute('aria-disabled')).toBe('true');
    });

    it('not viewable, per policy (nothing fetched for viewable: false)', async () => {
      const fetch = vi.fn(() => of(pdfBlob()));
      const cases: [ViewerSource, string, string | null][] = [
        [viewOnly({ extension: 'docx', viewable: false }), "Preview isn't available for this file type (DOCX). Ask the patient to share it as a PDF or photo.", null],
        [owner({ extension: 'docx', viewable: false, fetch }), "Preview isn't available for this file type (DOCX). Download it to open it on your device.", 'Download DOCX'],
        [owner({ extension: 'docx', viewable: false, policy: 'staff_verification', fetch }), "Preview isn't available for this file type (DOCX). Download it to check it.", 'Download DOCX'],
        [owner({ extension: 'docx', viewable: false, policy: 'staff_record', fetch }), "This file can't be shown.", null],
      ];
      for (const [src, msg, action] of cases) {
        await create((h) => h.source.set(src));
        expect(text()).toContain(msg);
        const btn = el.querySelector<HTMLButtonElement>('.sdv-card button');
        expect(btn?.textContent?.trim() ?? null).toBe(action);
        expect(el.querySelector('[role="toolbar"]')).toBeNull();
        fixture.destroy();
      }
      expect(fetch).not.toHaveBeenCalled();
      // The owner's Download fetches then saves.
      await create((h) => h.source.set(owner({ extension: 'docx', viewable: false, fetch, filename: 'notes.docx' })));
      el.querySelector<HTMLButtonElement>('.sdv-card button')?.click();
      await settle(2);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(anchors[0]?.download).toBe('notes.docx');
    });

    it('a password-protected or broken PDF, per policy', async () => {
      pdf.reject = { name: 'PasswordException' };
      await create();
      expect(text()).toContain(copy.PASSWORD_VIEW_ONLY);
      fixture.destroy();
      await create((h) => h.source.set(owner()));
      expect(text()).toContain(copy.PASSWORD_OTHER);
      expect(el.querySelector('.sdv-card button')?.textContent?.trim()).toBe('Download');
      fixture.destroy();
      pdf.reject = new Error('broken');
      await create((h) => h.source.set(owner({ policy: 'authored_print' })));
      expect(text()).toContain(copy.CANT_SHOW_TEXT);
      expect(el.querySelector('.sdv-card button')).toBeNull();
    });

    it('errors: network with Try again (which loads again), gone calls onGone, not_shared shows its text', async () => {
      let n = 0;
      const view = vi.fn(() => (n++ === 0 ? throwError(() => ({ status: 0 })) : of({ blob: pdfBlob(), mime: 'application/pdf', viewRef: null, viewedAt: '' })));
      await create((h) => h.source.set(viewOnly({ view })));
      expect(el.querySelector('.sdv-card [role="alert"]')?.textContent).toBe(copy.NETWORK_ERROR);
      el.querySelector<HTMLButtonElement>('.sdv-card button')?.click();
      await settle();
      expect(view).toHaveBeenCalledTimes(2);
      expect(el.querySelectorAll('.sdv-page').length).toBe(2);
      fixture.destroy();

      const onGone = vi.fn();
      const gone = viewOnlySource({
        key: 'doc:9',
        title: 'X',
        typeLabel: 'X',
        view: () => throwError(() => ({ statusCode: 404, errors: { code: 'not_shared' } })),
        recordPrint: () => of(null),
        notSharedText: 'This document is no longer shared with you.',
        onGone,
      });
      await create((h) => h.source.set(gone));
      expect(el.querySelector('[role="alert"]')?.textContent).toBe('This document is no longer shared with you.');
      expect(onGone).toHaveBeenCalledTimes(1);
      expect(el.querySelector('.sdv-card button')).toBeNull();
    });

    it('409 update_required: Reload — but in a live call no button and the after-the-call copy', async () => {
      const src = () => owner({ fetch: () => throwError(() => ({ statusCode: 409, errors: { code: 'update_required' } })) });
      await create((h) => h.source.set(src()));
      expect(text()).toContain(copy.UPDATE_RELOAD);
      expect(el.querySelector('.sdv-card button')?.textContent?.trim()).toBe('Reload');
      fixture.destroy();
      await create((h) => {
        h.source.set(src());
        h.liveCall.set(true);
      });
      expect(text()).toContain(copy.UPDATE_IN_CALL);
      expect(el.querySelector('.sdv-card button')).toBeNull();
    });

    it('revoked: the bytes go (canvases zeroed, video URL revoked) and the text shows with role=alert', async () => {
      await create();
      const canvases = Array.from(el.querySelectorAll<HTMLCanvasElement>('.sdv-page canvas'));
      expect(canvases[0].width).toBeGreaterThan(0);
      host.revoked.set('This document is no longer shared with you.');
      await settle(2);
      expect(canvases.every((c) => c.width === 0)).toBe(true);
      expect(pdf.destroyed).toBe(1);
      expect(el.querySelector('[role="alert"]')?.textContent).toBe('This document is no longer shared with you.');
      fixture.destroy();

      await create((h) => h.source.set(owner({ extension: 'webm', fetch: () => of(new Blob(['v'], { type: 'video/webm' })) })));
      expect(el.querySelector('video')?.getAttribute('controlslist')).toBe('nodownload noremoteplayback');
      host.revoked.set('Gone.');
      await settle(2);
      expect(revoked).toContain('blob:http://localhost/1');
      expect(el.querySelector('video')).toBeNull();
    });

    it('emits page, zoom and rotation for resume', async () => {
      await create();
      tool('zoomIn')?.click();
      await settle(2);
      const last = host.states[host.states.length - 1];
      expect(last).toMatchObject({ page: 1, total: 2, zoomMode: 'custom', zoom: 1, rotation: 0 });
    });

    it('[ and ] ask for the previous / next document', async () => {
      await create();
      key('[');
      key(']');
      key(']');
      expect(host.prevs).toBe(1);
      expect(host.nexts).toBe(2);
    });

    it('a photo: one labelled canvas, upright, watermarked for view_only', async () => {
      vi.stubGlobal('createImageBitmap', async () => ({ width: 400, height: 300, close: () => undefined }));
      await create((h) =>
        h.source.set(viewOnly({ extension: 'jpg', view: () => of({ blob: new Blob(['j'], { type: 'image/jpeg' }), mime: 'image/jpeg', viewRef: 'VM-7F3A2C1D', viewedAt: '2026-11-04T20:05:09Z' }) })),
      );
      const canvas = el.querySelector('.sdv-image canvas') as HTMLCanvasElement;
      // A light photo keeps an edge on the light stage, like a page.
      expect(canvas.classList.contains('shadow-card')).toBe(true);
      expect(canvas.getAttribute('role')).toBe('img');
      expect(canvas.getAttribute('aria-label')).toBe('Lab report');
      expect(allFillText()).toContain(REF_TEXT);
      expect(tool('zoom')?.textContent).toContain('100%');
    });
  });
});

/** A ViewerFile type check (keeps the import used). */
export type _File = ViewerFile;
