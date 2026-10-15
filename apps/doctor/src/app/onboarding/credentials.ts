import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  Injector,
  OnInit,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { apiErrorFields, apiErrorMessage, DoctorApi, openBlobDocument, todayLocal } from '@supadoc/data-access';
import type { CredentialType, DoctorCredentialsDto, SpecialistCredentialDto } from '@supadoc/models';
import {
  AlertComponent,
  ButtonComponent,
  ConfirmDialogComponent,
  type FileDropRejection,
  FileDropComponent,
  IconComponent,
} from '@supadoc/ui';
import { DoctorStandingStore } from '../standing/doctor-standing.store';
import { latestCredential, licenceDocuments, renewalText, ymdLabel } from '../standing/standing-rules';
import { CredentialStatusChip } from './credential-status';

const FIELD =
  'min-h-11 w-full rounded-field border border-[#b8c6d4] bg-white px-4 py-2.5 font-sans text-body-sm text-ink placeholder:text-slate/50 focus:border-cerulean focus:outline-none focus:ring-2 focus:ring-cerulean/20 aria-[invalid=true]:border-alert';
const LABEL = 'font-sans text-body-sm font-semibold text-ink';
const ACTION =
  'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-field border border-cloud bg-white px-3 py-2 font-sans text-caption font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 disabled:opacity-60';

/** The two documents every doctor must have verified, in the order they are asked for. */
const REQUIRED: readonly { type: CredentialType; label: string; hint: string }[] = [
  {
    type: 'mdcn_full_registration',
    label: 'MDCN full-registration certificate',
    hint: 'Your certificate of full registration with the Medical and Dental Council of Nigeria.',
  },
  {
    type: 'annual_practising_licence',
    label: 'Annual practising licence',
    hint: 'Your current APL, with its number and expiry date. Upload the renewal before it runs out.',
  },
];

/** What a file the picker turned away needs instead. */
function rejectionText(r: FileDropRejection, maxBytes: number): string {
  return r.reason === 'size'
    ? `“${r.file.name}” is larger than ${Math.round(maxBytes / 1_048_576)}MB. Upload a smaller scan or photo.`
    : `“${r.file.name}” isn't a PDF, JPG or PNG file.`;
}

/**
 * Licensing documents (route `/onboarding/credentials`): the doctor uploads
 * their MDCN full-registration certificate, current annual practising licence
 * (number + expiry) and any specialist certificates; sees each one's review
 * state and a reviewer's reason for turning one down; replaces, views (their
 * own file only, from a blob) or deletes one still waiting for review. Files
 * are stored encrypted; only the doctor and VideoMed reviewers can open them.
 * Open whatever the doctor's standing (a suspended doctor renews here).
 */
