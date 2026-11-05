import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  input,
  NgZone,
  output,
  untracked,
  ViewEncapsulation,
} from '@angular/core';
import type { PdfDocumentLike, PdfPageLike, PdfRenderTaskLike } from './pdf-loader';
import { drawWatermark } from './watermark';

/** Thumbnails are 120 CSS px wide. */
export const THUMB_CSS_WIDTH = 120;
/** Their raster is capped at 2× whatever the devicePixelRatio (240 device px). */
export const THUMB_MAX_DPR = 2;
const CONCURRENT = 2;
const RELEASE_BEYOND = 40;

const CSS = `
.sdv-thumbs{list-style:none;margin:0;padding:12px;display:flex;flex-direction:column;align-items:center;gap:12px}
.sdv-thumbs--grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));align-items:start}
.sdv-thumb{display:flex;flex-direction:column;align-items:center;gap:6px;width:100%;padding:4px;border-radius:10px;color:var(--sd-viewer-muted)}
.sdv-thumb:hover{background:var(--sd-viewer-hover)}
.sdv-thumb:focus-visible{outline:2px solid var(--sd-viewer-ring);outline-offset:2px}
.sdv-thumb-page{display:block;width:120px;max-width:100%;background:var(--sd-viewer-page);box-shadow:0 1px 3px rgb(10 22 40/.2)}
.sdv-thumb[aria-current=page] .sdv-thumb-page{box-shadow:0 0 0 2px var(--sd-viewer-accent)}
.sdv-thumb[aria-current=page]{color:var(--sd-viewer-text)}
.sdv-thumb canvas{display:block;width:100%;height:100%}
.sdv-thumb--hidden canvas{visibility:hidden}
`;

/**
 * The page rail (§1.5.3): one button per page with a lazily drawn thumbnail
 * (IntersectionObserver 600 px ahead, at most two renders at once, released
 * beyond 40 pages), raster capped at 2×. `view_only` thumbnails carry the
 * watermark too. While the screen is shared under a cover, page numbers only.
 */
@Component({
  selector: 'sd-viewer-thumbnails',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styles: [CSS],
  host: { class: 'block' },
  template: `
    <nav aria-label="Pages">
      <ol class="sdv-thumbs" [class.sdv-thumbs--grid]="grid()">
        @for (n of pages(); track n) {
          <li class="w-full">
            <button
              type="button"
              class="sdv-thumb font-sans text-caption tabular-nums"
              [class.sdv-thumb--hidden]="hideContent()"
              [attr.data-thumb]="n"
              [attr.aria-label]="'Page ' + n"
              [attr.aria-current]="n === current() ? 'page' : null"
              (click)="pick.emit(n)"
            >
              <span class="sdv-thumb-page" [style.aspect-ratio]="ratio(n)">
                <canvas aria-hidden="true"></canvas>
              </span>
              <span aria-hidden="true">{{ n }}</span>
            </button>
          </li>
        }
      </ol>
    </nav>
  `,
})
export class ViewerThumbnailsComponent {
  private readonly zone = inject(NgZone);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** The open PDF (null while loading). */
  readonly pdf = input<PdfDocumentLike | null>(null);
  readonly count = input(0);
  readonly current = input(1);
  /** The viewer's rotation (degrees, added to each page's own). */
  readonly rotation = input(0);
  /** height / width of page 1 at the current rotation, until a page's own is known. */
  readonly aspect = input(Math.SQRT2);
  /** The watermark text (view_only), else null. */
  readonly watermark = input<string | null>(null);
  /** The screen-share cover: page numbers only, nothing drawn on screen. */
  readonly hideContent = input(false);
  /** The page sheet's three-column grid (phones) instead of the rail. */
  readonly grid = input(false);
  /** A thumbnail was chosen. */
  readonly pick = output<number>();

  protected readonly pages = computed(() => Array.from({ length: this.count() }, (_, i) => i + 1));

  private readonly aspects = new Map<number, number>();
  private readonly drawn = new Set<number>();
  private readonly tasks = new Map<number, PdfRenderTaskLike>();
  private readonly wanted = new Set<number>();
  private queue: number[] = [];
  private io: IntersectionObserver | null = null;
  private generation = 0;

  constructor() {
    // A new document, page count, rotation or watermark: everything is dropped and drawn
    // again. One effect, after render (the buttons exist), so a reset is always followed by
    // a new observer: a reset alone (rotation) left every canvas blank.
    afterRenderEffect(() => {
      const pdf = this.pdf();
      this.count();
      this.rotation();
      this.watermark();
      untracked(() => {
        this.reset();
        this.observe(pdf);
      });
    });
    // Keep the current page's thumbnail in view.
    afterRenderEffect(() => {
      const n = this.current();
      untracked(() => {
        const btn = this.host.nativeElement.querySelector<HTMLElement>(`[data-thumb="${n}"]`);
        if (btn && typeof btn.scrollIntoView === 'function') btn.scrollIntoView({ block: 'nearest' });
        this.releaseFar(n);
      });
    });
    inject(DestroyRef).onDestroy(() => this.reset());
  }

