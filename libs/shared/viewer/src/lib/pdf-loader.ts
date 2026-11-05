import { InjectionToken } from '@angular/core';

/**
 * pdf.js (pdfjs-dist 5.7.284, legacy build, pinned) for the shared viewer —
 * loaded lazily (its own chunk, outside every initial bundle), with its worker
 * served from the app's own origin (`/pdfjs/…`, copied by each app's build).
 * The bytes are handed over in memory: pdf.js makes no request and needs no
 * token. No annotation layer, no forms, no XFA; the text layer (every policy
 * but `view_only`) lives in `text-layer.ts`.
 */

/** Where each app's build puts the worker, CMaps, standard fonts and decoders (apps/{app}/project.json). */
export const PDF_WORKER_SRC = '/pdfjs/pdf.worker.min.mjs';
export const PDF_CMAP_URL = '/pdfjs/cmaps/';
export const PDF_STANDARD_FONTS_URL = '/pdfjs/standard_fonts/';
export const PDF_WASM_URL = '/pdfjs/wasm/';

/** The few pdf.js shapes the viewer uses (kept narrow so tests can fake them). */
export interface PdfViewportLike {
  readonly width: number;
  readonly height: number;
  /** The scale it was made for (CSS px per PDF point × the zoom). */
  readonly scale?: number;
  /** Degrees, 0 / 90 / 180 / 270. */
  readonly rotation?: number;
}
export interface PdfRenderTaskLike {
  readonly promise: Promise<unknown>;
  cancel(): void;
}
export interface PdfPageLike {
  /** The page's own rotation from the file (degrees). */
  readonly rotate?: number;
  /** `rotation` is absolute (the page's own plus the viewer's), as pdf.js takes it. */
  getViewport(options: { scale: number; rotation?: number }): PdfViewportLike;
  render(params: { canvas: HTMLCanvasElement | null; canvasContext?: CanvasRenderingContext2D; viewport: PdfViewportLike }): PdfRenderTaskLike;
  cleanup(): unknown;
  /** The text content stream for the text layer (pdf.js `PDFPageProxy.streamTextContent`). */
  streamTextContent?(): unknown;
}
export interface PdfDocumentLike {
  readonly numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
}
export interface PdfLoadingTaskLike {
  readonly promise: Promise<PdfDocumentLike>;
  destroy(): Promise<unknown> | unknown;
}

/** Opens a PDF from its bytes. */
export type PdfLoader = (data: Uint8Array) => Promise<PdfLoadingTaskLike>;

/** The options pdf.js gets: bytes only, nothing fetched on its own, nothing scripted. */
export function pdfOptions(data: Uint8Array): Record<string, unknown> {
  return {
    data,
    enableXfa: false,
    disableAutoFetch: true,
    disableStream: true,
    cMapUrl: PDF_CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: PDF_STANDARD_FONTS_URL,
    wasmUrl: PDF_WASM_URL,
  };
}

/** The real loader: imports pdf.js on first use and points it at the same-origin worker. */
export const defaultPdfLoader: PdfLoader = async (data) => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  if (pdfjs.GlobalWorkerOptions.workerSrc !== PDF_WORKER_SRC) pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
  return pdfjs.getDocument(pdfOptions(data) as Parameters<typeof pdfjs.getDocument>[0]) as unknown as PdfLoadingTaskLike;
};

/** The viewer's PDF loader (tests provide a fake). */
export const PDF_LOADER = new InjectionToken<PdfLoader>('PDF_LOADER', {
  providedIn: 'root',
  factory: () => defaultPdfLoader,
});

/** A password-protected file (pdf.js rejects with a `PasswordException`). */
export function isPasswordError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: unknown }).name === 'PasswordException';
}
