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
  output,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { Observable } from 'rxjs';
import { StaffAuthService } from '@supadoc/auth';
import { AdminAppointmentsApi, apiErrorFields, apiErrorMessage, SettingsApi } from '@supadoc/data-access';
import type {
  AppointmentDto,
  AppointmentNoShow,
  AppointmentRefundMode,
  ResolvedAppointmentDto,
  SuccessResponse,
} from '@supadoc/models';
import { AlertComponent, DialogComponent, IconComponent } from '@supadoc/ui';
import {
  appointmentWhen,
  hasRefund,
  naira,
  NO_SHOW_LABEL,
  refundableAmount,
} from '../shared/appointment-status';
import { BTN_DANGER, BTN_GHOST, BTN_PRIMARY, FIELD, FIELD_INVALID, FOCUS_RING, LABEL, PILL } from '../specialists/specialist-ui';

/**
 * What the back office does to a consultation through this dialog:
 *  - cancel:  an open booking or a missed one → cancelled (PATCH …/status),
 *             refunding in full by default, part of it, or nothing (with a reason);
 *  - held:    it took place → completed (POST …/resolve `held`);
 *  - no_show: it didn't → missed, or change who didn't come (`no_show`);
 *  - refund:  give back more of a closed one (`refund`).
 * Every one is audited with the staff member and the reason.
 */
export type ResolveMode = 'cancel' | 'held' | 'no_show' | 'refund';

export interface ResolveOutcome {
  readonly appointment: ResolvedAppointmentDto;
  /** What happened, for the page's status line. */
  readonly message: string;
}

interface RefundOption {
  readonly value: AppointmentRefundMode;
  readonly label: string;
  readonly hint: string;
}

interface PartyOption {
  readonly value: AppointmentNoShow;
  readonly label: string;
  readonly hint: string;
}

const REASON_MIN = 3;
const REASON_MAX = 500;
const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;
/** Field errors the dialog shows next to their field (anything else goes in the alert). */
const INLINE_FIELDS = ['reason', 'amount', 'no_show', 'refund'] as const;

let nextId = 0;

