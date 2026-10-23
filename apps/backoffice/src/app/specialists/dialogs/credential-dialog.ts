import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { Observable } from 'rxjs';
import { apiErrorFields, apiErrorMessage, SpecialistsApi } from '@supadoc/data-access';
import type { SpecialistCredentialDto, SpecialistReviewSummaryDto, VerifyCredentialInput } from '@supadoc/models';
import { AlertComponent, IconComponent } from '@supadoc/ui';
import { BoDialog } from '../../shared/dialog';
import { DocumentViewer } from '../../shared/document-viewer';
import {
  BTN_DANGER,
  BTN_GHOST,
  BTN_SUCCESS,
  calendarDay,
  clinicTodayYmd,
  credentialBadge,
  dateTime,
  FIELD,
  FIELD_INVALID,
  LABEL,
  LICENCE_TYPES,
  PILL,
} from '../specialist-ui';

export type CredentialDialogMode = 'view' | 'verify' | 'reject';

/**
 * One licensing document, opened from the Credentials tab: the file itself
 * (the shared {@link DocumentViewer} — fetched as a blob, every open audited
 * server-side, shown from a blob URL that is revoked on close) beside its
 * details, with the reviewer's decision: verify with an attestation (register
 * checked + reference, and for a licence its number and expiry) or reject with
 * a reason the doctor sees. The register named is the doctor's: MDCN, or their
 * regulator abroad (`registerName`).
 */
