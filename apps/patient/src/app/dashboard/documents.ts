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
  OnInit,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import {
  apiErrorMessage,
  DocumentsApi,
  openBlobDocument,
  openPendingTab,
  PrescriptionsApi,
} from '@supadoc/data-access';
import type {
  DocumentTypeOption,
  MedicalDocumentDto,
  PrescriptionStatus,
  PrescriptionSummaryDto,
} from '@supadoc/models';
import type { HasUnsavedChanges } from '@supadoc/auth';
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

/** How many recent prescriptions the documents page previews. */
const RX_PREVIEW = 3;

/** Every prescription status reads as an icon AND a word — never colour alone. */
const RX_STATUS: Record<PrescriptionStatus, { label: string; icon: string; cls: string }> = {
  draft: { label: 'Draft', icon: 'pen-line', cls: 'bg-warning/15 text-warning' },
  active: { label: 'Active', icon: 'circle-check', cls: 'bg-sage/15 text-sage' },
  expired: { label: 'Expired', icon: 'hourglass', cls: 'bg-cloud text-slate' },
  cancelled: { label: 'Cancelled', icon: 'circle-x', cls: 'bg-alert/10 text-alert' },
};

type Step = '' | 'source' | 'queue' | 'uploading' | 'success';
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
  readonly result: MedicalDocumentDto | null;
}

/** A file that never made it into the queue, and why. */
interface SkippedFile {
  readonly name: string;
  readonly reason: string;
}

