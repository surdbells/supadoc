import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { APPLICATION_MAX_UPLOAD_BYTES, APPLICATION_UPLOAD_ACCEPT, type ApplicationDocumentDto } from '@supadoc/models';
import { fileMatchesAccept, IconComponent } from '@supadoc/ui';
import { formatBytes } from '../core/format';

export const UPLOAD_HINT = 'PDF, PNG or JPG, up to 5MB';
export const FILE_TYPE_ERROR = 'File must be PDF, PNG or JPG.';
export const FILE_SIZE_ERROR = 'File must be 5MB or smaller.';

let nextId = 0;

/** Why a picked file is refused before upload, or null if it may go. */
export function fileProblem(file: File): string | null {
  if (!fileMatchesAccept(file, APPLICATION_UPLOAD_ACCEPT)) return FILE_TYPE_ERROR;
  if (file.size > APPLICATION_MAX_UPLOAD_BYTES) return FILE_SIZE_ERROR;
  return null;
}

/**
 * One document slot (Figma upload block): title (14 Medium Ink, `*`), helper,
 * then either the drop zone (Snow fill, Haze hairline: "Click to upload or drag
 * and drop", "PDF, PNG or JPG, up to 5MB") or the uploaded row (Sage/10 fill,
 * Sage border, file disc, name, "{size} · Uploaded", Replace, trash). While a
 * file uploads a progress bar shows; refused files and failures show an alert
 * line. When an upload finishes, focus moves to the file name.
 *
 * It only checks type and size; the page uploads on `pick` and sets
 * `document`, `progress` and `error`.
 */
@Component({
  selector: 'onb-file-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'flex min-w-0 flex-col' },
  template: `
    <!-- prettier-ignore -->
    <p [id]="titleId" class="font-sans text-body-sm font-medium text-ink">{{ label() }}@if (required()) {<span class="ml-1 inline-block -translate-y-0.5 text-alert" aria-hidden="true">*</span><span class="sr-only"> (required)</span>}</p>
    @if (hint()) {
      <p class="mt-1 font-sans text-caption text-slate">{{ hint() }}</p>
    }
    <input
      #picker
      type="file"
      class="hidden"
      tabindex="-1"
      aria-hidden="true"
      [accept]="accept"
      (change)="onPicked($event)"
    />
    <div class="mt-3">
      @if (document(); as doc) {
        <div
          class="flex min-h-[72px] items-center gap-4 rounded-field border border-sage bg-sage/10 px-4 py-3 sm:px-6"
        >
          <span class="inline-flex size-12 shrink-0 items-center justify-center rounded-full bg-white text-slate" aria-hidden="true">
            <sd-icon name="file" [size]="24" [strokeWidth]="1.5" />
          </span>
          <span class="flex min-w-0 flex-1 flex-col">
            <button
              #name
              type="button"
              [id]="inputId()"
              class="truncate rounded text-left font-sans text-body text-ink underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
              [attr.aria-label]="'View ' + doc.original_name"
              (click)="view.emit()"
            >
              {{ doc.original_name }}
            </button>
            <span class="font-sans text-caption text-slate">{{ size(doc) }} · Uploaded</span>
          </span>
          @if (!readonly()) {
            <button
              type="button"
              class="inline-flex h-10 shrink-0 items-center rounded-lg px-1 font-sans text-body-sm font-medium text-cerulean hover:text-cerulean-dark focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 disabled:opacity-60"
              [attr.aria-label]="'Replace ' + label()"
              [disabled]="busy()"
              (click)="browse()"
            >
              Replace
            </button>
            @if (removable()) {
              <button
                type="button"
                class="inline-flex size-10 shrink-0 items-center justify-center rounded-full text-alert hover:bg-alert/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-alert/40 disabled:opacity-60"
                [attr.aria-label]="'Remove ' + label()"
                [disabled]="busy()"
                (click)="remove.emit()"
              >
                <sd-icon name="trash-2" [size]="20" [strokeWidth]="1.5" />
              </button>
            }
          }
        </div>
      } @else {
        <button
          type="button"
          [id]="inputId()"
          [class]="zoneClass()"
          [attr.aria-label]="'Upload ' + label() + '. ' + uploadHint"
          [attr.aria-describedby]="shownError() ? errorId : null"
          [attr.aria-disabled]="readonly() || busy() || null"
          (click)="browse()"
          (dragenter)="onDragEnter($event)"
          (dragover)="onDragOver($event)"
          (dragleave)="onDragLeave($event)"
          (drop)="onDrop($event)"
        >
          <sd-icon name="upload" [size]="20" [strokeWidth]="1.5" class="text-slate" />
          <span class="mt-2.5 font-sans text-body-sm text-slate">
            <span class="font-semibold text-cerulean">Click to upload</span> or drag and drop
          </span>
          <span class="mt-1 font-sans text-caption text-slate">{{ uploadHint }}</span>
        </button>
      }
      @if (progress() !== null) {
        <div
          class="mt-2 h-1.5 overflow-hidden rounded-full bg-frost"
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax="100"
          [attr.aria-valuenow]="progress()"
          [attr.aria-label]="'Uploading ' + label()"
        >
          <div class="h-full rounded-full bg-cerulean transition-[width]" [style.width.%]="progress()"></div>
        </div>
      }
      @if (shownError()) {
        <p [id]="errorId" role="alert" class="mt-1 font-label text-caption text-alert">{{ shownError() }}</p>
      }
      @if (readonly() && !document()) {
        <p class="mt-1 font-label text-caption text-slate">Not requested.</p>
      }
    </div>
  `,
})
export class FileFieldComponent {
  private readonly injector = inject(Injector);

