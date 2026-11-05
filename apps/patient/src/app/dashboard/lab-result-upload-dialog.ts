import { HttpEventType } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  OnInit,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subscription } from 'rxjs';
import {
  apiErrorCode,
  apiErrorMessage,
  DocumentSharingApi,
  fileExtension,
  isDoctorViewableName,
  LabRequestsApi,
} from '@supadoc/data-access';
import type {
  LabResultUploadedDto,
  PatientLabRequestDto,
  SharingDoctorDto,
} from '@supadoc/models';
import {
  DialogComponent,
  FileDropComponent,
  IconComponent,
  type FileDropRejection,
  type LeaveCopy,
  warnBeforeUnload,
} from '@supadoc/ui';
import {
  cap,
  defaultFolderTicks,
  drName,
  folderUntil,
  holdsFolder,
  holdsPausedFolder,
  isSharingUnavailable,
} from './document-sharing';
import {
  fileSizeLabel,
  LAB_FILE_SIZE_ERROR,
  LAB_FILE_TYPE_ERROR,
  LAB_RESULT_ACCEPT,
  LAB_RESULT_MAX_BYTES,
  labDoctor,
  resultFileError,
  shareDefault,
} from './lab-ui';

/** The confirm dialog's own button look (`sd-confirm-dialog`). */
const BUTTON =
  'inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-field px-4 py-3 font-sans text-body font-semibold ' +
  'transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-(--sd-dialog-ring) focus-visible:ring-offset-2 ' +
  'focus-visible:ring-offset-(--sd-dialog-surface) aria-disabled:cursor-not-allowed aria-disabled:opacity-60';

export const LAB_CHOOSE_TEST = 'Choose at least one test.';
export const LAB_FOLDER_CHECKING = 'Checking who can see your folder…';
export const LAB_FOLDER_ERROR =
  "Couldn't check who can see your folder. Try again.";

/** A 409 `status_changed`: the request moved under the dialog (e.g. the doctor cancelled it); nothing was stored. */
export interface LabUploadRefused {
  readonly message: string;
}

/**
 * "Upload result" (spec §4.4) — one result file for a lab request: the file
 * (PDF, photos, DICOM, Word; 10 MB), its document type, the tests it covers,
 * and who sees it. "Share this result with Dr X" decides for the requesting
 * doctor (ticked while the request's results grant is active, or before any
 * grant when the patient agreed at acceptance). Doctors who can see the
 * patient's whole folder are asked about at upload, as on the documents page:
 * here they all start unticked (an appointment-style upload) and the unticked
 * ones are sent as `exclude_specialist_ids[]`. Upload waits until that list has
 * loaded (or sharing is reported off): a file is never shared without asking.
 */