/** Every upload status reads as an icon AND a word — never colour alone. */
const UPLOAD_STATUS: Record<UploadStatus, { label: string; icon: string; cls: string }> = {
  queued: { label: 'Waiting', icon: 'clock', cls: 'bg-cloud text-slate' },
  uploading: { label: 'Uploading', icon: 'loader-circle', cls: 'bg-frost text-cerulean' },
  done: { label: 'Uploaded', icon: 'circle-check', cls: 'bg-sage/15 text-sage' },
  failed: { label: 'Failed', icon: 'circle-x', cls: 'bg-alert/10 text-alert' },
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
 * Medical documents (route `/dashboard/documents`) — the patient's record
 * library plus the upload flow (drop or pick files → a type per file → one
 * request per file, in turn, with progress and retry → success). Files are
 * streamed back through an authenticated endpoint, opened in a new tab.
 */
@Component({
  selector: 'pat-documents',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DialogComponent, FileDropComponent, IconComponent, NgTemplateOutlet, RouterLink],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <header class="flex flex-wrap items-start justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">Medical Document</h1>
          <p class="font-sans text-body text-slate">All your reports, scans, and prescriptions in one place.</p>
        </div>
        @if (hasAny()) {
          <button #headerUpload type="button" class="flex items-center gap-2 rounded-field bg-cerulean px-5 py-3 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean" (click)="startUpload()">
            <sd-icon name="upload" [size]="18" />Upload Document
          </button>
        }
      </header>

      <!-- Prescriptions sent by your doctors (the PDF opens in a new tab) -->
      @if (rxLoading()) {
        <div class="sd-shimmer h-24 rounded-card"></div>
      } @else if (rxLoadError()) {
        <section class="flex flex-col gap-3 rounded-card border border-cloud bg-white p-4 sm:p-5">
          <span class="flex items-center gap-2 font-sans text-body font-semibold text-ink">
            <sd-icon name="pill" [size]="20" class="text-slate" />Prescriptions
          </span>
          <p class="flex items-start gap-2 font-sans text-body-sm text-alert" role="alert">
            <sd-icon name="triangle-alert" [size]="18" class="mt-0.5 shrink-0" />{{ rxLoadError() }}
          </p>
          <button type="button" class="w-fit rounded-field border border-cloud bg-white px-5 py-2 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean" (click)="loadPrescriptions()">
            Try again
          </button>
        </section>
      } @else if (prescriptions().length > 0) {
        <section class="flex flex-col gap-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="flex items-center gap-2 font-sans text-body font-semibold text-ink">
              <sd-icon name="pill" [size]="20" class="text-slate" />Prescriptions
            </span>
            <a routerLink="/dashboard/prescriptions" class="flex items-center gap-1 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:text-ocean">
              See all prescriptions<sd-icon name="chevron-right" [size]="16" />
            </a>
          </div>
          <ul class="flex flex-col gap-3">
            @for (rx of recentRx(); track rx.id) {
              <li class="flex flex-col gap-3 rounded-card border border-cloud bg-white p-4 sm:flex-row sm:items-center sm:gap-4">
                <div class="flex min-w-0 flex-1 items-start gap-4 sm:items-center">
                  <span class="flex size-11 shrink-0 items-center justify-center rounded-lg bg-teal/10 text-teal">
                    <sd-icon name="pill" [size]="20" />
                  </span>
                  <span class="flex min-w-0 flex-col gap-1">
                    <span class="flex flex-wrap items-center gap-2">
                      <span class="font-sans text-body-sm font-semibold text-ink">{{ rx.number }}</span>
                      <span class="inline-flex items-center gap-1 rounded-pill px-2.5 py-0.5 font-sans text-caption font-medium" [class]="rxStatus(rx.status).cls">
                        <sd-icon [name]="rxStatus(rx.status).icon" [size]="12" />{{ rxStatus(rx.status).label }}
                      </span>
                    </span>
                    <span class="font-sans text-caption text-slate">
                      {{ rx.prescriber || 'Your doctor' }}@if (rx.valid_until) { · Valid until {{ shortDate(rx.valid_until) }} }
                    </span>
                  </span>
                </div>
                @if (rx.sent_at) {
                  <span class="hidden font-sans text-body-sm text-slate md:block">{{ date(rx.sent_at) }}</span>
                }
                <div class="flex shrink-0 items-center gap-2 pl-[60px] sm:pl-0">
                  <button
                    type="button"
                    class="inline-flex items-center gap-1.5 rounded-field border border-cloud px-3 py-1.5 font-sans text-caption font-semibold text-cerulean transition-colors hover:border-cerulean disabled:opacity-60"
                    [disabled]="openingRx() === rx.id"
                    [attr.aria-label]="'View prescription ' + rx.number"
                    (click)="viewRx(rx)"
                  >
                    <sd-icon [name]="openingRx() === rx.id ? 'loader-circle' : 'eye'" [size]="14" [class.animate-spin]="openingRx() === rx.id" />View
                  </button>
                  <a
                    [routerLink]="['/dashboard/prescriptions', rx.id]"
                    class="inline-flex items-center gap-1 rounded-field px-2 py-1.5 font-sans text-caption font-semibold text-slate transition-colors hover:text-cerulean"
                    [attr.aria-label]="'Details for prescription ' + rx.number"
                  >
                    Details<sd-icon name="chevron-right" [size]="14" />
                  </a>
                </div>
              </li>
            }
          </ul>
          @if (rxError()) {
            <p class="flex items-start gap-2 font-sans text-caption text-alert" role="alert">
              <sd-icon name="triangle-alert" [size]="16" class="mt-0.5 shrink-0" />{{ rxError() }}
            </p>
          }
        </section>
      }

      @if (loading() && docs().length === 0) {
        <div class="flex flex-col gap-3">
          @for (i of [1,2,3]; track i) { <div class="sd-shimmer h-20 rounded-card"></div> }
        </div>
      } @else if (loadError() && !hasAny()) {
        <div class="flex flex-col items-center gap-4 py-20 text-center">
          <p class="font-sans text-body-sm text-alert">{{ loadError() }}</p>
          <button type="button" class="rounded-field border border-cloud bg-white px-6 py-2.5 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean" (click)="reload()">
            Try again
          </button>
        </div>
      } @else if (!hasAny()) {
        <!-- Empty state -->
        <div class="flex flex-col items-center gap-5 py-20 text-center">
          <span class="flex size-24 items-center justify-center rounded-full bg-glacier text-slate">
            <sd-icon name="file-text" [size]="40" />
          </span>
          <div class="flex max-w-sm flex-col gap-1.5">
            <h2 class="font-heading text-h5 text-ink">No document yet</h2>
            <p class="font-sans text-body-sm text-slate">Upload your medical files to keep your health information in one place.</p>
          </div>
          <button type="button" class="flex items-center gap-2 rounded-field bg-cerulean px-6 py-3.5 font-sans text-body font-semibold text-white transition-colors hover:bg-ocean" (click)="startUpload()">
            <sd-icon name="upload" [size]="18" />Upload Document
          </button>
        </div>
      } @else {
        <!-- Toolbar -->
        <div class="flex flex-wrap items-center gap-3">
          <span class="flex items-center gap-2 font-sans text-body font-semibold text-ink">
            <sd-icon name="file-text" [size]="20" class="text-slate" />Upload History
          </span>
          <div class="flex min-w-[220px] flex-1 items-center gap-2 rounded-field border border-cloud bg-white px-4 py-2.5">
            <sd-icon name="search" [size]="18" class="text-slate" />
            <input
              type="search"
              placeholder="Search Document"
              class="min-w-0 flex-1 bg-transparent font-sans text-body-sm text-ink outline-none placeholder:text-slate"
              [value]="search()"
              (input)="onSearch($any($event.target).value)"
            />
          </div>
          <div class="relative">
            <select
              class="appearance-none rounded-field border border-cloud bg-white py-2.5 pl-9 pr-9 font-sans text-body-sm text-ink outline-none focus:border-cerulean"
              [value]="typeFilter()"
              (change)="onFilter($any($event.target).value)"
            >
              <option value="">All</option>
              @for (t of types(); track t.value) { <option [value]="t.value">{{ t.label }}</option> }
            </select>
            <sd-icon name="filter" [size]="16" class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate" />
            <sd-icon name="chevron-down" [size]="16" class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate" />
          </div>
          <button
            type="button"
            class="flex items-center gap-2 rounded-field border border-cloud bg-white px-4 py-2.5 font-sans text-body-sm text-ink transition-colors hover:border-cerulean"
            (click)="toggleSort()"
          >
            <sd-icon name="arrow-up-down" [size]="16" class="text-slate" />
            Sort: <span class="font-semibold">{{ sortDir() === 'desc' ? 'Newest' : 'Oldest' }}</span>
          </button>
        </div>

        @if (loadError()) {
          <p class="font-sans text-body-sm text-alert">{{ loadError() }}</p>
        }

        <!-- List -->
        <ul class="flex flex-col gap-3">
          @for (d of docs(); track d.id) {
            <li>
              <button
                type="button"
                class="flex w-full items-center gap-4 rounded-card border border-cloud bg-white p-4 text-left transition-colors hover:border-cerulean/50"
                (click)="open(d)"
              >
                <span class="flex size-11 shrink-0 items-center justify-center rounded-lg bg-glacier text-slate">
                  <sd-icon name="file-text" [size]="20" />
                </span>
                <span class="flex min-w-0 flex-1 flex-col">
                  <span class="truncate font-sans text-body-sm font-semibold text-ink">{{ d.title }}</span>
                  <span class="font-sans text-caption uppercase text-slate">{{ d.extension }}. {{ d.size_label }}</span>
                </span>
                <span class="hidden min-w-0 flex-1 truncate font-sans text-body-sm text-ink sm:block">{{ d.type_label }}</span>
                <span class="hidden font-sans text-body-sm text-slate md:block">{{ date(d.created_at) }}</span>
                <span class="shrink-0 rounded-pill px-3 py-1 font-sans text-caption font-medium" [class]="badgeClass(d.uploader_role)">{{ badgeLabel(d.uploader_role) }}</span>
                <sd-icon name="chevron-right" [size]="18" class="shrink-0 text-slate" />
              </button>
            </li>
          } @empty {
            <li class="rounded-card border border-cloud bg-white px-5 py-16 text-center font-sans text-body-sm text-slate">
              {{ loading() ? 'Loading…' : 'No documents match your search.' }}
            </li>
          }
        </ul>

        @if (hasMore()) {
          <button type="button" class="mx-auto rounded-field border border-cloud bg-white px-6 py-2.5 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean disabled:opacity-60" [disabled]="loading()" (click)="loadMore()">
            {{ loading() ? 'Loading…' : 'Load more' }}
          </button>
        }
      }
    </div>

    <!-- Files a drop or pick turned away (accumulates until dismissed) -->
    <ng-template #skippedNote>
      @if (skipped().length > 0) {
        <div class="flex flex-col gap-2 rounded-field bg-alert/10 px-4 py-3 font-sans text-body-sm text-alert" role="alert">
          <div class="flex items-start justify-between gap-3">
            <span class="flex items-start gap-2 font-semibold">
              <sd-icon name="triangle-alert" [size]="18" class="mt-0.5 shrink-0" />{{ skipped().length === 1 ? '1 file wasn’t added' : skipped().length + ' files weren’t added' }}
            </span>
            <button type="button" class="shrink-0 transition-colors hover:text-ink" aria-label="Dismiss" (click)="dismissSkipped()"><sd-icon name="x" [size]="18" /></button>
          </div>
          <ul class="flex flex-col gap-1 pl-[26px] font-sans text-caption">
            @for (s of skipped(); track $index) {
              <li class="wrap-anywhere"><span class="font-semibold">{{ s.name }}</span> — {{ s.reason }}</li>
            }
          </ul>
        </div>
      }
    </ng-template>

    <!-- Upload modal (the shared dialog: top layer, Esc, scroll lock, focus back to the opener) -->
    <sd-dialog
      [open]="uploadOpen()"
      layout="plain"
      size="md"
      labelledBy="doc-upload-title"
      [busy]="running()"
      (closed)="requestClose()"
      (afterClose)="afterUploadClosed()"
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
                <button type="button" class="flex-1 rounded-field border border-cloud py-3 font-sans text-body font-semibold text-slate transition-colors hover:bg-glacier" (click)="requestClose()">Cancel</button>
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
              @if (typesError()) { <p class="font-sans text-caption text-alert">{{ typesError() }}</p> }
              <ng-container [ngTemplateOutlet]="skippedNote" />
              @if (missingTypes() > 0) {
                <p class="font-sans text-caption text-slate">
                  {{ missingTypes() === 1 ? 'Choose a type for 1 more document to continue.' : 'Choose a type for ' + missingTypes() + ' more documents to continue.' }}
                </p>
              }
              <div class="flex gap-3">
                <button type="button" class="flex-1 rounded-field border border-cloud py-3 font-sans text-body font-semibold text-slate transition-colors hover:bg-glacier" (click)="requestClose()">Cancel</button>
                <button type="button" class="flex-1 rounded-field bg-cerulean py-3 font-sans text-body font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-50" [disabled]="!canUpload()" (click)="startBatch()">
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
                      <span class="inline-flex shrink-0 items-center gap-1 rounded-pill px-2.5 py-0.5 font-sans text-caption font-medium" [class]="uploadStatus(item.status).cls">
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
                        <p class="flex min-w-0 items-start gap-1.5 font-sans text-caption text-alert">
                          <sd-icon name="triangle-alert" [size]="14" class="mt-0.5 shrink-0" /><span class="min-w-0 wrap-anywhere">{{ item.error }}</span>
                        </p>
                        <button type="button" class="inline-flex shrink-0 items-center gap-1 rounded-field border border-cloud px-3 py-1.5 font-sans text-caption font-semibold text-cerulean transition-colors hover:border-cerulean" [attr.aria-label]="'Retry ' + item.file.name" (click)="retry(item.key)">
                          <sd-icon name="refresh-cw" [size]="14" />Retry
                        </button>
                      </div>
                    }
                  </li>
                }
              </ul>
              @if (!running()) {
                <div class="flex gap-3">
                  <button type="button" class="flex-1 rounded-field border border-cloud py-3 font-sans text-body font-semibold text-slate transition-colors hover:bg-glacier" (click)="finishWithFailures()">
                    {{ doneItems().length > 0 ? 'Done' : 'Close' }}
                  </button>
                  <button type="button" class="flex-1 rounded-field bg-cerulean py-3 font-sans text-body font-semibold text-white transition-colors hover:bg-ocean" (click)="retryFailed()">
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
                @if (failedCount() > 0) {
                  <p class="flex w-full items-start gap-2 rounded-field bg-warning/10 px-4 py-3 text-left font-sans text-body-sm text-warning">
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
                <button type="button" class="w-full rounded-field bg-cerulean py-3.5 font-sans text-body font-semibold text-white transition-colors hover:bg-ocean" (click)="close()">View Medical records</button>
                <button type="button" class="font-sans text-body font-semibold text-cerulean transition-colors hover:text-ocean" (click)="startUpload()">Upload more</button>
              </div>
            }
          }
        </div>
    </sd-dialog>
  `,
})
export class PatientDocuments implements OnInit, HasUnsavedChanges {
  private readonly api = inject(DocumentsApi);
  private readonly prescriptionsApi = inject(PrescriptionsApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  private readonly dialogs = inject(DialogService);
  /** The upload dialog's content (focus is kept inside it as steps change). */
  private readonly dialogBody = viewChild<ElementRef<HTMLElement>>('dialogBody');
  /** The current step's heading (one per step; it names the dialog). */
  private readonly stepTitle = viewChild<ElementRef<HTMLElement>>('stepTitle');
  /** The page-header Upload button — focus goes here when the empty-state opener is gone. */
  private readonly headerUpload = viewChild<ElementRef<HTMLElement>>('headerUpload');

  protected readonly accept = ACCEPT;
  protected readonly maxBytes = MAX_BYTES;
  protected readonly maxFiles = MAX_FILES;
  protected readonly customMax = CUSTOM_TYPE_MAX;

  // Prescriptions preview (newest first, from GET /api/portal/prescriptions)
  protected readonly prescriptions = signal<PrescriptionSummaryDto[]>([]);
  protected readonly recentRx = computed(() => this.prescriptions().slice(0, RX_PREVIEW));
  protected readonly rxLoading = signal(true);
  /** Loading the list failed — shown instead of hiding the section. */
  protected readonly rxLoadError = signal('');
  /** Opening one prescription's PDF failed. */
  protected readonly rxError = signal('');
  /** Id of the prescription whose PDF link is being fetched. */
  protected readonly openingRx = signal('');

  // List state
  protected readonly docs = signal<MedicalDocumentDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly loadError = signal('');
  protected readonly hasMore = signal(false);
  /** True once we know the patient has at least one document (drives empty state). */
  protected readonly hasAny = signal(false);
  protected readonly search = signal('');
  protected readonly typeFilter = signal('');
  protected readonly sortDir = signal<'asc' | 'desc'>('desc');
  private page = 1;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  // Types
  protected readonly types = signal<DocumentTypeOption[]>([]);
  protected readonly typesError = signal('');

  // Upload modal state
  protected readonly step = signal<Step>('');
  protected readonly uploadOpen = signal(false);
  protected readonly modalOpen = computed(() => this.uploadOpen() && this.step() !== '');
  /** The discard question is up (Esc pressed again must not ask twice). */
  private confirmingDiscard = false;
  protected readonly queue = signal<QueueItem[]>([]);
  protected readonly skipped = signal<SkippedFile[]>([]);
  /** A file is on the wire — the modal can't be closed mid-request. */
  protected readonly busy = computed(() => this.queue().some((i) => i.status === 'uploading'));
  /** The batch still has work to do (uploading now, or waiting its turn). */
  protected readonly running = computed(() =>
    this.queue().some((i) => i.status === 'uploading' || i.status === 'queued'),
  );
  protected readonly doneItems = computed(() => this.queue().filter((i) => i.status === 'done'));
  protected readonly failedCount = computed(
    () => this.queue().filter((i) => i.status === 'failed').length,
  );
  /** Files still waiting for a type (or for the "Others" name). */
  protected readonly missingTypes = computed(
    () => this.queue().filter((i) => !this.typeReady(i)).length,
  );
  protected readonly canUpload = computed(
    () => this.queue().length > 0 && this.missingTypes() === 0,
  );
  protected readonly uploadedSummary = computed(() => {
    const n = this.doneItems().length;
    return n === 1 ? 'Document uploaded' : `${n} documents uploaded`;
  });
  /** What the aria-live region says — per file, not per progress tick. */
  protected readonly liveStatus = computed(() => {
    const list = this.queue();
    const failed = this.failedCount();
    const failedNote = failed > 0 ? ` ${failed} failed.` : '';
    if (this.step() === 'uploading') {
      const at = list.findIndex((i) => i.status === 'uploading');
      if (at >= 0) return `Uploading ${list[at].file.name}, ${at + 1} of ${list.length}.${failedNote}`;
      if (!this.running()) return `${this.doneItems().length} of ${list.length} uploaded.${failedNote}`;
    }
    if (this.step() === 'success') return `${this.uploadedSummary()}.${failedNote}`;
    return '';
  });
  private nextKey = 1;
  /** Something was uploaded since the list was last loaded. */
  private needsReload = false;

  constructor() {
    // Closing or reloading the tab with files picked (or still uploading) loses them.
    warnBeforeUnload(() => this.hasUnsavedChanges());

    // While the modal is open, a file dropped anywhere outside a drop zone
    // must not make the browser navigate away to open it. The zones cancel
    // their own events first, so anything still uncancelled here is a miss.
    effect((onCleanup) => {
      const win = this.document.defaultView;
      if (!this.modalOpen() || !win) return;
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

    // Every step swaps out the dialog's content, destroying whatever had focus
    // (often the very button that was used). Opening the modal, and each step
    // change, puts focus on the new step's heading so it stays in the dialog.
    effect(() => {
      if (this.step() !== '') this.keepFocusInDialog(true);
    });
  }

  ngOnInit(): void {
    this.api.types().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => this.types.set(res.data),
      error: (err: unknown) =>
        this.typesError.set(apiErrorMessage(err, 'Could not load document types.')),
    });
    this.reload();
    this.loadPrescriptions();
  }

  // ----- Prescriptions -----
  protected loadPrescriptions(): void {
    this.rxLoading.set(true);
    this.rxLoadError.set('');
    this.prescriptionsApi
      .mine()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.prescriptions.set(res.data ?? []);
          this.rxLoading.set(false);
        },
        error: (err: unknown) => {
          this.rxLoadError.set(apiErrorMessage(err, 'Could not load your prescriptions.'));
          this.rxLoading.set(false);
        },
      });
  }

  /**
   * Open the prescription PDF in a new tab. The tab is opened synchronously on
   * the click (so popup blockers allow it), then pointed at the signed link.
   */
  protected viewRx(rx: PrescriptionSummaryDto): void {
    if (this.openingRx()) return;
    const pending = openPendingTab();
    this.openingRx.set(rx.id);
    this.rxError.set('');
    this.prescriptionsApi
      .link(rx.id, false)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          pending.go(this.prescriptionsApi.fileUrl(res.data));
          this.openingRx.set('');
        },
        error: (err: unknown) => {
          pending.fail();
          this.openingRx.set('');
          this.rxError.set(apiErrorMessage(err, 'Could not open the prescription. Please try again.'));
        },
      });
  }

  protected rxStatus(status: PrescriptionStatus): { label: string; icon: string; cls: string } {
    return RX_STATUS[status] ?? RX_STATUS.active;
  }

  /** `YYYY-MM-DD` → "12 Oct 2026". */
  protected shortDate(ymd: string): string {
    const d = new Date(`${ymd.slice(0, 10)}T00:00:00`);
    return isNaN(d.getTime())
      ? ymd
      : new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
  }

  // ----- List -----
  protected reload(): void {
    this.loading.set(true);
    this.loadError.set('');
    this.api
      .list({ page: this.page, per_page: 20, search: this.search() || undefined, type: this.typeFilter() || undefined, sort_dir: this.sortDir() })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.docs.update((list) => (this.page === 1 ? res.data : [...list, ...res.data]));
          this.hasMore.set(res.meta.page < res.meta.total_pages);
          // "No documents at all" only when the unfiltered first page is empty.
          if (this.page === 1 && this.search() === '' && this.typeFilter() === '') {
            this.hasAny.set(res.meta.total > 0);
          } else {
            this.hasAny.set(true);
          }
          this.loading.set(false);
        },
        error: (err: unknown) => {
          this.loadError.set(apiErrorMessage(err, 'Could not load your documents.'));
          this.loading.set(false);
        },
      });
  }

  protected onSearch(v: string): void {
    this.search.set(v);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.page = 1;
      this.reload();
    }, 300);
  }
  protected onFilter(v: string): void {
    this.typeFilter.set(v);
    this.page = 1;
    this.reload();
  }
  protected toggleSort(): void {
    this.sortDir.update((d) => (d === 'desc' ? 'asc' : 'desc'));
    this.page = 1;
    this.reload();
  }
  protected loadMore(): void {
    this.page += 1;
    this.reload();
  }

  protected open(d: MedicalDocumentDto): void {
    openBlobDocument(this.api.fileBlob(d.id));
  }

  // ----- Upload flow -----
  protected startUpload(): void {
    this.queue.set([]);
    this.skipped.set([]);
    this.step.set('source');
    this.uploadOpen.set(true);
  }

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
    this.uploadOpen.set(false);
  }

  /** The dialog has gone: reset the flow, show what was uploaded, and keep focus on the page. */
  protected afterUploadClosed(): void {
    this.step.set('');
    this.queue.set([]);
    this.skipped.set([]);
    if (this.needsReload) {
      this.needsReload = false;
      this.page = 1;
      this.reload();
    }
    // A first upload removes the empty-state button that opened the modal.
    setTimeout(() => {
      const active = this.document.activeElement;
      if (!active || active === this.document.body) this.headerUpload()?.nativeElement.focus();
    });
  }

  /** Files picked and typed, not uploaded yet (the Document Type step). */
  private pendingFiles(): number {
    return this.step() === 'queue' ? this.queue().length : 0;
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

  /** `unsavedChangesGuard`: leaving with files picked, or a batch still uploading, asks first. */
  hasUnsavedChanges(): boolean {
    return this.uploadOpen() && (this.pendingFiles() > 0 || this.running());
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
   * fell back to <body>) or focus is otherwise outside the dialog, move it to
   * the current step's heading. Called whenever an action removes the button
   * that triggered it. `always` (a new step) moves focus to the heading
   * regardless. (While the dialog is opening, it focuses the heading itself.)
   */
  private keepFocusInDialog(always = false): void {
    afterNextRender(() => {
      const root = this.dialogBody()?.nativeElement;
      if (!root || (!always && root.contains(this.document.activeElement))) return;
      this.stepTitle()?.nativeElement.focus();
    }, { injector: this.injector });
  }

  protected dismissSkipped(): void {
    this.skipped.set([]);
    this.keepFocusInDialog();
  }

  /** Queue what a drop or pick produced, turning away what we can't take. */
  protected addFiles(files: File[]): void {
    const current = this.queue();
    const added: QueueItem[] = [];
    const skipped: SkippedFile[] = [];
    for (const file of files) {
      const err = this.validate(file);
      const dup = [...current, ...added].some(
        (i) =>
          i.file.name === file.name &&
          i.file.size === file.size &&
          i.file.lastModified === file.lastModified,
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
    this.skip(
      rejections.map((r) => ({ name: r.file.name, reason: r.reason === 'size' ? TOO_BIG : UNSUPPORTED })),
    );
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
      list.some(
        (o) => o.type !== item.type || (item.type === 'other' && o.custom.trim() !== item.custom.trim()),
      )
    );
  }

  private typeReady(i: QueueItem): boolean {
    return i.type !== '' && (i.type !== 'other' || i.custom.trim() !== '');
  }

  protected startBatch(): void {
    if (!this.canUpload()) return;
    this.skipped.set([]);
    this.step.set('uploading');
    this.uploadNext();
  }

  /**
   * Upload the next waiting file. The API takes one file per request, so the
   * batch goes one at a time — each with its own progress and outcome — and a
   * failure never stops the rest.
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
      .upload(next.file, next.type, next.type === 'other' ? next.custom.trim() : undefined)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (event) => {
          if (event.type === HttpEventType.UploadProgress && event.total) {
            this.patch(next.key, { progress: Math.round((event.loaded / event.total) * 100) });
          } else if (event.type === HttpEventType.Response) {
            const doc = event.body?.data ?? null;
            this.patch(next.key, { status: 'done', progress: 100, result: doc });
            if (doc) this.docs.update((list) => [doc, ...list]);
            this.hasAny.set(true);
            this.needsReload = true;
            this.uploadNext();
          }
        },
        error: (err: unknown) => {
          this.patch(next.key, {
            status: 'failed',
            error: apiErrorMessage(err, 'Upload failed. Please try again.'),
          });
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
  protected badgeLabel(role: string): string {
    return role === 'patient' ? 'Patient-upload' : role === 'doctor' ? 'Doctor-uploaded' : 'Staff-uploaded';
  }
  protected badgeClass(role: string): string {
    return role === 'patient'
      ? 'bg-sage/15 text-sage'
      : role === 'doctor'
        ? 'bg-warning/15 text-warning'
        : 'bg-cloud text-slate';
  }
  protected date(iso: string): string {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(iso));
  }
}