  protected ratio(n: number): string {
    const a = this.aspects.get(n) ?? this.aspect();
    return `1 / ${a.toFixed(4)}`;
  }

  private reset(): void {
    this.generation++;
    this.io?.disconnect();
    this.io = null;
    for (const t of this.tasks.values()) {
      try {
        t.cancel();
      } catch {
        /* done */
      }
    }
    this.tasks.clear();
    this.queue = [];
    this.wanted.clear();
    this.drawn.clear();
    this.aspects.clear();
    for (const c of Array.from(this.host.nativeElement.querySelectorAll('canvas'))) c.width = c.height = 0;
  }

  private observe(pdf: PdfDocumentLike | null): void {
    this.io?.disconnect();
    this.io = null;
    if (!pdf) return;
    const buttons = Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>('[data-thumb]'));
    if (typeof IntersectionObserver === 'undefined') {
      for (const b of buttons) this.want(Number(b.dataset['thumb']));
      return;
    }
    const root = this.scrollRoot();
    this.zone.runOutsideAngular(() => {
      this.io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            const n = Number((e.target as HTMLElement).dataset['thumb']);
            if (e.isIntersecting) this.want(n);
          }
        },
        { root, rootMargin: '600px 0px' },
      );
      for (const b of buttons) this.io.observe(b);
    });
  }

  /** The nearest scrolling ancestor (the rail or the page sheet), else the viewport. */
  private scrollRoot(): Element | null {
    let el: HTMLElement | null = this.host.nativeElement;
    while (el) {
      const o = typeof getComputedStyle === 'function' ? getComputedStyle(el).overflowY : '';
      if (o === 'auto' || o === 'scroll') return el;
      el = el.parentElement;
    }
    return null;
  }

  private want(n: number): void {
    if (this.drawn.has(n) || this.tasks.has(n) || this.wanted.has(n)) return;
    this.wanted.add(n);
    this.queue.push(n);
    this.pump();
  }

  private pump(): void {
    while (this.tasks.size < CONCURRENT && this.queue.length) {
      const n = this.queue.shift() as number;
      this.wanted.delete(n);
      void this.render(n, this.generation);
    }
  }

  private async render(n: number, gen: number): Promise<void> {
    const pdf = this.pdf();
    const canvas = this.host.nativeElement.querySelector<HTMLCanvasElement>(`[data-thumb="${n}"] canvas`);
    if (!pdf || !canvas) return;
    const placeholder: PdfRenderTaskLike = { promise: Promise.resolve(), cancel: () => undefined };
    this.tasks.set(n, placeholder);
    let page: PdfPageLike | null = null;
    try {
      page = await pdf.getPage(n);
      if (gen !== this.generation) return;
      const rotation = ((page.rotate ?? 0) + this.rotation()) % 360;
      const base = page.getViewport({ scale: 1, rotation });
      if (base.width > 0) this.aspects.set(n, base.height / base.width);
      const dpr = Math.min(THUMB_MAX_DPR, Math.max(1, globalThis.devicePixelRatio || 1));
      const scale = (THUMB_CSS_WIDTH * dpr) / Math.max(1, base.width);
      const viewport = page.getViewport({ scale, rotation });
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const task = this.zone.runOutsideAngular(() => (page as PdfPageLike).render({ canvas, viewport }));
      this.tasks.set(n, task);
      await task.promise;
      if (gen !== this.generation) return;
      const text = this.watermark();
      const ctx = text ? canvas.getContext('2d') : null;
      if (ctx && text) drawWatermark(ctx, canvas.width, canvas.height, { text, cssWidth: THUMB_CSS_WIDTH, dpr });
      this.drawn.add(n);
      canvas.parentElement?.style.setProperty('aspect-ratio', this.ratio(n));
    } catch {
      /* cancelled or broken: the number still shows */
    } finally {
      if (gen === this.generation) {
        this.tasks.delete(n);
        this.pump();
      }
    }
  }

  /** Thumbnails more than 40 pages from the current one: free their canvases. */
  private releaseFar(current: number): void {
    for (const n of [...this.drawn]) {
      if (Math.abs(n - current) <= RELEASE_BEYOND) continue;
      this.drawn.delete(n);
      const c = this.host.nativeElement.querySelector<HTMLCanvasElement>(`[data-thumb="${n}"] canvas`);
      if (c) c.width = c.height = 0;
    }
  }
}
