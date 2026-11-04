import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  NgZone,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { DialogService, IconComponent } from '@supadoc/ui';
import {
  isPasswordError,
  PDF_LOADER,
  type PdfDocumentLike,
  type PdfLoadingTaskLike,
  type PdfPageLike,
  type PdfRenderTaskLike,
} from './pdf-loader';
import {
  buildPrintRoot,
  canvasToJpeg,
  MAX_PRINT_PAGES,
  PRINT_DPI,
  PRINT_FAILED,
  PRINT_IMAGE_MAX_PX,
  PRINT_PAGE_CSS_PX,
  PRINT_TOO_LONG,
  PrintTooLongError,
  type PreparedPrint,
} from './print-pages';
import { drawPrintFooter, drawWatermark, footerBandPx, overlayLines, printFooterText, watermarkText } from './watermark';

/** A patient document fetched for viewing (`DoctorApi.patientDocumentView`). */
export interface ProtectedDocumentFile {
  /** The bytes (null while loading, on an error, or for a type that can't be shown). */
  readonly blob: Blob | null;
  /** The type the API served it as (fixed per extension). */
  readonly mime: string;
  readonly title: string;
  readonly typeLabel: string;
  /** "pdf", "docx"… (for the "Preview isn't available" card). */
  readonly extension?: string;
  /** "VM-7F3A2C1D", or null from an older API. */
  readonly viewRef: string | null;
  /** When the view was recorded (ISO). */
  readonly viewedAt: string;
}

/** Who is viewing, for the watermark. */
export interface ProtectedWatermark {
  readonly viewerName: string;
  /** The doctor's profile zone (`DoctorClock.zone()`). */
  readonly timeZone: string;
}

/** Where the host is in fetching the file. */
export type ProtectedViewerState = 'loading' | 'ready' | 'error' | 'not_viewable';

type Kind = 'pdf' | 'image' | 'video' | 'none';

/** iOS Safari refuses canvases larger than this many pixels. */
const MAX_CANVAS_AREA = 16_777_216;
/** Images on screen: at most this many pixels on the long side. */
const SCREEN_IMAGE_MAX_PX = 4096;
/** Pages further than this from the visible ones are released. */
const KEEP_AROUND = 3;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.25;

export const VIEW_ONLY_NOTICE = 'View only · Downloads are turned off for patient documents.';
export const PASSWORD_TEXT = "This file is password-protected and can't be shown here. Ask the patient to share an unlocked copy.";
export const CANT_SHOW_TEXT = "This file can't be shown.";

/** A blob's bytes (FileReader where `Blob.arrayBuffer` is missing, e.g. older Safari). */
function readBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/** What the viewer can draw, from the served type. */
export function viewerKind(mime: string): Kind {
  const m = (mime || '').toLowerCase().split(';')[0].trim();
  if (m === 'application/pdf') return 'pdf';
  if (m === 'image/jpeg' || m === 'image/png' || m === 'image/webp') return 'image';
  if (m === 'video/mp4' || m === 'video/webm') return 'video';
  return 'none';
}

/**
 * The doctor's view-only viewer for a patient's document: PDF pages and
 * photos drawn on canvases with a traceable watermark burned in, videos in a
 * `<video>` with a watermark layer, and Print (a watermarked raster, recorded
 * first by the host). There is no download path: no links, no `download`, no
 * on-screen blob images, no text or annotation layer; the context menu,
 * dragging, copying and Ctrl/Cmd+S are refused while focus is inside.
 *
 * Hosts: the call's "Document" tab (`docked`) or full-screen sheet (`sheet`,
 * dark) and the appointment page's dialog (`dialog`, light). `printRequested`
 * fires once the pages are prepared: the host records the print, then calls
 * `print()`, or `cancelPrint()` when recording failed.
 */
