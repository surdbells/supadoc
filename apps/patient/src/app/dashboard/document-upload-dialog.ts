import { DOCUMENT, NgTemplateOutlet } from '@angular/common';
import { HttpEventType } from '@angular/common/http';
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
  OnInit,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { apiErrorMessage, DocumentsApi, DocumentSharingApi } from '@supadoc/data-access';
import type {
  DocumentShareDuration,
  DocumentTypeOption,
  SharingAppointmentRefDto,
  SharingDoctorDto,
  UploadedDocumentDto,
  UploadShareOptions,
} from '@supadoc/models';
import {
  type ConfirmOptions,
  DialogComponent,
  DialogService,
  FileDropComponent,
  IconComponent,
  type FileDropRejection,
  type LeaveCopy,
  warnBeforeUnload,
} from '@supadoc/ui';
import {
  defaultDuration,
  defaultFolderTicks,
  drName,
  durationChoices,
  durationError,
  folderUntil,
  holdsFolder,
  holdsPausedFolder,
  initials,
  isSharingUnavailable,
  MAX_SHARE_DOCTORS,
  newKey,
  uploadOutcomeLines,
  uploadShareOptions,
  untilDateBounds,
} from './document-sharing';

export type UploadStep = '' | 'source' | 'queue' | 'share' | 'uploading' | 'success';
type UploadStatus = 'queued' | 'uploading' | 'done' | 'failed';

/** One file in an upload batch: its own type, progress and outcome. */
interface QueueItem {
  /** Local key for `@for` tracking (files have no id until uploaded). */
  readonly key: number;
  readonly file: File;
  readonly type: string;
  readonly custom: string;
  readonly status: UploadStatus;
  readonly progress: number;
  /** The API's message when the upload failed. */
  readonly error: string;
  readonly result: UploadedDocumentDto | null;
}

/** A file that never made it into the queue, and why. */
interface SkippedFile {
  readonly name: string;
  readonly reason: string;
}

/** Every upload status reads as an icon AND a word — never colour alone. */
const UPLOAD_STATUS: Record<UploadStatus, { label: string; icon: string; cls: string }> = {
  queued: { label: 'Waiting', icon: 'clock', cls: 'bg-cloud text-slate' },
  uploading: { label: 'Uploading', icon: 'loader-circle', cls: 'bg-frost text-cerulean-dark' },
  done: { label: 'Uploaded', icon: 'circle-check', cls: 'bg-sage/15 text-sage-ink' },
  failed: { label: 'Failed', icon: 'circle-x', cls: 'bg-alert/10 text-alert-ink' },
};

/** Accepted client-side (mirrors MedicalDocumentStorage on the server). */
const ACCEPT =
  '.pdf,.jpg,.jpeg,.png,.dcm,.docx,.doc,.mp4,.webm,.mov,application/pdf,image/jpeg,image/png,video/mp4,video/webm,video/quicktime';
const ALLOWED_EXT = ['pdf', 'jpg', 'jpeg', 'png', 'dcm', 'docx', 'doc', 'mp4', 'webm', 'mov'];
const MAX_BYTES = 10 * 1024 * 1024;
const TOO_BIG = 'File must be 10MB or smaller.';
const UNSUPPORTED = 'Unsupported file type. Use PDF, JPG, PNG, DOCX, DICOM or video.';
/** Files per batch — each is its own request, so keep a batch reviewable. */
const MAX_FILES = 20;
/** Length of medical_documents.custom_type. */
const CUSTOM_TYPE_MAX = 120;

/**
 * The medical-document upload flow (drop or pick files → a type per file →
 * **who can see them** → one request per file, in turn, with progress and
 * retry → what happened). Used by Medical Documents and by an appointment's
 * "Upload and share" (doctor preset and locked, "after the consultation" ends
 * offered). Nothing is shared silently: the patient chooses on the "Who can
 * see these files?" step, and doctors who can see the whole folder are listed
 * with "Also let Dr X see these files".
 */
