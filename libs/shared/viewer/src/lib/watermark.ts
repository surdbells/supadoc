import { formatInZone, timeLabel } from '@supadoc/data-access';

/**
 * The traceable watermark burned into every rendered page or image of a
 * patient document (and every printed page): who viewed it, when on their
 * clock, and the view's reference. Never the patient's name. Pure: drawing
 * goes through a 2D context, so it is tested by spying on `fillText`.
 */

export interface WatermarkInput {
  /** The doctor's profile name as stored ("Dr Ada Obi"). */
  readonly viewerName: string;
  /** When the view was recorded (the API's `X-SD-Viewed-At`). */
  readonly viewedAt: string;
  /** The doctor's profile zone (`DoctorClock.zone()`). */
  readonly timeZone: string;
  /** "VM-7F3A2C1D", or null from an older API (the "Ref" part is left out). */
  readonly viewRef: string | null;
}

/** "Wed 4 Nov 2026, 2:05 PM CST" — the date and the time with the zone's abbreviation. */
function stamp(at: string, tz: string): string {
  return `${formatInZone(at, tz, 'date')}, ${timeLabel(at, tz)}`;
}

/** "Dr Ada Obi · Wed 4 Nov 2026, 2:05 PM CST · VideoMed · Ref VM-7F3A2C1D". */
export function watermarkText(w: WatermarkInput): string {
  const base = `${w.viewerName.trim() || 'Doctor'} · ${stamp(w.viewedAt, w.timeZone)} · VideoMed`;
  return w.viewRef ? `${base} · Ref ${w.viewRef}` : base;
}

/**
 * The printed page's footer: "Printed by Dr Ada Obi · Wed 4 Nov 2026, 2:05 PM
 * CST · VideoMed Ref VM-7F3A2C1D · Confidential patient record. Do not share."
 * (" · VideoMed" without a reference).
 */
export function printFooterText(w: Omit<WatermarkInput, 'viewedAt'> & { readonly printedAt: string }): string {
  const ref = w.viewRef ? ` · VideoMed Ref ${w.viewRef}` : ' · VideoMed';
  return `Printed by ${w.viewerName.trim() || 'Doctor'} · ${stamp(w.printedAt, w.timeZone)}${ref} · Confidential patient record. Do not share.`;
}

/** Screen: 14% slate, rows 4 font-sizes apart. Print: denser and 18%. */
export type WatermarkDensity = 'screen' | 'print';

export interface DrawWatermarkOptions {
  readonly text: string;
  /** The canvas's on-screen (CSS) width; the font scales with it. */
  readonly cssWidth: number;
  /** Device pixels per CSS pixel the canvas was rendered at. */
  readonly dpr: number;
  readonly density?: WatermarkDensity;
}

/** The watermark's font size in canvas pixels: max(12, cssWidth / 45) CSS px × dpr. */
export function watermarkFontPx(cssWidth: number, dpr: number): number {
  return Math.max(12, cssWidth / 45) * Math.max(1, dpr);
}

/**
 * Tile the text diagonally (−30°) across the whole canvas: columns the text's
 * width + 120 CSS px apart, rows 4 (screen) or 3 (print) font sizes apart,
 * every other row offset by half a column. Slate fill with a faint white
 * stroke, so it reads on white and dark pages without hiding the content.
 */
export function drawWatermark(ctx: CanvasRenderingContext2D, canvasWidth: number, canvasHeight: number, o: DrawWatermarkOptions): void {
  const dpr = Math.max(1, o.dpr);
  const font = watermarkFontPx(o.cssWidth, dpr);
  const print = o.density === 'print';
  ctx.save();
  ctx.font = `600 ${Math.round(font)}px Poppins, Arial, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = print ? 'rgba(84, 110, 122, 0.18)' : 'rgba(84, 110, 122, 0.14)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
  ctx.lineWidth = dpr;
  const width = ctx.measureText(o.text).width || o.text.length * font * 0.55;
  const stepX = width + 120 * dpr;
  const stepY = (print ? 3 : 4) * font;
  // Rotate about the centre and cover the rotated bounding box (the diagonal both ways).
  const diag = Math.hypot(canvasWidth, canvasHeight);
  ctx.translate(canvasWidth / 2, canvasHeight / 2);
  ctx.rotate((-30 * Math.PI) / 180);
  let row = 0;
  for (let y = -diag / 2; y <= diag / 2 + stepY; y += stepY, row++) {
    const offset = row % 2 === 1 ? stepX / 2 : 0;
    for (let x = -diag / 2 - stepX + offset; x <= diag / 2 + stepX; x += stepX) {
      ctx.strokeText(o.text, x, y);
      ctx.fillText(o.text, x, y);
    }
  }
  ctx.restore();
}

/** The printed footer band's height in canvas pixels (28 CSS px at print resolution). */
export function footerBandPx(scale: number): number {
  return Math.round(28 * scale);
}

/**
 * The footer band at the bottom of a printed page: white band, slate text
 * at about 9 pt, centred (shrunk to fit a narrow page).
 */
export function drawPrintFooter(ctx: CanvasRenderingContext2D, canvasWidth: number, top: number, band: number, text: string): void {
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, top, canvasWidth, band);
  let size = Math.max(8, Math.round(band * 0.45));
  ctx.font = `500 ${size}px Poppins, Arial, sans-serif`;
  const max = canvasWidth - band;
  while (size > 6 && ctx.measureText(text).width > max) {
    size -= 1;
    ctx.font = `500 ${size}px Poppins, Arial, sans-serif`;
  }
  ctx.fillStyle = '#546e7a';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvasWidth / 2, top + band / 2);
  ctx.restore();
}

/** Lines of the repeated watermark for the video overlay (an aria-hidden CSS layer). */
export function overlayLines(text: string, rows = 12): string[] {
  const line = `${text}     ${text}     ${text}`;
  return Array.from({ length: rows }, () => line);
}
