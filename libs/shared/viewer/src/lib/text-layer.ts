import { InjectionToken } from '@angular/core';
import type { PdfPageLike, PdfViewportLike } from './pdf-loader';

/**
 * The pdf.js text layer (D12) for every policy except `view_only`: real text
 * over each drawn page, so screen readers, selection and the browser's Find
 * reach it. pdf.js builds the spans with `textContent` (no HTML strings) into
 * the container (`div.sd-text-layer` over the canvas). No annotation layer:
 * links and forms stay inert. `view_only` never calls this.
 */
export interface TextLayerJob {
  /** Settles once the text is laid out (rejects when cancelled or broken). */
  readonly promise: Promise<unknown>;
  cancel(): void;
}

/** Lays out one page's text into `container` for a CSS-scale `viewport`. */
export type TextLayerRenderer = (params: {
  readonly page: PdfPageLike;
  readonly container: HTMLElement;
  readonly viewport: PdfViewportLike;
}) => TextLayerJob;

/** The real renderer: pdf.js `TextLayer` from the same lazy chunk as the loader. */
export const defaultTextLayerRenderer: TextLayerRenderer = ({ page, container, viewport }) => {
  let layer: { render(): Promise<unknown>; cancel(): void } | null = null;
  let cancelled = false;
  const promise = (async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    if (cancelled || typeof page.streamTextContent !== 'function') return;
    const TextLayer = pdfjs.TextLayer as unknown as new (p: {
      textContentSource: unknown;
      container: HTMLElement;
      viewport: PdfViewportLike;
    }) => { render(): Promise<unknown>; cancel(): void };
    layer = new TextLayer({ textContentSource: page.streamTextContent(), container, viewport });
    await layer.render();
  })();
  return {
    promise,
    cancel(): void {
      cancelled = true;
      try {
        layer?.cancel();
      } catch {
        /* already done */
      }
    },
  };
};

/** The text layer renderer (tests provide a fake). */
export const TEXT_LAYER_RENDERER = new InjectionToken<TextLayerRenderer>('TEXT_LAYER_RENDERER', {
  providedIn: 'root',
  factory: () => defaultTextLayerRenderer,
});

/**
 * The pdf.js text layer rules (from pdf_viewer.css 5.7.284), under the
 * viewer's own class (the body's styles are unencapsulated: pdf.js creates the
 * spans, which carry no Angular scoping attribute).
 */
export const TEXT_LAYER_CSS = `
.sd-text-layer{position:absolute;text-align:initial;inset:0;overflow:clip;line-height:1;text-size-adjust:none;transform-origin:0 0;--min-font-size:1;--text-scale-factor:calc(var(--total-scale-factor) * var(--min-font-size));--min-font-size-inv:calc(1 / var(--min-font-size))}
.sd-text-layer :is(span,br){color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0 0}
.sd-text-layer>:not(.markedContent),.sd-text-layer .markedContent span:not(.markedContent){z-index:1;--font-height:0;font-size:calc(var(--text-scale-factor) * var(--font-height));--scale-x:1;--rotate:0deg;transform:rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv))}
.sd-text-layer .markedContent{display:contents}
.sd-text-layer ::selection{background:color-mix(in srgb,var(--sd-viewer-accent) 25%,transparent)}
.sd-text-layer[data-main-rotation="90"]{transform:rotate(90deg) translateY(-100%)}
.sd-text-layer[data-main-rotation="180"]{transform:rotate(180deg) translate(-100%,-100%)}
.sd-text-layer[data-main-rotation="270"]{transform:rotate(270deg) translateX(-100%)}
`;