@Component({
  selector: 'pat-document-upload-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DialogComponent, FileDropComponent, IconComponent, NgTemplateOutlet],
  template: `
    <!-- Files a drop or pick turned away (accumulates until dismissed) -->
    <ng-template #skippedNote>
      @if (skipped().length > 0) {
        <div class="flex flex-col gap-2 rounded-field bg-alert/10 px-4 py-3 font-sans text-body-sm text-alert-ink" role="alert">
          <div class="flex items-start justify-between gap-3">
            <span class="flex items-start gap-2 font-semibold">
              <sd-icon name="triangle-alert" [size]="18" class="mt-0.5 shrink-0" />{{ skipped().length === 1 ? '1 file wasn’t added' : skipped().length + ' files weren’t added' }}
            </span>
            <button type="button" class="inline-flex size-11 shrink-0 items-center justify-center transition-colors hover:text-ink" aria-label="Dismiss" (click)="dismissSkipped()"><sd-icon name="x" [size]="18" /></button>
          </div>
          <ul class="flex flex-col gap-1 pl-[26px] font-sans text-caption">
            @for (s of skipped(); track $index) {
              <li class="wrap-anywhere"><span class="font-semibold">{{ s.name }}</span> — {{ s.reason }}</li>
            }
          </ul>
        </div>
      }
    </ng-template>

    <!-- The shared dialog: top layer, Esc, scroll lock, focus back to the opener -->
    <sd-dialog
      [open]="open()"
      layout="plain"
      size="md"
      labelledBy="doc-upload-title"
      [busy]="running()"
      (closed)="requestClose()"
      (afterClose)="afterClosed()"
    >
      <div #dialogBody class="flex flex-col gap-6 p-5 sm:p-6">
        <!-- Batch progress and outcome, announced to screen readers -->
        <p class="sr-only" aria-live="polite" aria-atomic="true">{{ liveStatus() }}</p>

        @switch (step()) {
          @case ('source') {
            <div class="flex items-start justify-between gap-3 border-b border-cloud pb-4">
              <div class="flex flex-col gap-1">
                <h3 #stepTitle id="doc-upload-title" tabindex="-1" data-autofocus class="font-heading text-h5 text-ink outline-none">Upload Documents</h3>
                <p class="font-sans text-body-sm text-slate">Add one or more files to your medical records</p>
              </div>
              <button type="button" class="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-slate transition-colors hover:text-ink" aria-label="Close" (click)="requestClose()"><sd-icon name="x" [size]="22" /></button>
            </div>
            <sd-file-drop
              [accept]="accept"
              [multiple]="true"
              [maxBytes]="maxBytes"
              [hint]="'Up to ' + maxFiles + ' files at a time'"
              (files)="addFiles($event)"
              (rejected)="onRejected($event)"
            />
            <div class="rounded-card bg-frost/50 p-4 font-sans text-body-sm text-slate">
              <p><span class="font-semibold text-ink">Supported Size:</span> Maximum of 10mb per file</p>
              <p class="mt-1"><span class="font-semibold text-ink">Supported format:</span> DICOM (.dcm), PDF, JPG, PNG, DOCX, or video</p>
            </div>
            <ng-container [ngTemplateOutlet]="skippedNote" />
            <div class="flex gap-3">
              <button type="button" class="min-h-11 flex-1 rounded-field border border-cloud py-3 font-sans text-body font-semibold text-slate transition-colors hover:bg-glacier" (click)="requestClose()">Cancel</button>
            </div>
          }

          @case ('queue') {
            <div class="flex items-start justify-between gap-3 border-b border-cloud pb-4">
              <div class="flex flex-col gap-1">
                <h3 #stepTitle id="doc-upload-title" tabindex="-1" data-autofocus class="font-heading text-h5 text-ink outline-none">Document Type</h3>
                <p class="font-sans text-body-sm text-slate">Select the type of each document</p>
              </div>
              <button type="button" class="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-slate transition-colors hover:text-ink" aria-label="Close" (click)="requestClose()"><sd-icon name="x" [size]="22" /></button>
            </div>
            <ul class="flex flex-col gap-3" aria-label="Documents to upload">
              @for (item of queue(); track item.key) {
                <li class="flex flex-col gap-3 rounded-card border border-cloud p-3 sm:p-4">
                  <div class="flex items-center gap-3">
                    <span class="flex size-10 shrink-0 items-center justify-center rounded-full bg-glacier text-slate"><sd-icon name="file-text" [size]="18" /></span>
                    <span class="flex min-w-0 flex-1 flex-col">
                      <span class="truncate font-sans text-body-sm font-semibold text-ink" [title]="item.file.name">{{ item.file.name }}</span>
                      <span class="font-sans text-caption text-slate">{{ sizeLabel(item.file.size) }}</span>
                    </span>
                    <button type="button" class="inline-flex size-11 shrink-0 items-center justify-center rounded-field text-slate transition-colors hover:text-alert" [attr.aria-label]="'Remove ' + item.file.name" (click)="removeItem(item.key)">
                      <sd-icon name="trash-2" [size]="18" />
                    </button>
                  </div>
                  <label class="relative block">
                    <span class="sr-only">Document type for {{ item.file.name }}</span>
                    <select class="w-full appearance-none rounded-field border border-cloud bg-white px-4 py-3 pr-10 font-sans text-body-sm text-ink outline-none focus:border-cerulean" (change)="setType(item.key, $any($event.target).value)">
                      <option value="" [selected]="item.type === ''">Select document type</option>
                      @for (t of types(); track t.value) { <option [value]="t.value" [selected]="t.value === item.type">{{ t.label }}</option> }
                    </select>
                    <sd-icon name="chevron-down" [size]="18" class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate" />
                  </label>
                  @if (item.type === 'other') {
                    <label class="flex flex-col gap-1.5">
                      <span class="font-sans text-caption text-slate">Others (Specify)<span class="sr-only"> for {{ item.file.name }}</span></span>
                      <input
                        class="rounded-field border border-cloud px-4 py-3 font-sans text-body-sm text-ink outline-none focus:border-cerulean"
                        placeholder="Enter document type"
                        [attr.maxlength]="customMax"
                        [value]="item.custom"
                        (input)="setCustom(item.key, $any($event.target).value)"
                      />
                    </label>
                  }
                  @if (canApplyToAll(item)) {
                    <button type="button" class="flex w-fit items-center gap-1.5 font-sans text-caption font-semibold text-cerulean transition-colors hover:text-ocean" (click)="applyToAll(item.key)">
                      <sd-icon name="copy" [size]="14" />Apply this type to all
                    </button>
                  }
                </li>
              }
            </ul>
            @if (queue().length < maxFiles) {
              <sd-file-drop
                [compact]="true"
                label="Add more files"
                [accept]="accept"
                [multiple]="true"
                [maxBytes]="maxBytes"
                (files)="addFiles($event)"
                (rejected)="onRejected($event)"
              />
            }
            @if (typesError()) { <p class="font-sans text-caption text-alert-ink">{{ typesError() }}</p> }
            <ng-container [ngTemplateOutlet]="skippedNote" />
            @if (missingTypes() > 0) {
              <p class="font-sans text-caption text-slate">
                {{ missingTypes() === 1 ? 'Choose a type for 1 more document to continue.' : 'Choose a type for ' + missingTypes() + ' more documents to continue.' }}
              </p>
            }
            <div class="flex gap-3">
              <button type="button" class="min-h-11 flex-1 rounded-field border border-cloud py-3 font-sans text-body font-semibold text-slate transition-colors hover:bg-glacier" (click)="requestClose()">Cancel</button>
              <button type="button" class="min-h-11 flex-1 rounded-field bg-cerulean py-3 font-sans text-body font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-50" [disabled]="!typesDone()" (click)="toShare()">
                Continue
              </button>
            </div>
          }

          @case ('share') {
            <div class="flex items-start justify-between gap-3 border-b border-cloud pb-4">
              <div class="flex flex-col gap-1">
                <h3 #stepTitle id="doc-upload-title" tabindex="-1" data-autofocus class="font-heading text-h5 text-ink outline-none">Who can see these files?</h3>
                <p class="font-sans text-body-sm text-slate">Only doctors you choose can see them.</p>
              </div>
              <button type="button" class="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-slate transition-colors hover:text-ink" aria-label="Close" (click)="requestClose()"><sd-icon name="x" [size]="22" /></button>
            </div>

            @if (doctorsLoading()) {
              @for (i of [1, 2]; track i) { <div class="sd-shimmer h-16 rounded-card"></div> }
            } @else if (doctorsError()) {
              <p class="flex items-start gap-2 rounded-field bg-alert/10 px-4 py-3 font-sans text-body-sm text-alert-ink" role="alert">
                <sd-icon name="triangle-alert" [size]="18" class="mt-0.5 shrink-0" />{{ doctorsError() }}
              </p>
              <button type="button" class="min-h-11 w-fit rounded-field border border-haze bg-white px-5 font-sans text-body-sm font-semibold text-cerulean shadow-control transition hover:border-cerulean" (click)="loadDoctors()">Try again</button>
            } @else if (sharingOff()) {
              <p class="flex items-start gap-2 rounded-field bg-glacier px-4 py-3 font-sans text-body-sm text-slate" role="status">
                <sd-icon name="lock" [size]="18" class="mt-0.5 shrink-0" />Sharing is unavailable right now. Your documents stay private.
              </p>
            } @else if (doctors().length === 0) {
              <p class="flex items-start gap-2 rounded-field bg-glacier px-4 py-3 font-sans text-body-sm text-slate">
                <sd-icon name="lock" [size]="18" class="mt-0.5 shrink-0" />You haven't booked a doctor yet, so these files will be private.
              </p>
            } @else {
              <fieldset class="flex flex-col gap-3">
                <legend class="sr-only">Who can see these files?</legend>
                <label class="flex min-h-11 cursor-pointer items-start gap-3 rounded-card border-2 p-4 transition-colors" [class]="mode() === 'private' ? on : off">
                  <input type="radio" name="upload-share-mode" value="private" class="mt-1 size-5 shrink-0 accent-cerulean" [checked]="mode() === 'private'" (change)="mode.set('private')" />
                  <span class="flex flex-col gap-0.5">
                    <span class="font-sans text-body-sm font-semibold text-ink">{{ anyFolder() ? "Don't share with anyone new" : 'Keep private' }}</span>
                    <span class="font-sans text-caption text-slate">{{ anyFolder() ? 'Doctors who can see your whole folder are listed below.' : 'Only you can see them. You can share later.' }}</span>
                  </span>
                </label>
                <label class="flex min-h-11 cursor-pointer items-start gap-3 rounded-card border-2 p-4 transition-colors" [class]="mode() === 'share' ? on : off">
                  <input type="radio" name="upload-share-mode" value="share" class="mt-1 size-5 shrink-0 accent-cerulean" [checked]="mode() === 'share'" (change)="mode.set('share')" />
                  <span class="flex flex-col gap-0.5">
                    <span class="font-sans text-body-sm font-semibold text-ink">Share with doctors</span>
                    <span class="font-sans text-caption text-slate">Choose who and for how long.</span>
                  </span>
                </label>
              </fieldset>

              @if (mode() === 'share') {
                <fieldset class="flex flex-col gap-2">
                  <legend class="mb-2 font-sans text-body-sm font-semibold text-ink">Who can see them?</legend>
                  @for (d of shareable(); track d.specialist.id) {
                    <label class="flex min-h-11 items-center gap-3 rounded-card border-2 p-3 transition-colors has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-70" [class]="(chosen().includes(d.specialist.id) ? on : off) + (lockDoctor() || !d.can_share ? '' : ' cursor-pointer')">
                      <input type="checkbox" class="size-5 shrink-0 accent-cerulean" [checked]="chosen().includes(d.specialist.id)" [disabled]="lockDoctor() || !d.can_share || (!chosen().includes(d.specialist.id) && chosen().length >= maxDoctors)" (change)="toggleDoctor(d.specialist.id, $any($event.target).checked)" />
                      <span class="flex size-9 shrink-0 items-center justify-center rounded-full bg-frost font-sans text-caption font-semibold text-cerulean-dark" aria-hidden="true">{{ initialsOf(d.specialist.name) }}</span>
                      <span class="flex min-w-0 flex-col">
                        <span class="font-sans text-body-sm font-semibold text-ink">{{ dr(d.specialist.name) }}</span>
                        @if (d.specialist.specialty) { <span class="font-sans text-caption text-slate">{{ d.specialist.specialty }}</span> }
                        @if (!d.can_share) { <span class="font-sans text-caption text-slate">Not available — not practising on VideoMed right now</span> }
                      </span>
                    </label>
                  }
                  @if (chosen().length >= maxDoctors) {
                    <p class="font-sans text-caption text-slate">You can share with up to 5 doctors at a time.</p>
                  }
                </fieldset>
                <fieldset class="flex flex-col gap-2">
                  <legend class="mb-2 font-sans text-body-sm font-semibold text-ink">For how long?</legend>
                  @for (c of choices(); track c.value) {
                    <label class="flex min-h-11 cursor-pointer items-start gap-3 rounded-card border-2 px-4 py-3 transition-colors" [class]="duration() === c.value ? on : off">
                      <input type="radio" name="upload-share-duration" class="mt-1 size-5 shrink-0 accent-cerulean" [checked]="duration() === c.value" (change)="duration.set(c.value)" />
                      <span class="flex flex-col gap-0.5">
                        <span class="font-sans text-body-sm font-semibold text-ink">{{ c.label }}</span>
                        @if (c.hint) { <span class="font-sans text-caption text-slate">{{ c.hint }}</span> }
                      </span>
                    </label>
                  }
                  @if (duration() === 'until') {
                    <label class="flex flex-col gap-1.5">
                      <span class="font-sans text-caption font-semibold text-ink">End date</span>
                      <input type="date" class="min-h-11 rounded-field border border-cloud bg-white px-4 font-sans text-body-sm text-ink outline-none focus:border-cerulean" [min]="bounds.min" [max]="bounds.max" [value]="untilDate()" (input)="untilDate.set($any($event.target).value)" />
                    </label>
                  }
                </fieldset>
              }

              @if (folderDoctors().length > 0) {
                <fieldset class="flex flex-col gap-2">
                  <legend class="mb-2 font-sans text-body-sm font-semibold text-ink">Doctors who can see your whole folder</legend>
                  @for (d of folderDoctors(); track d.specialist.id) {
                    <label class="flex min-h-11 cursor-pointer items-start gap-3 rounded-card border border-cloud p-3">
                      <input type="checkbox" class="mt-0.5 size-5 shrink-0 accent-cerulean" [checked]="!!ticks()[d.specialist.id]" (change)="tick(d.specialist.id, $any($event.target).checked)" />
                      <span class="flex flex-col gap-0.5">
                        <span class="font-sans text-body-sm font-semibold text-ink">Also let {{ dr(d.specialist.name) }} see these files</span>
                        <span class="font-sans text-caption text-slate">Whole folder {{ folderUntilOf(d) }}</span>
                        @if (paused(d)) {
                          <!-- Paused shares resume (new files too) if the doctor is back within 30 days: opt in only. -->
                          <span class="inline-flex w-fit items-center gap-1 rounded-pill bg-warning/15 px-2.5 py-0.5 font-sans text-caption font-medium text-warning-ink inset-ring inset-ring-current/20">
                            <sd-icon name="hourglass" [size]="12" />Paused — not practising on VideoMed right now
                          </span>
                        }
                      </span>
                    </label>
                  }
                </fieldset>
              }

              @if (shareProblem() && triedUpload()) {
                <p class="font-sans text-caption text-alert-ink" role="alert">{{ shareProblem() }}</p>
              }
            }

            <div class="flex gap-3">
              <button type="button" class="min-h-11 flex-1 rounded-field border border-cloud py-3 font-sans text-body font-semibold text-slate transition-colors hover:bg-glacier" (click)="backToQueue()">Back</button>
              <button type="button" class="min-h-11 flex-1 rounded-field bg-cerulean py-3 font-sans text-body font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-50" [disabled]="doctorsLoading() || !!doctorsError()" (click)="startBatch()">
                Upload {{ queue().length }} {{ queue().length === 1 ? 'file' : 'files' }}
              </button>
            </div>
          }

          @case ('uploading') {
            <div class="flex flex-col gap-1 border-b border-cloud pb-4">
              <h3 #stepTitle id="doc-upload-title" tabindex="-1" data-autofocus class="font-heading text-h5 text-ink outline-none">{{ running() ? 'Uploading' : 'Some uploads failed' }}</h3>
              <p class="font-sans text-body-sm text-slate">{{ doneItems().length }} of {{ queue().length }} uploaded</p>
            </div>
            <ul class="flex flex-col gap-3" aria-label="Upload progress">
              @for (item of queue(); track item.key) {
                <li class="flex flex-col gap-2 rounded-card border border-cloud p-3 sm:p-4">
                  <div class="flex items-center gap-3">
                    <span class="flex size-10 shrink-0 items-center justify-center rounded-full bg-glacier text-slate"><sd-icon name="file-text" [size]="18" /></span>
                    <span class="flex min-w-0 flex-1 flex-col">
                      <span class="truncate font-sans text-body-sm font-semibold text-ink" [title]="item.file.name">{{ item.file.name }}</span>
                      <span class="truncate font-sans text-caption text-slate">{{ sizeLabel(item.file.size) }} · {{ typeLabel(item) }}</span>
                    </span>
                    <span class="inline-flex shrink-0 items-center gap-1 rounded-pill px-2.5 py-0.5 font-sans text-caption font-medium inset-ring inset-ring-current/20" [class]="uploadStatus(item.status).cls">
                      <sd-icon [name]="uploadStatus(item.status).icon" [size]="12" [class.animate-spin]="item.status === 'uploading'" />{{ item.status === 'uploading' ? item.progress + '%' : uploadStatus(item.status).label }}
                    </span>
                  </div>
                  @if (item.status === 'uploading') {
                    <div
                      class="h-1.5 w-full overflow-hidden rounded-full bg-frost"
                      role="progressbar"
                      aria-valuemin="0"
                      aria-valuemax="100"
                      [attr.aria-valuenow]="item.progress"
                      [attr.aria-label]="'Uploading ' + item.file.name"
                    >
                      <div class="h-full rounded-full bg-cerulean transition-[width] duration-200" [style.width.%]="item.progress"></div>
                    </div>
                  }
                  @if (item.status === 'failed') {
                    <div class="flex items-start justify-between gap-3">
                      <p class="flex min-w-0 items-start gap-1.5 font-sans text-caption text-alert-ink">
                        <sd-icon name="triangle-alert" [size]="14" class="mt-0.5 shrink-0" /><span class="min-w-0 wrap-anywhere">{{ item.error }}</span>
                      </p>
                      <button type="button" class="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-field border border-cloud px-3 font-sans text-caption font-semibold text-cerulean transition-colors hover:border-cerulean" [attr.aria-label]="'Retry ' + item.file.name" (click)="retry(item.key)">
                        <sd-icon name="refresh-cw" [size]="14" />Retry
                      </button>
                    </div>
                  }
                </li>
              }
            </ul>
            @if (!running()) {
              <div class="flex gap-3">
                <button type="button" class="min-h-11 flex-1 rounded-field border border-cloud py-3 font-sans text-body font-semibold text-slate transition-colors hover:bg-glacier" (click)="finishWithFailures()">
                  {{ doneItems().length > 0 ? 'Done' : 'Close' }}
                </button>
                <button type="button" class="min-h-11 flex-1 rounded-field bg-cerulean py-3 font-sans text-body font-semibold text-white transition-colors hover:bg-ocean" (click)="retryFailed()">
                  {{ failedCount() === 1 ? 'Retry' : 'Retry all' }}
                </button>
              </div>
            }
          }

          @case ('success') {
            <div class="flex flex-col items-center gap-4 py-4 text-center">
              <span class="flex size-16 items-center justify-center rounded-full bg-sage text-white"><sd-icon name="check" [size]="34" /></span>
              <div class="flex flex-col gap-1">
                <h3 #stepTitle id="doc-upload-title" tabindex="-1" data-autofocus class="font-heading text-h4 text-ink outline-none">{{ uploadedSummary() }}</h3>
                <p class="font-sans text-body text-slate">{{ doneItems().length === 1 ? 'Your document has' : 'Your documents have' }} been successfully added to your medical records.</p>
              </div>
              <ul class="flex w-full flex-col gap-2 text-left" aria-label="Who can see them">
                @for (line of outcomeLines(); track $index) {
                  <li class="flex items-start gap-2 rounded-field bg-glacier px-4 py-3 font-sans text-body-sm text-ink">
                    <sd-icon [name]="line.startsWith('Kept private') || line.startsWith('Saved') ? 'lock' : 'share-2'" [size]="18" class="mt-0.5 shrink-0 text-slate" />{{ line }}
                  </li>
                }
              </ul>
              @if (failedCount() > 0) {
                <p class="flex w-full items-start gap-2 rounded-field bg-warning/15 px-4 py-3 text-left font-sans text-body-sm text-warning-ink">
                  <sd-icon name="triangle-alert" [size]="18" class="mt-0.5 shrink-0" />
                  <span>{{ failedCount() === 1 ? '1 document wasn’t uploaded.' : failedCount() + ' documents weren’t uploaded.' }} You can try again with Upload Document.</span>
                </p>
              }
              <ul class="flex w-full flex-col gap-2 text-left">
                @for (item of doneItems(); track item.key) {
                  <li class="flex items-center gap-4 rounded-card border border-cloud p-4">
                    <span class="flex size-11 shrink-0 items-center justify-center rounded-full bg-glacier text-slate"><sd-icon name="file-text" [size]="20" /></span>
                    <span class="flex min-w-0 flex-col">
                      <span class="truncate font-sans text-body-sm font-semibold text-ink">
                        {{ item.result?.title || item.file.name }}
                        <span class="font-normal text-slate">({{ item.result ? item.result.extension + '. ' + item.result.size_label : sizeLabel(item.file.size) }})</span>
                      </span>
                      <span class="font-sans text-body-sm text-slate">{{ item.result?.type_label || typeLabel(item) }}</span>
                    </span>
                  </li>
                }
              </ul>
              <button type="button" class="min-h-11 w-full rounded-field bg-cerulean py-3.5 font-sans text-body font-semibold text-white transition-colors hover:bg-ocean" (click)="close()">{{ doneLabel() }}</button>
              <button type="button" class="min-h-11 font-sans text-body font-semibold text-cerulean transition-colors hover:text-ocean" (click)="restart()">Upload more</button>
            </div>
          }
        }
      </div>
    </sd-dialog>
  `,
})
export class DocumentUploadDialog implements OnInit {
  private readonly api = inject(DocumentsApi);
  private readonly sharing = inject(DocumentSharingApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  private readonly dialogs = inject(DialogService);
  private readonly dialogBody = viewChild<ElementRef<HTMLElement>>('dialogBody');
  private readonly stepTitle = viewChild<ElementRef<HTMLElement>>('stepTitle');

  /** Share with this doctor by default (an appointment's doctor). */
  readonly presetDoctorId = input<string | null>(null);
  /** Offers "after the consultation" ends, anchored to it. */
  readonly appointment = input<SharingAppointmentRefDto | null>(null);
  /** The preset doctor is the only one to share with. */
  readonly lockDoctor = input(false);
  readonly surface = input<'documents_page' | 'appointment_details'>('documents_page');
  /** The success step's main button. */
  readonly doneLabel = input('View Medical records');

  /** One file stored (with who can see it now). */
  readonly uploaded = output<UploadedDocumentDto>();
  /** The dialog has closed; `uploaded` = how many files were stored. */
  readonly closed = output<{ uploaded: number }>();

  protected readonly accept = ACCEPT;
  protected readonly maxBytes = MAX_BYTES;
  protected readonly maxFiles = MAX_FILES;
  protected readonly customMax = CUSTOM_TYPE_MAX;
  protected readonly maxDoctors = MAX_SHARE_DOCTORS;
  protected readonly bounds = untilDateBounds();
  protected readonly on = 'border-cerulean bg-frost/30';
  protected readonly off = 'border-cloud hover:border-cerulean/40';

  protected readonly open = signal(true);
  protected readonly step = signal<UploadStep>('source');
  protected readonly types = signal<DocumentTypeOption[]>([]);
  protected readonly typesError = signal('');
  protected readonly queue = signal<QueueItem[]>([]);
  protected readonly skipped = signal<SkippedFile[]>([]);
  /** The discard question is up (Esc pressed again must not ask twice). */
  private confirmingDiscard = false;
  private nextKey = 1;
  private uploadedCount = 0;

  // ----- "Who can see these files?" -----
  protected readonly doctors = signal<SharingDoctorDto[]>([]);
  protected readonly doctorsLoading = signal(false);
  protected readonly doctorsError = signal('');
  protected readonly sharingOff = signal(false);
  private doctorsLoaded = false;
  protected readonly mode = signal<'private' | 'share'>('private');
  protected readonly chosen = signal<string[]>([]);
  protected readonly duration = signal<DocumentShareDuration>('7d');
  protected readonly untilDate = signal('');
  protected readonly ticks = signal<Record<string, boolean>>({});
  protected readonly triedUpload = signal(false);
  /** One key per batch: every file (and every retry) carries it. */
  private batchId = newKey();
  /** The sharing fields, fixed when the batch starts (retries reuse them). */
  private batchShare: UploadShareOptions | null = null;

  /** The Who list: every booked doctor (those not practising now shown, but disabled). */
  protected readonly shareable = computed(() => {
    const preset = this.presetDoctorId();
    const list = this.doctors();
    return this.lockDoctor() && preset ? list.filter((d) => d.specialist.id === preset) : list;
  });
  /** Whole-folder holders, paused ones too (they see new files if they come back within 30 days). */
  private readonly folderHolders = computed(() => this.doctors().filter((d) => holdsFolder(d) || holdsPausedFolder(d)));
  protected readonly anyFolder = computed(() => this.folderHolders().length > 0);
  /** Folder holders not already chosen to share with. */
  protected readonly folderDoctors = computed(() => {
    const share = this.mode() === 'share' ? this.chosen() : [];
    return this.folderHolders().filter((d) => !share.includes(d.specialist.id));
  });
  private readonly anchorApplies = computed(() => {
    const ids = this.chosen();
    const preset = this.presetDoctorId();
    return !!this.appointment() && ids.length === 1 && (!preset || ids[0] === preset);
  });
  protected readonly choices = computed(() => durationChoices(this.anchorApplies() ? this.appointment() : null));
  protected readonly shareProblem = computed(() => {
    if (this.mode() !== 'share' || this.sharingOff() || this.doctors().length === 0) return '';
    if (this.chosen().length === 0) return 'Choose at least one doctor, or keep the files private.';
    return durationError(
      { duration: this.duration(), untilDate: this.untilDate(), appointment: this.anchorApplies() ? this.appointment() : null },
      this.bounds,
    );
  });

  // ----- Batch -----
  /** A file is on the wire — the dialog can't be closed mid-request. */
  protected readonly busy = computed(() => this.queue().some((i) => i.status === 'uploading'));
  /** The batch still has work to do (uploading now, or waiting its turn). */
  protected readonly running = computed(
    () => this.step() === 'uploading' && this.queue().some((i) => i.status === 'uploading' || i.status === 'queued'),
  );
  protected readonly doneItems = computed(() => this.queue().filter((i) => i.status === 'done'));
  protected readonly failedCount = computed(() => this.queue().filter((i) => i.status === 'failed').length);
  /** Files still waiting for a type (or for the "Others" name). */
  protected readonly missingTypes = computed(() => this.queue().filter((i) => !this.typeReady(i)).length);
  protected readonly typesDone = computed(() => this.queue().length > 0 && this.missingTypes() === 0);
  protected readonly uploadedSummary = computed(() => {
    const n = this.doneItems().length;
    return n === 1 ? 'Document uploaded' : `${n} documents uploaded`;
  });
  protected readonly outcomeLines = computed(() => {
    const results = this.doneItems()
      .map((i) => i.result)
      .filter((r): r is UploadedDocumentDto => !!r);
    const names = new Map(this.doctors().map((d) => [d.specialist.id, d.specialist.name]));
    return uploadOutcomeLines(results, (id) => names.get(id) ?? '');
  });
  /** What the aria-live region says — per file, not per progress tick (with the sharing outcome). */
  protected readonly liveStatus = computed(() => {
    const list = this.queue();
    const failed = this.failedCount();
    const failedNote = failed > 0 ? ` ${failed} failed.` : '';
    if (this.step() === 'uploading') {
      const at = list.findIndex((i) => i.status === 'uploading');
      if (at >= 0) return `Uploading ${list[at].file.name}, ${at + 1} of ${list.length}.${failedNote}`;
      if (!this.running()) return `${this.doneItems().length} of ${list.length} uploaded.${failedNote}`;
    }
    if (this.step() === 'success') return `${this.uploadedSummary()}. ${this.outcomeLines().join(' ')}${failedNote}`;
    return '';
  });

  constructor() {
    // Closing or reloading the tab with files picked (or still uploading) loses them.
    warnBeforeUnload(() => this.hasUnsavedChanges());

    // While the dialog is open, a file dropped anywhere outside a drop zone
    // must not make the browser navigate away to open it.
    effect((onCleanup) => {
      const win = this.document.defaultView;
      if (!this.open() || !win) return;
      const guard = (e: DragEvent): void => {
        if (e.defaultPrevented || !Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
      };
      win.addEventListener('dragover', guard);
      win.addEventListener('drop', guard);
      onCleanup(() => {
        win.removeEventListener('dragover', guard);
        win.removeEventListener('drop', guard);
      });
    });

    // Every step swaps the dialog's content (and the control that was used):
    // focus goes to the new step's heading so it stays in the dialog.
    effect(() => {
      if (this.step() !== '') untracked(() => this.keepFocusInDialog(true));
    });

    // An "after the consultation" end that is no longer offered falls back to the default.
    effect(() => {
      const offered = this.choices();
      const d = this.duration();
      if (!offered.some((c) => c.value === d)) untracked(() => this.duration.set(defaultDuration(offered)));
    });
  }

  ngOnInit(): void {
    this.api
      .types()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => this.types.set(res.data),
        error: (err: unknown) => this.typesError.set(apiErrorMessage(err, 'Could not load document types.')),
      });
    const preset = this.presetDoctorId();
    if (preset) {
      this.mode.set('share');
      this.chosen.set([preset]);
    }
    this.duration.set(defaultDuration(durationChoices(this.appointment() && preset ? this.appointment() : null)));
    this.loadDoctors();
  }