@Component({
  selector: 'doc-protected-document-viewer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: {
    class: 'block min-h-0',
    // Ctrl/Cmd+P anywhere while a page or photo is on screen: the audited Print, never the browser's own.
    '(window:keydown)': 'onWindowKey($event)',
    // The native fullscreen shows the bare <video>, without its watermark layer: leave it at once.
    '(document:fullscreenchange)': 'onFullscreenChange()',
    '(document:webkitfullscreenchange)': 'onFullscreenChange()',
  },
  // The browser's own Print (its menu) never prints the on-screen pages: only the
  // audited, watermarked print root (on <body>, outside this host) reaches paper.
  styles: ['@media print { :host { display: none !important; } }'],
  template: `
    <div
      tabindex="-1"
      class="flex h-full min-h-0 flex-col select-none outline-none [-webkit-user-drag:none] [-webkit-touch-callout:none]"
      [class]="t().root"
      (contextmenu)="refuse($event)"
      (dragstart)="refuse($event)"
      (copy)="refuse($event)"
      (cut)="refuse($event)"
      (keydown)="onKey($event)"
    >
      <ng-content select="[viewerBar]" />
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-2" [class]="t().border">
        <h2 #heading id="doc-viewer-title" tabindex="-1" class="min-w-0 flex-1 basis-40 truncate font-heading text-body font-semibold outline-none" [class]="t().strong">
          {{ file().title }}
        </h2>
        @if (kind() === 'pdf' && pageCount() > 0 && state() === 'ready') {
          <span class="shrink-0 font-sans text-caption tabular-nums" [class]="t().muted">Page {{ currentPage() }} of {{ pageCount() }}</span>
        }
        <div role="toolbar" aria-label="Document viewer" tabindex="-1" class="flex shrink-0 items-center gap-1" (keydown)="onToolbarKey($event)">
          @for (b of tools(); track b.id; let i = $index) {
            <button
              type="button"
              class="flex size-11 items-center justify-center rounded-field transition-colors focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
              [class]="t().tool"
              [attr.tabindex]="i === activeTool() ? 0 : -1"
              [attr.aria-label]="b.label"
              [attr.aria-disabled]="b.disabled || null"
              (focus)="activeTool.set(i)"
              (click)="useTool(b.id, b.disabled)"
            >
              <sd-icon [name]="b.icon" [size]="18" />
            </button>
          }
        </div>
      </div>
      <p class="flex items-center gap-1.5 px-3 py-1.5 font-sans text-caption" [class]="t().notice">
        <sd-icon name="lock" [size]="13" class="shrink-0" />{{ notice }}
      </p>
      @if (printError()) {
        <p class="mx-3 mb-2 flex items-start gap-2 rounded-field px-3 py-2 font-sans text-caption" [class]="t().error" role="alert">
          <sd-icon name="circle-alert" [size]="14" class="mt-px shrink-0" />{{ printError() }}
        </p>
      }
      @if (printBusy()) {
        <p class="sr-only" role="status">Preparing the print…</p>
      }

      <div #scroller class="relative min-h-0 flex-1 overflow-auto" [class]="t().area" [attr.aria-busy]="state() === 'loading' || rendering() || null">
        @switch (shown()) {
          @case ('loading') {
            <div class="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center" role="status">
              <span class="size-8 animate-spin rounded-full border-2 motion-reduce:animate-none" [class]="t().spinner"></span>
              <p class="font-sans text-body-sm" [class]="t().muted">Opening document…</p>
            </div>
          }
          @case ('error') {
            <div class="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
              <sd-icon name="triangle-alert" [size]="28" [class]="t().alertIcon" />
              <p class="max-w-sm font-sans text-body-sm" [class]="t().strong" role="alert">{{ errorShown() || cantShow }}</p>
            </div>
          }
          @case ('not_viewable') {
            <div class="m-4 flex flex-col items-center gap-3 rounded-card border px-6 py-10 text-center" [class]="t().card">
              <sd-icon name="file-text" [size]="28" [class]="t().muted" />
              <p class="max-w-sm font-sans text-body-sm" [class]="t().strong">{{ notViewableText() }}</p>
            </div>
          }
          @case ('pdf') {
            <div class="flex flex-col items-center gap-3 px-3 py-3">
              @for (p of pageNumbers(); track p) {
                <div
                  class="relative shrink-0 bg-white shadow-card"
                  [attr.data-page]="p"
                  [style.width.px]="pageCssWidth()"
                  [style.aspect-ratio]="aspectFor(p)"
                >
                  <canvas class="block h-full w-full" role="img" [attr.aria-label]="'Page ' + p + ' of ' + pageCount() + ', ' + file().title"></canvas>
                </div>
              }
            </div>
          }
          @case ('image') {
            <div class="flex justify-center px-3 py-3">
              <canvas #imageCanvas class="block shadow-card" role="img" [attr.aria-label]="file().title" [style.width.px]="imageCssWidth()"></canvas>
            </div>
          }
          @case ('video') {
            <div class="flex justify-center px-3 py-3">
              <div class="relative w-full max-w-4xl overflow-hidden rounded-card bg-black" (contextmenu)="refuse($event)">
                <video
                  #video
                  class="block max-h-[70dvh] w-full"
                  controls
                  playsinline
                  disablepictureinpicture
                  disableremoteplayback
                  controlslist="nodownload noremoteplayback noplaybackrate nofullscreen"
                  preload="metadata"
                  [attr.aria-label]="file().title"
                  (contextmenu)="refuse($event)"
                  (dblclick)="refuse($event)"
                  (webkitbeginfullscreen)="leaveVideoFullscreen()"
                ></video>
                <!-- The watermark over the video: not interactive, not read out. -->
                <div class="pointer-events-none absolute inset-0 flex flex-col justify-around overflow-hidden opacity-[0.14]" aria-hidden="true">
                  @for (line of overlay(); track $index) {
                    <span class="-rotate-[30deg] whitespace-nowrap font-sans text-body-sm font-semibold text-white [text-shadow:0_0_2px_#000]">{{ line }}</span>
                  }
                </div>
              </div>
            </div>
          }
        }
      </div>
    </div>
  `,
})
export class ProtectedDocumentViewer {
  private readonly zone = inject(NgZone);
  private readonly injector = inject(Injector);
  private readonly dialogs = inject(DialogService);
  private readonly loadPdf = inject(PDF_LOADER);

