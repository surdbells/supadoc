import { HttpEventType } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  OnInit,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  apiErrorMessage,
  DocumentsApi,
  openBlobDocument,
} from '@supadoc/data-access';
import type { DocumentTypeOption, MedicalDocumentDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';

type Step = '' | 'source' | 'type' | 'preview' | 'uploading' | 'success';

/** Accepted client-side (mirrors MedicalDocumentStorage on the server). */
const ACCEPT =
  '.pdf,.jpg,.jpeg,.png,.dcm,.docx,.doc,.mp4,.webm,.mov,application/pdf,image/jpeg,image/png,video/mp4,video/webm,video/quicktime';
const ALLOWED_EXT = ['pdf', 'jpg', 'jpeg', 'png', 'dcm', 'docx', 'doc', 'mp4', 'webm', 'mov'];
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * Medical documents (route `/dashboard/documents`) — the patient's record
 * library plus the upload flow (source → type → preview → progress → success).
 * Files are streamed back through an authenticated endpoint, opened in a new tab.
 */
@Component({
  selector: 'pat-documents',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <header class="flex flex-wrap items-start justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">Medical Document</h1>
          <p class="font-sans text-body text-slate">All your reports, scans, and prescriptions in one place.</p>
        </div>
        @if (hasAny()) {
          <button type="button" class="flex items-center gap-2 rounded-field bg-cerulean px-5 py-3 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean" (click)="startUpload()">
            <sd-icon name="upload" [size]="18" />Upload Document
          </button>
        }
      </header>

      @if (loading() && docs().length === 0) {
        <div class="flex flex-col gap-3">
          @for (i of [1,2,3]; track i) { <div class="sd-shimmer h-20 rounded-card"></div> }
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

    <!-- Hidden file inputs -->
    <input #fileInputEl type="file" class="hidden" [attr.accept]="accept" (change)="onFilePicked($event)" />
    <input #cameraInputEl type="file" class="hidden" accept="image/*" capture="environment" (change)="onFilePicked($event)" />

    <!-- Upload modal -->
    @if (step() !== '') {
      <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <button type="button" class="absolute inset-0 cursor-default bg-abyss/40" aria-label="Close" (click)="close()"></button>
        <div class="relative z-10 flex w-full max-w-lg flex-col gap-6 rounded-[16px] bg-white p-6 shadow-[0_4px_24px_rgba(10,22,40,0.16)]">

          @switch (step()) {
            @case ('source') {
              <div class="flex items-start justify-between border-b border-cloud pb-4">
                <div class="flex flex-col gap-1">
                  <h3 class="font-heading text-h5 text-ink">Upload Document</h3>
                  <p class="font-sans text-body-sm text-slate">Choose how you want to upload your document</p>
                </div>
                <button type="button" class="text-slate hover:text-ink" aria-label="Close" (click)="close()"><sd-icon name="x" [size]="22" /></button>
              </div>
              <button type="button" class="flex items-center gap-4 rounded-card border border-cloud p-5 text-left transition-colors hover:border-cerulean" (click)="cameraInput().nativeElement.click()">
                <span class="flex size-12 shrink-0 items-center justify-center rounded-full bg-frost text-cerulean"><sd-icon name="camera" [size]="22" /></span>
                <span class="flex flex-col"><span class="font-sans text-body font-semibold text-ink">Take photo</span><span class="font-sans text-body-sm text-slate">Use your camera to capture the document</span></span>
              </button>
              <button type="button" class="flex items-center gap-4 rounded-card border border-cloud p-5 text-left transition-colors hover:border-cerulean" (click)="fileInput().nativeElement.click()">
                <span class="flex size-12 shrink-0 items-center justify-center rounded-full bg-frost text-cerulean"><sd-icon name="folder-open" [size]="22" /></span>
                <span class="flex flex-col"><span class="font-sans text-body font-semibold text-ink">Choose from file</span><span class="font-sans text-body-sm text-slate">Select from gallery or files</span></span>
              </button>
              <div class="rounded-card bg-frost/50 p-4 font-sans text-body-sm text-slate">
                <p><span class="font-semibold text-ink">Supported Size:</span> Maximum of 10mb</p>
                <p class="mt-1"><span class="font-semibold text-ink">Supported format:</span> DICOM (.dcm), PDF, JPG, PNG, DOCX, or video</p>
              </div>
              @if (fileError()) { <p class="font-sans text-caption text-alert">{{ fileError() }}</p> }
              <div class="flex gap-3">
                <button type="button" class="flex-1 rounded-field border border-cloud py-3 font-sans text-body font-semibold text-slate transition-colors hover:bg-glacier" (click)="close()">Cancel</button>
              </div>
            }

            @case ('type') {
              <div class="flex items-start justify-between border-b border-cloud pb-4">
                <div class="flex flex-col gap-1">
                  <h3 class="font-heading text-h5 text-ink">Document Type</h3>
                  <p class="font-sans text-body-sm text-slate">Select the type of document</p>
                </div>
                <button type="button" class="text-slate hover:text-ink" aria-label="Close" (click)="close()"><sd-icon name="x" [size]="22" /></button>
              </div>
              <div class="flex items-center justify-between gap-3 rounded-field border border-cloud px-4 py-3">
                <span class="flex min-w-0 items-center gap-2"><sd-icon name="file-text" [size]="18" class="shrink-0 text-slate" /><span class="truncate font-sans text-body-sm text-ink">{{ file()?.name }}</span></span>
                <span class="flex shrink-0 items-center gap-3"><span class="font-sans text-caption text-slate">{{ fileSizeLabel() }}</span><button type="button" class="text-slate hover:text-alert" aria-label="Remove" (click)="clearFile()"><sd-icon name="x" [size]="18" /></button></span>
              </div>
              <label class="flex flex-col gap-1.5">
                <span class="font-sans text-body-sm text-slate">Document Type</span>
                <div class="relative">
                  <select class="w-full appearance-none rounded-field border border-cloud bg-white px-4 py-3 pr-10 font-sans text-body-sm text-ink outline-none focus:border-cerulean" [value]="selectedType()" (change)="selectedType.set($any($event.target).value)">
                    <option value="">Select type</option>
                    @for (t of types(); track t.value) { <option [value]="t.value">{{ t.label }}</option> }
                  </select>
                  <sd-icon name="chevron-down" [size]="18" class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate" />
                </div>
              </label>
              @if (selectedType() === 'other') {
                <label class="flex flex-col gap-1.5">
                  <span class="font-sans text-body-sm text-slate">Others (Specify)</span>
                  <input class="rounded-field border border-cloud px-4 py-3 font-sans text-body-sm text-ink outline-none focus:border-cerulean" placeholder="Enter document type" [value]="customType()" (input)="customType.set($any($event.target).value)" />
                </label>
              }
              @if (fileError()) { <p class="font-sans text-caption text-alert">{{ fileError() }}</p> }
              <div class="flex gap-3">
                <button type="button" class="flex-1 rounded-field border border-cloud py-3 font-sans text-body font-semibold text-slate transition-colors hover:bg-glacier" (click)="close()">Cancel</button>
                <button type="button" class="flex-1 rounded-field bg-cerulean py-3 font-sans text-body font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-50" [disabled]="!canContinueType()" (click)="step.set('preview')">Continue</button>
              </div>
            }

            @case ('preview') {
              <div class="flex items-start justify-between border-b border-cloud pb-4">
                <div class="flex flex-col gap-1">
                  <h3 class="font-heading text-h5 text-ink">Preview</h3>
                  <p class="font-sans text-body-sm text-slate">Confirm before upload</p>
                </div>
                <button type="button" class="text-slate hover:text-ink" aria-label="Close" (click)="close()"><sd-icon name="x" [size]="22" /></button>
              </div>
              <div class="flex items-center gap-4 rounded-card border border-cloud p-5">
                <span class="flex size-12 shrink-0 items-center justify-center rounded-full bg-glacier text-slate"><sd-icon name="file-text" [size]="22" /></span>
                <span class="flex min-w-0 flex-col">
                  <span class="truncate font-sans text-body font-semibold text-ink">{{ file()?.name }} <span class="font-normal text-slate">({{ fileSizeLabel() }})</span></span>
                  <span class="font-sans text-body-sm text-slate">{{ selectedTypeLabel() }}</span>
                </span>
              </div>
              @if (fileError()) { <p class="font-sans text-caption text-alert">{{ fileError() }}</p> }
              <div class="flex gap-3">
                <button type="button" class="flex-1 rounded-field border border-cloud py-3 font-sans text-body font-semibold text-slate transition-colors hover:bg-glacier" (click)="step.set('type')">Cancel</button>
                <button type="button" class="flex-1 rounded-field bg-cerulean py-3 font-sans text-body font-semibold text-white transition-colors hover:bg-ocean" (click)="doUpload()">Upload</button>
              </div>
            }

            @case ('uploading') {
              <div class="flex items-start justify-between border-b border-cloud pb-4">
                <div class="flex flex-col gap-1">
                  <h3 class="font-heading text-h5 text-ink">Uploading</h3>
                  <p class="font-sans text-body-sm text-slate">It will take a few seconds</p>
                </div>
              </div>
              <div class="flex items-center gap-4 rounded-card border border-cloud p-5">
                <span class="flex size-12 shrink-0 items-center justify-center rounded-full bg-glacier text-slate"><sd-icon name="file-text" [size]="22" /></span>
                <span class="flex min-w-0 flex-col">
                  <span class="truncate font-sans text-body font-semibold text-ink">{{ file()?.name }} <span class="font-normal text-slate">({{ fileSizeLabel() }})</span></span>
                  <span class="font-sans text-body-sm text-slate">{{ selectedTypeLabel() }}</span>
                </span>
              </div>
              <div class="h-2 w-full overflow-hidden rounded-full bg-frost">
                <div class="h-full rounded-full bg-cerulean transition-[width] duration-200" [style.width.%]="progress()"></div>
              </div>
              @if (fileError()) {
                <p class="font-sans text-caption text-alert">{{ fileError() }}</p>
                <div class="flex gap-3">
                  <button type="button" class="flex-1 rounded-field border border-cloud py-3 font-sans text-body font-semibold text-slate transition-colors hover:bg-glacier" (click)="step.set('preview')">Back</button>
                  <button type="button" class="flex-1 rounded-field bg-cerulean py-3 font-sans text-body font-semibold text-white transition-colors hover:bg-ocean" (click)="doUpload()">Retry</button>
                </div>
              }
            }

            @case ('success') {
              <div class="flex flex-col items-center gap-4 py-4 text-center">
                <span class="flex size-16 items-center justify-center rounded-full bg-sage text-white"><sd-icon name="check" [size]="34" /></span>
                <div class="flex flex-col gap-1">
                  <h3 class="font-heading text-h4 text-ink">Document uploaded</h3>
                  <p class="font-sans text-body text-slate">Your document has been successfully added to your medical records.</p>
                </div>
                <div class="flex w-full items-center gap-4 rounded-card border border-cloud p-4 text-left">
                  <span class="flex size-11 shrink-0 items-center justify-center rounded-full bg-glacier text-slate"><sd-icon name="file-text" [size]="20" /></span>
                  <span class="flex min-w-0 flex-col">
                    <span class="truncate font-sans text-body-sm font-semibold text-ink">{{ uploaded()?.title }} <span class="font-normal text-slate">({{ uploaded()?.extension }}. {{ uploaded()?.size_label }})</span></span>
                    <span class="font-sans text-body-sm text-slate">{{ uploaded()?.type_label }}</span>
                  </span>
                </div>
                <button type="button" class="w-full rounded-field bg-cerulean py-3.5 font-sans text-body font-semibold text-white transition-colors hover:bg-ocean" (click)="close()">View Medical records</button>
                <button type="button" class="font-sans text-body font-semibold text-cerulean transition-colors hover:text-ocean" (click)="startUpload()">Upload another</button>
              </div>
            }
          }
        </div>
      </div>
    }
  `,
})
export class PatientDocuments implements OnInit {
  private readonly api = inject(DocumentsApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly accept = ACCEPT;
  protected readonly fileInput = viewChild.required<ElementRef<HTMLInputElement>>('fileInputEl');
  protected readonly cameraInput = viewChild.required<ElementRef<HTMLInputElement>>('cameraInputEl');

  // List state
  protected readonly docs = signal<MedicalDocumentDto[]>([]);
  protected readonly loading = signal(true);
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

  // Upload modal state
  protected readonly step = signal<Step>('');
  protected readonly file = signal<File | null>(null);
  protected readonly selectedType = signal('');
  protected readonly customType = signal('');
  protected readonly fileError = signal('');
  protected readonly progress = signal(0);
  protected readonly uploaded = signal<MedicalDocumentDto | null>(null);

  ngOnInit(): void {
    this.api.types().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => this.types.set(res.data),
      error: () => undefined,
    });
    this.reload();
  }

  // ----- List -----
  private reload(): void {
    this.loading.set(true);
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
        error: () => this.loading.set(false),
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
    this.file.set(null);
    this.selectedType.set('');
    this.customType.set('');
    this.fileError.set('');
    this.progress.set(0);
    this.step.set('source');
  }

  protected close(): void {
    const wasSuccess = this.step() === 'success';
    this.step.set('');
    this.fileError.set('');
    if (wasSuccess) {
      this.page = 1;
      this.reload();
    }
  }

  protected onFilePicked(event: Event): void {
    const input = event.target as HTMLInputElement;
    const picked = input.files?.[0] ?? null;
    input.value = ''; // allow re-picking the same file
    if (!picked) return;
    const err = this.validate(picked);
    if (err) {
      this.fileError.set(err);
      return;
    }
    this.fileError.set('');
    this.file.set(picked);
    this.step.set('type');
  }

  private validate(f: File): string | null {
    if (f.size > MAX_BYTES) return 'File must be 10MB or smaller.';
    const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
    if (!ALLOWED_EXT.includes(ext)) return 'Unsupported file type. Use PDF, JPG, PNG, DOCX, DICOM or video.';
    return null;
  }

  protected clearFile(): void {
    this.file.set(null);
    this.step.set('source');
  }

  protected canContinueType(): boolean {
    if (!this.file() || this.selectedType() === '') return false;
    if (this.selectedType() === 'other' && this.customType().trim() === '') return false;
    return true;
  }

  protected doUpload(): void {
    const f = this.file();
    if (!f) return;
    this.fileError.set('');
    this.progress.set(0);
    this.step.set('uploading');

    this.api
      .upload(f, this.selectedType(), this.selectedType() === 'other' ? this.customType().trim() : undefined)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (event) => {
          if (event.type === HttpEventType.UploadProgress && event.total) {
            this.progress.set(Math.round((event.loaded / event.total) * 100));
          } else if (event.type === HttpEventType.Response) {
            const doc = event.body?.data ?? null;
            this.progress.set(100);
            this.uploaded.set(doc);
            if (doc) this.docs.update((list) => [doc, ...list]);
            this.hasAny.set(true);
            this.step.set('success');
          }
        },
        error: (err) => {
          this.fileError.set(apiErrorMessage(err, 'Upload failed. Please try again.'));
        },
      });
  }

  // ----- Display helpers -----
  protected fileSizeLabel(): string {
    const f = this.file();
    if (!f) return '';
    return f.size >= 1024 * 1024
      ? `${(f.size / (1024 * 1024)).toFixed(f.size >= 10 * 1024 * 1024 ? 0 : 1).replace(/\.0$/, '')}mb`
      : `${Math.round(f.size / 1024)}kb`;
  }
  protected selectedTypeLabel(): string {
    if (this.selectedType() === 'other') return this.customType().trim() || 'Other';
    return this.types().find((t) => t.value === this.selectedType())?.label ?? '';
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
