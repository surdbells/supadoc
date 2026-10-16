import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { IconComponent } from '../icon/icon';

/** Why a dropped or picked file was turned away by `sd-file-drop`. */
export type FileDropRejectReason = 'type' | 'size';

export interface FileDropRejection {
  readonly file: File;
  readonly reason: FileDropRejectReason;
}

/**
 * True when `file` satisfies an `<input accept>`-style list: `.ext` tokens match
 * the file name, `type/*` the MIME family, anything else the exact MIME type.
 * An empty list accepts everything. Dropped files skip the native picker's
 * filter, so this is what keeps a drop honest — the server still has the final
 * say on content.
 */
export function fileMatchesAccept(file: File, accept: string): boolean {
  const tokens = accept
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return true;
  const name = file.name.toLowerCase();
  const mime = (file.type || '').toLowerCase();
  return tokens.some((t) => {
    if (t.startsWith('.')) return name.endsWith(t);
    if (t.endsWith('/*')) return mime !== '' && mime.startsWith(t.slice(0, -1));
    return mime === t;
  });
}

/** True when the drag carries files (not text or a link dragged off the page). */
function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

/**
 * Dashed drop zone + click-to-browse picker. It is a real `<button>`, so it is
 * focusable and opens the file dialog with Enter / Space. Files that are
 * dropped or picked are filtered by `accept` and `maxBytes`: the ones that pass
 * are emitted from `files`, and the ones that don't are emitted from `rejected`
 * so the caller can explain why. With `multiple` off, only the first
 * acceptable file is kept.
 *
 * The highlight uses an enter/leave counter, because moving over the zone's own
 * children fires `dragleave` on the zone and would otherwise make it flicker.
 *
 * Usage:
 * `<sd-file-drop accept=".pdf,image/*" [multiple]="true" [maxBytes]="10485760"
 *    hint="PDF or image · up to 10MB" (files)="add($event)" (rejected)="explain($event)" />`
 */
@Component({
  selector: 'sd-file-drop',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    <button
      type="button"
      class="w-full rounded-card border-2 border-dashed text-center transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 focus-visible:ring-offset-2"
      [class]="zoneClass()"
      [attr.aria-disabled]="disabled() || null"
      (click)="browse()"
      (dragenter)="onDragEnter($event)"
      (dragover)="onDragOver($event)"
      (dragleave)="onDragLeave($event)"
      (drop)="onDrop($event)"
    >
      @if (compact()) {
        <sd-icon
          [name]="dragging() ? 'download' : 'plus'"
          [size]="18"
          class="shrink-0 text-cerulean"
        />
        <span
          class="min-w-0 font-sans text-body-sm font-semibold text-cerulean"
          >{{ dragging() ? 'Drop to add' : label() }}</span
        >
      } @else {
        <span
          class="flex size-12 items-center justify-center rounded-full bg-frost text-cerulean-dark"
        >
          <sd-icon [name]="dragging() ? 'download' : 'upload'" [size]="24" />
        </span>
        <!-- Touch screens can't drag files in, so the prompt is for mouse users only. -->
        <span
          class="font-sans text-body font-semibold text-ink pointer-coarse:hidden"
          >{{ dragging() ? 'Drop to add' : label() }}</span
        >
        <span
          class="rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white shadow-btn inset-shadow-rim"
          >{{ browseText() }}</span
        >
        @if (hint()) {
          <span class="font-sans text-caption text-slate">{{ hint() }}</span>
        }
      }
    </button>
    <input
      #inputEl
      type="file"
      class="hidden"
      [attr.accept]="accept() || null"
      [multiple]="multiple()"
      (change)="onPicked($event)"
    />
  `,
})
export class FileDropComponent {
  /** `<input accept>` syntax: `.pdf,.png,image/*,application/pdf`. Empty = anything. */
  readonly accept = input('');
  readonly multiple = input(false);
  /** Largest file accepted, in bytes. 0 = no client-side limit. */
  readonly maxBytes = input(0);
  readonly disabled = input(false);
  /** The drag prompt. In the full layout it is hidden on touch screens. */
  readonly label = input('Drag and drop files here');
  /** Supporting line under the button — formats and size limit. */
  readonly hint = input('');
  /** Text of the browse button; defaults to "Choose files" / "Choose a file". */
  readonly browseLabel = input('');
  /** A single slim row, for "add more" beneath an existing list. */
  readonly compact = input(false);

  /** The files that passed `accept` and `maxBytes` (never empty). */
  readonly files = output<File[]>();
  /** The files that didn't, with the reason (never empty). */
  readonly rejected = output<FileDropRejection[]>();

  protected readonly dragging = signal(false);
  private readonly inputEl =
    viewChild.required<ElementRef<HTMLInputElement>>('inputEl');
  /** dragenter minus dragleave, counted across the zone and its children. */
  private depth = 0;

  protected readonly browseText = computed(
    () =>
      this.browseLabel() ||
      (this.multiple() ? 'Choose files' : 'Choose a file'),
  );

  protected readonly zoneClass = computed(() => {
    const layout = this.compact()
      ? 'flex items-center justify-center gap-2 px-4 py-3'
      : 'flex flex-col items-center gap-3 px-6 py-8';
    const state = this.disabled()
      ? 'cursor-not-allowed border-cloud bg-glacier/40 opacity-60'
      : this.dragging()
        ? 'border-cerulean bg-frost/40'
        : 'border-[#b8c6d4] bg-glacier/40 hover:border-cerulean/60';
    return `${layout} ${state}`;
  });

  protected browse(): void {
    if (this.disabled()) return;
    this.inputEl().nativeElement.click();
  }

  protected onDragEnter(event: DragEvent): void {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    this.depth += 1;
    if (!this.disabled()) this.dragging.set(true);
  }

  protected onDragOver(event: DragEvent): void {
    if (!carriesFiles(event)) return;
    // Cancelling dragover is what makes this a drop target at all.
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = this.disabled() ? 'none' : 'copy';
    }
  }

  protected onDragLeave(event: DragEvent): void {
    if (!carriesFiles(event)) return;
    this.depth = Math.max(0, this.depth - 1);
    if (this.depth === 0) this.dragging.set(false);
  }

  protected onDrop(event: DragEvent): void {
    // Always swallow a drop that lands here, so the browser never navigates to
    // the file — even while disabled.
    event.preventDefault();
    event.stopPropagation();
    this.depth = 0;
    this.dragging.set(false);
    if (this.disabled()) return;
    this.take(Array.from(event.dataTransfer?.files ?? []));
  }

  protected onPicked(event: Event): void {
    const el = event.target as HTMLInputElement;
    const picked = Array.from(el.files ?? []);
    el.value = ''; // allow re-picking the same file
    this.take(picked);
  }

  private take(list: File[]): void {
    if (list.length === 0) return;
    const accepted: File[] = [];
    const rejected: FileDropRejection[] = [];
    const max = this.maxBytes();
    for (const file of list) {
      if (!fileMatchesAccept(file, this.accept())) {
        rejected.push({ file, reason: 'type' });
      } else if (max > 0 && file.size > max) {
        rejected.push({ file, reason: 'size' });
      } else {
        accepted.push(file);
      }
    }
    const kept = this.multiple() ? accepted : accepted.slice(0, 1);
    if (kept.length > 0) this.files.emit(kept);
    if (rejected.length > 0) this.rejected.emit(rejected);
  }
}
