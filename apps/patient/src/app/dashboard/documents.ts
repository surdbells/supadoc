import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  OnInit,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';
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
  UploadedDocumentDto,
} from '@supadoc/models';
import type { HasUnsavedChanges } from '@supadoc/auth';
import { AlertComponent, IconComponent, type LeaveCopy } from '@supadoc/ui';
import { AccessRequestsBanner } from './access-requests-banner';
import { type ApproveOutcome, approveOutcomeLine } from './approve-request-dialog';
import { DocumentAccessDialog } from './document-access-dialog';
import { type AccessChip, accessChip } from './document-sharing';
import { DocumentUploadDialog } from './document-upload-dialog';

/** How many recent prescriptions the documents page previews. */
const RX_PREVIEW = 3;

/** Every prescription status reads as an icon AND a word — never colour alone. */
const RX_STATUS: Record<PrescriptionStatus, { label: string; icon: string; cls: string }> = {
  draft: { label: 'Draft', icon: 'pen-line', cls: 'bg-warning/15 text-warning-ink' },
  active: { label: 'Active', icon: 'circle-check', cls: 'bg-sage/15 text-sage-ink' },
  expired: { label: 'Expired', icon: 'hourglass', cls: 'bg-cloud text-slate' },
  cancelled: { label: 'Cancelled', icon: 'circle-x', cls: 'bg-alert/10 text-alert-ink' },
};

/**
 * Medical documents (route `/dashboard/documents`) — the patient's record
 * library (the Figma page) plus, for sharing: one line saying doctors only see
 * what the patient shares (→ Manage sharing), doctors' pending requests, and
 * per row who can see the document (chip + an access button opening "Who can
 * see this document"). Uploads go through the upload dialog, which asks who
 * can see the files. Files are streamed back through an authenticated
 * endpoint, opened in a new tab.
 */
