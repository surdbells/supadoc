import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal, viewChild } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { API_CONFIG, DoctorApi } from '@supadoc/data-access';
import { DialogService, provideSupadocIcons } from '@supadoc/ui';
import { firstValueFrom } from 'rxjs';
import { isViewableDoc } from '../appointment/document-access';
import { PDF_LOADER, pdfOptions, type PdfLoader } from './pdf-loader';
import { PRINT_FAILED } from './print-pages';
import {
  ProtectedDocumentViewer,
  type ProtectedDocumentFile,
  type ProtectedViewerState,
  VIEW_ONLY_NOTICE,
} from './protected-document-viewer';

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

const PDF: ProtectedDocumentFile = {
  blob: new Blob(['%PDF-1.7'], { type: 'application/pdf' }),
  mime: 'application/pdf',
  title: 'Lab report',
  typeLabel: 'Laboratory test report',
  extension: 'pdf',
  viewRef: 'VM-7F3A2C1D',
  viewedAt: '2026-11-04T20:05:09Z',
};

@Component({
  imports: [ProtectedDocumentViewer],
  template: `
    <doc-protected-document-viewer
      [file]="file()"
      [state]="state()"
      [watermark]="{ viewerName: 'Dr Ada Obi', timeZone: 'America/Chicago' }"
      mode="dialog"
      [inCall]="false"
      (closed)="closes = closes + 1"
      (printRequested)="printRequests = printRequests + 1"
    />
  `,
})
class HostComponent {
  readonly file = signal<ProtectedDocumentFile>(PDF);
  readonly state = signal<ProtectedViewerState>('ready');
  readonly viewer = viewChild.required(ProtectedDocumentViewer);
  closes = 0;
  printRequests = 0;
}