@Component({
  selector: 'pat-lab-result-upload-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DialogComponent, FileDropComponent, IconComponent],
  template: `
    <sd-dialog
      [open]="open()"
      title="Upload result"
      subtitle="Add the result file the lab gave you."
      size="md"
      [busy]="uploading()"
      (closed)="close()"
      (afterClose)="closed.emit()"
    >
      <form
        id="lab-upload-form"
        class="flex flex-col gap-5"
        novalidate
        (submit)="submit($event)"
      >
        <!-- The file -->
        @if (file(); as f) {
          <div
            class="flex items-center gap-3 rounded-card border border-(--sd-dialog-border) p-3"
          >
            <span
              class="flex size-10 shrink-0 items-center justify-center rounded-full bg-(--sd-dialog-info-soft) text-(--sd-dialog-info-text)"
              aria-hidden="true"
            >
              <sd-icon name="file-text" [size]="18" />
            </span>
            <span class="flex min-w-0 flex-1 flex-col">
              <span
                class="truncate font-sans text-body-sm font-semibold text-(--sd-dialog-strong)"
                [title]="f.name"
                >{{ f.name }}</span
              >
              <span class="font-sans text-caption text-(--sd-dialog-muted)">{{
                size(f.size)
              }}</span>
            </span>
            <button
              type="button"
              class="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-(--sd-dialog-muted) transition-colors hover:bg-(--sd-dialog-hover) hover:text-(--sd-dialog-text) focus:outline-none focus-visible:ring-2 focus-visible:ring-(--sd-dialog-ring)"
              [attr.aria-label]="'Remove ' + f.name"
              [disabled]="uploading()"
              (click)="removeFile()"
            >
              <sd-icon name="trash-2" [size]="18" />
            </button>
          </div>
        } @else {
          <sd-file-drop
            label="Click to upload or drag and drop"
            hint="PDF, JPG, PNG, WEBP, DICOM (.dcm) or Word, up to 10MB"
            [accept]="accept"
            [maxBytes]="maxBytes"
            (files)="pick($event)"
            (rejected)="onRejected($event)"
          />
        }
        @if (fileError()) {
          <p
            class="font-sans text-body-sm text-(--sd-dialog-danger-text)"
            role="alert"
          >
            {{ fileError() }}
          </p>
        }

        <!-- Document type -->
        <div class="flex flex-col gap-1.5">
          <label
            for="lab-upload-type"
            class="font-sans text-body-sm font-semibold text-(--sd-dialog-text)"
            >Document type</label
          >
          <div class="relative">
            <select
              id="lab-upload-type"
              class="w-full appearance-none rounded-[12px] border border-(--sd-dialog-field) bg-(--sd-dialog-surface) px-3.5 py-2.5 pr-10 font-sans text-body text-(--sd-dialog-text) focus:outline-none focus-visible:ring-2 focus-visible:ring-(--sd-dialog-ring)"
              [disabled]="uploading()"
              (change)="docType.set($any($event.target).value)"
            >
              @for (t of request().result_document_types; track t.value) {
                <option [value]="t.value" [selected]="t.value === docType()">
                  {{ t.label }}
                </option>
              }
            </select>
            <sd-icon
              name="chevron-down"
              [size]="18"
              class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-(--sd-dialog-muted)"
            />
          </div>
        </div>

        <!-- Which tests -->
        <fieldset
          class="flex flex-col gap-2"
          [attr.aria-describedby]="
            showItemsError() ? 'lab-upload-items-error' : null
          "
        >
          <legend
            class="mb-2 font-sans text-body-sm font-semibold text-(--sd-dialog-text)"
          >
            Which tests does this cover?
          </legend>
          @for (item of request().items; track item.id) {
            <label
              class="flex min-h-11 cursor-pointer items-center gap-3 rounded-card border border-(--sd-dialog-border) px-3 py-2 hover:bg-(--sd-dialog-hover)"
            >
              <input
                type="checkbox"
                class="size-5 shrink-0 accent-cerulean"
                [attr.data-item]="item.id"
                [checked]="itemIds().includes(item.id)"
                [disabled]="uploading()"
                (change)="toggleItem(item.id, $any($event.target).checked)"
              />
              <span
                class="min-w-0 font-sans text-body-sm text-(--sd-dialog-text)"
                >{{ item.label }}</span
              >
            </label>
          }
        </fieldset>
        @if (showItemsError()) {
          <p
            id="lab-upload-items-error"
            class="font-sans text-body-sm text-(--sd-dialog-danger-text)"
            role="alert"
          >
            {{ chooseTest }}
          </p>
        }

        <!-- The requesting doctor -->
        <div class="flex flex-col gap-2">
          <label
            class="flex cursor-pointer items-start gap-3 rounded-card border border-(--sd-dialog-border) p-3 hover:bg-(--sd-dialog-hover)"
          >
            <input
              type="checkbox"
              class="mt-0.5 size-5 shrink-0 accent-cerulean"
              data-testid="lab-share"
              [checked]="share()"
              [disabled]="uploading()"
              [attr.aria-describedby]="shareDescribedBy()"
              (change)="share.set($any($event.target).checked)"
            />
            <span class="flex min-w-0 flex-col gap-1">
              <span
                class="font-sans text-body-sm font-semibold text-(--sd-dialog-strong)"
                >Share this result with {{ doctor() }}</span
              >
              <span
                id="lab-upload-share-note"
                class="font-sans text-caption text-(--sd-dialog-muted)"
                >{{ doctorCap() }} can view and print it in VideoMed, but not
                download it.</span
              >
              @if (stoppedSharing()) {
                <span
                  id="lab-upload-share-ended"
                  class="font-sans text-caption text-(--sd-dialog-muted)"
                  >You stopped sharing this request's results with
                  {{ doctor() }}. Tick to share this file with them.</span
                >
              }
            </span>
          </label>
          @if (viewWarning(); as w) {
            <p
              class="flex items-start gap-2 rounded-[12px] bg-(--sd-dialog-warning-soft) px-3.5 py-2.5 font-sans text-body-sm text-(--sd-dialog-warning-text)"
              data-testid="lab-view-warning"
            >
              <sd-icon
                name="triangle-alert"
                [size]="18"
                class="mt-0.5 shrink-0"
              />{{ w }}
            </p>
          }
        </div>

        <!-- Doctors who can see the whole folder: asked at upload, all unticked -->
        @if (!sharingOff()) {
          @if (doctorsLoading()) {
            <p
              class="flex items-center gap-2 font-sans text-body-sm text-(--sd-dialog-muted)"
              role="status"
            >
              <sd-icon
                name="loader-circle"
                [size]="16"
                class="shrink-0 motion-safe:animate-spin"
              />{{ folderChecking }}
            </p>
          } @else if (doctorsError()) {
            <div class="flex flex-col gap-2">
              <p
                class="flex items-start gap-2 rounded-[12px] bg-(--sd-dialog-danger-soft) px-3.5 py-2.5 font-sans text-body-sm text-(--sd-dialog-danger-text)"
                role="alert"
              >
                <sd-icon
                  name="triangle-alert"
                  [size]="18"
                  class="mt-0.5 shrink-0"
                />{{ folderError }}
              </p>
              <button
                type="button"
                class="min-h-11 w-fit rounded-field border border-(--sd-dialog-field) bg-(--sd-dialog-surface) px-5 font-sans text-body-sm font-semibold text-(--sd-dialog-text) transition-colors hover:bg-(--sd-dialog-hover) focus:outline-none focus-visible:ring-2 focus-visible:ring-(--sd-dialog-ring)"
                (click)="loadDoctors()"
              >
                Try again
              </button>
            </div>
          } @else if (folderDoctors().length > 0) {
            <fieldset class="flex flex-col gap-2">
              <legend
                class="mb-2 font-sans text-body-sm font-semibold text-(--sd-dialog-text)"
              >
                Doctors who can see your whole folder
              </legend>
              @for (d of folderDoctors(); track d.specialist.id) {
                <label
                  class="flex min-h-11 cursor-pointer items-start gap-3 rounded-card border border-(--sd-dialog-border) p-3 hover:bg-(--sd-dialog-hover)"
                >
                  <input
                    type="checkbox"
                    class="mt-0.5 size-5 shrink-0 accent-cerulean"
                    [attr.data-folder]="d.specialist.id"
                    [checked]="!!ticks()[d.specialist.id]"
                    [disabled]="uploading()"
                    (change)="
                      tick(d.specialist.id, $any($event.target).checked)
                    "
                  />
                  <span class="flex min-w-0 flex-col gap-0.5">
                    <span
                      class="font-sans text-body-sm font-semibold text-(--sd-dialog-strong)"
                      >Also let {{ dr(d.specialist.name) }} see this file</span
                    >
                    <span
                      class="font-sans text-caption text-(--sd-dialog-muted)"
                      >Whole folder {{ folderUntilOf(d) }}</span
                    >
                    @if (paused(d)) {
                      <span
                        class="inline-flex w-fit items-center gap-1 rounded-pill bg-(--sd-dialog-warning-soft) px-2.5 py-0.5 font-sans text-caption font-medium text-(--sd-dialog-warning-text)"
                      >
                        <sd-icon name="hourglass" [size]="12" />Paused — not
                        practising on VideoMed right now
                      </span>
                    }
                  </span>
                </label>
              }
            </fieldset>
          }
        }

        @if (uploading()) {
          <div class="flex flex-col gap-2">
            <p
              class="font-sans text-body-sm font-semibold text-(--sd-dialog-text)"
            >
              Uploading…
            </p>
            <div
              class="h-1.5 w-full overflow-hidden rounded-full bg-frost"
              role="progressbar"
              aria-label="Uploading…"
              aria-valuemin="0"
              aria-valuemax="100"
              [attr.aria-valuenow]="progress()"
            >
              <div
                class="h-full rounded-full bg-cerulean transition-[width] duration-200 motion-reduce:transition-none"
                [style.width.%]="progress()"
              ></div>
            </div>
          </div>
        }

        @if (error()) {
          <p
            class="flex items-start gap-2 rounded-[12px] bg-(--sd-dialog-danger-soft) px-3.5 py-2.5 font-sans text-body-sm text-(--sd-dialog-danger-text)"
            role="alert"
          >
            <sd-icon
              name="circle-alert"
              [size]="18"
              class="mt-0.5 shrink-0"
            /><span class="min-w-0 wrap-anywhere">{{ error() }}</span>
          </p>
        }
      </form>

      <div
        dialogFooter
        class="flex shrink-0 flex-col-reverse gap-3 px-5 pt-4 pb-5 sm:flex-row sm:px-6 sm:pb-6"
      >
        <button
          type="button"
          [class]="cancelClass"
          [attr.aria-disabled]="uploading() || null"
          (click)="close()"
        >
          Cancel
        </button>
        <button
          type="submit"
          form="lab-upload-form"
          [class]="confirmClass"
          [disabled]="!ready()"
          [attr.aria-disabled]="uploading() || null"
        >
          @if (uploading()) {
            <sd-icon
              name="loader-circle"
              [size]="18"
              class="motion-safe:animate-spin"
            />
          }
          Upload
        </button>
      </div>
    </sd-dialog>
  `,
})
export class LabResultUploadDialog implements OnInit {
  private readonly api = inject(LabRequestsApi);
  private readonly sharing = inject(DocumentSharingApi);
  private readonly destroyRef = inject(DestroyRef);