@Component({
  selector: 'bo-credential-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, AlertComponent, BoDialog, DocumentViewer],
  template: `
    <bo-dialog
      [open]="open()"
      [title]="credential()?.type_label ?? 'Document'"
      [subtitle]="doctorName()"
      size="xl"
      [busy]="saving()"
      (closed)="closed.emit()"
    >
      @if (credential(); as c) {
        <div class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
          <!-- The document (only while open: closing releases the file) -->
          @if (open()) {
            <bo-document-viewer
              [load]="loadFile()"
              [mime]="c.mime"
              [name]="c.original_name"
              [sizeBytes]="c.size_bytes"
              [alt]="c.type_label + ' uploaded by the doctor'"
              goneMessage="This document could not be read. Ask the doctor to upload it again."
            />
          } @else {
            <div></div>
          }

          <!-- Details + decision -->
          <div class="flex min-w-0 flex-col gap-4">
            <span class="${PILL} w-fit" [class]="badge().cls"><sd-icon [name]="badge().icon" [size]="13" />{{ badge().label }}</span>
            <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 font-sans text-body-sm">
              <dt class="text-slate">Number</dt><dd class="break-all text-ink">{{ c.number || '—' }}</dd>
              <dt class="text-slate">Issued</dt><dd class="text-ink">{{ day(c.issued_at) }}</dd>
              <dt class="text-slate">Expires</dt><dd class="text-ink">{{ day(c.expires_at) }}</dd>
              <dt class="text-slate">Uploaded</dt><dd class="text-ink">{{ when(c.created_at) }}</dd>
              @if (c.reviewed_at) {
                <dt class="text-slate">Reviewed</dt><dd class="break-words text-ink">{{ when(c.reviewed_at) }}{{ c.reviewed_by_name ? ' by ' + c.reviewed_by_name : '' }}</dd>
              }
              @if (c.attestation; as a) {
                <dt class="text-slate">Register ref.</dt><dd class="break-all text-ink">{{ a.register_reference }}</dd>
                @if (a.note) {
                  <dt class="text-slate">Note</dt><dd class="whitespace-pre-line break-words text-ink">{{ a.note }}</dd>
                }
              }
              @if (c.sha256) {
                <dt class="text-slate">SHA-256</dt><dd class="break-all font-mono text-[11px] text-slate">{{ c.sha256 }}</dd>
              }
            </dl>
            @if (c.rejection_reason) {
              <div class="rounded-field bg-alert/10 px-4 py-3 font-sans text-body-sm text-ink">
                <span class="block font-semibold">Rejected because:</span>
                <span class="whitespace-pre-line break-words">{{ c.rejection_reason }}</span>
              </div>
            }

            @if (canVerify() || canReject()) {
              <div class="flex gap-1 rounded-pill border border-haze bg-glacier p-1" role="group" aria-label="Decision">
                @if (canVerify()) {
                  <button type="button" class="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-pill px-3 font-sans text-body-sm font-semibold transition" [class]="action() === 'verify' ? 'bg-sage/15 text-sage-ink shadow-control' : 'text-slate hover:text-ink'" [attr.aria-pressed]="action() === 'verify'" (click)="setAction('verify')">
                    <sd-icon name="badge-check" [size]="16" />Verify
                  </button>
                }
                @if (canReject()) {
                  <button type="button" class="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-pill px-3 font-sans text-body-sm font-semibold transition" [class]="action() === 'reject' ? 'bg-alert/10 text-alert-ink shadow-control' : 'text-slate hover:text-ink'" [attr.aria-pressed]="action() === 'reject'" (click)="setAction('reject')">
                    <sd-icon name="circle-x" [size]="16" />Reject
                  </button>
                }
              </div>

              @if (action() === 'verify' && canVerify()) {
                <form id="bo-cred-verify" class="flex flex-col gap-4" novalidate (submit)="$event.preventDefault(); verify()">
                  <label class="flex min-h-11 cursor-pointer items-start gap-3 rounded-field border px-4 py-3" [class]="err('register_checked') ? 'border-alert' : 'border-cloud'">
                    <input type="checkbox" class="mt-0.5 size-5 shrink-0 accent-sage" [checked]="registerChecked()" (change)="registerChecked.set($any($event.target).checked); clearErr('register_checked')" [attr.aria-invalid]="err('register_checked') ? 'true' : null" [attr.aria-describedby]="err('register_checked') ? 'bo-cred-checked-err' : null" data-autofocus />
                    <span class="font-sans text-body-sm text-ink">I checked this document against {{ registerName() }}, and the doctor's name and number match.</span>
                  </label>
                  @if (err('register_checked'); as e) { <span id="bo-cred-checked-err" class="-mt-2 font-sans text-caption text-alert">{{ e }}</span> }
                  <label class="flex flex-col gap-1.5">
                    <span class="${LABEL}">Register reference (required)</span>
                    <input type="text" maxlength="120" class="${FIELD}" [class]="err('register_reference') ? '${FIELD_INVALID}' : ''" [value]="reference()" (input)="reference.set($any($event.target).value); clearErr('register_reference')" [placeholder]="registerName() === 'the MDCN register' ? 'e.g. MDCN search 15 Oct 2026, entry 12345' : 'e.g. Online register search 15 Oct 2026, entry 12345'" [attr.aria-invalid]="err('register_reference') ? 'true' : null" [attr.aria-describedby]="err('register_reference') ? 'bo-cred-ref-err' : null" />
                    @if (err('register_reference'); as e) { <span id="bo-cred-ref-err" class="font-sans text-caption text-alert">{{ e }}</span> }
                  </label>
                  @if (isLicence() || c.number) {
                    <label class="flex flex-col gap-1.5">
                      <span class="${LABEL}">Number{{ isLicence() ? ' (required)' : '' }}</span>
                      <input type="text" class="${FIELD}" [class]="err('number') ? '${FIELD_INVALID}' : ''" [value]="number()" (input)="number.set($any($event.target).value); clearErr('number')" [attr.aria-invalid]="err('number') ? 'true' : null" [attr.aria-describedby]="err('number') ? 'bo-cred-number-err' : null" />
                      @if (err('number'); as e) { <span id="bo-cred-number-err" class="font-sans text-caption text-alert">{{ e }}</span> }
                    </label>
                  }
                  @if (isLicence() || c.expires_at) {
                    <label class="flex flex-col gap-1.5">
                      <span class="${LABEL}">Expires on{{ isLicence() ? ' (required)' : '' }}</span>
                      <input type="date" class="${FIELD} min-h-11" [min]="today" [class]="err('expires_at') ? '${FIELD_INVALID}' : ''" [value]="expiresAt()" (input)="expiresAt.set($any($event.target).value); clearErr('expires_at')" [attr.aria-invalid]="err('expires_at') ? 'true' : null" [attr.aria-describedby]="err('expires_at') ? 'bo-cred-exp-err bo-cred-exp-hint' : 'bo-cred-exp-hint'" />
                      <span id="bo-cred-exp-hint" class="font-sans text-caption text-slate">Correct it if it differs from the document — reminders and automatic suspension use this date.</span>
                      @if (err('expires_at'); as e) { <span id="bo-cred-exp-err" class="font-sans text-caption text-alert">{{ e }}</span> }
                    </label>
                  }
                  <label class="flex flex-col gap-1.5">
                    <span class="${LABEL}">Note (optional)</span>
                    <textarea rows="2" maxlength="1000" class="${FIELD}" [value]="note()" (input)="note.set($any($event.target).value)"></textarea>
                  </label>
                </form>
              } @else if (action() === 'reject' && canReject()) {
                <form id="bo-cred-reject" class="flex flex-col gap-4" novalidate (submit)="$event.preventDefault(); reject()">
                  @if (c.status === 'verified') {
                    <sd-alert tone="warning">This document is verified. Rejecting it withdraws the verification{{ isLicence() ? ', and the doctor may no longer hold a current licence' : '' }}.</sd-alert>
                  }
                  <label class="flex flex-col gap-1.5">
                    <span class="${LABEL}">Reason — the doctor sees this (required)</span>
                    <textarea rows="4" maxlength="1000" class="${FIELD}" [class]="err('reason') ? '${FIELD_INVALID}' : ''" [value]="reason()" (input)="reason.set($any($event.target).value); clearErr('reason')" placeholder="e.g. The scan is cut off — please upload the whole licence." [attr.aria-invalid]="err('reason') ? 'true' : null" [attr.aria-describedby]="err('reason') ? 'bo-cred-reason-err' : null" data-autofocus></textarea>
                    @if (err('reason'); as e) { <span id="bo-cred-reason-err" class="font-sans text-caption text-alert">{{ e }}</span> }
                  </label>
                </form>
              }
            }

            <div aria-live="assertive">
              @if (error()) {
                <sd-alert tone="error">{{ error() }}</sd-alert>
              }
            </div>
          </div>
        </div>
      }
      <div dialogFooter class="flex flex-col-reverse gap-2 border-t border-cloud px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
        <button type="button" class="${BTN_GHOST}" [disabled]="saving()" (click)="closed.emit()">Close</button>
        @if (action() === 'verify' && canVerify()) {
          <button type="submit" form="bo-cred-verify" class="${BTN_SUCCESS}" [disabled]="saving()">
            <sd-icon [name]="saving() ? 'loader-circle' : 'badge-check'" [size]="18" [class.animate-spin]="saving()" />{{ saving() ? 'Verifying…' : 'Verify document' }}
          </button>
        } @else if (action() === 'reject' && canReject()) {
          <button type="submit" form="bo-cred-reject" class="${BTN_DANGER}" [disabled]="saving()">
            <sd-icon [name]="saving() ? 'loader-circle' : 'circle-x'" [size]="18" [class.animate-spin]="saving()" />{{ saving() ? 'Rejecting…' : 'Reject document' }}
          </button>
        }
      </div>
    </bo-dialog>
  `,
})
export class CredentialDialog {
  private readonly api = inject(SpecialistsApi);
  private readonly destroyRef = inject(DestroyRef);