describe('ProtectedDocumentViewer', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;
  let el: HTMLElement;
  let renders: number[];
  let destroyed: number;
  let contexts: ReturnType<typeof fakeContext>[];
  let made: string[];
  let revoked: string[];
  let decode: ReturnType<typeof vi.fn>;
  const proto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
  const real = { getContext: proto['getContext'], toBlob: proto['toBlob'] };
  const realUrl = { create: (URL as unknown as Record<string, unknown>)['createObjectURL'], revoke: (URL as unknown as Record<string, unknown>)['revokeObjectURL'] };
  const realDecode = (HTMLImageElement.prototype as { decode?: unknown }).decode;

  const loader: PdfLoader = async () => ({
    promise: Promise.resolve({
      numPages: 2,
      getPage: async (n: number) => ({
        getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
        render: () => {
          renders.push(n);
          return { promise: Promise.resolve(), cancel: () => undefined };
        },
        cleanup: () => undefined,
      }),
    }),
    destroy: () => {
      destroyed++;
      return Promise.resolve();
    },
  });

  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      fixture.detectChanges();
      await new Promise((r) => setTimeout(r));
    }
    fixture.detectChanges();
  };
  const text = () => (el.textContent ?? '').replace(/\s+/g, ' ');
  const viewerRoot = (): HTMLElement => {
    const root = el.querySelector<HTMLElement>('doc-protected-document-viewer > div');
    if (!root) throw new Error('No viewer');
    return root;
  };
  const tool = (label: string) => el.querySelector<HTMLButtonElement>(`[role="toolbar"] button[aria-label="${label}"]`);

  beforeEach(async () => {
    renders = [];
    destroyed = 0;
    contexts = [];
    made = [];
    revoked = [];
    proto['getContext'] = function () {
      const c = fakeContext();
      contexts.push(c);
      return c;
    };
    proto['toBlob'] = function (cb: BlobCallback) {
      cb(new Blob(['jpeg'], { type: 'image/jpeg' }));
    };
    (URL as unknown as Record<string, unknown>)['createObjectURL'] = () => {
      const u = `blob:test-${made.length + 1}`;
      made.push(u);
      return u;
    };
    (URL as unknown as Record<string, unknown>)['revokeObjectURL'] = (u: string) => revoked.push(u);
    decode = vi.fn(() => Promise.resolve());
    (HTMLImageElement.prototype as { decode?: unknown }).decode = decode;

    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [
        provideSupadocIcons(),
        { provide: PDF_LOADER, useValue: loader },
        { provide: DialogService, useValue: { confirm: async () => ({ confirmed: true }), requests: () => [] } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    el = fixture.nativeElement;
    document.body.appendChild(el);
    await settle();
  });

  afterEach(() => {
    fixture.destroy();
    el.remove();
    proto['getContext'] = real.getContext;
    proto['toBlob'] = real.toBlob;
    (URL as unknown as Record<string, unknown>)['createObjectURL'] = realUrl.create;
    (URL as unknown as Record<string, unknown>)['revokeObjectURL'] = realUrl.revoke;
    (HTMLImageElement.prototype as { decode?: unknown }).decode = realDecode;
    document.querySelectorAll('.sd-print-root, style[data-sd-print]').forEach((n) => n.remove());
    vi.restoreAllMocks();
  });

  it('renders each PDF page to a labelled canvas, with the view-only notice', () => {
    expect(renders.sort()).toEqual([1, 2]);
    const canvases = Array.from(el.querySelectorAll('canvas'));
    expect(canvases.map((c) => [c.getAttribute('role'), c.getAttribute('aria-label')])).toEqual([
      ['img', 'Page 1 of 2, Lab report'],
      ['img', 'Page 2 of 2, Lab report'],
    ]);
    expect(text()).toContain(VIEW_ONLY_NOTICE);
    expect(text()).toContain('Page 1 of 2');
  });

  it('burns the watermark into each page (with the view reference)', () => {
    const drawn = contexts.flatMap((c) => c.fillText.mock.calls.map((call) => call[0] as string));
    expect(drawn.length).toBeGreaterThan(0);
    expect(new Set(drawn)).toEqual(new Set(['Dr Ada Obi · Wed 4 Nov 2026, 2:05 PM CST · VideoMed · Ref VM-7F3A2C1D']));
  });

  it('…and without a reference from an older API', async () => {
    contexts = [];
    host.file.set({ ...PDF, blob: new Blob(['%PDF-2'], { type: 'application/pdf' }), viewRef: null });
    await settle();
    const drawn = contexts.flatMap((c) => c.fillText.mock.calls.map((call) => call[0] as string));
    expect(new Set(drawn)).toEqual(new Set(['Dr Ada Obi · Wed 4 Nov 2026, 2:05 PM CST · VideoMed']));
  });

  it('offers no download path: no links, no download attribute, no blob images, no window.open', () => {
    const open = vi.spyOn(window, 'open');
    expect(el.querySelector('a')).toBeNull();
    expect(el.querySelector('[download]')).toBeNull();
    expect(el.querySelector('a[href^="blob:"], img[src^="blob:"]')).toBeNull();
    tool('Zoom in')?.click();
    tool('Fit width')?.click();
    expect(open).not.toHaveBeenCalled();
  });

  it('refuses the context menu, dragging, copying and Ctrl+S; Ctrl+P prints', async () => {
    const root = viewerRoot();
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    (root.querySelector('canvas') ?? root).dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
    const drag = new Event('dragstart', { bubbles: true, cancelable: true });
    root.dispatchEvent(drag);
    expect(drag.defaultPrevented).toBe(true);
    const copy = new Event('copy', { bubbles: true, cancelable: true });
    root.dispatchEvent(copy);
    expect(copy.defaultPrevented).toBe(true);
    const save = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
    root.dispatchEvent(save);
    expect(save.defaultPrevented).toBe(true);
    const print = new KeyboardEvent('keydown', { key: 'p', metaKey: true, bubbles: true, cancelable: true });
    root.dispatchEvent(print);
    expect(print.defaultPrevented).toBe(true);
    await settle();
    expect(host.printRequests).toBe(1);
  });

  it('prepares the print first (decoded IMGs in a print root), and prints only when the host says so', async () => {
    const held: (() => void)[] = [];
    const release = () => held.forEach((r) => r());
    decode.mockImplementation(() => new Promise<void>((r) => held.push(r)));
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    tool('Print')?.click();
    await settle();
    const root = document.querySelector('body > .sd-print-root');
    expect(Array.from(root?.children ?? []).map((c) => c.tagName)).toEqual(['IMG', 'IMG']);
    expect(document.querySelector('style[data-sd-print]')).not.toBeNull();
    // A held decode holds everything: no record, no print.
    expect(host.printRequests).toBe(0);
    expect(printSpy).not.toHaveBeenCalled();
    release();
    await settle();
    expect(host.printRequests).toBe(1);
    expect(printSpy).not.toHaveBeenCalled();
    await host.viewer().print();
    expect(printSpy).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('afterprint'));
    expect(document.querySelector('.sd-print-root')).toBeNull();
    expect(document.querySelector('style[data-sd-print]')).toBeNull();
  });

  it('a page that fails to decode records nothing and says so', async () => {
    decode.mockImplementation(() => Promise.reject(new Error('decode')));
    tool('Print')?.click();
    await settle();
    expect(host.printRequests).toBe(0);
    expect(el.querySelector('[role="alert"]')?.textContent?.trim()).toBe(PRINT_FAILED);
    expect(document.querySelector('.sd-print-root')).toBeNull();
  });

  it('refuses to print when recording failed (cancelPrint cleans up)', async () => {
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    tool('Print')?.click();
    await settle();
    expect(host.printRequests).toBe(1);
    host.viewer().cancelPrint();
    await settle();
    expect(document.querySelector('.sd-print-root')).toBeNull();
    expect(printSpy).not.toHaveBeenCalled();
    expect(el.querySelector('[role="alert"]')?.textContent?.trim()).toBe(PRINT_FAILED);
  });

  it('a video plays from an object URL that is revoked on close', async () => {
    host.file.set({ ...PDF, blob: new Blob(['v'], { type: 'video/mp4' }), mime: 'video/mp4', title: 'Rash video', extension: 'mp4' });
    await settle();
    const video = el.querySelector('video');
    expect(video?.getAttribute('src')).toBe('blob:test-1');
    expect(video?.getAttribute('controlslist')).toBe('nodownload noremoteplayback noplaybackrate nofullscreen');
    expect(video?.hasAttribute('disablepictureinpicture')).toBe(true);
    expect(tool('Print')).toBeNull();
    expect(destroyed).toBe(1); // the PDF's loading task was destroyed when the file changed
    tool('Close')?.click();
    await settle();
    expect(host.closes).toBe(1);
    expect(revoked).toContain('blob:test-1');
  });

  it('closing while the print is being prepared leaves no print root behind and records nothing', async () => {
    const held: (() => void)[] = [];
    decode.mockImplementation(() => new Promise<void>((r) => held.push(r)));
    tool('Print')?.click();
    await settle();
    expect(document.querySelector('body > .sd-print-root')).not.toBeNull();
    tool('Close')?.click();
    await settle();
    held.forEach((r) => r()); // the decode finishes after the close
    await settle();
    expect(document.querySelector('.sd-print-root')).toBeNull();
    expect(document.querySelector('style[data-sd-print]')).toBeNull();
    expect(revoked).toEqual(expect.arrayContaining(made));
    expect(host.printRequests).toBe(0);
  });

  it('Ctrl/Cmd+P with focus outside the viewer goes to the audited Print while it is on screen; the browser print hides it', async () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    try {
      outside.focus();
      // Not on screen (the call's Document tab behind another tab): the browser's own print, which shows none of it.
      const hidden = new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true, cancelable: true });
      outside.dispatchEvent(hidden);
      expect(hidden.defaultPrevented).toBe(false);

      const viewerHost = el.querySelector<HTMLElement>('doc-protected-document-viewer');
      if (!viewerHost) throw new Error('No viewer');
      vi.spyOn(viewerHost, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
      const shown = new KeyboardEvent('keydown', { key: 'P', metaKey: true, shiftKey: true, bubbles: true, cancelable: true });
      outside.dispatchEvent(shown);
      expect(shown.defaultPrevented).toBe(true);
      await settle();
      expect(host.printRequests).toBe(1);
    } finally {
      outside.remove();
    }
    const css = Array.from(document.querySelectorAll('style'))
      .map((s) => s.textContent ?? '')
      .join('\n');
    expect(css).toMatch(/@media print\s*\{\s*\[_nghost-[^\]]+\]\s*\{\s*display:\s*none\s*!important/);
  });

  it('a video never stays in the browser’s fullscreen (its watermark layer isn’t there)', async () => {
    host.file.set({ ...PDF, blob: new Blob(['v'], { type: 'video/mp4' }), mime: 'video/mp4', title: 'Rash video', extension: 'mp4' });
    await settle();
    const video = el.querySelector('video');
    if (!video) throw new Error('No video');
    const doc = document as unknown as Record<string, unknown>;
    const exit = vi.fn(async () => undefined);
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => video });
    Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit });
    try {
      document.dispatchEvent(new Event('fullscreenchange'));
      expect(exit).toHaveBeenCalledTimes(1);
      const dbl = new MouseEvent('dblclick', { bubbles: true, cancelable: true });
      video.dispatchEvent(dbl);
      expect(dbl.defaultPrevented).toBe(true);
      const webkitExit = vi.fn();
      Object.defineProperty(video, 'webkitExitFullscreen', { configurable: true, value: webkitExit });
      video.dispatchEvent(new Event('webkitbeginfullscreen'));
      expect(webkitExit).toHaveBeenCalledTimes(1);
    } finally {
      delete doc['fullscreenElement'];
      delete doc['exitFullscreen'];
    }
  });

  it('a photo prints with its footer band at 28 CSS px of the printed page, whatever its size', async () => {
    vi.stubGlobal('createImageBitmap', async () => ({ width: 3000, height: 2000, close: () => undefined }));
    try {
      host.file.set({ ...PDF, blob: new Blob(['jpg'], { type: 'image/jpeg' }), mime: 'image/jpeg', title: 'Rash photo', extension: 'jpg' });
      await settle();
      contexts = [];
      tool('Print')?.click();
      await settle();
      expect(host.printRequests).toBe(1);
      // The footer band sits under the 3000 × 2000 picture: 28 × 3000 / 718 px tall.
      const band = contexts.flatMap((c) => c.fillRect.mock.calls).find((call) => call[1] === 2000);
      expect(band?.[3]).toBe(Math.round((28 * 3000) / 718));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('shows the not-viewable card for a type the viewer cannot show; `viewable: undefined` counts as viewable', async () => {
    host.file.set({ ...PDF, blob: null, mime: '', extension: 'docx' });
    host.state.set('not_viewable');
    await settle();
    expect(text()).toContain("Preview isn't available for this file type (DOCX). Ask the patient to share it as a PDF or photo.");
    expect(el.querySelector('canvas')).toBeNull();
    expect(tool('Print')?.getAttribute('aria-disabled')).toBe('true');
    expect(isViewableDoc({ viewable: undefined })).toBe(true);
    expect(isViewableDoc({ viewable: false })).toBe(false);
  });

  it('Esc closes', async () => {
    const root = viewerRoot();
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await settle();
    expect(host.closes).toBe(1);
  });
});

describe('pdf.js options and the document request', () => {
  it('pdf.js gets bytes only, with nothing fetched or scripted on its own', () => {
    const data = new Uint8Array([1, 2, 3]);
    expect(pdfOptions(data)).toMatchObject({
      data,
      enableXfa: false,
      disableAutoFetch: true,
      disableStream: true,
      cMapUrl: '/pdfjs/cmaps/',
      standardFontDataUrl: '/pdfjs/standard_fonts/',
    });
  });

  it('patientDocumentView sends X-SD-Viewer: 1; no X-SD-View-Ref gives viewRef null and the print record sends {}', async () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: API_CONFIG, useValue: { baseUrl: 'https://api.test/' } }],
    });
    const api = TestBed.inject(DoctorApi);
    const http = TestBed.inject(HttpTestingController);
    const view = firstValueFrom(api.patientDocumentView('ap-1', 'doc-1'));
    const req = http.expectOne('https://api.test/api/doctor/appointments/ap-1/patient-documents/doc-1/file');
    expect(req.request.headers.get('X-SD-Viewer')).toBe('1');
    req.flush(new Blob(['%PDF'], { type: 'application/pdf' }), { headers: { 'Content-Type': 'application/pdf' } });
    const got = await view;
    expect(got.viewRef).toBeNull();
    expect(got.mime).toBe('application/pdf');

    api.patientDocumentPrinted('ap-1', 'doc-1', got.viewRef).subscribe();
    const printed = http.expectOne('https://api.test/api/doctor/appointments/ap-1/patient-documents/doc-1/printed');
    expect(printed.request.method).toBe('POST');
    expect(printed.request.body).toEqual({});
    printed.flush({ status: 'success', message: 'Recorded', data: { recorded: true } });
    http.verify();
  });
});