  readonly label = input.required<string>();
  /** Id of the drop zone (or, once uploaded, the file name button): focus target for errors. */
  readonly inputId = input<string | null>(null);
  readonly hint = input<string | null>(null);
  readonly required = input(false);
  readonly document = input<ApplicationDocumentDto | null>(null);
  /** 0–100 while uploading, else null. */
  readonly progress = input<number | null>(null);
  /** An upload / server error from the page. */
  readonly error = input<string | null>(null);
  /** Read-only (info mode, not in the open request). */
  readonly readonly = input(false);
  /** False hides the trash button. */
  readonly removable = input(true);
  /** Taller zone (116px) when the format line wraps in a two-column grid. */
  readonly compact = input(false);

  readonly pick = output<File>();
  readonly remove = output<void>();
  readonly view = output<void>();

  protected readonly accept = APPLICATION_UPLOAD_ACCEPT;
  protected readonly uploadHint = UPLOAD_HINT;
  protected readonly titleId = `onb-file-${++nextId}`;
  protected readonly errorId = `${this.titleId}-error`;
  private readonly localError = signal<string | null>(null);
  private readonly dragging = signal(false);
  private dragDepth = 0;

  protected readonly busy = computed(() => this.progress() !== null);
  protected readonly shownError = computed(() => this.localError() ?? this.error());
  protected readonly zoneClass = computed(() => {
    const base =
      'flex w-full flex-col items-center justify-center rounded-field border px-4 py-3 text-center transition-colors ' +
      'focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 focus-visible:ring-offset-2 ' +
      (this.compact() ? 'min-h-[116px] ' : 'min-h-[98px] ');
    if (this.readonly()) return `${base} cursor-not-allowed border-haze bg-snow opacity-60`;
    if (this.dragging()) return `${base} border-cerulean bg-cerulean/10`;
    if (this.shownError()) return `${base} border-alert bg-snow`;
    return `${base} border-haze bg-snow hover:border-cerulean/40`;
  });

  private readonly picker = viewChild.required<ElementRef<HTMLInputElement>>('picker');
  private readonly nameButton = viewChild<ElementRef<HTMLButtonElement>>('name');

  constructor() {
    // An upload just finished (a new document id): put focus on its name.
    let lastId: string | null | undefined;
    effect(() => {
      const id = this.document()?.id ?? null;
      untracked(() => {
        if (lastId !== undefined && id && id !== lastId) {
          afterNextRender(() => this.nameButton()?.nativeElement.focus(), { injector: this.injector });
        }
        lastId = id;
      });
    });
  }

  protected size(doc: ApplicationDocumentDto): string {
    return formatBytes(doc.size_bytes);
  }

  browse(): void {
    if (this.readonly() || this.busy()) return;
    const el = this.picker().nativeElement;
    el.value = '';
    el.click();
  }

  protected onPicked(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) this.take(file);
  }

  protected onDragEnter(event: DragEvent): void {
    if (!this.carriesFiles(event) || this.readonly()) return;
    event.preventDefault();
    this.dragDepth++;
    this.dragging.set(true);
  }

  protected onDragOver(event: DragEvent): void {
    if (!this.carriesFiles(event) || this.readonly()) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  }

  protected onDragLeave(event: DragEvent): void {
    if (!this.carriesFiles(event)) return;
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) this.dragging.set(false);
  }

  protected onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragDepth = 0;
    this.dragging.set(false);
    if (this.readonly() || this.busy()) return;
    const file = event.dataTransfer?.files?.[0];
    if (file) this.take(file);
  }

  /** Checks type and size, then hands the file to the page. */
  take(file: File): void {
    const problem = fileProblem(file);
    this.localError.set(problem);
    if (!problem) this.pick.emit(file);
  }

  private carriesFiles(event: DragEvent): boolean {
    return Array.from(event.dataTransfer?.types ?? []).includes('Files');
  }
}
