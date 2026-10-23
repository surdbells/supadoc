import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  Injector,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { AdminDoctorApplicationsApi, apiErrorFields, apiErrorMessage } from '@supadoc/data-access';
import type {
  ApprovalDocumentInput,
  ApprovalDocumentPrefillDto,
  ApproveApplicationInput,
  ApproveApplicationResultDto,
  DoctorApplicationDetailDto,
} from '@supadoc/models';
import { AlertComponent, DialogComponent, IconComponent, SearchSelectComponent } from '@supadoc/ui';
import {
  CHECKBOX,
  DIALOG_FOOTER,
  FIELD,
  FIELD_ERROR,
  FIELD_GROUP,
  FIELD_GROUP_INPUT,
  FIELD_INVALID,
  FIELD_PREFIX,
  HINT,
  LABEL,
  SUBSECTION_TITLE,
} from '../../shared/layout';
import { SearchSelectA11y } from '../../specialists/select-a11y';
import { BTN_GHOST, BTN_SECONDARY, BTN_SUCCESS, clinicTodayYmd } from '../../specialists/specialist-ui';
import { isActiveSpecialty, SpecialtyChoices, specialtyField } from '../../specialists/specialty-choices';
import { ApplicationDocumentDialog } from './application-document-dialog';
import { isConflict } from './request-info-dialog';

/** What the reviewer enters for one carried document. */
interface DocForm {
  checked: boolean;
  register_reference: string;
  number: string;
  issued_on: string;
  expires_on: string;
}

type DocField = keyof DocForm;
const DOC_FIELDS: readonly DocField[] = ['number', 'issued_on', 'expires_on', 'register_reference', 'checked'];

const FEE_MAX = 10_000_000;