  /** The document (its bytes once loaded). */
  readonly file = input.required<ProtectedDocumentFile>();
  /** The doctor's name and zone for the watermark. */
  readonly watermark = input.required<ProtectedWatermark>();
  /** `docked` (call tab) / `sheet` (call, full screen) — the cockpit's theme; `dialog` (appointment page) — light. */
  readonly mode = input<'docked' | 'sheet' | 'dialog'>('docked');
  /** The call cockpit's theme (`dialog` is always light). */
  readonly tone = input<'dark' | 'light'>('dark');
  /** In a live call: Print asks first (the video may freeze while the print dialog is open). */
  readonly inCall = input(false);
  /** Where the host is in fetching the file. */
  readonly state = input<ProtectedViewerState>('ready');
  /** The host's error text for `state` `error`. */
  readonly errorText = input('');
  /** Close / Esc. */
  readonly closed = output<void>();
  /** The pages are prepared: record the print, then call `print()` (or `cancelPrint()`). */
  readonly printRequested = output<void>();

  protected readonly notice = VIEW_ONLY_NOTICE;
  protected readonly cantShow = CANT_SHOW_TEXT;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');
  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  private readonly imageCanvas = viewChild<ElementRef<HTMLCanvasElement>>('imageCanvas');
  private readonly videoEl = viewChild<ElementRef<HTMLVideoElement>>('video');

  protected readonly kind = computed(() => viewerKind(this.file().mime));
  /** A rendering problem found here (a password, a broken file). */
  private readonly renderError = signal('');
  protected readonly shown = computed<'loading' | 'error' | 'not_viewable' | Kind>(() => {
    const s = this.state();
    if (s !== 'ready') return s;
    if (this.renderError()) return 'error';
    const k = this.kind();
    if (k === 'none' || !this.file().blob) return 'not_viewable';
    return k;
  });
  protected readonly notViewableText = computed(() => {
    const ext = (this.file().extension ?? '').replace(/^\./, '').toUpperCase();
    return `Preview isn't available for this file type${ext ? ` (${ext})` : ''}. Ask the patient to share it as a PDF or photo.`;
  });
  protected readonly errorShown = computed(() => (this.renderError() ? this.renderError() : this.errorText()));

  protected readonly zoom = signal(1);
  protected readonly pageCount = signal(0);
  protected readonly currentPage = signal(1);
  protected readonly pageNumbers = computed(() => Array.from({ length: this.pageCount() }, (_, i) => i + 1));
  /** The scroller's inner width (CSS px) — "fit width". */
  private readonly areaWidth = signal(0);
  protected readonly pageCssWidth = computed(() => Math.max(120, Math.round((this.areaWidth() || 800) * this.zoom())));
  protected readonly imageCssWidth = computed(() => this.imageWidth());
  private readonly imageWidth = signal(0);
  protected readonly rendering = signal(false);
  protected readonly printBusy = signal(false);
  protected readonly printError = signal('');
  protected readonly activeTool = signal(0);