/** 8–64 of A–Z a–z 0–9 _ - : the API posts an `amount` refund once per key. */
function idempotencyKey(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Settle a consultation from its back-office page: cancel it (with the refund
 * choice), mark it held or missed, or refund more. Shows what was paid and
 * what already went back, asks for a reason (kept in the audit log) and runs
 * the request itself — busy state and inline errors included. Emits
 * `resolved` with the updated appointment; the parent closes it on `closed`.
 */
@Component({
  selector: 'bo-appointment-resolve-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DialogComponent, IconComponent, AlertComponent],
  template: `
    <sd-dialog
      [open]="open()"
      [title]="title()"
      [subtitle]="subtitle()"
      size="md"
      [busy]="saving()"
      [dialogRole]="danger() ? 'alertdialog' : 'dialog'"
      [describedBy]="formId + '-consequence'"
      (closed)="closed.emit()"
    >
      <form [id]="formId" class="flex flex-col gap-5" novalidate (submit)="$event.preventDefault(); submit()">
        <p [id]="formId + '-consequence'" class="font-sans text-body-sm text-slate">{{ consequence() }}</p>

        <dl class="flex flex-col divide-y divide-cloud rounded-field border border-cloud bg-glacier px-4 font-sans text-body-sm">
          @for (f of facts(); track f.label) {
            <div class="flex items-baseline justify-between gap-4 py-2.5">
              <dt class="shrink-0 text-slate">{{ f.label }}</dt>
              <dd class="min-w-0 break-words text-right font-semibold text-ink">{{ f.value }}</dd>
            </div>
          }
        </dl>

        @if (mode() === 'no_show') {
          <fieldset class="flex min-w-0 flex-col gap-2" [attr.aria-describedby]="formId + '-evidence' + (fieldError('no_show') ? ' ' + formId + '-party-error' : '')">
            <legend class="mb-2 font-sans text-body-sm font-semibold text-ink">Who didn't come?</legend>
            @for (p of parties; track p.value) {
              <label
                class="flex cursor-pointer items-start gap-3 rounded-field border px-4 py-3 transition-colors"
                [class]="party() === p.value ? 'border-cerulean bg-frost/30' : (fieldError('no_show') ? 'border-alert' : 'border-cloud hover:border-cerulean/50')"
              >
                <input
                  type="radio"
                  class="mt-0.5 size-4 shrink-0 accent-cerulean ${FOCUS_RING}"
                  [name]="formId + '-party'"
                  [value]="p.value"
                  [checked]="party() === p.value"
                  [disabled]="saving()"
                  (change)="setParty(p.value)"
                />
                <span class="flex min-w-0 flex-col gap-0.5">
                  <span class="flex flex-wrap items-center gap-2 font-sans text-body-sm font-semibold text-ink">
                    {{ p.label }}
                    @if (suggested() === p.value) {
                      <span class="${PILL} bg-frost text-cerulean"><sd-icon name="search-check" [size]="12" />Matches the call records</span>
                    }
                    @if (appointment().no_show === p.value && appointment().status === 'missed') {
                      <span class="${PILL} bg-cloud text-slate">Current</span>
                    }
                  </span>
                  <span class="font-sans text-caption text-slate">{{ p.hint }}</span>
                </span>
              </label>
            }
            <p [id]="formId + '-evidence'" class="flex items-start gap-1.5 font-sans text-caption text-slate">
              <sd-icon name="video" [size]="14" class="mt-0.5 shrink-0" />{{ evidence() }}
            </p>
            @if (fieldError('no_show'); as msg) {
              <p [id]="formId + '-party-error'" class="flex items-start gap-1.5 font-sans text-caption text-alert">
                <sd-icon name="circle-alert" [size]="14" class="mt-0.5 shrink-0" />{{ msg }}
              </p>
            }
          </fieldset>
        }

        @if (refundOptions().length > 0) {
          <fieldset class="flex min-w-0 flex-col gap-2" [attr.aria-describedby]="fieldError('refund') ? formId + '-refund-error' : null">
            <legend class="mb-2 font-sans text-body-sm font-semibold text-ink">Refund to the patient's wallet</legend>
            @for (o of refundOptions(); track o.value; let first = $first) {
              <label
                class="flex cursor-pointer items-start gap-3 rounded-field border px-4 py-3 transition-colors"
                [class]="refund() === o.value ? 'border-cerulean bg-frost/30' : 'border-cloud hover:border-cerulean/50'"
              >
                <input
                  type="radio"
                  class="mt-0.5 size-4 shrink-0 accent-cerulean ${FOCUS_RING}"
                  [name]="formId + '-refund'"
                  [value]="o.value"
                  [checked]="refund() === o.value"
                  [disabled]="saving()"
                  (change)="setRefund(o.value)"
                />
                <span class="flex min-w-0 flex-col gap-0.5">
                  <span class="font-sans text-body-sm font-semibold text-ink">{{ o.label }}</span>
                  @if (o.hint) {
                    <span class="font-sans text-caption text-slate">{{ o.hint }}</span>
                  }
                </span>
              </label>
            }
            @if (fieldError('refund'); as msg) {
              <p [id]="formId + '-refund-error'" class="flex items-start gap-1.5 font-sans text-caption text-alert">
                <sd-icon name="circle-alert" [size]="14" class="mt-0.5 shrink-0" />{{ msg }}
              </p>
            }
            @if (refund() === 'amount') {
              <div class="flex flex-col gap-1.5 pl-1 pt-1">
                <label [for]="formId + '-amount'" class="${LABEL}">Amount to refund</label>
                <div
                  class="flex items-stretch overflow-hidden rounded-field border bg-white focus-within:ring-2"
                  [class]="fieldError('amount') ? 'border-alert focus-within:ring-alert/20' : 'border-cloud focus-within:border-cerulean focus-within:ring-cerulean/20'"
                >
                  <span class="flex shrink-0 items-center border-r border-cloud bg-glacier px-3 font-sans text-body-sm text-slate" aria-hidden="true">₦</span>
                  <input
                    [id]="formId + '-amount'"
                    type="text"
                    inputmode="decimal"
                    autocomplete="off"
                    class="min-h-11 w-full min-w-0 flex-1 bg-transparent px-3 py-2.5 font-sans text-body-sm text-ink focus:outline-none"
                    placeholder="0.00"
                    [value]="amount()"
                    [readOnly]="saving()"
                    [attr.aria-invalid]="fieldError('amount') ? 'true' : null"
                    [attr.aria-describedby]="formId + '-amount-hint' + (fieldError('amount') ? ' ' + formId + '-amount-error' : '')"
                    data-autofocus
                    (input)="setAmount($any($event.target).value)"
                  />
                </div>
                @if (fieldError('amount'); as msg) {
                  <p [id]="formId + '-amount-error'" class="flex items-start gap-1.5 font-sans text-caption text-alert">
                    <sd-icon name="circle-alert" [size]="14" class="mt-0.5 shrink-0" />{{ msg }}
                  </p>
                }
                <p [id]="formId + '-amount-hint'" class="font-sans text-caption text-slate">At most {{ money(refundable()) }}.</p>
              </div>
            }
          </fieldset>
        } @else if (nothingPaidNote(); as note) {
          <p class="flex items-start gap-2 rounded-field bg-glacier px-4 py-3 font-sans text-body-sm text-slate">
            <sd-icon name="info" [size]="18" class="mt-0.5 shrink-0" />{{ note }}
          </p>
        }

        <div class="flex flex-col gap-1.5">
          <label [for]="formId + '-reason'" class="font-sans text-body-sm font-semibold text-ink">
            Reason
            @if (!reasonRequired()) {
              <span class="font-normal text-slate">(optional)</span>
            }
          </label>
          <textarea
            [id]="formId + '-reason'"
            rows="3"
            class="${FIELD} resize-y"
            [class]="fieldError('reason') ? '${FIELD_INVALID}' : ''"
            [attr.maxlength]="reasonMax"
            [attr.placeholder]="reasonPlaceholder()"
            [attr.aria-required]="reasonRequired() || null"
            [attr.aria-invalid]="fieldError('reason') ? 'true' : null"
            [attr.aria-describedby]="formId + '-reason-hint' + (fieldError('reason') ? ' ' + formId + '-reason-error' : '')"
            [readOnly]="saving()"
            [value]="reason()"
            (input)="setReason($any($event.target).value)"
          ></textarea>
          <div class="flex items-start justify-between gap-3 font-sans text-caption">
            <div class="flex min-w-0 flex-col gap-0.5">
              @if (fieldError('reason'); as msg) {
                <p [id]="formId + '-reason-error'" class="flex items-start gap-1.5 text-alert">
                  <sd-icon name="circle-alert" [size]="14" class="mt-0.5 shrink-0" />{{ msg }}
                </p>
              }
              <p [id]="formId + '-reason-hint'" class="text-slate">Kept in the audit log with your name. Never sent to the patient or the doctor.</p>
            </div>
            <span class="shrink-0 tabular-nums text-slate">{{ reason().length }}/{{ reasonMax }}<span class="sr-only"> characters</span></span>
          </div>
        </div>

        @if (error(); as e) {
          <sd-alert tone="error">{{ e }}</sd-alert>
        }
        <p class="sr-only" aria-live="polite">{{ saving() ? busyLabel() : '' }}</p>
      </form>

      <div dialogFooter class="flex flex-col-reverse gap-2 border-t border-cloud px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
        <button
          type="button"
          class="${BTN_GHOST}"
          [disabled]="saving()"
          [attr.data-autofocus]="danger() && refund() !== 'amount' ? '' : null"
          (click)="closed.emit()"
        >
          {{ dismissLabel() }}
        </button>
        <button type="submit" [attr.form]="formId" [class]="danger() ? btnDanger : btnPrimary" [disabled]="saving()">
          <sd-icon [name]="saving() ? 'loader-circle' : submitIcon()" [size]="18" [class.animate-spin]="saving()" />{{ saving() ? busyLabel() : submitLabel() }}
        </button>
      </div>
    </sd-dialog>
  `,
})
export class AppointmentResolveDialog {
  private readonly api = inject(AdminAppointmentsApi);
  private readonly settingsApi = inject(SettingsApi);
  private readonly auth = inject(StaffAuthService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  readonly open = input(false);
  readonly mode = input<ResolveMode>('cancel');
  readonly appointment = input.required<AppointmentDto>();

  /** Close it (Keep / ×, Esc, the scrim — not while a request runs). */
  readonly closed = output<void>();
  /** The request succeeded. */
  readonly resolved = output<ResolveOutcome>();

  protected readonly formId = `bo-resolve-${++nextId}`;
  protected readonly reasonMax = REASON_MAX;
  protected readonly btnDanger = BTN_DANGER;
  protected readonly btnPrimary = BTN_PRIMARY;

  protected readonly party = signal<AppointmentNoShow | null>(null);
  protected readonly refund = signal<AppointmentRefundMode | null>(null);
  protected readonly amount = signal('');
  protected readonly reason = signal('');
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  /** Field errors: the form's own checks after a submit attempt, then the API's 422 `errors`. */
  private readonly errors = signal<Record<string, string>>({});
  /** The no-show refund shares (Booking settings), when this account may read them. */
  private readonly shares = signal<{ patient: number; both: number } | null>(null);
  private sharesLoaded = false;
  /** Made when the dialog opens: a retried or double-submitted amount refund posts once. */
  private key = idempotencyKey();

  protected readonly refundable = computed(() => refundableAmount(this.appointment()));
  private readonly patientName = computed(() => this.appointment().patient?.name?.trim() || 'the patient');
  private readonly doctorName = computed(() => this.appointment().specialist.name?.trim() || 'the doctor');
  private readonly isMissed = computed(() => this.appointment().status === 'missed');

  /** Destructive: cancelling, or settling with no refund. */
  protected readonly danger = computed(() => this.mode() === 'cancel');

  protected readonly parties: readonly PartyOption[] = [
    { value: 'doctor', label: NO_SHOW_LABEL.doctor, hint: "The patient was there and the doctor never joined. Always a full refund; it counts towards the doctor's no-show alert." },
    { value: 'patient', label: NO_SHOW_LABEL.patient, hint: 'The doctor was there and the patient never joined.' },
    { value: 'both', label: NO_SHOW_LABEL.both, hint: 'Neither side joined the call.' },
  ];

  /** What the call records point to (first joins inside the visit window), or null when they don't say. */
  protected readonly suggested = computed<AppointmentNoShow | null>(() => {
    const a = this.appointment();
    const doctor = !!a.doctor_first_joined_at;
    const patient = !!a.patient_first_joined_at;
    if (doctor && !patient) return 'patient';
    if (patient && !doctor) return 'doctor';
    return null;
  });

  protected readonly evidence = computed(() => {
    const a = this.appointment();
    if (!a.doctor_first_joined_at && !a.patient_first_joined_at) {
      return 'No joins were recorded for this consultation (consultations from before join records began have none).';
    }
    return `Call records: the doctor ${this.joined(a.doctor_first_joined_at)}; the patient ${this.joined(a.patient_first_joined_at)}.`;
  });

  protected readonly title = computed(() => {
    switch (this.mode()) {
      case 'cancel':
        return this.appointment().patient?.name ? `Cancel ${this.appointment().patient?.name}'s consultation?` : 'Cancel this consultation?';
      case 'held':
        return 'Mark as held?';
      case 'no_show':
        return this.isMissed() ? "Change who didn't come?" : 'Mark as missed?';
      default:
        return 'Refund more of this consultation?';
    }
  });

  protected readonly subtitle = computed(() => `${this.doctorName()} · ${appointmentWhen(this.appointment())}`);

  protected readonly consequence = computed(() => {
    const a = this.appointment();
    const guests = a.guests?.length ?? 0;
    const guestNote = guests > 0 ? `, and ${guests === 1 ? 'the invited guest' : `the ${guests} invited guests`}` : '';
    switch (this.mode()) {
      case 'cancel':
        return (a.phase ?? 'upcoming') === 'upcoming'
          ? `${capitalise(this.patientName())}${guestNote} and ${this.doctorName()} are told, and the time is freed for other bookings. This can't be undone.`
          : `${capitalise(this.patientName())} and ${this.doctorName()} are told, and it moves to History as cancelled. This can't be undone.`;
      case 'held':
        return `Use this when the consultation took place but wasn't closed. It moves to Completed for both sides, ${this.patientName()} is told${this.isMissed() ? ', the no-show is cleared' : ''}, and it counts towards ${this.doctorName()}'s earnings.`;
      case 'no_show':
        return this.isMissed()
          ? 'The refund follows the rules for your new choice. Following the rules only ever tops up what already went back — it never takes money back. Both sides are told again with the new outcome.'
          : `Use this when the consultation didn't take place. It closes as Missed. ${capitalise(this.patientName())} and ${this.doctorName()} are each told who didn't come.`;
      default:
        return `${capitalise(this.patientName())} is told how much went back to their wallet.`;
    }
  });

  protected readonly facts = computed(() => {
    const a = this.appointment();
    const out: { label: string; value: string }[] = [];
    if (a.patient?.name) out.push({ label: 'Patient', value: a.patient.name });
    const paid = a.payment_status === 'paid' || a.payment_status === 'refunded';
    if (!(Number(a.amount) > 0)) out.push({ label: 'Price', value: 'Free' });
    else if (paid) out.push({ label: 'Paid', value: naira(a.amount) });
    else out.push({ label: 'Price', value: `${naira(a.amount)} · ${a.payment_status === 'pending' ? 'payment pending' : 'not paid'}` });
    if ((a.guests?.length ?? 0) > 0) out.push({ label: 'Guests', value: String(a.guests?.length) });
    if (hasRefund(a)) out.push({ label: 'Already refunded', value: naira(a.refunded_amount) });
    if (this.refundable() > 0 && (hasRefund(a) || this.mode() === 'refund')) out.push({ label: 'Left to refund', value: naira(this.refundable()) });
    if (this.isMissed() && a.no_show) out.push({ label: "Who didn't come", value: NO_SHOW_LABEL[a.no_show] });
    return out;
  });

  protected readonly refundOptions = computed<readonly RefundOption[]>(() => {
    const left = this.refundable();
    if (left <= 0) return [];
    const full = naira(left);
    const part: RefundOption = { value: 'amount', label: 'Refund part of it', hint: `Up to ${full}.` };
    switch (this.mode()) {
      case 'cancel':
        return [
          { value: 'full', label: `Refund in full — ${full}`, hint: 'Everything left on it goes back to the wallet, guest fees included.' },
          part,
          { value: 'none', label: 'No refund', hint: 'Only with a good reason — e.g. it took place after all. Say why below.' },
        ];
      case 'held':
        return [
          { value: 'none', label: 'No refund', hint: `It took place, so ${this.doctorName()} earns the fee.` },
          { value: 'full', label: `Refund in full — ${full}`, hint: 'A goodwill refund of everything left; the doctor then earns nothing for it.' },
          part,
        ];
      case 'no_show':
        return [
          { value: 'policy', label: 'Follow the no-show rules', hint: this.policyHint() },
          { value: 'full', label: `Refund in full — ${full}`, hint: 'Everything left, guest fees included.' },
          part,
          { value: 'none', label: 'No refund now', hint: 'Nothing more goes back.' },
        ];
      default:
        return [{ value: 'full', label: `Refund everything left — ${full}`, hint: '' }, part];
    }
  });

  /** When there is nothing to refund, say so instead of offering choices. */
  protected readonly nothingPaidNote = computed(() => {
    if (this.mode() === 'refund' || this.refundable() > 0) return '';
    const a = this.appointment();
    if (hasRefund(a)) return 'Everything paid for it already went back to the wallet.';
    return Number(a.amount) > 0 ? "It wasn't paid for, so there's nothing to refund." : "It's free, so there's nothing to refund.";
  });

  protected readonly reasonRequired = computed(() => this.mode() !== 'cancel' || this.refund() === 'none' || this.refund() === 'amount');

  protected readonly reasonPlaceholder = computed(() => {
    switch (this.mode()) {
      case 'cancel':
        return 'e.g. The doctor is unwell and asked us to cancel.';
      case 'held':
        return 'e.g. The doctor confirmed by phone that the consultation took place.';
      case 'no_show':
        return "e.g. The patient called to say they couldn't join.";
      default:
        return 'e.g. Goodwill refund after a poor connection.';
    }
  });

  protected readonly dismissLabel = computed(() => (this.mode() === 'cancel' ? 'Keep appointment' : 'Cancel'));

  protected readonly submitLabel = computed(() => {
    const left = this.refundable();
    switch (this.mode()) {
      case 'cancel':
        if (left <= 0) return 'Cancel appointment';
        if (this.refund() === 'full') return `Cancel and refund ${naira(left)}`;
        if (this.refund() === 'amount') return 'Cancel and refund';
        return 'Cancel without refund';
      case 'held':
        return 'Mark held';
      case 'no_show':
        return this.isMissed() ? 'Save change' : 'Mark missed';
      default:
        return this.refund() === 'full' ? `Refund ${naira(left)}` : 'Refund';
    }
  });

  protected readonly submitIcon = computed(() => {
    switch (this.mode()) {
      case 'cancel':
        return 'calendar-x';
      case 'held':
        return 'circle-check';
      case 'no_show':
        return 'user-x';
      default:
        return 'wallet';
    }
  });

  protected readonly busyLabel = computed(() => {
    switch (this.mode()) {
      case 'cancel':
        return 'Cancelling…';
      case 'refund':
        return 'Refunding…';
      default:
        return 'Saving…';
    }
  });

  constructor() {
    // Start fresh each time it opens.
    effect(() => {
      if (!this.open()) return;
      untracked(() => this.reset());
    });
  }

  protected fieldError(key: string): string {
    return this.errors()[key] ?? '';
  }

  protected setParty(p: AppointmentNoShow): void {
    this.party.set(p);
    this.clearError('no_show');
  }

  protected setRefund(mode: AppointmentRefundMode): void {
    this.refund.set(mode);
    this.clearError('refund');
    this.clearError('amount');
    // A refund that moves money turns "nothing would change" into a change.
    if (this.party() && !this.isUnchangedNoShow()) this.clearError('no_show');
    if (!this.reasonRequired()) this.clearError('reason');
  }

  protected setAmount(raw: string): void {
    this.amount.set(raw);
    this.clearError('amount');
  }

  protected setReason(raw: string): void {
    this.reason.set(raw);
    this.clearError('reason');
  }

  protected money(n: number): string {
    return naira(n);
  }

  protected submit(): void {
    if (this.saving()) return;
    this.error.set('');
    const problems = this.validate();
    this.errors.set(problems);
    if (Object.keys(problems).length > 0) {
      this.error.set('Check the highlighted fields.');
      this.focusFirstProblem();
      return;
    }
    const mode = this.mode();
    const party = this.party();
    this.saving.set(true);
    this.request()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.saving.set(false);
          this.resolved.emit({ appointment: res.data, message: this.successMessage(mode, res.data, party) });
        },
        error: (err: unknown) => {
          this.saving.set(false);
          const fields = apiErrorFields(err);
          const inline = INLINE_FIELDS.some((k) => fields[k]);
          this.errors.set(fields);
          this.error.set(inline ? '' : apiErrorMessage(err, this.failureFallback()));
          if (inline) this.focusFirstProblem();
        },
      });
  }

  // ----- internals -----

  /** Put focus on the first field with a problem (form order: who, refund, amount, reason) once it renders. */
  private focusFirstProblem(): void {
    afterNextRender(
      () => {
        const root = this.host.nativeElement;
        const e = this.errors();
        const target =
          (e['no_show'] && root.querySelector<HTMLElement>(`input[name="${this.formId}-party"]:checked, input[name="${this.formId}-party"]`)) ||
          (e['refund'] && root.querySelector<HTMLElement>(`input[name="${this.formId}-refund"]:checked, input[name="${this.formId}-refund"]`)) ||
          root.querySelector<HTMLElement>('[aria-invalid="true"]');
        target?.focus();
      },
      { injector: this.injector },
    );
  }

  private reset(): void {
    const a = this.appointment();
    this.key = idempotencyKey();
    this.party.set(this.mode() === 'no_show' ? (this.isMissed() ? (a.no_show ?? null) : this.suggested()) : null);
    this.refund.set(this.refundOptions()[0]?.value ?? null);
    this.amount.set('');
    this.reason.set('');
    this.errors.set({});
    this.error.set('');
    this.saving.set(false);
    if (this.mode() === 'no_show') this.loadShares();
  }

  /** The no-show refund shares, for the policy option's wording (needs settings.manage; else generic wording). */
  private loadShares(): void {
    if (this.sharesLoaded || !this.auth.hasPermission('settings.manage')) return;
    this.sharesLoaded = true;
    this.settingsApi
      .getBookingSettings()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) =>
          this.shares.set({
            patient: res.data.noshow_patient_refund_pct ?? 0,
            both: res.data.noshow_both_refund_pct ?? 0,
          }),
        error: () => (this.sharesLoaded = false),
      });
  }

  private policyHint(): string {
    const party = this.party();
    const left = this.refundable();
    const shares = this.shares();
    const topUp = this.isMissed() ? ' Never takes back what already went back.' : '';
    if (party === 'doctor') return `Full refund — ${naira(left)}. A doctor no-show always refunds everything.${topUp}`;
    if (party === 'patient' || party === 'both') {
      const pct = shares ? (party === 'patient' ? shares.patient : shares.both) : null;
      const earns = party === 'patient' ? `${this.doctorName()} earns the rest` : `${this.doctorName()} earns nothing`;
      const share =
        pct === null
          ? 'The share set in Booking settings of the consultation fee goes back, plus any guest fees'
          : pct === 0
            ? 'Guest fees go back; the consultation fee does not'
            : `${pct}% of the consultation fee goes back, plus any guest fees`;
      return `${share}; ${earns}.${topUp}`;
    }
    return "Depends on who didn't come — choose above.";
  }

  private validate(): Record<string, string> {
    const out: Record<string, string> = {};
    if (this.mode() === 'no_show' && !this.party()) out['no_show'] = "Choose who didn't come.";
    else if (this.isUnchangedNoShow()) {
      out['no_show'] =
        this.refundOptions().length > 0
          ? "Nothing would change. Choose who didn't come differently, or another refund option."
          : "Nothing would change. Choose who didn't come differently.";
    }
    if (this.refund() === 'amount') {
      const raw = this.amount().trim().replace(/,/g, '');
      const n = Number(raw);
      if (!AMOUNT_RE.test(raw) || !(n > 0)) out['amount'] = 'Enter an amount in naira, e.g. 2500 or 2500.50.';
      else if (n > this.refundable()) out['amount'] = `At most ${naira(this.refundable())} can be refunded.`;
    }
    const reason = this.reason().trim();
    if (!reason && this.reasonRequired()) out['reason'] = 'Say why — it is kept in the audit log.';
    else if (reason && reason.length < REASON_MIN) out['reason'] = `Please enter at least ${REASON_MIN} characters.`;
    else if (reason.length > REASON_MAX) out['reason'] = `Please keep it to ${REASON_MAX} characters or fewer.`;
    return out;
  }

  /**
   * Re-saving a missed visit with the same party and no money moving: the API
   * changes nothing for `policy` (no audit row, the reason is dropped) and only
   * re-sends both notices for `none` — so don't report a change that isn't one.
   */
  private isUnchangedNoShow(): boolean {
    if (this.mode() !== 'no_show' || !this.isMissed() || this.party() !== this.appointment().no_show) return false;
    const refund = this.refundOptions().length > 0 ? this.refund() : null;
    return refund === null || refund === 'policy' || refund === 'none';
  }

  private request(): Observable<SuccessResponse<ResolvedAppointmentDto>> {
    const a = this.appointment();
    const reason = this.reason().trim();
    const refund = this.refundOptions().length > 0 ? (this.refund() ?? undefined) : undefined;
    const amount = refund === 'amount' ? this.amount().trim().replace(/,/g, '') : undefined;
    const key = refund === 'amount' ? this.key : undefined;
    switch (this.mode()) {
      case 'cancel':
        return this.api.updateStatus(a.id, 'cancelled', {
          ...(refund && refund !== 'policy' ? { refund } : {}),
          ...(amount ? { amount } : {}),
          ...(reason ? { reason } : {}),
          ...(key ? { idempotency_key: key } : {}),
        });
      case 'held':
        return this.api.resolve(a.id, { action: 'held', reason, ...(refund ? { refund } : {}), ...(amount ? { amount } : {}), ...(key ? { idempotency_key: key } : {}) });
      case 'no_show':
        return this.api.resolve(a.id, {
          action: 'no_show',
          no_show: this.party() ?? undefined,
          reason,
          ...(refund ? { refund } : {}),
          ...(amount ? { amount } : {}),
          ...(key ? { idempotency_key: key } : {}),
        });
      default:
        return this.api.resolve(a.id, { action: 'refund', reason, ...(refund ? { refund } : {}), ...(amount ? { amount } : {}), ...(key ? { idempotency_key: key } : {}) });
    }
  }

  private successMessage(mode: ResolveMode, a: ResolvedAppointmentDto, party: AppointmentNoShow | null): string {
    const refunded = Number(a.refunded_now) || 0;
    const back = refunded > 0 ? ` ${naira(refunded)} went back to the patient's wallet.` : '';
    switch (mode) {
      case 'cancel':
        return `Appointment cancelled.${back || (refundableAmount(this.appointment()) > 0 ? ' Nothing was refunded.' : '')}`;
      case 'held':
        return `Marked held — it's now completed.${back}`;
      case 'no_show':
        return `Marked missed (${party ? NO_SHOW_LABEL[party] : 'no-show'}).${back}`;
      default:
        return refunded > 0 ? `${naira(refunded)} refunded to the patient's wallet.` : 'Nothing more was refunded — it had all gone back already.';
    }
  }

  private failureFallback(): string {
    switch (this.mode()) {
      case 'cancel':
        return 'Could not cancel the appointment.';
      case 'refund':
        return 'Could not issue the refund.';
      default:
        return 'Could not update the consultation.';
    }
  }

  private joined(iso: string | null | undefined): string {
    if (!iso) return 'never joined';
    const d = new Date(iso);
    return isNaN(d.getTime())
      ? 'joined'
      : `first joined at ${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(d)}`;
  }

  private clearError(key: string): void {
    if (!this.errors()[key]) return;
    this.errors.update((all) => {
      const rest = { ...all };
      delete rest[key];
      return rest;
    });
    if (Object.keys(this.errors()).length === 0) this.error.set('');
  }
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