  readonly open = input(false);
  readonly specialistId = input.required<string>();
  readonly doctorName = input('');
  readonly credential = input<SpecialistCredentialDto | null>(null);
  readonly mode = input<CredentialDialogMode>('view');
  /** The register the reviewer checks: "the MDCN register", or the doctor's regulator's abroad. */
  readonly registerName = input('the MDCN register');
  readonly closed = output<void>();
  /** A decision was saved — the doctor's new review summary. */
  readonly decided = output<SpecialistReviewSummaryDto>();

  protected readonly today = clinicTodayYmd();
  protected readonly action = signal<'verify' | 'reject' | null>(null);

  /** Re-keyed on the document's id only, so a refreshed copy of the same document isn't fetched (and audited) again. */
  private readonly credentialId = computed(() => this.credential()?.id ?? null);
  protected readonly loadFile = computed<(() => Observable<Blob>) | null>(() => {
    const id = this.credentialId();
    const specialistId = this.specialistId();
    return id ? () => this.api.credentialFile(specialistId, id) : null;
  });

  protected readonly registerChecked = signal(false);
  protected readonly reference = signal('');
  protected readonly number = signal('');
  protected readonly expiresAt = signal('');
  protected readonly note = signal('');
  protected readonly reason = signal('');
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly errors = signal<Record<string, string>>({});