  readonly request = input.required<PatientLabRequestDto>();

  /** The result was stored (with the request as it is now). */
  readonly uploaded = output<LabResultUploadedDto>();
  /** 409 `status_changed`: nothing was stored; the host shows the message and reloads. */
  readonly refused = output<LabUploadRefused>();
  /** The dialog has closed (after its exit animation). */
  readonly closed = output<void>();

  protected readonly accept = LAB_RESULT_ACCEPT;
  protected readonly maxBytes = LAB_RESULT_MAX_BYTES;
  protected readonly chooseTest = LAB_CHOOSE_TEST;
  protected readonly folderChecking = LAB_FOLDER_CHECKING;
  protected readonly folderError = LAB_FOLDER_ERROR;
  protected readonly cancelClass =
    `${BUTTON} border border-(--sd-dialog-border) bg-(--sd-dialog-surface) text-(--sd-dialog-muted) ` +
    'hover:bg-(--sd-dialog-hover) hover:text-(--sd-dialog-text)';
  protected readonly confirmClass =
    `${BUTTON} text-(--sd-dialog-on-accent) bg-(--sd-dialog-primary) hover:bg-(--sd-dialog-primary-hover) inset-shadow-rim shadow-control ` +
    'disabled:cursor-not-allowed disabled:opacity-60';