  protected loadDoctors(): void {
    this.doctorsLoading.set(true);
    this.doctorsError.set('');
    this.sharing
      .doctors()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          const list = res.data ?? [];
          this.doctors.set(list);
          this.doctorsLoading.set(false);
          this.sharingOff.set(false);
          // A doctor who isn't practising now can't be shared with (their row is disabled).
          const off = list.filter((d) => !d.can_share).map((d) => d.specialist.id);
          if (off.length > 0) this.chosen.update((ids) => ids.filter((id) => !off.includes(id)));
          if (!this.doctorsLoaded) {
            this.doctorsLoaded = true;
            const folder = list.filter((d) => holdsFolder(d) || holdsPausedFolder(d)).map((d) => d.specialist.id);
            const paused = list.filter(holdsPausedFolder).map((d) => d.specialist.id);
            this.ticks.set(defaultFolderTicks(folder, this.appointment() ? this.presetDoctorId() : null, paused));
          }
        },
        error: (err: unknown) => {
          this.doctorsLoading.set(false);
          if (isSharingUnavailable(err)) {
            // Sharing is off: the files are stored privately (the server says so too).
            this.sharingOff.set(true);
            this.doctors.set([]);
            return;
          }
          this.doctorsError.set(apiErrorMessage(err, 'Could not load your doctors. Try again before uploading.'));
        },
      });
  }

  // ----- Closing -----

  /**
   * ×, Cancel, Esc or the scrim. Files picked but not uploaded yet are asked
   * about first; a batch that is still running can't be closed.
   */
  protected async requestClose(): Promise<void> {
    if (this.running() || this.confirmingDiscard) return;
    const pending = this.pendingFiles();
    if (pending > 0) {
      this.confirmingDiscard = true;
      const { confirmed } = await this.dialogs.confirm(this.discardCopy(pending));
      this.confirmingDiscard = false;
      if (!confirmed) return;
    }
    this.close();
  }

  protected close(): void {
    if (this.busy()) return; // let the file on the wire finish first
    this.open.set(false);
  }

  protected afterClosed(): void {
    this.step.set('');
    this.closed.emit({ uploaded: this.uploadedCount });
  }

  /** Files picked and typed, not uploaded yet. */
  private pendingFiles(): number {
    return this.step() === 'queue' || this.step() === 'share' ? this.queue().length : 0;
  }

  private discardCopy(n: number): ConfirmOptions {
    return {
      tone: 'warning',
      icon: 'trash-2',
      title: n === 1 ? 'Discard the selected file?' : `Discard ${n} selected files?`,
      message: n === 1 ? "It hasn't been uploaded yet." : "They haven't been uploaded yet.",
      confirmLabel: n === 1 ? 'Discard file' : 'Discard files',
      cancelLabel: 'Keep them',
    };
  }

  /** For the host's `unsavedChangesGuard`: files picked, or a batch still uploading. */
  hasUnsavedChanges(): boolean {
    return this.open() && (this.pendingFiles() > 0 || this.running());
  }

  /** The guard's prompt copy. */
  readonly leaveCopy = (): LeaveCopy => {
    if (this.running()) {
      return {
        title: 'Leave while uploading?',
        message: "Files that haven't finished uploading won't be saved.",
        confirmLabel: 'Leave anyway',
        cancelLabel: 'Stay',
      };
    }
    const { title, message, confirmLabel, cancelLabel } = this.discardCopy(this.pendingFiles());
    return { title, message, confirmLabel, cancelLabel };
  };

  /**
   * After the next render, if the control that had focus was destroyed (focus
   * fell back to <body>) or focus is outside the dialog, move it to the current
   * step's heading. `always` (a new step) moves it there regardless.
   */
  private keepFocusInDialog(always = false): void {
    afterNextRender(
      () => {
        const root = this.dialogBody()?.nativeElement;
        if (!root || (!always && root.contains(this.document.activeElement))) return;
        this.stepTitle()?.nativeElement.focus();
      },
      { injector: this.injector },
    );
  }

  protected dismissSkipped(): void {
    this.skipped.set([]);
    this.keepFocusInDialog();
  }

  // ----- Files -----

  /** Queue what a drop or pick produced, turning away what we can't take. */
  protected addFiles(files: File[]): void {
    const current = this.queue();
    const added: QueueItem[] = [];
    const skipped: SkippedFile[] = [];
    for (const file of files) {
      const err = this.validate(file);
      const dup = [...current, ...added].some(
        (i) => i.file.name === file.name && i.file.size === file.size && i.file.lastModified === file.lastModified,
      );
      if (err) skipped.push({ name: file.name, reason: err });
      else if (dup) skipped.push({ name: file.name, reason: 'Already in the list.' });
      else if (current.length + added.length >= MAX_FILES) {
        skipped.push({ name: file.name, reason: `You can upload up to ${MAX_FILES} files at a time.` });
      } else {
        added.push({ key: this.nextKey++, file, type: '', custom: '', status: 'queued', progress: 0, error: '', result: null });
      }
    }
    if (added.length > 0) this.queue.set([...current, ...added]);
    this.skip(skipped);
    if (this.step() === 'source' && this.queue().length > 0) this.step.set('queue');
    // A full batch hides the "Add more files" zone that was just used.
    else if (this.queue().length >= MAX_FILES) this.keepFocusInDialog();
  }

  /** Files the drop zone already turned away on type or size. */
  protected onRejected(rejections: FileDropRejection[]): void {
    this.skip(rejections.map((r) => ({ name: r.file.name, reason: r.reason === 'size' ? TOO_BIG : UNSUPPORTED })));
  }

  private skip(list: SkippedFile[]): void {
    if (list.length === 0) return;
    this.skipped.update((prev) => [
      ...prev.filter((p) => !list.some((s) => s.name === p.name && s.reason === p.reason)),
      ...list,
    ]);
  }

  private validate(f: File): string | null {
    if (f.size > MAX_BYTES) return TOO_BIG;
    const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
    if (!ALLOWED_EXT.includes(ext)) return UNSUPPORTED;
    if (f.size === 0) return 'This file is empty.';
    return null;
  }

  protected removeItem(key: number): void {
    this.queue.update((list) => list.filter((i) => i.key !== key));
    if (this.queue().length === 0) this.step.set('source');
    else this.keepFocusInDialog(); // the Remove button went with its row
  }

  protected setType(key: number, type: string): void {
    this.patch(key, { type });
  }

  protected setCustom(key: number, custom: string): void {
    this.patch(key, { custom });
  }

  /** Copy one file's type (and its "Others" name) onto every file in the batch. */
  protected applyToAll(key: number): void {
    const from = this.queue().find((i) => i.key === key);
    if (!from) return;
    this.queue.update((list) => list.map((i): QueueItem => ({ ...i, type: from.type, custom: from.custom })));
    this.keepFocusInDialog(); // every row now matches, so the link is gone
  }

  /** Offered on a file that has a type, while some other file differs. */
  protected canApplyToAll(item: QueueItem): boolean {
    const list = this.queue();
    return (
      list.length > 1 &&
      this.typeReady(item) &&
      list.some((o) => o.type !== item.type || (item.type === 'other' && o.custom.trim() !== item.custom.trim()))
    );
  }

  private typeReady(i: QueueItem): boolean {
    return i.type !== '' && (i.type !== 'other' || i.custom.trim() !== '');
  }

  // ----- Who can see them -----

  protected toShare(): void {
    if (!this.typesDone()) return;
    this.skipped.set([]);
    this.triedUpload.set(false);
    this.step.set('share');
  }

  protected backToQueue(): void {
    this.step.set('queue');
  }

  protected toggleDoctor(id: string, on: boolean): void {
    if (this.lockDoctor()) return;
    this.chosen.update((ids) =>
      on ? (ids.includes(id) || ids.length >= MAX_SHARE_DOCTORS ? ids : [...ids, id]) : ids.filter((x) => x !== id),
    );
  }

  protected tick(id: string, on: boolean): void {
    this.ticks.update((t) => ({ ...t, [id]: on }));
  }

  // ----- Uploading -----

  protected startBatch(): void {
    this.triedUpload.set(true);
    if (this.doctorsLoading() || this.doctorsError() || this.shareProblem()) return;
    this.batchShare = this.sharingOff()
      ? null
      : uploadShareOptions({
          mode: this.mode(),
          doctorIds: this.chosen(),
          duration: this.duration(),
          untilDate: this.untilDate(),
          appointmentId: this.anchorApplies() ? (this.appointment()?.id ?? null) : null,
          batchId: this.batchId,
          folderDoctorIds: this.folderDoctors().map((d) => d.specialist.id),
          folderTicks: this.ticks(),
          surface: this.surface(),
        });
    this.skipped.set([]);
    this.step.set('uploading');
    this.uploadNext();
  }

  /**
   * Upload the next waiting file. The API takes one file per request, so the
   * batch goes one at a time — each with its own progress and outcome — and a
   * failure never stops the rest. Every file carries the same sharing fields.
   */
  private uploadNext(): void {
    if (this.busy()) return;
    const next = this.queue().find((i) => i.status === 'queued');
    if (!next) {
      // All settled: straight to the summary unless something needs a retry.
      if (this.failedCount() === 0) this.step.set('success');
      return;
    }
    this.patch(next.key, { status: 'uploading', progress: 0, error: '' });

    this.api
      .upload(next.file, next.type, next.type === 'other' ? next.custom.trim() : undefined, this.batchShare ?? undefined)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (event) => {
          if (event.type === HttpEventType.UploadProgress && event.total) {
            this.patch(next.key, { progress: Math.round((event.loaded / event.total) * 100) });
          } else if (event.type === HttpEventType.Response) {
            const doc = event.body?.data ?? null;
            this.patch(next.key, { status: 'done', progress: 100, result: doc });
            this.uploadedCount += 1;
            if (doc) this.uploaded.emit(doc);
            this.uploadNext();
          }
        },
        error: (err: unknown) => {
          this.patch(next.key, { status: 'failed', error: apiErrorMessage(err, 'Upload failed. Please try again.') });
          this.uploadNext();
        },
      });
  }

  protected retry(key: number): void {
    this.patch(key, { status: 'queued', progress: 0, error: '' });
    this.uploadNext();
    this.keepFocusInDialog(); // the row's Retry button is gone
  }

  protected retryFailed(): void {
    this.queue.update((list) =>
      list.map((i): QueueItem => (i.status === 'failed' ? { ...i, status: 'queued', progress: 0, error: '' } : i)),
    );
    this.uploadNext();
    this.keepFocusInDialog(); // the footer hides while the batch runs
  }

  /** Leave the failed files behind: show what did upload, or just close. */
  protected finishWithFailures(): void {
    if (this.doneItems().length > 0) this.step.set('success');
    else this.close();
  }

  /** "Upload more": a fresh batch (and batch key) in the same dialog. */
  protected restart(): void {
    this.queue.set([]);
    this.skipped.set([]);
    this.batchId = newKey();
    this.batchShare = null;
    this.triedUpload.set(false);
    this.step.set('source');
  }

  private patch(key: number, changes: Partial<QueueItem>): void {
    this.queue.update((list) => list.map((i) => (i.key === key ? { ...i, ...changes } : i)));
  }

  // ----- Display helpers -----
  protected sizeLabel(bytes: number): string {
    return bytes >= 1024 * 1024
      ? `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1).replace(/\.0$/, '')}mb`
      : `${Math.max(1, Math.round(bytes / 1024))}kb`;
  }
  protected typeLabel(item: QueueItem): string {
    if (item.type === 'other') return item.custom.trim() || 'Other';
    return this.types().find((t) => t.value === item.type)?.label ?? '';
  }
  protected uploadStatus(status: UploadStatus): { label: string; icon: string; cls: string } {
    return UPLOAD_STATUS[status];
  }
  protected dr(name: string): string {
    return drName(name);
  }
  protected initialsOf(name: string): string {
    return initials(name);
  }
  protected paused(d: SharingDoctorDto): boolean {
    return holdsPausedFolder(d);
  }
  protected folderUntilOf(d: SharingDoctorDto): string {
    const until = folderUntil(d);
    return until === 'No end date' ? 'with no end date' : until.replace(/^Until/, 'until');
  }
}
