import {
  ChangeDetectionStrategy,
  Component,
  effect,
  ElementRef,
  input,
  OnDestroy,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type { Observable, Subscription } from 'rxjs';
import { apiErrorMessage } from '@supadoc/data-access';
import { IconComponent } from '@supadoc/ui';
import { BTN_GHOST } from './layout';

/** File types shown inline — anything else is offered as a download only. */
export const PREVIEWABLE_MIME: ReadonlySet<string> = new Set(['application/pdf', 'image/jpeg', 'image/png']);

export type DocumentKind = 'pdf' | 'image' | 'other';

/** How a stored file is shown: by its stored, sniffed type — never the response's. */
export function documentKind(mime: string | null | undefined): DocumentKind {
  const m = (mime ?? '').toLowerCase();
  if (!PREVIEWABLE_MIME.has(m)) return 'other';
  return m === 'application/pdf' ? 'pdf' : 'image';
}

function sizeText(bytes: number): string {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A confidential document, shown inside a dialog: the file is fetched as a
 * blob through `load` (every open is audited server-side), re-typed from the
 * stored MIME type, and put on the native `<iframe>` / `<img>` from a blob URL
 * through an effect — no sanitizer bypass — that is revoked when the viewer
 * goes away or loads another file. "Open in new tab" and "Download" use the
 * same blob URL. A 404 means the stored file can't be read (no retry).
 *
 * Usage: `<bo-document-viewer [load]="loadFn" [mime]="doc.mime" [name]="doc.original_name" />`
 * where `loadFn` changes only when the document does (each new function is a new read).
 */
@Component({
  selector: 'bo-document-viewer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'flex min-w-0 flex-col gap-2' },
  template: `
    <div class="flex flex-wrap items-center justify-between gap-2">
      <p class="min-w-0 break-all font-sans text-caption text-slate">{{ name() }}{{ sizeBytes() !== null ? ' · ' + size(sizeBytes() ?? 0) : '' }}</p>
      @if (objectUrl(); as url) {
        <span class="flex gap-1">
          <a [href]="url" target="_blank" rel="noopener" class="${BTN_GHOST} !min-h-11 !px-3 !py-1.5 text-caption"><sd-icon name="external-link" [size]="16" />Open in new tab</a>
          <a [href]="url" [attr.download]="name() || null" class="${BTN_GHOST} !min-h-11 !px-3 !py-1.5 text-caption"><sd-icon name="download" [size]="16" />Download</a>
        </span>
      }
    </div>
    <div class="flex min-h-[320px] items-center justify-center overflow-hidden rounded-field border border-cloud bg-glacier lg:min-h-[60vh]" [attr.aria-busy]="loading() || null">
      @if (loading()) {
        <span class="flex items-center gap-2 font-sans text-body-sm text-slate" role="status"><sd-icon name="loader-circle" [size]="18" class="animate-spin" />Opening the document…</span>
      } @else if (error()) {
        <div class="flex flex-col items-center gap-3 p-6 text-center">
          <sd-icon name="triangle-alert" [size]="28" class="text-alert" />
          <p class="font-sans text-body-sm text-slate" role="alert">{{ error() }}</p>
          @if (!gone()) {
            <button type="button" class="${BTN_GHOST}" (click)="reload()"><sd-icon name="refresh-cw" [size]="16" />Try again</button>
          }
        </div>
      } @else if (kind() === 'pdf' && objectUrl()) {
        <iframe #frame [title]="'Document: ' + name()" class="h-[60vh] min-h-[320px] w-full bg-white"></iframe>
      } @else if (kind() === 'image' && objectUrl()) {
        <img #image [alt]="alt() || name()" class="max-h-[70vh] w-auto max-w-full object-contain" />
      } @else if (objectUrl()) {
        <p class="p-6 text-center font-sans text-body-sm text-slate">This file type can't be shown here. Download it to check it.</p>
      }
    </div>
    <p class="flex items-start gap-1.5 font-sans text-caption text-slate">
      <sd-icon name="shield-check" [size]="14" class="mt-0.5 shrink-0" />Confidential. Opening a document is recorded in the audit log.
    </p>
  `,
})
export class DocumentViewer implements OnDestroy {
  /** Reads the file (null: nothing to show). A new function is a new read. */
  readonly load = input<(() => Observable<Blob>) | null>(null);
  /** The stored, sniffed type (decides PDF frame, image or download only). */
  readonly mime = input('');
  /** The file name (shown, and used for Download). */
  readonly name = input('');
  readonly sizeBytes = input<number | null>(null);
  /** The image's text alternative (defaults to the file name). */
  readonly alt = input('');
  /** Said when the stored file can't be read (404). */
  readonly goneMessage = input('This document could not be read.');

  protected readonly objectUrl = signal<string | null>(null);
  protected readonly kind = signal<DocumentKind>('other');
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  /** The stored file can't be read (404) — retrying won't help. */
  protected readonly gone = signal(false);

  private readonly frame = viewChild<ElementRef<HTMLIFrameElement>>('frame');
  private readonly image = viewChild<ElementRef<HTMLImageElement>>('image');
  private sub?: Subscription;

  constructor() {
    effect(() => {
      const load = this.load();
      untracked(() => (load ? this.read(load) : this.release()));
    });
    // Our own blob URL goes onto the native element (typed from the allow-list above).
    effect(() => {
      const url = this.objectUrl();
      const frame = this.frame()?.nativeElement;
      const image = this.image()?.nativeElement;
      if (url && frame && frame.src !== url) frame.src = url;
      if (url && image && image.src !== url) image.src = url;
    });
  }

  ngOnDestroy(): void {
    this.release();
  }

  /** "Try again" after a failure that may pass. */
  reload(): void {
    const load = this.load();
    if (load) this.read(load);
  }

  private read(load: () => Observable<Blob>): void {
    this.release();
    this.loading.set(true);
    this.error.set('');
    this.gone.set(false);
    const kind = documentKind(this.mime());
    this.sub = load().subscribe({
      next: (blob) => {
        this.loading.set(false);
        const type = kind === 'other' ? 'application/octet-stream' : this.mime().toLowerCase();
        this.kind.set(kind);
        this.objectUrl.set(URL.createObjectURL(new Blob([blob], { type })));
      },
      error: (err: unknown) => {
        this.loading.set(false);
        // A blob request's JSON error body arrives as a Blob, so the API's own
        // message is lost: a 404 is the stored file that can't be read.
        const e = err as { statusCode?: number; status?: number } | null;
        if ((e?.statusCode ?? e?.status) === 404) {
          this.gone.set(true);
          this.error.set(this.goneMessage());
          return;
        }
        this.error.set(apiErrorMessage(err, 'Could not open this document. Please try again.'));
      },
    });
  }

  private release(): void {
    this.sub?.unsubscribe();
    this.sub = undefined;
    const url = this.objectUrl();
    if (url) URL.revokeObjectURL(url);
    this.objectUrl.set(null);
    this.loading.set(false);
  }

  protected size(bytes: number): string {
    return sizeText(bytes);
  }
}