  protected readonly open = signal(true);
  /** A file is on the wire (the page asks before leaving; the tab warns before closing). */
  readonly uploading = signal(false);
  protected readonly progress = signal(0);
  protected readonly file = signal<File | null>(null);
  protected readonly fileError = signal('');
  protected readonly docType = signal('');
  protected readonly itemIds = signal<string[]>([]);
  protected readonly share = signal(false);
  protected readonly tried = signal(false);
  protected readonly error = signal('');

  // ----- whole-folder holders -----
  protected readonly doctors = signal<SharingDoctorDto[]>([]);
  protected readonly doctorsLoading = signal(true);
  protected readonly doctorsError = signal(false);
  protected readonly sharingOff = signal(false);
  protected readonly ticks = signal<Record<string, boolean>>({});
  private ticksSet = false;
  private uploadSub: Subscription | null = null;

  protected readonly doctor = computed(() => labDoctor(this.request()));
  protected readonly doctorCap = computed(() => cap(this.doctor()));
  protected readonly stoppedSharing = computed(
    () => this.request().results_sharing === 'ended',
  );
  protected readonly shareDescribedBy = computed(() =>
    this.stoppedSharing()
      ? 'lab-upload-share-note lab-upload-share-ended'
      : 'lab-upload-share-note',
  );
  /** Folder holders other than the requesting doctor (the Share box decides for them). */
  protected readonly folderDoctors = computed(() => {
    const requester = this.request().doctor.id;
    return this.doctors().filter(
      (d) =>
        (holdsFolder(d) || holdsPausedFolder(d)) &&
        d.specialist.id !== requester,
    );
  });
  /** The list has loaded, or sharing is off: Upload may go (never without asking). */
  protected readonly ready = computed(
    () => !this.doctorsLoading() && (!this.doctorsError() || this.sharingOff()),
  );
  protected readonly showItemsError = computed(
    () => this.tried() && this.itemIds().length === 0,
  );
  /** D32: the requesting doctor can't open this file type (the share still goes ahead). */
  protected readonly viewWarning = computed(() => {
    const f = this.file();
    if (!this.share() || !f || isDoctorViewableName(f.name)) return '';
    const ext = fileExtension(f.name).toUpperCase();
    return ext
      ? `${this.doctorCap()} can't open ${ext} files in VideoMed. Share a PDF or photo.`
      : '';
  });

  constructor() {
    // Closing or reloading the tab mid-upload loses the file.
    warnBeforeUnload(() => this.uploading());
  }

  ngOnInit(): void {
    const r = this.request();
    this.docType.set(
      r.default_document_type || r.result_document_types[0]?.value || '',
    );
    this.itemIds.set(r.items.map((i) => i.id));
    this.share.set(shareDefault(r));
    this.loadDoctors();
  }

