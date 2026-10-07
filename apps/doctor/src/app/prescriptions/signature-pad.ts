import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  input,
  NgZone,
  OnDestroy,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { IconComponent } from '@supadoc/ui';

interface Point {
  x: number;
  y: number;
}

const INK = '#1c2b3a';
const LINE_WIDTH = 2.5;
/** Exported PNG is at most this wide (keeps it well under the 500 KB limit). */
const MAX_EXPORT_WIDTH = 1200;
/** ~490 KB of binary as base64 — re-export smaller above this. */
const MAX_DATA_URL_CHARS = 650_000;

/**
 * A hand-signature pad: draw with a mouse, finger or pen. White background,
 * dark ink, smoothed strokes, devicePixelRatio-aware. Emits a PNG data URL
 * (`data:image/png;base64,…`) after each stroke, or `null` after `clear()`.
 *
 * Usage: `<doc-signature-pad (changed)="sig.set($event)" />`.
 */
@Component({
  selector: 'doc-signature-pad',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    <div
      class="relative w-full max-w-[600px] overflow-hidden rounded-field border border-ash bg-white"
      [style.height.px]="height()"
    >
      <canvas
        #canvas
        class="block size-full cursor-crosshair touch-none select-none"
        role="img"
        [attr.aria-label]="label()"
      ></canvas>
      <span
        class="pointer-events-none absolute bottom-9 left-6 right-6 border-b border-dashed border-ash"
        aria-hidden="true"
      ></span>
      @if (empty()) {
        <span
          class="pointer-events-none absolute inset-0 flex select-none items-center justify-center font-heading text-h5 text-ash"
          aria-hidden="true"
          >Sign here</span
        >
      }
    </div>
    @if (showClear()) {
      <button
        type="button"
        class="mt-2 inline-flex items-center gap-1.5 rounded-field border border-cloud bg-white px-3 py-2 font-sans text-caption font-semibold text-cerulean transition-colors hover:border-cerulean disabled:cursor-not-allowed disabled:opacity-50"
        [disabled]="empty()"
        (click)="clear()"
      >
        <sd-icon name="eraser" [size]="14" />
        Clear
      </button>
    }
  `,
})
export class SignaturePad implements AfterViewInit, OnDestroy {
  private readonly zone = inject(NgZone);

  /** Accessible label for the drawing surface. */
  readonly label = input('Signature pad. Draw your signature with a mouse, finger or pen.');
  /** Pad height in CSS pixels (width fills the container, up to 600px). */
  readonly height = input(200);
  /** Show the built-in "Clear" button under the pad. */
  readonly showClear = input(true);

  /** PNG data URL after each stroke ends, or null after `clear()`. */
  readonly changed = output<string | null>();

  protected readonly empty = signal(true);

  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private ctx: CanvasRenderingContext2D | null = null;
  private strokes: Point[][] = [];
  private current: Point[] | null = null;
  private pointerId: number | null = null;
  private cssW = 0;
  private cssH = 0;
  private resizeObserver: ResizeObserver | null = null;
  private readonly cleanups: (() => void)[] = [];

  ngAfterViewInit(): void {
    const canvas = this.canvasRef().nativeElement;
    this.zone.runOutsideAngular(() => {
      const listen = <K extends keyof HTMLElementEventMap>(
        type: K,
        fn: (e: HTMLElementEventMap[K]) => void,
      ) => {
        canvas.addEventListener(type, fn as EventListener);
        this.cleanups.push(() => canvas.removeEventListener(type, fn as EventListener));
      };
      listen('pointerdown', (e) => this.onDown(e));
      listen('pointermove', (e) => this.onMove(e));
      listen('pointerup', (e) => this.onUp(e));
      listen('pointercancel', (e) => this.onUp(e));
      if (typeof ResizeObserver !== 'undefined') {
        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(canvas);
      }
    });
    this.resize();
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    for (const off of this.cleanups) off();
  }

  /** Wipe the pad and emit `null`. */
  clear(): void {
    this.strokes = [];
    this.current = null;
    this.pointerId = null;
    this.redraw();
    this.empty.set(true);
    this.changed.emit(null);
  }

  /** True when nothing has been drawn. */
  isEmpty(): boolean {
    return this.strokes.length === 0;
  }

  /** The current drawing as a PNG data URL (white background), or null when empty. */
  toDataUrl(): string | null {
    if (this.strokes.length === 0 || !this.cssW || !this.cssH) return null;
    const scale = Math.min(2, MAX_EXPORT_WIDTH / this.cssW);
    let url = this.exportAt(scale);
    if (url.length > MAX_DATA_URL_CHARS) url = this.exportAt(Math.min(1, scale));
    return url;
  }

  // ----- drawing -----

  private exportAt(scale: number): string {
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(this.cssW * scale));
    out.height = Math.max(1, Math.round(this.cssH * scale));
    const ctx = out.getContext('2d');
    if (!ctx) return '';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    for (const s of this.strokes) this.paintStroke(ctx, s);
    return out.toDataURL('image/png');
  }

  private resize(): void {
    const canvas = this.canvasRef().nativeElement;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    this.cssW = rect.width;
    this.cssH = rect.height;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    this.ctx = canvas.getContext('2d');
    this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.redraw();
  }

  private redraw(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.restore();
    for (const s of this.strokes) this.paintStroke(ctx, s);
  }

  private style(ctx: CanvasRenderingContext2D): void {
    ctx.strokeStyle = INK;
    ctx.fillStyle = INK;
    ctx.lineWidth = LINE_WIDTH;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  /** The whole stroke: line to the first midpoint, quadratic curves through midpoints, line to the end. */
  private paintStroke(ctx: CanvasRenderingContext2D, pts: Point[]): void {
    this.style(ctx);
    if (pts.length === 1) {
      this.dot(ctx, pts[0]);
      return;
    }
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    const m0 = mid(pts[0], pts[1]);
    ctx.lineTo(m0.x, m0.y);
    for (let i = 1; i < pts.length - 1; i++) {
      const m = mid(pts[i], pts[i + 1]);
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, m.x, m.y);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
  }

  /** Incrementally draw the newest piece of the stroke being drawn. */
  private paintTail(pts: Point[]): void {
    const ctx = this.ctx;
    const n = pts.length;
    if (!ctx || n < 2) return;
    this.style(ctx);
    ctx.beginPath();
    if (n === 2) {
      const m = mid(pts[0], pts[1]);
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(m.x, m.y);
    } else {
      const a = pts[n - 3];
      const b = pts[n - 2];
      const c = pts[n - 1];
      const m1 = mid(a, b);
      const m2 = mid(b, c);
      ctx.moveTo(m1.x, m1.y);
      ctx.quadraticCurveTo(b.x, b.y, m2.x, m2.y);
    }
    ctx.stroke();
  }

  private dot(ctx: CanvasRenderingContext2D, p: Point): void {
    ctx.beginPath();
    ctx.arc(p.x, p.y, LINE_WIDTH / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  private point(e: PointerEvent): Point {
    const rect = this.canvasRef().nativeElement.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // ----- pointer events (outside Angular) -----

  private onDown(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (this.pointerId !== null) return;
    e.preventDefault();
    const canvas = this.canvasRef().nativeElement;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* not capturable — drawing still works while inside the pad */
    }
    this.pointerId = e.pointerId;
    const p = this.point(e);
    this.current = [p];
    this.strokes.push(this.current);
    if (this.ctx) {
      this.style(this.ctx);
      this.dot(this.ctx, p);
    }
    if (this.empty()) this.zone.run(() => this.empty.set(false));
  }

  private onMove(e: PointerEvent): void {
    if (!this.current || e.pointerId !== this.pointerId) return;
    e.preventDefault();
    const batch =
      typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    for (const ev of batch.length ? batch : [e]) {
      const p = this.point(ev);
      const last = this.current[this.current.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) < 0.75) continue;
      this.current.push(p);
      this.paintTail(this.current);
    }
  }

  private onUp(e: PointerEvent): void {
    if (!this.current || e.pointerId !== this.pointerId) return;
    const pts = this.current;
    if (pts.length > 1 && this.ctx) {
      // Finish the tail from the last midpoint to the final point.
      const a = pts[pts.length - 2];
      const b = pts[pts.length - 1];
      const m = mid(a, b);
      this.style(this.ctx);
      this.ctx.beginPath();
      this.ctx.moveTo(m.x, m.y);
      this.ctx.lineTo(b.x, b.y);
      this.ctx.stroke();
    }
    this.current = null;
    this.pointerId = null;
    const canvas = this.canvasRef().nativeElement;
    try {
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const url = this.toDataUrl();
    this.zone.run(() => this.changed.emit(url));
  }
}

function mid(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