/** 'YYYY-MM-DD' minus `months` calendar months, clamped to the month's end (31 Aug − 6 → 28/29 Feb). */
export function minusMonthsYmd(ymd: string, months: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const total = y * 12 + (m - 1) - months;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${String(ny).padStart(4, '0')}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** The fee as the API takes it ("15000.00"), or null when it isn't a positive amount up to ₦10m with ≤2 decimals. */
export function feeValue(raw: string): string | null {
  const v = raw.trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return null;
  const n = Number(v);
  if (!(n > 0) || n > FEE_MAX) return null;
  return n.toFixed(2);
}

/**
 * Approve an application: says what approval does (a doctor login, a profile
 * that can't be booked until the doctor finishes setup and goes live, the
 * documents carried over as verified, the set-password email), takes the
 * specialty and consultation fee, and for each carried document the
 * reviewer's attestation — what they checked, the number / issue / expiry
 * dates where its type needs them, and a tick — plus one overall attestation
 * against the doctor's register. A login that would be taken over blocks it.
 * On success the body becomes the result: the invite outcome and a link to
 * the new doctor page.
 */
@Component({
  selector: 'bo-approve-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    AlertComponent,
    DialogComponent,
    IconComponent,
    SearchSelectComponent,
    SearchSelectA11y,
    ApplicationDocumentDialog,
  ],
  template: `
    <sd-dialog
      [open]="open()"
      [title]="result() ? 'Application approved' : 'Approve and create the doctor'"
      [subtitle]="detail().full_name + ' · ' + detail().reference"
      size="xl"
      [busy]="saving()"
      (closed)="close()"
    >
      @if (result(); as r) {
        <div class="flex flex-col gap-4">
          <sd-alert tone="success">Approved. {{ detail().full_name }}'s doctor profile was created.</sd-alert>
          <div class="flex flex-col gap-1 rounded-field px-4 py-3 font-sans text-body-sm text-ink" [class]="r.invite.email_sent ? 'bg-sage/10' : 'bg-warning/10'" role="status">
            <span class="flex items-start gap-2">
              <sd-icon [name]="r.invite.email_sent ? 'mail' : 'circle-alert'" [size]="16" class="mt-0.5 shrink-0" />
              {{ r.invite.email_sent ? 'Set-password email sent to ' + (r.invite.login?.email ?? detail().email) + '. The link works for 7 days.' : 'Email not sent — use Resend invite on the application or the doctor page.' }}
            </span>
            @if (r.invite.dev_link) {
              <span class="break-all text-caption text-slate">Testing only — set-password link: <span class="select-all font-mono text-ink">{{ r.invite.dev_link }}</span></span>
            }
          </div>
          <p class="font-sans text-body-sm text-slate">They can't be booked until they finish setting up their profile and go live.</p>
        </div>
      } @else if (approval(); as a) {
        <form id="bo-approve-form" class="flex flex-col gap-6" novalidate (submit)="$event.preventDefault(); submit()">
          <!-- 1. What happens -->
          <section class="flex flex-col gap-3" aria-labelledby="bo-ap-what-title">
            <h3 id="bo-ap-what-title" class="${SUBSECTION_TITLE}"><sd-icon name="info" [size]="18" class="text-cerulean" />What happens when you approve</h3>
            @if (a.login.state === 'blocked') {
              <sd-alert tone="error">
                <span class="block font-semibold">This application can't be approved yet.</span>
                {{ a.login.problem || 'Their email belongs to an existing login or doctor profile.' }}
              </sd-alert>
            }
            <ul class="flex flex-col gap-2 font-sans text-body-sm text-ink">
              @if (a.login.state === 'reuse_invited_login') {
                <li class="flex items-start gap-2"><sd-icon name="user-check" [size]="16" class="mt-0.5 shrink-0 text-cerulean" />Their invited login is reused.</li>
              } @else if (a.login.state === 'new') {
                <li class="flex items-start gap-2"><sd-icon name="user-plus" [size]="16" class="mt-0.5 shrink-0 text-cerulean" /><span>A doctor login is created for <span class="break-all font-semibold">{{ detail().email }}</span>.</span></li>
              }
              <li class="flex items-start gap-2"><sd-icon name="stethoscope" [size]="16" class="mt-0.5 shrink-0 text-cerulean" />A doctor profile is created. They can't be booked until they finish setup and go live.</li>
              <li class="flex items-start gap-2"><sd-icon name="file-check" [size]="16" class="mt-0.5 shrink-0 text-cerulean" />{{ a.documents.length }} {{ a.documents.length === 1 ? 'document is' : 'documents are' }} added to their record as verified.</li>
              <li class="flex items-start gap-2"><sd-icon name="mail" [size]="16" class="mt-0.5 shrink-0 text-cerulean" /><span>A set-password email goes to <span class="break-all font-semibold">{{ detail().email }}</span> (link valid 7 days).</span></li>
            </ul>
            @if (problems().length > 0) {
              <div class="flex flex-col gap-2 rounded-field bg-warning/10 p-4" role="alert">
                <p class="font-sans text-body-sm font-semibold text-ink">Before you can approve:</p>
                <ul class="flex flex-col gap-1.5">
                  @for (p of problems(); track p) {
                    <li class="flex items-start gap-2 font-sans text-body-sm text-ink"><sd-icon name="circle-alert" [size]="16" class="mt-0.5 shrink-0 text-warning" />{{ p }}</li>
                  }
                </ul>
              </div>
            }
            @if (err('email'); as e) {
              <sd-alert tone="error">{{ e }}</sd-alert>
            }
          </section>

          <!-- 2. Profile -->
          <section class="flex flex-col gap-4 border-t border-cloud pt-5" aria-labelledby="bo-ap-profile-title">
            <h3 id="bo-ap-profile-title" class="${SUBSECTION_TITLE}"><sd-icon name="user-round" [size]="18" class="text-cerulean" />Profile</h3>
            <div class="grid items-start gap-4 sm:grid-cols-2">
              <div class="flex min-w-0 flex-col gap-1.5">
                <span id="bo-ap-spec-label" class="${LABEL}">Specialty <span aria-hidden="true">*</span></span>
                @switch (choices.state()) {
                  @case ('ready') {
                    <sd-search-select
                      boSelectA11y="bo-ap-spec-label"
                      [boSelectDescribedBy]="err('specialty') ? 'bo-ap-spec-err' : (specialtyWarning() ? 'bo-ap-spec-warn' : null)"
                      [options]="specialtyOptions().options"
                      [value]="specialtyOptions().value"
                      (valueChange)="setSpecialty($event)"
                      [clearable]="false"
                      placeholder="Choose a specialty"
                      searchPlaceholder="Search specialties…"
                      [error]="err('specialty')"
                    />
                    @if (err('specialty'); as e) { <span id="bo-ap-spec-err" class="sr-only">{{ e }}</span> }
                  }
                  @case ('loading') {
                    <div class="sd-shimmer h-12 rounded-field" aria-hidden="true"></div>
                    <span class="sr-only" role="status">Loading the specialty list…</span>
                    @if (err('specialty'); as e) { <span id="bo-ap-spec-err" class="${FIELD_ERROR}">{{ e }}</span> }
                  }
                  @default {
                    <input id="bo-ap-spec" type="text" class="${FIELD}" [class]="err('specialty') ? '${FIELD_INVALID}' : ''" aria-labelledby="bo-ap-spec-label" [value]="specialty()" (input)="setSpecialty($any($event.target).value)" [attr.aria-invalid]="err('specialty') ? 'true' : null" [attr.aria-describedby]="err('specialty') ? 'bo-ap-spec-err' : null" />
                    @if (err('specialty'); as e) { <span id="bo-ap-spec-err" class="${FIELD_ERROR}">{{ e }}</span> }
                  }
                }
                @if (specialtyWarning(); as w) {
                  <span id="bo-ap-spec-warn" class="flex items-start gap-1.5 font-sans text-caption text-ink"><sd-icon name="circle-alert" [size]="14" class="mt-0.5 shrink-0 text-warning" />{{ w }}</span>
                }
              </div>
              <label class="flex min-w-0 flex-col gap-1.5">
                <span class="${LABEL}">Consultation fee (₦) <span aria-hidden="true">*</span></span>
                <span class="${FIELD_GROUP}" [class]="err('consultation_fee') ? '${FIELD_INVALID}' : ''">
                  <span class="${FIELD_PREFIX}" aria-hidden="true">₦</span>
                  <input
                    id="bo-ap-fee"
                    type="text"
                    inputmode="decimal"
                    autocomplete="off"
                    required
                    class="${FIELD_GROUP_INPUT}"
                    placeholder="15000"
                    [value]="fee()"
                    (input)="fee.set($any($event.target).value); clearErr('consultation_fee')"
                    [attr.aria-invalid]="err('consultation_fee') ? 'true' : null"
                    [attr.aria-describedby]="err('consultation_fee') ? 'bo-ap-fee-hint bo-ap-fee-err' : 'bo-ap-fee-hint'"
                  />
                </span>
                <span id="bo-ap-fee-hint" class="${HINT}">Per consultation. The doctor sets their own availability.</span>
                @if (err('consultation_fee'); as e) { <span id="bo-ap-fee-err" class="${FIELD_ERROR}">{{ e }}</span> }
              </label>
            </div>
          </section>

          <!-- 3. Documents -->
          <section class="flex flex-col gap-4 border-t border-cloud pt-5" aria-labelledby="bo-ap-docs-title">
            <h3 id="bo-ap-docs-title" class="${SUBSECTION_TITLE}"><sd-icon name="file-check" [size]="18" class="text-cerulean" />Documents</h3>
            @if (err('documents'); as e) {
              <sd-alert tone="error">{{ e }}</sd-alert>
            }
            <ul class="flex flex-col gap-4">
              @for (p of a.documents; track p.document_id) {
                @let f = form(p.document_id);
                @let id = 'bo-ap-doc-' + p.document_id;
                <li>
                  <!-- A named group: each field below is announced with the document it belongs to. -->
                  <div role="group" [attr.aria-labelledby]="id + '-title'" class="flex flex-col gap-4 rounded-field border p-4" [class]="docHasError(p.document_id) ? 'border-alert' : 'border-cloud'">
                    <div class="flex flex-wrap items-start justify-between gap-2">
                      <div class="flex min-w-0 flex-col gap-0.5">
                        <span [id]="id + '-title'" class="font-heading text-body font-semibold text-ink">{{ p.slot_label }}</span>
                        <span class="break-all font-sans text-caption text-slate">{{ p.original_name }}</span>
                      </div>
                      <button type="button" [id]="id + '-view'" class="${BTN_SECONDARY}" (click)="view(p.document_id)">
                        <sd-icon name="eye" [size]="16" />View<span class="sr-only"> {{ p.slot_label }}</span>
                      </button>
                    </div>
                    @if (p.needs_number || p.needs_issue_date || p.needs_expiry) {
                      <div class="grid items-start gap-4 sm:grid-cols-3">
                        @if (p.needs_number) {
                          <label class="flex min-w-0 flex-col gap-1.5">
                            <span class="${LABEL}">Number <span aria-hidden="true">*</span></span>
                            <input [id]="id + '-number'" type="text" maxlength="60" required autocomplete="off" class="${FIELD}" [class]="docErr(p.document_id, 'number') ? '${FIELD_INVALID}' : ''" [value]="f.number" (input)="setDoc(p.document_id, 'number', $any($event.target).value)" [attr.aria-invalid]="docErr(p.document_id, 'number') ? 'true' : null" [attr.aria-describedby]="docErr(p.document_id, 'number') ? id + '-number-err' : null" />
                            @if (docErr(p.document_id, 'number'); as e) { <span [id]="id + '-number-err'" class="${FIELD_ERROR}">{{ e }}</span> }
                          </label>
                        }
                        @if (p.needs_issue_date) {
                          <label class="flex min-w-0 flex-col gap-1.5">
                            <span class="${LABEL}">Issue date <span aria-hidden="true">*</span></span>
                            <input [id]="id + '-issued_on'" type="date" required class="${FIELD} min-h-12" [attr.min]="p.slot === 'good_standing_certificate' ? goodStandingMin : null" [max]="today" [class]="docErr(p.document_id, 'issued_on') ? '${FIELD_INVALID}' : ''" [value]="f.issued_on" (input)="setDoc(p.document_id, 'issued_on', $any($event.target).value)" [attr.aria-invalid]="docErr(p.document_id, 'issued_on') ? 'true' : null" [attr.aria-describedby]="docErr(p.document_id, 'issued_on') ? id + '-issued_on-err' : null" />
                            @if (docErr(p.document_id, 'issued_on'); as e) { <span [id]="id + '-issued_on-err'" class="${FIELD_ERROR}">{{ e }}</span> }
                          </label>
                        }
                        @if (p.needs_expiry) {
                          <label class="flex min-w-0 flex-col gap-1.5">
                            <span class="${LABEL}">Expiry date <span aria-hidden="true">*</span></span>
                            <input [id]="id + '-expires_on'" type="date" required class="${FIELD} min-h-12" [min]="today" [class]="docErr(p.document_id, 'expires_on') ? '${FIELD_INVALID}' : ''" [value]="f.expires_on" (input)="setDoc(p.document_id, 'expires_on', $any($event.target).value)" [attr.aria-invalid]="docErr(p.document_id, 'expires_on') ? 'true' : null" [attr.aria-describedby]="(p.expiry_hint ? id + '-expires_on-hint ' : '') + (docErr(p.document_id, 'expires_on') ? id + '-expires_on-err' : '') || null" />
                            @if (p.expiry_hint) { <span [id]="id + '-expires_on-hint'" class="${HINT}">{{ p.expiry_hint }}</span> }
                            @if (docErr(p.document_id, 'expires_on'); as e) { <span [id]="id + '-expires_on-err'" class="${FIELD_ERROR}">{{ e }}</span> }
                          </label>
                        }
                      </div>
                    }
                    <label class="flex min-w-0 flex-col gap-1.5">
                      <span class="${LABEL}">Register reference / what you checked <span aria-hidden="true">*</span></span>
                      <input [id]="id + '-register_reference'" type="text" maxlength="120" required autocomplete="off" class="${FIELD}" [class]="docErr(p.document_id, 'register_reference') ? '${FIELD_INVALID}' : ''" [value]="f.register_reference" (input)="setDoc(p.document_id, 'register_reference', $any($event.target).value)" [attr.aria-invalid]="docErr(p.document_id, 'register_reference') ? 'true' : null" [attr.aria-describedby]="docErr(p.document_id, 'register_reference') ? id + '-ref-hint ' + id + '-register_reference-err' : id + '-ref-hint'" />
                      <span [id]="id + '-ref-hint'" class="${HINT}">{{ p.reference_hint }}</span>
                      @if (docErr(p.document_id, 'register_reference'); as e) { <span [id]="id + '-register_reference-err'" class="${FIELD_ERROR}">{{ e }}</span> }
                    </label>
                    <label class="flex min-h-11 cursor-pointer items-center gap-2">
                      <input [id]="id + '-checked'" type="checkbox" class="${CHECKBOX}" [checked]="f.checked" (change)="setDoc(p.document_id, 'checked', $any($event.target).checked)" [attr.aria-invalid]="docErr(p.document_id, 'checked') ? 'true' : null" [attr.aria-describedby]="docErr(p.document_id, 'checked') ? id + '-checked-err' : null" />
                      <span class="font-sans text-body-sm text-ink">I checked this document</span>
                    </label>
                    @if (docErr(p.document_id, 'checked'); as e) { <span [id]="id + '-checked-err'" class="-mt-3 ${FIELD_ERROR}">{{ e }}</span> }
                  </div>
                </li>
              }
            </ul>
          </section>

          <!-- 4. The attestation -->
          <section class="flex flex-col gap-2 border-t border-cloud pt-5">
            <label class="flex min-h-11 cursor-pointer items-start gap-3 rounded-field border px-4 py-3" [class]="err('attest') ? 'border-alert' : 'border-cloud'">
              <input id="bo-ap-attest" type="checkbox" class="mt-0.5 size-5 shrink-0 accent-sage" [checked]="attest()" (change)="attest.set($any($event.target).checked); clearErr('attest')" [attr.aria-invalid]="err('attest') ? 'true' : null" [attr.aria-describedby]="err('attest') ? 'bo-ap-attest-hint bo-ap-attest-err' : 'bo-ap-attest-hint'" />
              <span class="flex flex-col">
                <span class="font-sans text-body-sm text-ink">I confirm I checked these documents and this applicant's identity against {{ a.register_name }}.</span>
                <span id="bo-ap-attest-hint" class="${HINT}">Recorded with your name on each document, the approval and the audit log.</span>
              </span>
            </label>
            @if (err('attest'); as e) { <span id="bo-ap-attest-err" class="${FIELD_ERROR}">{{ e }}</span> }
          </section>

          <div aria-live="assertive">
            @if (error()) {
              <sd-alert tone="error">{{ error() }}</sd-alert>
            }
          </div>
        </form>
      } @else {
        <sd-alert tone="info">This application can't be approved in its current state. Reload the page to see where it stands.</sd-alert>
      }
      <div dialogFooter class="${DIALOG_FOOTER}">
        @if (result(); as r) {
          <a [routerLink]="['/specialists', r.specialist_id]" class="${BTN_GHOST}" (click)="closed.emit()">Open doctor page</a>
          <button type="button" class="${BTN_SUCCESS}" (click)="closed.emit()" data-autofocus>Done</button>
        } @else {
          <button type="button" class="${BTN_GHOST}" [disabled]="saving()" (click)="close()">Cancel</button>
          @if (approval()) {
            <button type="submit" form="bo-approve-form" class="${BTN_SUCCESS}" [disabled]="saving() || blocked()">
              <sd-icon [name]="saving() ? 'loader-circle' : 'badge-check'" [size]="18" [class.animate-spin]="saving()" />{{ saving() ? 'Approving…' : 'Approve and create doctor' }}
            </button>
          }
        }
      </div>
    </sd-dialog>

    <!-- Stacked over the form: the document being attested. -->
    <bo-application-document-dialog
      [open]="viewing() !== null"
      [applicationId]="detail().id"
      [document]="viewedDocument()"
      [subtitle]="detail().full_name + ' · ' + detail().reference"
      (closed)="viewing.set(null)"
    />
  `,
})
export class ApproveDialog {
  private readonly api = inject(AdminDoctorApplicationsApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly dialog = viewChild(DialogComponent);
  protected readonly choices = inject(SpecialtyChoices);

  readonly open = input(false);
  readonly detail = input.required<DoctorApplicationDetailDto>();
  readonly closed = output<void>();
  /** Approved — the result (the application, the new doctor, the invite). */
  readonly approved = output<ApproveApplicationResultDto>();
  /** The application moved on meanwhile (409): the page re-reads it. */
  readonly stale = output<void>();

  /** The clinic's today: the day the API checks dates against. */
  protected today = clinicTodayYmd();
  protected goodStandingMin = minusMonthsYmd(this.today, 6);

  protected readonly approval = computed(() => this.detail().approval);
  /**
   * The server's checks the reviewer can't fix in this dialog (e.g. a missing
   * document). Not `specialty` — they choose another one here, `specialtyWarning`
   * says why and `validate()` refuses an off-list choice; not `email` — a blocked
   * login has its own alert; not `attest` — it's the tick below.
   */
  private readonly blocking = computed(() =>
    Object.entries(this.approval()?.problems ?? {}).filter(([key, msg]) => !!msg && key !== 'specialty' && key !== 'attest' && key !== 'email'),
  );
  protected readonly blocked = computed(() => {
    const a = this.approval();
    return !a || a.login.state === 'blocked' || this.blocking().length > 0;
  });
  /** Why approval can't happen yet (the server's checks, before the reviewer's own fields). */
  protected readonly problems = computed(() => this.blocking().map(([, msg]) => msg));

  protected readonly forms = signal<Record<string, DocForm>>({});
  protected readonly specialty = signal('');
  protected readonly fee = signal('');
  protected readonly attest = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly errors = signal<Record<string, string>>({});
  protected readonly result = signal<ApproveApplicationResultDto | null>(null);
  protected readonly viewing = signal<string | null>(null);

  protected readonly viewedDocument = computed(() => {
    const id = this.viewing();
    return id ? (this.detail().documents.find((d) => d.id === id) ?? null) : null;
  });

  protected readonly specialtyOptions = computed(() => specialtyField(this.choices.items(), this.specialty()));
  /** The application's specialty has left the list: the reviewer picks one that is on it. */
  protected readonly specialtyWarning = computed(() => {
    const a = this.approval();
    const original = (this.detail().specialty ?? '').trim();
    if (!a || a.specialty_on_list || !original) return '';
    return this.specialty().trim().toLowerCase() === original.toLowerCase()
      ? `${original} is no longer on the specialty list. Choose one.`
      : '';
  });

  constructor() {
    // Each open: the prefill afresh, the specialty list re-read.
    effect(() => {
      if (!this.open()) return;
      untracked(() => {
        const d = this.detail();
        this.today = clinicTodayYmd();
        this.goodStandingMin = minusMonthsYmd(this.today, 6);
        this.result.set(null);
        this.viewing.set(null);
        this.specialty.set(d.specialty ?? '');
        this.fee.set('');
        this.attest.set(false);
        this.error.set('');
        this.errors.set({});
        const forms: Record<string, DocForm> = {};
        for (const p of d.approval?.documents ?? []) {
          forms[p.document_id] = {
            checked: false,
            register_reference: p.prefill.register_reference ?? '',
            number: p.prefill.number ?? '',
            issued_on: p.prefill.issued_on ?? '',
            expires_on: p.prefill.expires_on ?? '',
          };
        }
        this.forms.set(forms);
        this.choices.load();
      });
    });
  }

  protected close(): void {
    if (this.saving()) return;
    this.closed.emit();
  }

  protected view(documentId: string): void {
    this.viewing.set(documentId);
  }

  protected setSpecialty(value: string): void {
    this.specialty.set(value);
    this.clearErr('specialty');
  }

  protected setDoc(id: string, field: DocField, value: string | boolean): void {
    this.forms.update((all) => ({ ...all, [id]: { ...(all[id] ?? emptyForm()), [field]: value } }));
    this.clearErr(`documents.${id}.${field}`);
  }

  protected err(key: string): string {
    return this.errors()[key] ?? '';
  }

  /** The reviewer's entries for one document. */
  protected form(id: string): DocForm {
    return this.forms()[id] ?? emptyForm();
  }

  protected docErr(id: string, field: DocField): string {
    return this.errors()[`documents.${id}.${field}`] ?? '';
  }

  protected docHasError(id: string): boolean {
    return DOC_FIELDS.some((f) => !!this.docErr(id, f));
  }

  protected clearErr(key: string): void {
    if (!this.errors()[key]) return;
    this.errors.update((e) => {
      const next = { ...e };
      delete next[key];
      return next;
    });
  }

  /** The API's rules, checked first so most mistakes are caught before the request. */
  private validate(): Record<string, string> {
    const a = this.approval();
    const errors: Record<string, string> = {};
    if (!a) return errors;
    const specialty = this.specialty().trim();
    if (!specialty) errors['specialty'] = 'Choose a specialty.';
    else if (this.choices.state() === 'ready' && !isActiveSpecialty(this.choices.items(), specialty)) {
      errors['specialty'] = `${specialty} is no longer on the specialty list. Choose one.`;
    }
    if (!feeValue(this.fee())) errors['consultation_fee'] = 'Enter the consultation fee.';
    for (const p of a.documents) {
      Object.assign(errors, this.validateDoc(p));
    }
    if (!this.attest()) errors['attest'] = `Confirm that you checked this applicant's documents and identity against ${a.register_name}.`;
    return errors;
  }

  private validateDoc(p: ApprovalDocumentPrefillDto): Record<string, string> {
    const f = this.forms()[p.document_id] ?? emptyForm();
    const key = (field: DocField) => `documents.${p.document_id}.${field}`;
    const out: Record<string, string> = {};
    if (p.needs_number && !f.number.trim()) out[key('number')] = 'Enter the number on the document.';
    if (p.needs_issue_date) {
      if (!f.issued_on) out[key('issued_on')] = 'Enter the issue date.';
      else if (f.issued_on > this.today) out[key('issued_on')] = "The issue date can't be in the future.";
      else if (p.slot === 'good_standing_certificate' && f.issued_on < this.goodStandingMin) {
        out[key('issued_on')] = 'This certificate is more than 6 months old. Request a newer one.';
      }
    }
    if (p.needs_expiry) {
      if (!f.expires_on) out[key('expires_on')] = 'Enter the expiry date.';
      else if (f.expires_on < this.today) out[key('expires_on')] = 'This date has passed, so the document cannot be verified.';
    }
    const ref = f.register_reference.trim();
    if (!ref) out[key('register_reference')] = 'Say what you checked, e.g. the register entry.';
    else if (ref.length > 120) out[key('register_reference')] = 'Keep it to 120 characters.';
    if (!f.checked) out[key('checked')] = 'Tick to confirm you checked this document.';
    return out;
  }

  protected submit(): void {
    const a = this.approval();
    if (this.saving() || !a || this.blocked()) return;
    const errors = this.validate();
    this.errors.set(errors);
    this.error.set('');
    if (Object.keys(errors).length > 0) {
      this.error.set('Please complete the highlighted fields.');
      this.focusFirstError();
      return;
    }
    const documents: Record<string, ApprovalDocumentInput> = {};
    for (const p of a.documents) {
      const f = this.forms()[p.document_id] ?? emptyForm();
      documents[p.document_id] = {
        checked: true,
        register_reference: f.register_reference.trim(),
        number: p.needs_number ? f.number.trim() : null,
        issued_on: p.needs_issue_date ? f.issued_on : null,
        expires_on: p.needs_expiry ? f.expires_on : null,
      };
    }
    const body: ApproveApplicationInput = {
      expected_status: this.detail().status,
      attest: true,
      consultation_fee: feeValue(this.fee()) ?? '',
      specialty: this.specialty().trim(),
      documents,
    };
    this.saving.set(true);
    this.api
      .approve(this.detail().id, body)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.saving.set(false);
          this.result.set(res.data);
          this.approved.emit(res.data);
          // The form (and its focused button) gave way to the result.
          this.dialog()?.refocus();
        },
        error: (err: unknown) => {
          this.saving.set(false);
          this.errors.set(apiErrorFields(err));
          this.error.set(apiErrorMessage(err, 'Could not approve this application.'));
          if (isConflict(err)) this.stale.emit();
          this.dialog()?.refocus();
          this.focusFirstError();
        },
      });
  }

  /** Scroll to and focus the first field with an error, in the order the form shows them. */
  private focusFirstError(): void {
    const e = this.errors();
    const a = this.approval();
    const order: { key: string; el: string }[] = [
      { key: 'specialty', el: this.choices.state() === 'ready' ? 'bo-ap-spec-label-trigger' : 'bo-ap-spec' },
      { key: 'consultation_fee', el: 'bo-ap-fee' },
    ];
    for (const p of a?.documents ?? []) {
      for (const f of DOC_FIELDS) order.push({ key: `documents.${p.document_id}.${f}`, el: `bo-ap-doc-${p.document_id}-${f}` });
    }
    order.push({ key: 'attest', el: 'bo-ap-attest' });
    const first = order.find((o) => !!e[o.key]);
    if (!first) return;
    afterNextRender(
      () => {
        const el = document.getElementById(first.el);
        if (!el) return;
        if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
        el.focus({ preventScroll: true });
      },
      { injector: this.injector },
    );
  }
}

function emptyForm(): DocForm {
  return { checked: false, register_reference: '', number: '', issued_on: '', expires_on: '' };
}
