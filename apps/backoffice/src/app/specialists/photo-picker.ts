import { HttpEventType, type HttpEvent } from '@angular/common/http';
import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { apiErrorFields, apiErrorMessage } from '@supadoc/data-access';
import {
  SPECIALIST_PHOTO_ACCEPT,
  SPECIALIST_PHOTO_MAX_BYTES,
  type SpecialistPhotoResultDto,
  type SuccessResponse,
} from '@supadoc/models';
import { FileDropComponent, IconComponent, type FileDropRejection } from '@supadoc/ui';
import { SpecialistAvatar } from './specialist-avatar';

/** The API's own wording (422 `errors.photo`), so a refusal reads the same either side. */
export const PHOTO_TYPE_ERROR = 'Only JPG, PNG or WEBP images are allowed.';
export const PHOTO_SIZE_ERROR = 'Image must be 2MB or smaller.';

/** What one event of `SpecialistsApi.uploadPhoto()` means for the screen. */
export interface PhotoUploadStep {
  /** 0–100 while the file goes up (absent when the browser can't tell). */
  readonly progress?: number;
  /** The updated specialist, once the server has stored the photo. */
  readonly result?: SpecialistPhotoResultDto;
}

export function photoUploadStep(event: HttpEvent<SuccessResponse<SpecialistPhotoResultDto>>): PhotoUploadStep {
  if (event.type === HttpEventType.UploadProgress) {
    return event.total ? { progress: Math.min(100, Math.round((event.loaded / event.total) * 100)) } : {};
  }
  if (event.type === HttpEventType.Response && event.body?.data) {
    return { progress: 100, result: event.body.data };
  }
  return {};
}

/** Why an upload or removal failed, for the person: the photo field's own error first. */
export function photoErrorText(err: unknown, fallback = 'Could not upload the photo.'): string {
  return apiErrorFields(err)['photo'] ?? apiErrorFields(err)['photo_url'] ?? apiErrorMessage(err, fallback);
}

let nextId = 0;

/**
 * A doctor's headshot: the current photo (or initials), a drop zone that also
 * opens the file picker (Enter / Space), "Remove photo", progress while it
 * uploads, and why a file was refused. JPG, PNG or WebP up to 2 MB — checked
 * here first, and again from the bytes by the server.
 *
 * It only reports what the person did (`picked`, `remove`); the parent
 * uploads, confirms removal and passes `progress` / `error` back.
 *
 * `<bo-photo-picker [src]="previewUrl" [name]="name" [progress]="pct" [error]="err"
 *    (picked)="upload($event)" (remove)="askRemove()" />`
 */
@Component({
  selector: 'bo-photo-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, FileDropComponent, SpecialistAvatar],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-4 sm:flex-row sm:items-center">
      <div class="relative w-fit shrink-0">
        <bo-specialist-avatar [src]="src()" [name]="name()" size="xl" />
        @if (uploading()) {
          <span class="absolute inset-0 flex items-center justify-center rounded-full bg-white/70" aria-hidden="true">
            <sd-icon name="loader-circle" [size]="24" class="animate-spin text-cerulean" />
          </span>
        }
      </div>
      <div class="flex min-w-0 flex-1 flex-col gap-2">
        <sd-file-drop
          [compact]="true"
          [accept]="accept"
          [maxBytes]="maxBytes"
          [disabled]="disabled() || uploading()"
          [label]="src() ? replaceLabel() : addLabel()"
          (files)="take($event)"
          (rejected)="refuse($event)"
        />
        <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span [id]="hintId" class="font-sans text-caption text-slate">Drop an image here or choose one · JPG, PNG or WebP, up to 2 MB</span>
          @if (src() && removable()) {
            <button
              type="button"
              class="inline-flex min-h-11 items-center gap-1.5 rounded-field px-2 font-sans text-body-sm font-semibold text-alert transition-colors hover:bg-alert/5 disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-alert/40"
              [disabled]="disabled() || uploading()"
              (click)="remove.emit()"
            >
              <sd-icon name="trash-2" [size]="16" />{{ removeLabel() }}
            </button>
          }
        </div>
        @if (uploading()) {
          <div class="flex items-center gap-3">
            <div
              class="h-2 min-w-0 flex-1 overflow-hidden rounded-pill bg-glacier"
              role="progressbar"
              aria-label="Uploading the photo"
              aria-valuemin="0"
              aria-valuemax="100"
              [attr.aria-valuenow]="progress()"
            >
              <div class="h-full rounded-pill bg-cerulean transition-[width] duration-200" [style.width.%]="progress() ?? 0"></div>
            </div>
            <!-- The progressbar carries the value for screen readers. -->
            <span class="font-sans text-caption tabular-nums text-slate" aria-hidden="true">{{ progress() }}%</span>
          </div>
        }
        @if (shownError(); as e) {
          <p [id]="errorId" class="flex items-start gap-1.5 font-sans text-caption text-alert" role="alert">
            <sd-icon name="circle-alert" [size]="14" class="mt-0.5 shrink-0" />{{ e }}
          </p>
        }
      </div>
    </div>
  `,
})
export class PhotoPicker {
  /** What to show: the saved photo or the picked file's preview (absolute / blob URL), or null. */
  readonly src = input<string | null>(null);
  /** For the initials when there is no photo. */
  readonly name = input('');
  /** 0–100 while uploading; null when idle. */
  readonly progress = input<number | null>(null);
  /** The parent's error (an upload or removal the server refused). */
  readonly error = input('');
  readonly disabled = input(false);
  /** Show "Remove photo" while there is one. */
  readonly removable = input(true);
  readonly addLabel = input('Add a photo');
  readonly replaceLabel = input('Replace photo');
  readonly removeLabel = input('Remove photo');

  /** An acceptable image the person dropped or chose. */
  readonly picked = output<File>();
  /** "Remove photo" was pressed (the parent confirms). */
  readonly remove = output<void>();

  protected readonly accept = SPECIALIST_PHOTO_ACCEPT;
  protected readonly maxBytes = SPECIALIST_PHOTO_MAX_BYTES;
  private readonly uid = ++nextId;
  protected readonly hintId = `bo-photo-hint-${this.uid}`;
  protected readonly errorId = `bo-photo-err-${this.uid}`;

  /** Why the last dropped / chosen file was turned away before upload. */
  private readonly refused = signal('');

  protected readonly uploading = computed(() => this.progress() !== null);
  protected readonly shownError = computed(() => this.refused() || this.error());

  /** The drop zone's host: its button is what gets focus. */
  private readonly dropZone = viewChild.required(FileDropComponent, { read: ElementRef });

  constructor() {
    // sd-file-drop's button has no description of its own: point it at the
    // file-type / size hint (and the refusal, while one shows), so screen
    // readers hear the rule before choosing a file, not only after a refusal.
    afterRenderEffect(() => {
      const describedBy = this.shownError() ? `${this.hintId} ${this.errorId}` : this.hintId;
      (this.dropZone().nativeElement as HTMLElement).querySelector('button')?.setAttribute('aria-describedby', describedBy);
    });
  }

  protected take(files: File[]): void {
    const file = files[0];
    if (!file) return;
    this.refused.set('');
    this.picked.emit(file);
  }

  protected refuse(rejected: FileDropRejection[]): void {
    const first = rejected[0];
    if (!first) return;
    this.refused.set(first.reason === 'size' ? PHOTO_SIZE_ERROR : PHOTO_TYPE_ERROR);
  }

  /** Forget a local refusal (e.g. the parent started over). */
  reset(): void {
    this.refused.set('');
  }
}