  private readonly wmText = computed(() =>
    watermarkText({
      viewerName: this.watermark().viewerName,
      timeZone: this.watermark().timeZone,
      viewedAt: this.file().viewedAt,
      viewRef: this.file().viewRef,
    }),
  );
  protected readonly overlay = computed(() => overlayLines(this.wmText()));

  protected readonly tools = computed(() => {
    const ready = this.shown() === 'pdf' || this.shown() === 'image';
    const list: { id: 'out' | 'in' | 'fit' | 'print' | 'close'; label: string; icon: string; disabled: boolean }[] = [
      { id: 'out', label: 'Zoom out', icon: 'zoom-out', disabled: !ready || this.zoom() <= ZOOM_MIN },
      { id: 'in', label: 'Zoom in', icon: 'zoom-in', disabled: !ready || this.zoom() >= ZOOM_MAX },
      { id: 'fit', label: 'Fit width', icon: 'maximize-2', disabled: !ready },
    ];
    if (this.kind() !== 'video') list.push({ id: 'print', label: 'Print', icon: 'printer', disabled: !ready || this.printBusy() });
    list.push({ id: 'close', label: 'Close', icon: 'x', disabled: false });
    return list;
  });

  /** Dark (the call) or light (the appointment page) vocabulary. */
  protected readonly t = computed(() =>
    this.mode() === 'dialog' || this.tone() === 'light'
      ? {
          root: 'bg-white text-ink',
          border: 'border-cloud',
          strong: 'text-ink',
          muted: 'text-slate',
          notice: 'text-slate',
          tool: 'text-slate hover:bg-glacier focus-visible:outline-cerulean',
          area: 'bg-glacier',
          card: 'border-haze bg-white',
          error: 'bg-alert/10 text-alert-ink',
          alertIcon: 'text-alert',
          spinner: 'border-cerulean/20 border-t-cerulean',
        }
      : {
          root: 'bg-ink text-white',
          border: 'border-white/10',
          strong: 'text-white',
          muted: 'text-white/70',
          notice: 'text-white/70',
          tool: 'text-white/80 hover:bg-white/10 focus-visible:outline-frost',
          area: 'bg-abyss',
          card: 'border-white/10 bg-white/[0.03]',
          error: 'bg-alert/15 text-white',
          alertIcon: 'text-alert',
          spinner: 'border-white/20 border-t-white',
        },
  );

  // ---- Rendering state (outside Angular's change detection) ----
  private task: PdfLoadingTaskLike | null = null;
  private pdf: PdfDocumentLike | null = null;
  private readonly pages = new Map<number, PdfPageLike>();
  private readonly renderTasks = new Map<number, PdfRenderTaskLike>();
  /** Pages drawn at the current width: page → the CSS width it was drawn at. */
  private readonly drawn = new Map<number, number>();
  private readonly aspects = new Map<number, number>();
  private readonly visible = new Set<number>();
  private bitmap: ImageBitmap | null = null;
  private videoUrl: string | null = null;
  private io: IntersectionObserver | null = null;
  private ro: ResizeObserver | null = null;
  private generation = 0;
  private prepared: PreparedPrint | null = null;
  /** The in-call "Print during the call?" question is open (a second Ctrl+P doesn't ask again). */
  private asking = false;
  private loadedBlob: Blob | null = null;

  constructor() {
    // A new file (or one that just loaded): start over with it.
    effect(() => {
      const file = this.file();
      const shown = this.shown();
      untracked(() => this.open(file, shown));
    });
    // Zoom or a new width: draw again at the new size.
    effect(() => {
      this.pageCssWidth();
      this.areaWidth();
      untracked(() => this.redraw());
    });
    afterNextRender(() => {
      this.heading()?.nativeElement.focus();
      this.observeSize();
    });
    inject(DestroyRef).onDestroy(() => this.dispose());
  }

  // ---- Public (host) API ----

  /** Print the prepared pages (call after the print was recorded). */
  print(): Promise<void> {
    const p = this.prepared;
    this.prepared = null;
    this.printBusy.set(false);
    if (p) p.print();
    return Promise.resolve();
  }

  /** Recording the print failed: discard the prepared pages and say so. */
  cancelPrint(): void {
    this.prepared?.cleanup();
    this.prepared = null;
    this.printBusy.set(false);
    this.printError.set(PRINT_FAILED);
  }

  // ---- Toolbar and keys ----