@Component({
  selector: 'pat-documents',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AccessRequestsBanner,
    AlertComponent,
    DocumentAccessDialog,
    DocumentUploadDialog,
    IconComponent,
    RouterLink,
  ],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <header class="flex flex-wrap items-start justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">Medical Document</h1>
          <p class="font-sans text-body text-slate">All your reports, scans, and prescriptions in one place.</p>
          <p class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-sans text-body-sm text-slate">
            <span class="inline-flex items-center gap-1.5"><sd-icon name="shield-check" [size]="16" class="shrink-0 text-sage" />Doctors only see what you share.</span>
            <a routerLink="/dashboard/documents/sharing" class="inline-flex min-h-11 items-center gap-1 font-semibold text-cerulean transition-colors hover:text-ocean sm:min-h-0">
              Manage sharing<sd-icon name="chevron-right" [size]="16" />
            </a>
          </p>
        </div>
        @if (hasAny()) {
          <button #headerUpload type="button" class="flex items-center gap-2 rounded-field bg-cerulean px-5 py-3 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean" (click)="startUpload()">
            <sd-icon name="upload" [size]="18" />Upload Document
          </button>
        }
      </header>

      @if (notice()) {
        <sd-alert tone="success">{{ notice() }}</sd-alert>
      }

      <!-- Prescriptions sent by your doctors (the PDF opens in a new tab) -->
      @if (rxLoading()) {
        <div class="sd-shimmer h-24 rounded-card"></div>
      } @else if (rxLoadError()) {
        <section class="flex flex-col gap-3 rounded-card border border-haze bg-white p-4 shadow-card sm:p-5">
          <span class="flex items-center gap-2 font-sans text-body font-semibold text-ink">
            <sd-icon name="pill" [size]="20" class="text-slate" />Prescriptions
          </span>
          <p class="flex items-start gap-2 font-sans text-body-sm text-alert" role="alert">
            <sd-icon name="triangle-alert" [size]="18" class="mt-0.5 shrink-0" />{{ rxLoadError() }}
          </p>
          <button type="button" class="w-fit rounded-field border border-haze bg-white px-5 py-2 font-sans text-body-sm font-semibold text-cerulean shadow-control transition hover:border-cerulean active:shadow-none disabled:shadow-none" (click)="loadPrescriptions()">
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
              <li class="flex flex-col gap-3 rounded-card border border-haze bg-white p-4 shadow-card sm:flex-row sm:items-center sm:gap-4">
                <div class="flex min-w-0 flex-1 items-start gap-4 sm:items-center">
                  <span class="flex size-11 shrink-0 items-center justify-center rounded-lg bg-teal/10 text-teal-ink">
                    <sd-icon name="pill" [size]="20" />
                  </span>
                  <span class="flex min-w-0 flex-col gap-1">
                    <span class="flex flex-wrap items-center gap-2">
                      <span class="font-sans text-body-sm font-semibold text-ink">{{ rx.number }}</span>
                      <span class="inline-flex items-center gap-1 rounded-pill px-2.5 py-0.5 font-sans text-caption font-medium inset-ring inset-ring-current/20" [class]="rxStatus(rx.status).cls">
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
                    class="inline-flex items-center gap-1.5 rounded-field border border-haze bg-white px-3 py-1.5 font-sans text-caption font-semibold text-cerulean shadow-control transition hover:border-cerulean active:shadow-none disabled:opacity-60 disabled:shadow-none"
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

      <!-- Doctors asking to see the documents (only when some are pending) -->
      <pat-access-requests-banner [openRequestId]="requestId()" (opened)="dropRequestParam()" (handled)="answered($event)" />

      @if (loading() && docs().length === 0) {
        <div class="flex flex-col gap-3">
          @for (i of [1,2,3]; track i) { <div class="sd-shimmer h-20 rounded-card"></div> }
        </div>
      } @else if (loadError() && !hasAny()) {
        <div class="flex flex-col items-center gap-4 py-20 text-center">
          <p class="font-sans text-body-sm text-alert">{{ loadError() }}</p>
          <button type="button" class="rounded-field border border-haze bg-white px-6 py-2.5 font-sans text-body-sm font-semibold text-cerulean shadow-control transition hover:border-cerulean active:shadow-none disabled:shadow-none" (click)="reload()">
            Try again
          </button>
        </div>
      } @else if (!hasAny()) {
        <!-- Empty state (sd-es: shares sd-empty-state's dark-mode disc rule in styles.css) -->
        <div class="sd-es flex flex-col items-center gap-5 py-20 text-center">
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
          <div class="flex min-w-[220px] flex-1 items-center gap-2 rounded-field border border-haze bg-white px-4 py-2.5 shadow-control hover:border-cerulean/30">
            <sd-icon name="search" [size]="18" class="text-slate" />
            <input
              type="search"
              placeholder="Search Document"
              aria-label="Search documents"
              class="min-w-0 flex-1 bg-transparent font-sans text-body-sm text-ink outline-none placeholder:text-slate"
              [value]="search()"
              (input)="onSearch($any($event.target).value)"
            />
          </div>
          <div class="relative">
            <select
              aria-label="Filter by type"
              class="appearance-none rounded-field border border-haze bg-white py-2.5 pl-9 pr-9 font-sans text-body-sm text-ink shadow-control outline-none transition focus:border-cerulean active:shadow-none disabled:shadow-none"
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
            class="flex items-center gap-2 rounded-field border border-haze bg-white px-4 py-2.5 font-sans text-body-sm text-ink shadow-control transition hover:border-cerulean active:shadow-none disabled:shadow-none"
            (click)="toggleSort()"
          >
            <sd-icon name="arrow-up-down" [size]="16" class="text-slate" />
            Sort: <span class="font-semibold">{{ sortDir() === 'desc' ? 'Newest' : 'Oldest' }}</span>
          </button>
        </div>

        @if (loadError()) {
          <p class="font-sans text-body-sm text-alert">{{ loadError() }}</p>
        }

        <!-- List: per row the open button and, beside it (never nested), who can see it -->
        <ul class="flex flex-col gap-3">
          @for (d of docs(); track d.id) {
            <li class="flex items-center gap-1 rounded-card border border-haze bg-white pr-2 shadow-card transition hover:border-cerulean/40 hover:shadow-card-hover">
              <button
                type="button"
                class="flex min-w-0 flex-1 items-center gap-4 rounded-card p-4 text-left"
                (click)="open(d)"
              >
                <span class="flex size-11 shrink-0 items-center justify-center rounded-lg bg-glacier text-slate">
                  <sd-icon name="file-text" [size]="20" />
                </span>
                <span class="flex min-w-0 flex-1 flex-col">
                  <span class="truncate font-sans text-body-sm font-semibold text-ink">{{ d.title }}</span>
                  <span class="font-sans text-caption uppercase text-slate">{{ d.extension }}. {{ d.size_label }}</span>
                  @if (chip(d); as c) {
                    <span class="mt-1 inline-flex w-fit max-w-full items-center gap-1 rounded-pill px-2.5 py-0.5 font-sans text-caption font-medium inset-ring inset-ring-current/20 md:hidden" [class]="c.cls">
                      <sd-icon [name]="c.icon" [size]="12" class="shrink-0" /><span class="truncate">{{ c.label }}</span>
                    </span>
                  }
                </span>
                <span class="hidden min-w-0 flex-1 truncate font-sans text-body-sm text-ink sm:block">{{ d.type_label }}</span>
                @if (chip(d); as c) {
                  <span class="hidden min-w-0 max-w-[13rem] flex-col items-start gap-0.5 md:flex">
                    <span class="inline-flex max-w-full items-center gap-1 rounded-pill px-2.5 py-0.5 font-sans text-caption font-medium inset-ring inset-ring-current/20" [class]="c.cls">
                      <sd-icon [name]="c.icon" [size]="12" class="shrink-0" /><span class="truncate">{{ c.label }}</span>
                    </span>
                    @if (c.until) { <span class="font-sans text-caption text-slate">{{ c.until }}</span> }
                  </span>
                }
                <span class="hidden font-sans text-body-sm text-slate md:block">{{ date(d.created_at) }}</span>
                <span class="hidden shrink-0 rounded-pill px-3 py-1 font-sans text-caption font-medium inset-ring inset-ring-current/15 sm:inline" [class]="badgeClass(d.uploader_role)">{{ badgeLabel(d.uploader_role) }}</span>
                <!-- Figma's "open" chevron from sm up (at 375 px the row keeps its width for the title and chip) -->
                <span class="hidden shrink-0 text-slate sm:inline-flex" aria-hidden="true"><sd-icon name="chevron-right" [size]="18" /></span>
              </button>
              <button
                type="button"
                class="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-slate transition-colors hover:bg-glacier hover:text-cerulean focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
                [attr.aria-label]="'Who can see ' + d.title"
                (click)="openAccess(d)"
              >
                <sd-icon name="users" [size]="20" />
              </button>
            </li>
          } @empty {
            <li class="rounded-card border border-haze bg-white px-5 py-16 text-center font-sans text-body-sm text-slate shadow-card">
              {{ loading() ? 'Loading…' : 'No documents match your search.' }}
            </li>
          }
        </ul>

        @if (hasMore()) {
          <button type="button" class="mx-auto rounded-field border border-haze bg-white px-6 py-2.5 font-sans text-body-sm font-semibold text-cerulean shadow-control transition hover:border-cerulean active:shadow-none disabled:opacity-60 disabled:shadow-none" [disabled]="loading()" (click)="loadMore()">
            {{ loading() ? 'Loading…' : 'Load more' }}
          </button>
        }
      }
    </div>

    @if (uploadOpen()) {
      <pat-document-upload-dialog surface="documents_page" (uploaded)="onUploaded($event)" (closed)="uploadClosed($event.uploaded)" />
    }
    @if (accessDoc(); as d) {
      <pat-document-access-dialog [document]="d" (changed)="accessChanged = true" (closed)="accessClosed()" />
    }
  `,
})
export class PatientDocuments implements OnInit, HasUnsavedChanges {
  private readonly api = inject(DocumentsApi);
  private readonly prescriptionsApi = inject(PrescriptionsApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly document = inject(DOCUMENT);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  /** The page-header Upload button — focus goes here when the empty-state opener is gone. */
  private readonly headerUpload = viewChild<ElementRef<HTMLElement>>('headerUpload');
  private readonly uploadDialog = viewChild(DocumentUploadDialog);

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

  // Types (the filter)
  protected readonly types = signal<DocumentTypeOption[]>([]);

  // Dialogs
  protected readonly uploadOpen = signal(false);
  protected readonly accessDoc = signal<MedicalDocumentDto | null>(null);
  protected accessChanged = false;
  /** `?request=` from a notification: the banner opens it. */
  protected readonly requestId = toSignal(this.route.queryParamMap.pipe(map((q) => q.get('request'))), {
    initialValue: this.route.snapshot.queryParamMap.get('request'),
  });
  protected readonly notice = signal('');

  ngOnInit(): void {
    this.api.types().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => this.types.set(res.data),
      error: () => undefined,
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

  /** Back to the first page (after something changed who can see what). */
  private refresh(): void {
    this.page = 1;
    this.reload();
  }

  protected onSearch(v: string): void {
    this.search.set(v);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.refresh(), 300);
  }
  protected onFilter(v: string): void {
    this.typeFilter.set(v);
    this.refresh();
  }
  protected toggleSort(): void {
    this.sortDir.update((d) => (d === 'desc' ? 'asc' : 'desc'));
    this.refresh();
  }
  protected loadMore(): void {
    this.page += 1;
    this.reload();
  }

  protected open(d: MedicalDocumentDto): void {
    openBlobDocument(this.api.fileBlob(d.id));
  }

  /** Who can see a document, as one chip (hidden when the API didn't say). */
  protected chip(d: MedicalDocumentDto): AccessChip | null {
    return accessChip(d.shared_with);
  }

  // ----- Sharing -----
  protected openAccess(d: MedicalDocumentDto): void {
    this.accessChanged = false;
    this.accessDoc.set(d);
  }

  protected accessClosed(): void {
    this.accessDoc.set(null);
    if (this.accessChanged) this.refresh();
  }

  /** A request was opened from `?request=`: drop the parameter so a reload doesn't reopen it. */
  protected dropRequestParam(): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { request: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  protected answered(outcome: ApproveOutcome): void {
    const line = approveOutcomeLine(outcome);
    // The success alert (role="status") announces itself: no second live region.
    if (line) this.notice.set(line);
    // An approval (also one the server already had) changes the row chips.
    if (outcome.kind !== 'stale') this.refresh();
  }

  // ----- Upload -----
  protected startUpload(): void {
    this.uploadOpen.set(true);
  }

  protected onUploaded(doc: UploadedDocumentDto): void {
    this.docs.update((list) => [doc, ...list.filter((d) => d.id !== doc.id)]);
    this.hasAny.set(true);
  }

  /** The dialog has gone: show what was uploaded, and keep focus on the page. */
  protected uploadClosed(uploaded: number): void {
    this.uploadOpen.set(false);
    if (uploaded > 0) this.refresh();
    // A first upload removes the empty-state button that opened the dialog.
    setTimeout(() => {
      const active = this.document.activeElement;
      if (!active || active === this.document.body) this.headerUpload()?.nativeElement.focus();
    });
  }

  /** `unsavedChangesGuard`: leaving with files picked, or a batch still uploading, asks first. */
  hasUnsavedChanges(): boolean {
    return this.uploadDialog()?.hasUnsavedChanges() ?? false;
  }

  /** The guard's prompt copy (the upload dialog's). */
  readonly leaveCopy = (): LeaveCopy => this.uploadDialog()?.leaveCopy() ?? {};

  // ----- Display helpers -----
  protected badgeLabel(role: string): string {
    return role === 'patient' ? 'Patient-upload' : role === 'doctor' ? 'Doctor-uploaded' : 'Staff-uploaded';
  }
  protected badgeClass(role: string): string {
    return role === 'patient'
      ? 'bg-sage/15 text-sage-ink'
      : role === 'doctor'
        ? 'bg-warning/15 text-warning-ink'
        : 'bg-cloud text-slate';
  }
  protected date(iso: string): string {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(iso));
  }
}
