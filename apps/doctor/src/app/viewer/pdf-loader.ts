import { InjectionToken } from '@angular/core';

/**
 * pdf.js (pdfjs-dist 5.x, legacy build) for the view-only viewer — loaded
 * lazily (its own chunk, outside the initial bundle), with its worker served
 * from the app's own origin (`/pdfjs/…`, copied by the build). The bytes are
 * handed over in memory: pdf.js makes no request and needs no token. Canvas
 * rendering only — no text layer, no annotation layer, no forms, no XFA.
 */

/** Where the build puts the worker, CMaps and standard fonts (apps/doctor/project.json). */
export const PDF_WORKER_SRC = '/pdfjs/pdf.worker.min.mjs';
export const PDF_CMAP_URL = '/pdfjs/cmaps/';
export const PDF_STANDARD_FONTS_URL = '/pdfjs/standard_fonts/';
export const PDF_WASM_URL = '/pdfjs/wasm/';

/** The few pdf.js shapes the viewer uses (kept narrow so tests can fake them). */
export interface PdfViewportLike {
  readonly width: number;
  readonly height: number;
}
export interface PdfRenderTaskLike {
  readonly promise: Promise<unknown>;
  cancel(): void;
}
export interface PdfPageLike {
  getViewport(options: { scale: number }): PdfViewportLike;
  render(params: { canvas: HTMLCanvasElement | null; canvasContext?: CanvasRenderingContext2D; viewport: PdfViewportLike }): PdfRenderTaskLike;
  cleanup(): unknown;
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