@Component({
  selector: 'doc-credentials',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    AlertComponent,
    ButtonComponent,
    ConfirmDialogComponent,
    CredentialStatusChip,
    FileDropComponent,
    IconComponent,
  ],
  host: { class: 'block' },
  template: `
    <div class="flex max-w-3xl flex-col gap-6 py-2">
      <div class="flex items-start justify-between gap-4">
        <header class="flex flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">Licensing documents</h1>
          <p class="font-sans text-body text-slate">
            Reviewers verify your documents against the MDCN register. They're stored encrypted, and only you and VideoMed reviewers can open them.
          </p>
        </header>
        <a [routerLink]="backLink()" class="flex min-h-11 shrink-0 items-center gap-1 font-sans text-body text-slate transition-colors hover:text-cerulean">
          <sd-icon name="chevron-left" [size]="18" />Back
        </a>
      </div>

      @if (loading()) {
        <div class="sd-shimmer h-40 rounded-card" aria-hidden="true"></div>
        <div class="sd-shimmer h-72 rounded-card" aria-hidden="true"></div>
        <span class="sr-only" role="status">Loading your documents…</span>
      } @else if (loadError()) {
        <div class="flex flex-col items-center gap-3 rounded-card border border-cloud bg-white px-5 py-16 text-center">
          <sd-icon name="wifi-off" [size]="32" class="text-alert" />
          <p class="font-sans text-body-sm text-slate">{{ loadError() }}</p>
          <sd-button variant="outline" size="sm" (click)="load()"><sd-icon name="refresh-cw" [size]="16" />Try again</sd-button>
        </div>
      } @else if (data(); as d) {
        <!-- The two required documents, at a glance -->
        <section class="grid gap-3 sm:grid-cols-2" aria-label="Required documents">
          @for (r of required; track r.type) {
            @let doc = latest(r.type);
            <div class="flex flex-col gap-3 rounded-card border border-cloud bg-white p-4 sm:p-5">
              <div class="flex flex-col gap-2">
                <span class="font-heading text-body font-semibold text-ink">{{ r.label }}</span>
                <doc-credential-status [status]="doc?.status ?? 'missing'" />
              </div>
              <p class="font-sans text-caption text-slate">{{ docSummary(doc) || r.hint }}</p>
              @if (doc?.status === 'rejected' && doc?.rejection_reason) {
                <p class="whitespace-pre-line break-words rounded-field bg-alert/10 px-3 py-2 font-sans text-caption text-alert">
                  <span class="font-semibold">Reviewer's note:</span> {{ doc?.rejection_reason }}
                </p>
              }
              @if (r.type === 'annual_practising_licence' && licenceRenewal(); as renewal) {
                <!-- A renewal beside the licence in force: said on its own line. -->
                <p class="flex items-start gap-1.5 font-sans text-caption" [class]="renewal.status === 'rejected' ? 'text-alert' : 'text-slate'">
                  <sd-icon [name]="renewal.status === 'rejected' ? 'circle-x' : 'hourglass'" [size]="13" class="mt-0.5 shrink-0" />
                  <span class="min-w-0 whitespace-pre-line break-words">{{ renewalText(renewal) }}</span>
                </p>
              }
              <button type="button" class="${ACTION} mt-auto w-fit text-cerulean hover:border-cerulean" (click)="startUpload(r.type)">
                <sd-icon name="upload" [size]="16" />{{ doc ? (r.type === 'annual_practising_licence' ? 'Upload renewal' : 'Replace') : 'Upload' }}
                <span class="sr-only">— {{ r.label }}</span>
              </button>
            </div>
          }
        </section>

        <!-- Upload -->
        <section class="flex flex-col gap-5 rounded-card border border-cloud bg-white p-5 sm:p-6" aria-labelledby="upload-title">
          <div class="flex flex-col gap-1">
            <h2 #uploadTitle id="upload-title" tabindex="-1" class="flex items-center gap-2 font-heading text-body-lg text-ink outline-none">
              <sd-icon name="upload" [size]="20" class="text-cerulean" />Upload a document
            </h2>
            <p class="font-sans text-caption text-slate">PDF, JPG or PNG, up to {{ maxMb() }}MB. A new MDCN certificate or licence replaces the one waiting for review.</p>
          </div>

          <form class="flex flex-col gap-5" novalidate (submit)="$event.preventDefault(); upload()">
            <div class="flex flex-col gap-1.5">
              <label class="${LABEL}" for="cred-type">Document type <span class="text-alert" aria-hidden="true">*</span></label>
              <select
                #typeSelect
                id="cred-type"
                class="${FIELD}"
                required
                [attr.aria-invalid]="fieldError('type') ? 'true' : null"
                [attr.aria-describedby]="fieldError('type') ? 'cred-type-error' : null"
                (change)="setType($any($event.target).value)"
              >
                <!-- [selected] per option, so a preset type shows even before the options render. -->
                <option value="" disabled [selected]="!type()">Choose the document</option>
                @for (t of d.types; track t.type) {
                  <option [value]="t.type" [selected]="t.type === type()">{{ t.label }}</option>
                }
              </select>
              @if (fieldError('type'); as m) { <p id="cred-type-error" class="font-sans text-caption text-alert">{{ m }}</p> }
            </div>

            @if (type()) {
              <div class="grid gap-4 sm:grid-cols-3">
                <div class="flex flex-col gap-1.5">
                  <label class="${LABEL}" for="cred-number">
                    {{ type() === 'annual_practising_licence' ? 'Licence number' : 'Certificate number' }}
                    @if (needsNumber()) { <span class="text-alert" aria-hidden="true">*</span> } @else { <span class="font-normal text-slate">(optional)</span> }
                  </label>
                  <input
                    id="cred-number"
                    class="${FIELD}"
                    autocomplete="off"
                    maxlength="60"
                    [required]="needsNumber()"
                    [value]="number()"
                    [attr.aria-invalid]="fieldError('number') ? 'true' : null"
                    [attr.aria-describedby]="fieldError('number') ? 'cred-number-error' : null"
                    (input)="setField('number', $any($event.target).value)"
                  />
                  @if (fieldError('number'); as m) { <p id="cred-number-error" class="font-sans text-caption text-alert">{{ m }}</p> }
                </div>
                <div class="flex flex-col gap-1.5">
                  <label class="${LABEL}" for="cred-issued">Issued on <span class="font-normal text-slate">(optional)</span></label>
                  <input
                    id="cred-issued"
                    type="date"
                    class="${FIELD}"
                    [max]="today"
                    [value]="issuedAt()"
                    [attr.aria-invalid]="fieldError('issued_at') ? 'true' : null"
                    [attr.aria-describedby]="fieldError('issued_at') ? 'cred-issued-error' : null"
                    (input)="setField('issued_at', $any($event.target).value)"
                  />
                  @if (fieldError('issued_at'); as m) { <p id="cred-issued-error" class="font-sans text-caption text-alert">{{ m }}</p> }
                </div>
                @if (showsExpiry()) {
                  <div class="flex flex-col gap-1.5">
                    <label class="${LABEL}" for="cred-expires">
                      Expires on
                      @if (needsExpiry()) { <span class="text-alert" aria-hidden="true">*</span> } @else { <span class="font-normal text-slate">(optional)</span> }
                    </label>
                    <input
                      id="cred-expires"
                      type="date"
                      class="${FIELD}"
                      [min]="today"
                      [required]="needsExpiry()"
                      [value]="expiresAt()"
                      [attr.aria-invalid]="fieldError('expires_at') ? 'true' : null"
                      [attr.aria-describedby]="fieldError('expires_at') ? 'cred-expires-error' : 'cred-expires-hint'"
                      (input)="setField('expires_at', $any($event.target).value)"
                    />
                    @if (fieldError('expires_at'); as m) {
                      <p id="cred-expires-error" class="font-sans text-caption text-alert">{{ m }}</p>
                    } @else {
                      <p id="cred-expires-hint" class="font-sans text-caption text-slate">The last day it is valid.</p>
                    }
                  </div>
                }
              </div>
            }

            <div class="flex flex-col gap-2">
              <span class="${LABEL}" id="cred-file-label">File <span class="text-alert" aria-hidden="true">*</span></span>
              @if (file(); as f) {
                <div class="flex items-center gap-3 rounded-field border border-cloud bg-glacier px-4 py-3">
                  <sd-icon [name]="f.type === 'application/pdf' ? 'file-text' : 'camera'" [size]="20" class="shrink-0 text-cerulean" />
                  <span class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate font-sans text-body-sm font-semibold text-ink">{{ f.name }}</span>
                    <span class="font-sans text-caption text-slate">{{ size(f.size) }}</span>
                  </span>
                  <button type="button" class="${ACTION} text-slate hover:border-alert hover:text-alert" [disabled]="busy()" (click)="setFile(null)">
                    <sd-icon name="x" [size]="16" />Remove<span class="sr-only"> {{ f.name }}</span>
                  </button>
                </div>
              } @else {
                <sd-file-drop
                  [accept]="accept()"
                  [maxBytes]="d.max_bytes"
                  [disabled]="busy()"
                  label="Drag and drop the document here"
                  browseLabel="Choose a file"
                  [hint]="'PDF, JPG or PNG · up to ' + maxMb() + 'MB'"
                  (files)="setFile($event[0])"
                  (rejected)="rejectFiles($event)"
                />
              }
              @if (fieldError('file'); as m) { <p class="font-sans text-caption text-alert" role="alert">{{ m }}</p> }
            </div>

            @if (formError()) {
              <sd-alert tone="error">{{ formError() }}</sd-alert>
            }

            <div class="flex flex-col gap-3 border-t border-cloud pt-5 sm:flex-row sm:items-center sm:justify-between">
              <p class="font-sans text-caption text-slate">Upload the whole document, clearly legible. Reviewers may ask for a clearer copy.</p>
              <sd-button type="submit" class="shrink-0" [disabled]="busy()">
                @if (busy()) {
                  <sd-icon name="loader-circle" [size]="18" class="motion-safe:animate-spin" />Uploading…
                } @else {
                  <sd-icon name="upload" [size]="18" />Upload document
                }
              </sd-button>
            </div>
          </form>
        </section>

        <!-- Uploaded / deleted: announced, and focused when the control that did it goes away. -->
        <div aria-live="polite">
          @if (notice()) {
            <p #noticeEl tabindex="-1" class="flex items-start gap-2 rounded-field bg-sage/10 px-4 py-3 font-sans text-body-sm font-semibold text-sage outline-none">
              <sd-icon name="circle-check" [size]="18" class="mt-0.5 shrink-0" />{{ notice() }}
            </p>
          }
        </div>

        <!-- Everything uploaded -->
        <section class="flex flex-col gap-3" aria-labelledby="docs-title">
          <h2 id="docs-title" class="font-heading text-body-lg text-ink">Your documents</h2>
          @if (actionError()) {
            <sd-alert tone="error">{{ actionError() }}</sd-alert>
          }
          @if (d.credentials.length === 0) {
            <div class="flex flex-col items-center gap-2 rounded-card border border-dashed border-ash bg-white px-5 py-10 text-center">
              <sd-icon name="folder-open" [size]="28" class="text-slate" />
              <p class="font-sans text-body-sm text-slate">No documents uploaded yet.</p>
            </div>
          } @else {
            <ul class="flex flex-col gap-3">
              @for (c of d.credentials; track c.id) {
                <li class="flex flex-col gap-3 rounded-card border border-cloud bg-white p-4 sm:p-5">
                  <div class="flex flex-wrap items-start justify-between gap-2">
                    <div class="flex min-w-0 flex-col gap-0.5">
                      <span class="font-heading text-body font-semibold text-ink">{{ c.type_label }}</span>
                      @if (docSummary(c); as meta) { <span class="font-sans text-caption text-slate">{{ meta }}</span> }
                    </div>
                    <doc-credential-status [status]="c.status" />
                  </div>
                  @if (c.status === 'rejected' && c.rejection_reason) {
                    <p class="whitespace-pre-line break-words rounded-field bg-alert/10 px-3 py-2 font-sans text-caption text-alert">
                      <span class="font-semibold">Reviewer's note:</span> {{ c.rejection_reason }}
                    </p>
                  }
                  <p class="flex min-w-0 items-center gap-1.5 font-sans text-caption text-slate">
                    <sd-icon name="file-text" [size]="14" class="shrink-0" />
                    <span class="truncate">{{ c.original_name }}</span>
                    <span class="shrink-0">· {{ size(c.size_bytes) }} · uploaded {{ uploaded(c.created_at) }}</span>
                  </p>
                  <div class="flex flex-wrap gap-2">
                    <button type="button" class="${ACTION} text-cerulean hover:border-cerulean" (click)="view(c)">
                      <sd-icon name="eye" [size]="16" />View<span class="sr-only"> {{ c.type_label }} (opens in a new tab)</span>
                    </button>
                    <button type="button" class="${ACTION} text-cerulean hover:border-cerulean" (click)="startUpload(c.type)">
                      <sd-icon name="refresh-cw" [size]="16" />Replace<span class="sr-only"> {{ c.type_label }}</span>
                    </button>
                    @if (c.status === 'pending') {
                      <!-- Only before a reviewer has looked at it. -->
                      <button type="button" class="${ACTION} text-alert hover:border-alert" [disabled]="deletingId() === c.id" (click)="deleteTarget.set(c)">
                        <sd-icon name="trash-2" [size]="16" />{{ deletingId() === c.id ? 'Deleting…' : 'Delete' }}<span class="sr-only"> {{ c.type_label }}</span>
                      </button>
                    }
                  </div>
                </li>
              }
            </ul>
          }
        </section>
      }
    </div>

    <sd-confirm-dialog
      [open]="deleteTarget() !== null"
      title="Delete this document?"
      [message]="(deleteTarget()?.type_label ?? 'It') + ' (' + (deleteTarget()?.original_name ?? '') + ') will be removed before anyone reviews it. You can upload it again.'"
      confirmLabel="Delete"
      cancelLabel="Keep it"
      icon="trash-2"
      [danger]="true"
      (confirm)="confirmDelete()"
      (cancel)="deleteTarget.set(null)"
    />
  `,
})
export class DoctorCredentials implements OnInit {
  private readonly api = inject(DoctorApi);
  private readonly standing = inject(DoctorStandingStore);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);

  protected readonly required = REQUIRED;
  protected readonly today = todayLocal();

  protected readonly loading = signal(true);
  protected readonly loadError = signal('');
  protected readonly data = signal<DoctorCredentialsDto | null>(null);

  // ----- The upload form -----
  protected readonly type = signal<CredentialType | ''>('');
  protected readonly number = signal('');
  protected readonly issuedAt = signal('');
  protected readonly expiresAt = signal('');
  protected readonly file = signal<File | null>(null);
  protected readonly busy = signal(false);
  protected readonly formError = signal('');
  private readonly fieldErrors = signal<Record<string, string>>({});
  protected readonly notice = signal('');

  // ----- The list -----
  protected readonly deleteTarget = signal<SpecialistCredentialDto | null>(null);
  protected readonly deletingId = signal<string | null>(null);
  protected readonly actionError = signal('');

  private readonly uploadTitle = viewChild<ElementRef<HTMLElement>>('uploadTitle');
  private readonly typeSelect = viewChild<ElementRef<HTMLSelectElement>>('typeSelect');
  private readonly noticeEl = viewChild<ElementRef<HTMLElement>>('noticeEl');

  private readonly option = computed(() => this.data()?.types.find((t) => t.type === this.type()) ?? null);
  protected readonly needsNumber = computed(() => this.option()?.requires_number ?? false);
  protected readonly needsExpiry = computed(() => this.option()?.requires_expiry ?? false);
  /** An MDCN registration doesn't expire; a licence must say when it does; a certificate may. */
  protected readonly showsExpiry = computed(() => this.needsExpiry() || this.type() === 'specialist_certificate');
  protected readonly maxMb = computed(() => Math.round((this.data()?.max_bytes ?? 10_485_760) / 1_048_576));
  /** Extensions as well as MIME types: some systems leave a dropped file's type empty. */
  protected readonly accept = computed(() => ['.pdf', '.jpg', '.jpeg', '.png', ...(this.data()?.accepted ?? [])].join(','));
  /** An approved (or suspended) doctor came from their profile; one onboarding from the checklist. */
  protected readonly backLink = computed(() => {
    const s = this.standing.onboarding()?.status;
    return s === 'approved' || s === 'suspended' ? '/profile' : '/onboarding';
  });

  ngOnInit(): void {
    const preset = this.route.snapshot.queryParamMap.get('type');
    if (preset) this.type.set(preset as CredentialType);
    void this.standing.load();
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.loadError.set('');
    this.api
      .credentials()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.data.set(res.data);
          if (this.type() && !res.data.types.some((t) => t.type === this.type())) this.type.set('');
          this.loading.set(false);
        },
        error: (err: unknown) => {
          this.loadError.set(apiErrorMessage(err, 'Could not load your documents.'));
          this.loading.set(false);
        },
      });
  }

  /** Re-read the list (and the standing: the checklist and banners count these documents). */
  private refresh(): void {
    this.api
      .credentials()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (res) => this.data.set(res.data), error: () => undefined });
    void this.standing.load(true);
  }

  /** The licence in force (from the standing's licence state) and a renewal beside it. */
  private readonly licenceDocs = computed(() =>
    licenceDocuments(this.data()?.credentials, this.standing.onboarding()?.licence),
  );
  protected readonly licenceRenewal = computed(() => this.licenceDocs().renewal);
  protected readonly renewalText = renewalText;

  /** The document a summary card shows — for the licence, the one in force (a renewal has its own line). */
  protected latest(type: CredentialType): SpecialistCredentialDto | null {
    if (type === 'annual_practising_licence') return this.licenceDocs().current;
    return latestCredential(this.data()?.credentials, type);
  }

  // ----- Form -----

  protected fieldError(key: string): string {
    return this.fieldErrors()[key] ?? '';
  }

  private clearField(key: string): void {
    if (!this.fieldErrors()[key]) return;
    this.fieldErrors.update((errs) => {
      const next = { ...errs };
      delete next[key];
      return next;
    });
  }

  /** "Upload" / "Replace" on a document: that type, then the form. */
  protected startUpload(type: CredentialType): void {
    this.setType(type);
    this.notice.set('');
    afterNextRender(
      () => {
        const title = this.uploadTitle()?.nativeElement;
        title?.scrollIntoView({ block: 'start', behavior: 'smooth' });
        this.typeSelect()?.nativeElement.focus({ preventScroll: true });
      },
      { injector: this.injector },
    );
  }

  protected setType(value: string): void {
    this.type.set(value as CredentialType);
    this.clearField('type');
    if (!this.showsExpiry()) this.expiresAt.set('');
  }

  protected setField(key: 'number' | 'issued_at' | 'expires_at', value: string): void {
    if (key === 'number') this.number.set(value);
    else if (key === 'issued_at') this.issuedAt.set(value);
    else this.expiresAt.set(value);
    this.clearField(key);
  }

  protected setFile(file: File | null): void {
    this.file.set(file);
    this.clearField('file');
  }

  protected rejectFiles(rejections: FileDropRejection[]): void {
    const first = rejections[0];
    if (first) this.fieldErrors.update((errs) => ({ ...errs, file: rejectionText(first, this.data()?.max_bytes ?? 10_485_760) }));
  }

  /** The API's rules, checked first so most mistakes are caught before the upload. */
  private validate(): Record<string, string> {
    const errs: Record<string, string> = {};
    if (!this.type()) errs['type'] = 'Choose the document type.';
    if (this.needsNumber() && !this.number().trim()) {
      errs['number'] = this.type() === 'annual_practising_licence' ? 'Enter the licence number.' : 'Enter the certificate number.';
    }
    if (this.issuedAt() && this.issuedAt() > this.today) errs['issued_at'] = 'The issue date cannot be in the future.';
    if (this.needsExpiry() && !this.expiresAt()) errs['expires_at'] = 'Enter the date the licence expires.';
    else if (this.expiresAt() && this.expiresAt() < this.today) {
      errs['expires_at'] = 'This document has already expired — upload your current one.';
    } else if (this.expiresAt() && this.issuedAt() && this.expiresAt() < this.issuedAt()) {
      // The API's rule: the same day is allowed.
      errs['expires_at'] = 'The expiry date cannot be before the issue date.';
    }
    if (!this.file()) errs['file'] = 'Choose the file to upload.';
    return errs;
  }

  protected upload(): void {
    if (this.busy()) return;
    this.formError.set('');
    this.notice.set('');
    const errs = this.validate();
    this.fieldErrors.set(errs);
    const file = this.file();
    const type = this.type();
    if (Object.keys(errs).length > 0 || !file || !type) {
      this.focusFirstError();
      return;
    }

    this.busy.set(true);
    this.api
      .uploadCredential({
        file,
        type,
        ...(this.number().trim() ? { number: this.number().trim() } : {}),
        ...(this.issuedAt() ? { issued_at: this.issuedAt() } : {}),
        ...(this.expiresAt() ? { expires_at: this.expiresAt() } : {}),
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.busy.set(false);
          this.type.set('');
          this.number.set('');
          this.issuedAt.set('');
          this.expiresAt.set('');
          this.file.set(null);
          this.announce(`${res.data.type_label} uploaded. A reviewer will verify it — we'll let you know if anything needs changing.`);
          this.refresh();
        },
        error: (err: unknown) => {
          this.busy.set(false);
          const fields = apiErrorFields(err);
          const known = ['type', 'number', 'issued_at', 'expires_at', 'file'];
          const mine = Object.fromEntries(Object.entries(fields).filter(([k]) => known.includes(k)));
          this.fieldErrors.set(mine);
          this.formError.set(Object.keys(mine).length > 0 ? '' : apiErrorMessage(err, 'Could not upload the document. Please try again.'));
          this.focusFirstError();
        },
      });
  }

  private focusFirstError(): void {
    const ids: Record<string, string> = { type: 'cred-type', number: 'cred-number', issued_at: 'cred-issued', expires_at: 'cred-expires' };
    const first = Object.keys(this.fieldErrors()).find((k) => ids[k]);
    if (!first) return;
    afterNextRender(() => document.getElementById(ids[first])?.focus(), { injector: this.injector });
  }

  // ----- List -----

  /** Popup-safe: the tab opens on the click, the file follows from a blob URL. */
  protected view(c: SpecialistCredentialDto): void {
    openBlobDocument(this.api.credentialFile(c.id));
  }

  protected confirmDelete(): void {
    const c = this.deleteTarget();
    this.deleteTarget.set(null);
    if (!c || this.deletingId()) return;
    this.deletingId.set(c.id);
    this.actionError.set('');
    this.notice.set('');
    this.api
      .deleteCredential(c.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.deletingId.set(null);
          this.data.update((d) => (d ? { ...d, credentials: d.credentials.filter((x) => x.id !== c.id) } : d));
          this.announce(`${c.type_label} deleted.`);
          this.refresh();
        },
        error: (err: unknown) => {
          this.deletingId.set(null);
          this.actionError.set(apiErrorMessage(err, 'Could not delete the document.'));
          this.refresh(); // e.g. it was reviewed meanwhile
        },
      });
  }

  private announce(text: string): void {
    this.notice.set(text);
    afterNextRender(() => this.noticeEl()?.nativeElement.focus(), { injector: this.injector });
  }

  // ----- Display -----

  /** "No. ABC123 · issued 2 Jan 2026 · valid until 31 Mar 2027". */
  protected docSummary(c: SpecialistCredentialDto | null): string {
    if (!c) return '';
    return [
      c.number ? `No. ${c.number}` : '',
      c.issued_at ? `issued ${ymdLabel(c.issued_at)}` : '',
      c.expires_at ? `${c.status === 'expired' ? 'expired' : 'valid until'} ${ymdLabel(c.expires_at)}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
  }

  protected uploaded(iso: string): string {
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
  }

  protected size(bytes: number): string {
    if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
}
