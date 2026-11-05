import { drawPrintFooter, drawWatermark, footerBandPx } from './watermark';

/**
 * Printing a document: each page becomes a raster (JPEG; watermarked with a
 * footer band for view_only, plain for every other policy) shown only in a hidden "print root" in this same document — never
 * the original bytes, never an iframe (WebKit on iOS has been reported to
 * print the top document instead of an iframe; not verified). Built with
 * createElement / textContent / attribute setters only (no innerHTML).
 *
 * Sequence: the viewer renders the pages, `buildPrintRoot` waits for every
 * image to decode (a failure records nothing), the viewer records the print
 * (view_only: `source.recordPrint`, and prints only on success), then
 * `print()` opens the dialog; the root and its object URLs go on
 * `afterprint`, after 60 s at the latest, or when the viewer closes.
 */

/** Longer files aren't printed here. */
export const MAX_PRINT_PAGES = 100;
/** view_only PDF pages print at 150 DPI (watermarked, with the footer band). */
export const PRINT_DPI = 150;
/** Every other policy prints at 200 DPI, with no watermark or footer. */
export const PRINT_DPI_OPEN = 200;
/** Images print at their natural size, capped on the long side. */
export const PRINT_IMAGE_MAX_PX = 3000;
/**
 * The printed page's width in CSS px: A4's 210 mm less the 10 mm margins
 * (190 mm) at 96 CSS px per inch. Each page image prints `width: 100%`.
 */
export const PRINT_PAGE_CSS_PX = 718;
/** The print root is removed this long after printing even without `afterprint`. */
export const PRINT_CLEANUP_MS = 60_000;

export const PRINT_FAILED = "Couldn't prepare the print. Try again.";
export const PRINT_TOO_LONG = 'This file is too long to print here (over 100 pages).';

/** Thrown for a file over {@link MAX_PRINT_PAGES} pages. */
export class PrintTooLongError extends Error {
  constructor() {
    super(PRINT_TOO_LONG);
    this.name = 'PrintTooLongError';
  }
}

/** The print root's stylesheet: on paper only the pages show, one per sheet. */
export const PRINT_CSS = `.sd-print-root { display: none; }
@media print {
  body > :not(.sd-print-root) { display: none !important; }
  .sd-print-root { display: block !important; }
  @page { margin: 10mm; }
  .sd-print-root img { display: block; width: 100%; break-after: page; }
}`;

/** A canvas as a JPEG (quality 0.85). */
export function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob'))), 'image/jpeg', 0.85);
    } catch (err) {
      reject(err);
    }
  });
}

/** How one printed page is composed (from the policy: dpi / footer, §1.8.1). */
export interface ComposeOptions {
  /** Canvas pixels per printed CSS pixel (the footer band and watermark scale with it). */
  readonly dpr: number;
  /** The watermark text (view_only), else null: nothing burned in. */
  readonly watermark: string | null;
  /** The footer band text (view_only), else null: no band. */
  readonly footer: string | null;
}

/**
 * One printed page as a JPEG: the picture on white, the watermark (when given)
 * and the footer band under it (when given). The scratch canvas is released.
 */
export async function composePrintPage(source: CanvasImageSource, w: number, h: number, o: ComposeOptions): Promise<Blob> {
  const band = o.footer ? footerBandPx(o.dpr) : 0;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h + band;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, w, h);
  if (o.watermark) drawWatermark(ctx, w, h, { text: o.watermark, cssWidth: w / o.dpr, dpr: o.dpr, density: 'print' });
  if (o.footer) drawPrintFooter(ctx, w, h, band, o.footer);
  try {
    return await canvasToJpeg(canvas);
  } finally {
    canvas.width = canvas.height = 0;
  }
}

/** Prepared pages waiting to be printed (after the print was recorded, for view_only). */
export interface PreparedPrint {
  readonly root: HTMLElement;
  readonly style: HTMLStyleElement;
  /** Opens the browser's print dialog; cleans up after it (or after 60 s). */
  print(): void;
  /** Removes the root and the style, and revokes the URLs (safe to call twice). */
  cleanup(): void;
}

interface PrintEnv {
  readonly doc?: Document;
  readonly win?: Window;
  readonly createUrl?: (blob: Blob) => string;
  readonly revokeUrl?: (url: string) => void;
}

/**
 * Build the hidden print root (one `<img alt="">` per page) and wait until
 * every image has decoded, so no page prints blank. Rejects (after cleaning
 * up) when any image fails to decode.
 */
export async function buildPrintRoot(pages: readonly Blob[], env: PrintEnv = {}): Promise<PreparedPrint> {
  const doc = env.doc ?? document;
  const win = env.win ?? window;
  const createUrl = env.createUrl ?? ((b: Blob) => URL.createObjectURL(b));
  const revokeUrl = env.revokeUrl ?? ((u: string) => URL.revokeObjectURL(u));

  const style = doc.createElement('style');
  style.setAttribute('data-sd-print', '');
  style.textContent = PRINT_CSS;
  const root = doc.createElement('div');
  root.className = 'sd-print-root';
  root.setAttribute('aria-hidden', 'true');
  const urls: string[] = [];
  const imgs: HTMLImageElement[] = [];
  for (const page of pages) {
    const url = createUrl(page);
    urls.push(url);
    const img = doc.createElement('img');
    img.alt = '';
    img.src = url;
    imgs.push(img);
    root.append(img);
  }
  doc.head.append(style);
  doc.body.append(root);

  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAfterPrint = () => cleanup();
  function cleanup(): void {
    if (done) return;
    done = true;
    clearTimeout(timer);
    win.removeEventListener('afterprint', onAfterPrint);
    root.remove();
    style.remove();
    for (const u of urls) revokeUrl(u);
    urls.length = 0;
  }

  try {
    await Promise.all(imgs.map((i) => (typeof i.decode === 'function' ? i.decode() : Promise.resolve())));
  } catch (err) {
    cleanup();
    throw err;
  }
  if (done) throw new Error('cancelled');

  return {
    root,
    style,
    print(): void {
      if (done) return;
      win.addEventListener('afterprint', onAfterPrint);
      timer = setTimeout(cleanup, PRINT_CLEANUP_MS);
      win.print();
    },
    cleanup,
  };
}
