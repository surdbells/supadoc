/**
 * The zoom model (§1.5.1), pure. 100 % is actual size: one PDF point is 96/72
 * CSS px, one image pixel is one CSS px.
 */

export const ZOOM_PRESETS: readonly number[] = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
/** The zoom menu's fixed levels (after "Fit width" and "Fit page"). */
export const MENU_ZOOMS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;
/** CSS px per PDF point. */
export const PDF_TO_CSS = 96 / 72;
/** iOS Safari refuses canvases larger than this many pixels. */
export const MAX_CANVAS_AREA = 16_777_216;

export type ZoomMode = 'auto' | 'width' | 'page' | 'custom';

export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

/** The next preset above (`dir` 1) or below (-1) the current zoom. */
export function nextZoom(current: number, dir: 1 | -1): number {
  const eps = 0.001;
  if (dir > 0) return ZOOM_PRESETS.find((p) => p > current + eps) ?? ZOOM_MAX;
  for (let i = ZOOM_PRESETS.length - 1; i >= 0; i--) if (ZOOM_PRESETS[i] < current - eps) return ZOOM_PRESETS[i];
  return ZOOM_MIN;
}

/** The stage padding around pages: 16 px, or 8 px below 640 px. */
export function stagePadding(viewportWidth: number): number {
  return viewportWidth > 0 && viewportWidth < 640 ? 8 : 16;
}

/** (stage inner width − 2 × padding) / page width at 100 %, clamped to [0.25, 4]. */
export function fitWidthScale(stageWidth: number, pageWidth: number, padding: number): number {
  if (!(pageWidth > 0) || !(stageWidth > 0)) return 1;
  return clampZoom((stageWidth - 2 * padding) / pageWidth);
}

/** min(fit width, (stage inner height − 2 × padding) / page height at 100 %). */
export function fitPageScale(stageWidth: number, stageHeight: number, pageWidth: number, pageHeight: number, padding: number): number {
  const w = fitWidthScale(stageWidth, pageWidth, padding);
  if (!(pageHeight > 0) || !(stageHeight > 0)) return w;
  return clampZoom(Math.min(w, (stageHeight - 2 * padding) / pageHeight));
}

/**
 * The default zoom: PDF portrait pages min(fit width, 1.25), landscape pages
 * fit page (as pdf.js `auto`); images min(fit page, 1), never blown up.
 */
export function autoScale(kind: 'pdf' | 'image', stageWidth: number, stageHeight: number, pageWidth: number, pageHeight: number, padding: number): number {
  if (kind === 'image') return clampZoom(Math.min(1, fitPageScale(stageWidth, stageHeight, pageWidth, pageHeight, padding)));
  const landscape = pageWidth > pageHeight;
  return landscape
    ? fitPageScale(stageWidth, stageHeight, pageWidth, pageHeight, padding)
    : clampZoom(Math.min(1.25, fitWidthScale(stageWidth, pageWidth, padding)));
}

/** The zoom a mode gives (custom keeps `custom`). */
export function zoomFor(
  mode: ZoomMode,
  custom: number,
  kind: 'pdf' | 'image',
  stage: { readonly width: number; readonly height: number },
  page: { readonly width: number; readonly height: number },
  padding: number,
): number {
  switch (mode) {
    case 'width':
      return fitWidthScale(stage.width, page.width, padding);
    case 'page':
      return fitPageScale(stage.width, stage.height, page.width, page.height, padding);
    case 'auto':
      return autoScale(kind, stage.width, stage.height, page.width, page.height, padding);
    default:
      return clampZoom(custom);
  }
}

/**
 * The canvas scale for a page drawn at `cssScale` (CSS px per unit of
 * `width`/`height`): × devicePixelRatio, reduced until the canvas area is
 * within the iOS limit.
 */
export function renderScale(cssScale: number, dpr: number, width: number, height: number, maxArea = MAX_CANVAS_AREA): number {
  let scale = cssScale * Math.max(1, dpr || 1);
  const area = width * scale * height * scale;
  if (area > maxArea && area > 0) scale *= Math.sqrt(maxArea / area);
  return scale;
}

/** "125" for 1.25. */
export function zoomPercent(z: number): number {
  return Math.round(z * 100);
}

/** Width and height swap at 90° / 270°. */
export function rotatedSize(width: number, height: number, rotation: number): { width: number; height: number } {
  return rotation % 180 === 0 ? { width, height } : { width: height, height: width };
}