  protected useTool(id: 'out' | 'in' | 'fit' | 'print' | 'close', disabled: boolean): void {
    if (disabled) return;
    if (id === 'close') this.close();
    else if (id === 'print') void this.startPrint();
    else if (id === 'fit') this.zoom.set(1);
    else this.stepZoom(id === 'in' ? 1 : -1);
  }

  private stepZoom(dir: 1 | -1): void {
    if (this.shown() !== 'pdf' && this.shown() !== 'image') return;
    this.zoom.update((z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round((z + dir * ZOOM_STEP) * 100) / 100)));
  }

  protected refuse(e: Event): void {
    e.preventDefault();
  }

  protected onKey(e: KeyboardEvent): void {
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && key === 's') {
      e.preventDefault();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && key === 'p') {
      e.preventDefault();
      if (this.kind() !== 'video') void this.startPrint();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      this.stepZoom(1);
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      this.stepZoom(-1);
    } else if (e.key === '0') {
      e.preventDefault();
      this.zoom.set(1);
    }
  }

  /**
   * Ctrl/Cmd+P with focus anywhere (the dock, the notes…) while a page or photo
   * is on screen: the audited Print instead of the browser's (which would print
   * nothing of the document — see the print style — and record nothing).
   * Already handled inside the viewer (`onKey`) when focus is there.
   */
  protected onWindowKey(e: KeyboardEvent): void {
    if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 'p') return;
    if (!this.printable() || !this.onScreen()) return;
    e.preventDefault();
    void this.startPrint();
  }

  /** A page or a photo is shown (video has no Print). */
  private printable(): boolean {
    const s = this.shown();
    return s === 'pdf' || s === 'image';
  }

  /** Rendered and not hidden (the call's Document tab stays mounted behind the other tabs). */
  private onScreen(): boolean {
    return this.host.nativeElement.getClientRects().length > 0;
  }

  /** The video went to the browser's fullscreen (no watermark there): bring it back. */
  protected onFullscreenChange(): void {
    const video = this.videoEl()?.nativeElement;
    if (!video) return;
    const d = document as Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };
    const full = d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
    if (full !== video) return;
    try {
      if (typeof d.exitFullscreen === 'function') void Promise.resolve(d.exitFullscreen()).catch(() => undefined);
      else d.webkitExitFullscreen?.();
    } catch {
      /* not in fullscreen after all */
    }
  }

  /** iOS: the player's own fullscreen (`webkitbeginfullscreen`) — leave it. */
  protected leaveVideoFullscreen(): void {
    const video = this.videoEl()?.nativeElement as (HTMLVideoElement & { webkitExitFullscreen?: () => void }) | undefined;
    try {
      video?.webkitExitFullscreen?.();
    } catch {
      /* already left */
    }
  }

  /** Arrow keys, Home and End move between the toolbar's buttons (one tab stop). */
  protected onToolbarKey(e: KeyboardEvent): void {
    const n = this.tools().length;
    let next = this.activeTool();
    if (e.key === 'ArrowRight') next = (next + 1) % n;
    else if (e.key === 'ArrowLeft') next = (next - 1 + n) % n;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else return;
    e.preventDefault();
    this.activeTool.set(next);
    const buttons = (e.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('button');
    buttons[next]?.focus();
  }

  protected aspectFor(page: number): string {
    const a = this.aspects.get(page) ?? this.aspects.get(1) ?? Math.SQRT2;
    return `1 / ${a.toFixed(4)}`;
  }

  private close(): void {
    this.dispose();
    this.closed.emit();
  }

  // ---- Opening ----

  private open(file: ProtectedDocumentFile, shown: string): void {
    if (file.blob === this.loadedBlob && file.blob !== null) return;
    this.release();
    this.loadedBlob = file.blob;
    this.renderError.set('');
    this.printError.set('');
    this.zoom.set(1);
    const blob = file.blob;
    if (!blob || this.state() !== 'ready') return;
    const gen = ++this.generation;
    if (shown === 'pdf' || this.kind() === 'pdf') void this.openPdf(blob, gen);
    else if (this.kind() === 'image') void this.openImage(blob, gen);
    else if (this.kind() === 'video') this.openVideo(blob, gen);
  }

  private async openPdf(blob: Blob, gen: number): Promise<void> {
    this.rendering.set(true);
    try {
      const bytes = new Uint8Array(await readBytes(blob));
      const task = await this.loadPdf(bytes);
      if (gen !== this.generation) {
        void task.destroy();
        return;
      }
      this.task = task;
      const pdf = await task.promise;
      if (gen !== this.generation) return;
      this.pdf = pdf;
      const first = await pdf.getPage(1);
      if (gen !== this.generation) return;
      this.pages.set(1, first);
      const vp = first.getViewport({ scale: 1 });
      if (vp.width > 0) this.aspects.set(1, vp.height / vp.width);
      this.pageCount.set(pdf.numPages);
      this.currentPage.set(1);
      afterNextRender(() => this.observePages(gen), { injector: this.injector });
    } catch (err: unknown) {
      if (gen !== this.generation) return;
      this.renderError.set(isPasswordError(err) ? PASSWORD_TEXT : CANT_SHOW_TEXT);
    } finally {
      if (gen === this.generation) this.rendering.set(false);
    }
  }

  private async openImage(blob: Blob, gen: number): Promise<void> {
    this.rendering.set(true);
    try {
      const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      if (gen !== this.generation) {
        bitmap.close?.();
        return;
      }
      this.bitmap = bitmap;
      afterNextRender(() => this.drawImage(), { injector: this.injector });
    } catch {
      if (gen === this.generation) this.renderError.set(CANT_SHOW_TEXT);
    } finally {
      if (gen === this.generation) this.rendering.set(false);
    }
  }

  private openVideo(blob: Blob, gen: number): void {
    afterNextRender(
      () => {
        if (gen !== this.generation) return;
        const video = this.videoEl()?.nativeElement;
        if (!video) return;
        this.videoUrl = URL.createObjectURL(blob);
        video.src = this.videoUrl;
      },
      { injector: this.injector },
    );
  }

  // ---- PDF pages ----

  private holder(page: number): HTMLElement | null {
    return this.scroller()?.nativeElement.querySelector<HTMLElement>(`[data-page="${page}"]`) ?? null;
  }

  /** Watch which pages are near the screen; render those, release far ones. */
  private observePages(gen: number): void {
    if (gen !== this.generation) return;
    const root = this.scroller()?.nativeElement;
    if (!root) return;
    this.io?.disconnect();
    const holders = Array.from(root.querySelectorAll<HTMLElement>('[data-page]'));
    if (typeof IntersectionObserver === 'undefined') {
      // No observer (old browser, tests): draw them all.
      for (const h of holders) this.visible.add(Number(h.dataset['page']));
      for (const h of holders) void this.renderPage(Number(h.dataset['page']), gen);
      return;
    }
    this.zone.runOutsideAngular(() => {
      this.io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            const page = Number((e.target as HTMLElement).dataset['page']);
            if (e.isIntersecting) this.visible.add(page);
            else this.visible.delete(page);
          }
          const shown = [...this.visible].sort((a, b) => a - b);
          if (shown.length) this.zone.run(() => this.currentPage.set(shown[0]));
          for (const p of shown) void this.renderPage(p, gen);
          this.releaseFar(shown);
        },
        { root, rootMargin: '400px 0px' },
      );
      for (const h of holders) this.io.observe(h);
    });
  }

  private async renderPage(n: number, gen: number): Promise<void> {
    const pdf = this.pdf;
    const cssWidth = this.pageCssWidth();
    if (!pdf || gen !== this.generation || this.drawn.get(n) === cssWidth || this.renderTasks.has(n)) return;
    const canvas = this.holder(n)?.querySelector('canvas');
    if (!canvas) return;
    try {
      const page = this.pages.get(n) ?? (await pdf.getPage(n));
      this.pages.set(n, page);
      if (gen !== this.generation) return;
      const base = page.getViewport({ scale: 1 });
      if (base.width > 0) this.aspects.set(n, base.height / base.width);
      const dpr = Math.max(1, globalThis.devicePixelRatio || 1);
      let scale = (cssWidth / base.width) * dpr;
      const area = base.width * scale * base.height * scale;
      if (area > MAX_CANVAS_AREA) scale *= Math.sqrt(MAX_CANVAS_AREA / area);
      const viewport = page.getViewport({ scale });
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const task = this.zone.runOutsideAngular(() => page.render({ canvas, viewport }));
      this.renderTasks.set(n, task);
      await task.promise;
      this.renderTasks.delete(n);
      if (gen !== this.generation) return;
      const ctx = canvas.getContext('2d');
      if (ctx) drawWatermark(ctx, canvas.width, canvas.height, { text: this.wmText(), cssWidth, dpr: canvas.width / cssWidth });
      this.drawn.set(n, cssWidth);
    } catch {
      this.renderTasks.delete(n);
      // A cancelled render (zoom, close) is not an error; a real failure shows once.
      if (gen === this.generation && !this.drawn.size && n === 1) this.renderError.set(CANT_SHOW_TEXT);
    }
  }

  /** Pages more than three away from those on screen: free their memory. */
  private releaseFar(shown: number[]): void {
    if (!shown.length) return;
    const lo = shown[0] - KEEP_AROUND;
    const hi = shown[shown.length - 1] + KEEP_AROUND;
    for (const n of [...this.drawn.keys()]) {
      if (n >= lo && n <= hi) continue;
      this.drawn.delete(n);
      this.pages.get(n)?.cleanup();
      this.pages.delete(n);
      const c = this.holder(n)?.querySelector('canvas');
      if (c) c.width = c.height = 0;
    }
  }

  /** Zoom / resize: the drawn pages are stale; draw the visible ones again. */
  private redraw(): void {
    const gen = this.generation;
    if (this.pdf) {
      for (const t of this.renderTasks.values()) t.cancel();
      this.renderTasks.clear();
      this.drawn.clear();
      for (const p of [...this.visible]) void this.renderPage(p, gen);
    }
    if (this.bitmap) this.drawImage();
  }

  // ---- Images ----

  private drawImage(): void {
    const bmp = this.bitmap;
    const canvas = this.imageCanvas()?.nativeElement;
    if (!bmp || !canvas || !bmp.width) return;
    const cssWidth = Math.max(120, Math.round((this.areaWidth() || 800) * this.zoom()));
    const dpr = Math.max(1, globalThis.devicePixelRatio || 1);
    let w = cssWidth * dpr;
    let h = (w * bmp.height) / bmp.width;
    const long = Math.max(w, h);
    if (long > SCREEN_IMAGE_MAX_PX) {
      w *= SCREEN_IMAGE_MAX_PX / long;
      h *= SCREEN_IMAGE_MAX_PX / long;
    }
    canvas.width = Math.max(1, Math.floor(w));
    canvas.height = Math.max(1, Math.floor(h));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    drawWatermark(ctx, canvas.width, canvas.height, { text: this.wmText(), cssWidth, dpr: canvas.width / cssWidth });
    this.imageWidth.set(cssWidth);
  }

  private observeSize(): void {
    const el = this.scroller()?.nativeElement;
    if (!el) return;
    const measure = () => {
      const w = Math.max(0, el.clientWidth - 24);
      if (w && w !== this.areaWidth()) this.zone.run(() => this.areaWidth.set(w));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    this.zone.runOutsideAngular(() => {
      let frame = 0;
      this.ro = new ResizeObserver(() => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(measure);
      });
      this.ro.observe(el);
    });
  }

  // ---- Print ----

  private async startPrint(): Promise<void> {
    if (this.printBusy() || this.asking || !this.printable()) return;
    this.printError.set('');
    // The file this print is for: closing the viewer (or a new file) while it is
    // being asked about or prepared bumps it, and nothing may then stay behind.
    const gen = this.generation;
    if (this.inCall()) {
      this.asking = true;
      let confirmed = false;
      try {
        ({ confirmed } = await this.dialogs.confirm({
          tone: 'info',
          icon: 'printer',
          title: 'Print during the call?',
          message: 'The call stays connected, but your video may freeze until you close the print dialog.',
          confirmLabel: 'Print',
          cancelLabel: 'Cancel',
        }));
      } finally {
        this.asking = false;
      }
      if (!confirmed || gen !== this.generation) return;
    }
    this.printBusy.set(true);
    let prepared: PreparedPrint;
    try {
      const pages = await this.zone.runOutsideAngular(() => this.renderPrintPages());
      if (gen !== this.generation) {
        this.printBusy.set(false);
        return;
      }
      prepared = await buildPrintRoot(pages);
    } catch (err: unknown) {
      this.printBusy.set(false);
      // Closed meanwhile (its pages were released under the render): nothing to say.
      if (gen === this.generation) this.printError.set(err instanceof PrintTooLongError ? PRINT_TOO_LONG : PRINT_FAILED);
      return;
    }
    if (gen !== this.generation) {
      // Closed while the images decoded: the print root (the patient's pages) goes now.
      prepared.cleanup();
      this.printBusy.set(false);
      return;
    }
    this.prepared?.cleanup();
    this.prepared = prepared;
    // Prepared: the host records the print, then calls print() (or cancelPrint()).
    this.printRequested.emit();
  }

  /** Each page as a watermarked JPEG with the footer band (150 DPI; images at natural size, ≤ 3000 px). */
  private async renderPrintPages(): Promise<Blob[]> {
    const wm = this.watermark();
    const file = this.file();
    const footer = printFooterText({
      viewerName: wm.viewerName,
      timeZone: wm.timeZone,
      viewRef: file.viewRef,
      printedAt: new Date().toISOString(),
    });
    const text = this.wmText();
    const out: Blob[] = [];
    if (this.pdf) {
      const pdf = this.pdf;
      if (pdf.numPages > MAX_PRINT_PAGES) throw new PrintTooLongError();
      const scale = PRINT_DPI / 72;
      const dpr = PRINT_DPI / 96;
      const band = footerBandPx(dpr);
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = this.pages.get(n) ?? (await pdf.getPage(n));
        const vp = page.getViewport({ scale });
        const pageCanvas = document.createElement('canvas');
        pageCanvas.width = Math.floor(vp.width);
        pageCanvas.height = Math.floor(vp.height);
        await page.render({ canvas: pageCanvas, viewport: vp }).promise;
        out.push(await this.composePrintPage(pageCanvas, pageCanvas.width, pageCanvas.height, band, dpr, text, footer));
        pageCanvas.width = pageCanvas.height = 0;
        if (!this.pages.has(n)) page.cleanup();
      }
      return out;
    }
    const bmp = this.bitmap;
    if (!bmp) throw new Error('nothing to print');
    // Natural size, at most 3000 px on the long side; a small photo is drawn up to
    // the printed width, so its footer isn't a blur of upscaled pixels.
    const k = Math.min(PRINT_IMAGE_MAX_PX / Math.max(bmp.width, bmp.height), Math.max(1, PRINT_PAGE_CSS_PX / bmp.width));
    const w = Math.max(1, Math.floor(bmp.width * k));
    const h = Math.max(1, Math.floor(bmp.height * k));
    // The page prints `width: 100%` (≈ 718 CSS px): canvas pixels per printed CSS pixel,
    // so the footer band is 28 CSS px and its text about 9 pt whatever the photo's size.
    const dpr = w / PRINT_PAGE_CSS_PX;
    out.push(await this.composePrintPage(bmp, w, h, footerBandPx(dpr), dpr, text, footer));
    return out;
  }

  private async composePrintPage(
    source: CanvasImageSource,
    w: number,
    h: number,
    band: number,
    dpr: number,
    text: string,
    footer: string,
  ): Promise<Blob> {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h + band;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, w, h);
    drawWatermark(ctx, w, h, { text, cssWidth: w / dpr, dpr, density: 'print' });
    drawPrintFooter(ctx, w, h, band, footer);
    try {
      return await canvasToJpeg(canvas);
    } finally {
      canvas.width = canvas.height = 0;
    }
  }

  // ---- Teardown ----

  /** Drop the current file's rendering: tasks, canvases, URLs, the bitmap. */
  private release(): void {
    this.generation++;
    this.io?.disconnect();
    this.io = null;
    for (const t of this.renderTasks.values()) {
      try {
        t.cancel();
      } catch {
        /* already done */
      }
    }
    this.renderTasks.clear();
    for (const p of this.pages.values()) {
      try {
        p.cleanup();
      } catch {
        /* already released */
      }
    }
    this.pages.clear();
    this.drawn.clear();
    this.visible.clear();
    this.aspects.clear();
    const root = this.scroller()?.nativeElement;
    root?.querySelectorAll('canvas').forEach((c) => (c.width = c.height = 0));
    if (this.task) void Promise.resolve(this.task.destroy()).catch(() => undefined);
    this.task = null;
    this.pdf = null;
    this.bitmap?.close?.();
    this.bitmap = null;
    const video = this.videoEl()?.nativeElement;
    if (video) {
      video.pause?.();
      video.removeAttribute('src');
    }
    if (this.videoUrl) URL.revokeObjectURL(this.videoUrl);
    this.videoUrl = null;
    this.prepared?.cleanup();
    this.prepared = null;
    this.pageCount.set(0);
  }

  private dispose(): void {
    this.release();
    this.ro?.disconnect();
    this.ro = null;
    this.loadedBlob = null;
  }
}