  protected loadDoctors(): void {
    this.doctorsLoading.set(true);
    this.doctorsError.set(false);
    this.sharing
      .doctors()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          const list = res.data ?? [];
          this.doctors.set(list);
          this.sharingOff.set(false);
          if (!this.ticksSet) {
            this.ticksSet = true;
            const folder = list
              .filter((d) => holdsFolder(d) || holdsPausedFolder(d))
              .map((d) => d.specialist.id);
            const paused = list
              .filter(holdsPausedFolder)
              .map((d) => d.specialist.id);
            this.ticks.set(
              defaultFolderTicks(folder, this.request().doctor.id, paused),
            );
          }
          this.doctorsLoading.set(false);
        },
        error: (err: unknown) => {
          this.doctorsLoading.set(false);
          if (isSharingUnavailable(err)) {
            // Sharing is off: the file is stored privately (the server says so too).
            this.sharingOff.set(true);
            this.doctors.set([]);
            return;
          }
          this.doctorsError.set(true);
        },
      });
  }

  /** For the page's leave guard. */
  readonly leaveCopy = (): LeaveCopy => ({
    title: 'Leave while uploading?',
    message: "Your result hasn't finished uploading and won't be saved.",
    confirmLabel: 'Leave anyway',
    cancelLabel: 'Stay',
  });

  protected close(): void {
    if (this.uploading()) return;
    this.open.set(false);
  }

  protected pick(files: File[]): void {
    const f = files[0];
    if (!f) return;
    const err = resultFileError(f);
    this.fileError.set(err);
    this.file.set(err ? null : f);
    this.error.set('');
  }

  protected onRejected(rejections: FileDropRejection[]): void {
    const r = rejections[0];
    if (!r) return;
    this.fileError.set(
      r.reason === 'size' ? LAB_FILE_SIZE_ERROR : LAB_FILE_TYPE_ERROR,
    );
  }

  protected removeFile(): void {
    this.file.set(null);
    this.fileError.set('');
  }

  protected toggleItem(id: string, on: boolean): void {
    this.itemIds.update((ids) =>
      on
        ? ids.includes(id)
          ? ids
          : [...ids, id]
        : ids.filter((x) => x !== id),
    );
  }

  protected tick(id: string, on: boolean): void {
    this.ticks.update((t) => ({ ...t, [id]: on }));
  }

  protected submit(event?: Event): void {
    event?.preventDefault();
    if (this.uploading() || !this.ready()) return;
    this.tried.set(true);
    this.error.set('');
    const f = this.file();
    if (!f) {
      this.fileError.set('Attach a file');
      return;
    }
    if (this.itemIds().length === 0) return;

    const r = this.request();
    const order = r.items.map((i) => i.id);
    const items = order.filter((id) => this.itemIds().includes(id));
    const exclude = this.sharingOff()
      ? []
      : this.folderDoctors()
          .map((d) => d.specialist.id)
          .filter((id) => !this.ticks()[id]);
    this.uploading.set(true);
    this.progress.set(0);
    this.uploadSub?.unsubscribe();
    this.uploadSub = this.api
      .uploadResult(r.id, f, {
        document_type: this.docType() || undefined,
        item_ids: items,
        share: this.share(),
        exclude_specialist_ids: exclude,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (event) => {
          if (event.type === HttpEventType.UploadProgress && event.total) {
            this.progress.set(
              Math.min(100, Math.round((event.loaded / event.total) * 100)),
            );
          } else if (event.type === HttpEventType.Response) {
            this.progress.set(100);
            this.uploading.set(false);
            const data = event.body?.data;
            if (data) this.uploaded.emit(data);
            this.open.set(false);
          }
        },
        error: (err: unknown) => {
          this.uploading.set(false);
          this.progress.set(0);
          if (apiErrorCode(err) === 'status_changed') {
            // Nothing was stored: the page says why and shows the request as it is now.
            this.refused.emit({
              message: apiErrorMessage(err, 'This request has changed.'),
            });
            this.open.set(false);
            return;
          }
          this.error.set(
            apiErrorMessage(
              err,
              "We couldn't add your result. Please try again.",
            ),
          );
        },
      });
  }

  // ----- display helpers -----
  protected size(bytes: number): string {
    return fileSizeLabel(bytes);
  }
  protected dr(name: string): string {
    return drName(name);
  }
  protected paused(d: SharingDoctorDto): boolean {
    return holdsPausedFolder(d);
  }
  protected folderUntilOf(d: SharingDoctorDto): string {
    const until = folderUntil(d);
    return until === 'No end date'
      ? 'with no end date'
      : until.replace(/^Until/, 'until');
  }
}