  protected readonly badge = computed(() => credentialBadge(this.credential()?.status ?? 'pending'));
  protected readonly canVerify = computed(() => this.credential()?.status === 'pending');
  protected readonly canReject = computed(() => {
    const s = this.credential()?.status;
    return s === 'pending' || s === 'verified';
  });
  protected readonly isLicence = computed(() => LICENCE_TYPES.includes(this.credential()?.type ?? 'specialist_certificate'));

  constructor() {
    // Each open: reset the decision (the viewer fetches the file afresh).
    effect(() => {
      const open = this.open();
      const c = this.credential();
      const mode = this.mode();
      untracked(() => {
        if (!open || !c) return;
        this.action.set(mode === 'view' ? null : mode);
        this.registerChecked.set(false);
        this.reference.set('');
        this.number.set(c.number ?? '');
        this.expiresAt.set(c.expires_at ?? '');
        this.note.set('');
        this.reason.set('');
        this.error.set('');
        this.errors.set({});
      });
    });
  }

  protected setAction(a: 'verify' | 'reject'): void {
    this.action.set(a);
    this.error.set('');
    this.errors.set({});
  }

  protected err(key: string): string {
    return this.errors()[key] ?? '';
  }

  protected clearErr(key: string): void {
    if (!this.errors()[key]) return;
    this.errors.update((e) => {
      const next = { ...e };
      delete next[key];
      return next;
    });
  }

  protected verify(): void {
    const c = this.credential();
    if (!c || this.saving()) return;
    const errors: Record<string, string> = {};
    if (!this.registerChecked()) errors['register_checked'] = `Confirm that you checked ${this.registerName()}.`;
    const reference = this.reference().trim();
    if (!reference) errors['register_reference'] = 'Enter the register reference you checked.';
    const number = this.number().trim();
    if (this.isLicence() && !number) errors['number'] = 'Enter the licence number.';
    const expires = this.expiresAt().trim();
    if (this.isLicence() && !expires) errors['expires_at'] = 'Enter the date the licence expires.';
    else if (expires && expires < this.today) errors['expires_at'] = 'This date has passed, so the document cannot be verified.';
    this.errors.set(errors);
    if (Object.keys(errors).length > 0) {
      this.error.set('Please complete the highlighted fields.');
      return;
    }
    const input: VerifyCredentialInput = { register_checked: true, register_reference: reference };
    if (this.note().trim()) input.note = this.note().trim();
    if (number && number !== (c.number ?? '')) input.number = number;
    if (expires && expires !== (c.expires_at ?? '')) input.expires_at = expires;
    this.submit(this.api.verifyCredential(this.specialistId(), c.id, input), 'Could not verify this document.');
  }

  protected reject(): void {
    const c = this.credential();
    if (!c || this.saving()) return;
    const reason = this.reason().trim();
    if (!reason) {
      this.errors.set({ reason: 'Tell the doctor why the document was not accepted.' });
      this.error.set('');
      return;
    }
    this.submit(this.api.rejectCredential(this.specialistId(), c.id, reason), 'Could not reject this document.');
  }

  private submit(
    request: ReturnType<SpecialistsApi['verifyCredential']>,
    fallback: string,
  ): void {
    this.saving.set(true);
    this.error.set('');
    request.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => {
        this.saving.set(false);
        this.decided.emit(res.data);
      },
      error: (err: unknown) => {
        this.saving.set(false);
        this.errors.set(apiErrorFields(err));
        this.error.set(apiErrorMessage(err, fallback));
      },
    });
  }

  protected day(ymd: string | null): string {
    return calendarDay(ymd);
  }
  protected when(iso: string | null): string {
    return dateTime(iso);
  }
}
