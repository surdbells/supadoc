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
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { Subscription } from 'rxjs';
import { apiErrorFields, apiErrorMessage, SpecialistsApi } from '@supadoc/data-access';
import type {
  SpecialistDetailDto,
  SuspensionCode,
  SuspensionPreviewDto,
  SuspensionResultDto,
} from '@supadoc/models';
import { AlertComponent, IconComponent } from '@supadoc/ui';
import { BoDialog } from '../../shared/dialog';
import {
  BTN_DANGER,
  BTN_GHOST,
  BTN_PRIMARY,
  BTN_SECONDARY,
  codeLabel,
  FIELD,
  FIELD_INVALID,
  LABEL,
  money,
  plural,
  SUSPENSION_CODE_LABELS,
} from '../specialist-ui';

/**
 * Suspend an approved doctor — they stopped practising. First a preview of
 * what it does (bookings cancelled and refunded, guests' fees, follow-up
 * proposals withdrawn, patients told), then a reason code and a reason the
 * doctor sees, then the outcome. A run that stopped part-way (`incomplete`)
 * can be finished from here — straight away, or later by opening the dialog
 * with the suspension's `finishCode` / `finishReason`: it then shows what is
 * still left and re-runs the suspension with them (the API only finishes the
 * cancellations for a doctor already suspended).
 */
@Component({
  selector: 'bo-suspend-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, AlertComponent, BoDialog],
  template: `
    <bo-dialog
      [open]="open()"
      [title]="result() ? 'Suspension done' : (finishing() ? 'Finish suspending ' : 'Suspend ') + doctorName()"
      [subtitle]="result() ? '' : finishing() ? 'The suspension stopped before every future booking was cancelled. Finishing cancels and refunds the rest — it is safe to run again.' : 'For a doctor who has stopped practising. To pause bookings for a while, switch off “Taking bookings” on the Overview tab instead.'"
      size="lg"
      [busy]="saving()"
      (closed)="closed.emit()"
    >
      @if (result(); as r) {
        <div class="flex flex-col gap-4" aria-live="polite">
          @if (r.incomplete) {
            <sd-alert tone="warning">Some bookings couldn't be cancelled yet{{ r.failed ? ' (' + r.failed + ' failed)' : '' }}. The doctor is suspended — finish the rest now; it's safe to run again.</sd-alert>
          } @else {
            <sd-alert tone="success">{{ doctorName() }} is suspended, unlisted and signed out.</sd-alert>
          }
          <dl class="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 rounded-field bg-glacier p-4 font-sans text-body-sm">
            <dt class="text-slate">Bookings cancelled</dt><dd class="text-right font-semibold text-ink">{{ r.cancelled }}</dd>
            <dt class="text-slate">Refunds to wallets</dt><dd class="text-right font-semibold text-ink">{{ r.refunded_count }} · {{ money(r.refunded_total, r.currency) }}</dd>
            <dt class="text-slate">Guests told</dt><dd class="text-right font-semibold text-ink">{{ r.guests_notified }}</dd>
            <dt class="text-slate">Follow-up proposals withdrawn</dt><dd class="text-right font-semibold text-ink">{{ r.proposals_withdrawn }}</dd>
            <dt class="text-slate">Patients notified</dt><dd class="text-right font-semibold text-ink">{{ r.patients_notified }}</dd>
            <dt class="text-slate">Sessions signed out</dt><dd class="text-right font-semibold text-ink">{{ r.sessions_revoked }}</dd>
          </dl>
          @if (r.in_progress; as n) {
            <p class="flex items-start gap-2 font-sans text-body-sm text-ink"><sd-icon name="clock" [size]="16" class="mt-0.5 shrink-0 text-slate" />{{ inProgressText(n, true) }}</p>
          }
          @if (error()) {
            <sd-alert tone="error">{{ error() }}</sd-alert>
          }
        </div>
      } @else if (previewLoading()) {
        <div class="flex flex-col gap-3" aria-busy="true">
          <span class="sr-only" role="status">Working out what suspending would change…</span>
          <div class="sd-shimmer h-28 rounded-field"></div>
          <div class="sd-shimmer h-40 rounded-field"></div>
        </div>
      } @else if (previewError()) {
        <div class="flex flex-col items-center gap-3 py-6 text-center">
          <sd-icon name="wifi-off" [size]="28" class="text-alert" />
          <p class="font-sans text-body-sm text-slate" role="alert">{{ previewError() }}</p>
          <button type="button" class="${BTN_SECONDARY}" (click)="loadPreview()"><sd-icon name="refresh-cw" [size]="16" />Try again</button>
        </div>
      } @else if (finishing() && preview(); as p) {
        <form id="bo-suspend-finish" class="flex flex-col gap-4" novalidate (submit)="$event.preventDefault(); finish()">
          @if (nothingLeft()) {
            <sd-alert tone="success">Nothing is left to do — every future booking is already cancelled.</sd-alert>
          } @else {
            <section class="flex flex-col gap-2 rounded-field border border-alert/30 bg-alert/5 p-4" aria-labelledby="bo-suspend-left">
              <h3 id="bo-suspend-left" class="font-sans text-body-sm font-semibold text-ink">Still to do</h3>
              <ul class="flex flex-col gap-1.5 font-sans text-body-sm text-ink">
                @if (p.bookings > 0) {
                  <li class="flex items-start gap-2"><sd-icon name="calendar-off" [size]="16" class="mt-0.5 shrink-0 text-alert" />{{ plural(p.bookings, 'future booking') }} to cancel for {{ plural(p.patients, 'patient') }}</li>
                }
                @if (p.refunds > 0) {
                  <li class="flex items-start gap-2"><sd-icon name="wallet" [size]="16" class="mt-0.5 shrink-0 text-alert" />{{ plural(p.refunds, 'refund') }} to patients' wallets — {{ money(p.refund_total, p.currency) }} in total{{ p.guests > 0 ? ', including ' + money(p.guest_fees, p.currency) + ' in guest fees' : '' }}</li>
                }
                @if (p.proposals > 0) {
                  <li class="flex items-start gap-2"><sd-icon name="calendar-clock" [size]="16" class="mt-0.5 shrink-0 text-alert" />{{ plural(p.proposals, 'open follow-up proposal') }} to withdraw</li>
                }
                <li class="flex items-start gap-2"><sd-icon name="mail" [size]="16" class="mt-0.5 shrink-0 text-alert" />Each of these patients is emailed and notified with their refund and a link to doctors of the same specialty</li>
              </ul>
            </section>
          }
          @if (p.in_progress; as n) {
            <p class="flex items-start gap-2 font-sans text-body-sm text-ink"><sd-icon name="clock" [size]="16" class="mt-0.5 shrink-0 text-slate" />{{ inProgressText(n) }}</p>
          }
          <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 font-sans text-body-sm">
            <dt class="text-slate">Reason</dt><dd class="break-words text-ink">{{ codeText() }}</dd>
            @if (!needsReason()) {
              <dt class="text-slate">Explanation</dt><dd class="whitespace-pre-line break-words text-ink">{{ reason() }}</dd>
            }
          </dl>
          @if (needsReason() && !nothingLeft()) {
            <label class="flex flex-col gap-1.5">
              <span class="${LABEL}">Note for the record (required)</span>
              <textarea rows="3" maxlength="2000" class="${FIELD}" [class]="err('reason') ? '${FIELD_INVALID}' : ''" [value]="reason()" (input)="reason.set($any($event.target).value); clearErr('reason')" [attr.aria-invalid]="err('reason') ? 'true' : null" [attr.aria-describedby]="err('reason') ? 'bo-suspend-finish-err' : null" data-autofocus></textarea>
              @if (err('reason'); as e) { <span id="bo-suspend-finish-err" class="font-sans text-caption text-alert">{{ e }}</span> }
            </label>
          }
          <div aria-live="assertive">
            @if (error()) {
              <sd-alert tone="error">{{ error() }}</sd-alert>
            }
          </div>
        </form>
      } @else if (preview(); as p) {
        <form id="bo-suspend-form" class="flex flex-col gap-4" novalidate (submit)="$event.preventDefault(); submit()">
          <section class="flex flex-col gap-2 rounded-field border border-alert/30 bg-alert/5 p-4" aria-labelledby="bo-suspend-what">
            <h3 id="bo-suspend-what" class="font-sans text-body-sm font-semibold text-ink">What happens straight away</h3>
            <ul class="flex flex-col gap-1.5 font-sans text-body-sm text-ink">
              <li class="flex items-start gap-2"><sd-icon name="calendar-off" [size]="16" class="mt-0.5 shrink-0 text-alert" />
                @if (p.bookings > 0) {
                  {{ plural(p.bookings, 'future booking') }} cancelled for {{ plural(p.patients, 'patient') }}
                } @else {
                  No future bookings to cancel
                }
              </li>
              <li class="flex items-start gap-2"><sd-icon name="wallet" [size]="16" class="mt-0.5 shrink-0 text-alert" />
                @if (p.refunds > 0) {
                  {{ plural(p.refunds, 'refund') }} to patients' wallets — {{ money(p.refund_total, p.currency) }} in total{{ p.guests > 0 ? ', including ' + money(p.guest_fees, p.currency) + ' in guest fees (' + plural(p.guests, 'guest') + ')' : '' }}
                } @else {
                  Nothing to refund
                }
              </li>
              @if (p.proposals > 0) {
                <li class="flex items-start gap-2"><sd-icon name="calendar-clock" [size]="16" class="mt-0.5 shrink-0 text-alert" />{{ plural(p.proposals, 'open follow-up proposal') }} withdrawn</li>
              }
              @if (p.in_progress; as n) {
                <li class="flex items-start gap-2"><sd-icon name="clock" [size]="16" class="mt-0.5 shrink-0 text-slate" />{{ inProgressText(n) }}</li>
              }
              <li class="flex items-start gap-2"><sd-icon name="mail" [size]="16" class="mt-0.5 shrink-0 text-alert" />Each patient is emailed and notified with their refund and a link to doctors of the same specialty</li>
              <li class="flex items-start gap-2"><sd-icon name="log-out" [size]="16" class="mt-0.5 shrink-0 text-alert" />Unlisted, signed out everywhere, and blocked from clinical work and new payouts</li>
            </ul>
          </section>

          <label class="flex flex-col gap-1.5">
            <span class="${LABEL}">Reason (required)</span>
            <select class="${FIELD} min-h-11" [class]="err('code') ? '${FIELD_INVALID}' : ''" (change)="code.set($any($event.target).value); clearErr('code')" [attr.aria-invalid]="err('code') ? 'true' : null" [attr.aria-describedby]="err('code') ? 'bo-suspend-code-err' : null" data-autofocus>
              <option value="" [selected]="code() === ''" disabled>Choose a reason…</option>
              @for (c of codes(); track c.code) {
                <option [value]="c.code" [selected]="code() === c.code">{{ c.label }}</option>
              }
            </select>
            @if (err('code'); as e) { <span id="bo-suspend-code-err" class="font-sans text-caption text-alert">{{ e }}</span> }
          </label>
          <label class="flex flex-col gap-1.5">
            <span class="${LABEL}">Explanation — the doctor sees this (required)</span>
            <textarea rows="4" maxlength="2000" class="${FIELD}" [class]="err('reason') ? '${FIELD_INVALID}' : ''" [value]="reason()" (input)="reason.set($any($event.target).value); clearErr('reason')" placeholder="e.g. Your annual practising licence expired on 30 September. Upload the renewed licence to be reinstated." [attr.aria-invalid]="err('reason') ? 'true' : null" [attr.aria-describedby]="err('reason') ? 'bo-suspend-reason-err' : 'bo-suspend-reason-count'"></textarea>
            @if (err('reason'); as e) { <span id="bo-suspend-reason-err" class="font-sans text-caption text-alert">{{ e }}</span> }
            @else { <span id="bo-suspend-reason-count" class="font-sans text-caption text-slate">{{ reason().length }} / 2000</span> }
          </label>
          @if (p.bookings > 0) {
            <label class="flex min-h-11 cursor-pointer items-start gap-3 rounded-field border px-4 py-3" [class]="err('ack') ? 'border-alert' : 'border-cloud'">
              <input type="checkbox" class="mt-0.5 size-5 shrink-0 accent-alert" [checked]="ack()" (change)="ack.set($any($event.target).checked); clearErr('ack')" [attr.aria-invalid]="err('ack') ? 'true' : null" [attr.aria-describedby]="err('ack') ? 'bo-suspend-ack-err' : null" />
              <span class="font-sans text-body-sm text-ink">I understand {{ plural(p.bookings, 'booking') }} will be cancelled and refunded, and reinstating the doctor won't restore them.</span>
            </label>
            @if (err('ack'); as e) { <span id="bo-suspend-ack-err" class="-mt-2 font-sans text-caption text-alert">{{ e }}</span> }
          }
          <div aria-live="assertive">
            @if (error()) {
              <sd-alert tone="error">{{ error() }}</sd-alert>
            }
          </div>
        </form>
      }

      <div dialogFooter class="flex flex-col-reverse gap-2 border-t border-cloud px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
        @if (result(); as r) {
          @if (r.incomplete) {
            <button type="button" class="${BTN_GHOST}" [disabled]="saving()" (click)="closed.emit()">Later</button>
            <button type="button" class="${BTN_PRIMARY}" [disabled]="saving()" (click)="run()" data-autofocus>
              <sd-icon [name]="saving() ? 'loader-circle' : 'refresh-cw'" [size]="18" [class.animate-spin]="saving()" />{{ saving() ? 'Finishing…' : 'Finish now' }}
            </button>
          } @else {
            <button type="button" class="${BTN_PRIMARY}" (click)="closed.emit()" data-autofocus>Done</button>
          }
        } @else if (finishing()) {
          <button type="button" class="${BTN_GHOST}" [disabled]="saving()" (click)="closed.emit()">{{ nothingLeft() ? 'Close' : 'Cancel' }}</button>
          @if (preview(); as p) {
            @if (!nothingLeft()) {
              <button type="submit" form="bo-suspend-finish" class="${BTN_DANGER}" [disabled]="saving()" data-autofocus>
                <sd-icon [name]="saving() ? 'loader-circle' : 'refresh-cw'" [size]="18" [class.animate-spin]="saving()" />{{ saving() ? 'Finishing…' : (p.bookings > 0 ? 'Cancel and refund ' + plural(p.bookings, 'booking') : 'Finish suspension') }}
              </button>
            }
          }
        } @else {
          <button type="button" class="${BTN_GHOST}" [disabled]="saving()" (click)="closed.emit()">Cancel</button>
          @if (preview(); as p) {
            <button type="submit" form="bo-suspend-form" class="${BTN_DANGER}" [disabled]="saving()">
              <sd-icon [name]="saving() ? 'loader-circle' : 'ban'" [size]="18" [class.animate-spin]="saving()" />{{ saving() ? 'Suspending…' : (p.bookings > 0 ? 'Suspend and cancel ' + plural(p.bookings, 'booking') : 'Suspend doctor') }}
            </button>
          }
        }
      </div>
    </bo-dialog>
  `,
})
export class SuspendDialog {
  private readonly api = inject(SpecialistsApi);
  private readonly destroyRef = inject(DestroyRef);

  readonly open = input(false);
  readonly specialistId = input.required<string>();
  readonly doctorName = input('');
  /**
   * Set (with `finishReason`) to finish an earlier suspension that stopped
   * part-way: the dialog then re-runs it with that code and reason. Read when
   * the dialog opens.
   */
  readonly finishCode = input<SuspensionCode | null>(null);
  readonly finishReason = input<string | null>(null);
  readonly closed = output<void>();
  /** Each successful run — the doctor's new review summary for the page. */
  readonly suspended = output<Partial<SpecialistDetailDto>>();

  private readonly dialog = viewChild(BoDialog);

  /** Opened to finish an earlier, incomplete suspension. */
  protected readonly finishing = signal(false);
  /** Finishing, but the suspension has no stored reason to send again. */
  protected readonly needsReason = signal(false);
  protected readonly preview = signal<SuspensionPreviewDto | null>(null);
  protected readonly previewLoading = signal(false);
  protected readonly previewError = signal('');
  protected readonly code = signal<SuspensionCode | ''>('');
  protected readonly reason = signal('');
  protected readonly ack = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly errors = signal<Record<string, string>>({});
  protected readonly result = signal<SuspensionResultDto | null>(null);
  private previewSub?: Subscription;

  protected readonly codes = computed(() => {
    const live = this.preview()?.codes ?? [];
    return live.length > 0
      ? live
      : Object.entries(SUSPENSION_CODE_LABELS).map(([code, label]) => ({ code: code as SuspensionCode, label }));
  });

  protected readonly codeText = computed(() => {
    const code = this.code();
    return this.codes().find((c) => c.code === code)?.label ?? codeLabel(code);
  });

  /** Finishing, and the preview says no booking or proposal is left. */
  protected readonly nothingLeft = computed(() => {
    const p = this.preview();
    return !!p && p.bookings === 0 && p.proposals === 0;
  });

  constructor() {
    effect(() => {
      const open = this.open();
      untracked(() => {
        if (!open) {
          this.previewSub?.unsubscribe();
          return;
        }
        const finishCode = this.finishCode();
        const finishReason = (this.finishReason() ?? '').trim();
        this.finishing.set(!!finishCode);
        this.needsReason.set(!!finishCode && finishReason === '');
        this.code.set(finishCode ?? '');
        this.reason.set(finishCode ? finishReason : '');
        this.ack.set(false);
        this.error.set('');
        this.errors.set({});
        this.result.set(null);
        this.loadPreview();
      });
    });
  }

  protected loadPreview(): void {
    this.previewSub?.unsubscribe();
    this.preview.set(null);
    this.previewLoading.set(true);
    this.previewError.set('');
    this.previewSub = this.api
      .suspensionPreview(this.specialistId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.preview.set(res.data);
          this.previewLoading.set(false);
          // The form replaced the loading placeholder: focus its first control.
          this.dialog()?.refocus();
        },
        error: (err: unknown) => {
          this.previewError.set(apiErrorMessage(err, 'Could not work out what suspending would change.'));
          this.previewLoading.set(false);
        },
      });
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

  protected submit(): void {
    const p = this.preview();
    if (!p || this.saving()) return;
    const errors: Record<string, string> = {};
    if (!this.code()) errors['code'] = 'Choose a reason.';
    const reason = this.reason().trim();
    if (!reason) errors['reason'] = 'Explain why — the doctor will see this.';
    if (p.bookings > 0 && !this.ack()) errors['ack'] = 'Confirm that the bookings will be cancelled.';
    this.errors.set(errors);
    if (Object.keys(errors).length > 0) {
      this.error.set(Object.values(errors)[0]);
      return;
    }
    this.run();
  }

  /** Finish an earlier suspension with its own code and reason. */
  protected finish(): void {
    if (this.saving() || this.nothingLeft()) return;
    if (!this.reason().trim()) {
      this.errors.set({ reason: 'Add a short note for the record.' });
      this.error.set('');
      return;
    }
    this.run();
  }

  /** Suspend (or finish an incomplete run with the same code and reason). */
  protected run(): void {
    const code = this.code();
    if (!code || this.saving()) return;
    this.saving.set(true);
    this.error.set('');
    this.api
      .suspend(this.specialistId(), { code, reason: this.reason().trim() })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.saving.set(false);
          this.result.set(res.data.affected);
          this.suspended.emit(res.data.summary);
          // The outcome replaced the form and its focused button.
          this.dialog()?.refocus();
        },
        error: (err: unknown) => {
          this.saving.set(false);
          this.errors.set(apiErrorFields(err));
          this.error.set(apiErrorMessage(err, 'Could not suspend this doctor.'));
          // The button that was pressed lost focus while disabled.
          this.dialog()?.refocus();
        },
      });
  }

  protected money(amount: string, currency: string): string {
    return money(amount, currency);
  }
  protected plural(n: number, word: string): string {
    return plural(n, word);
  }
  /** Consultations taking place now: the suspension leaves them to finish (the cron completes them). */
  protected inProgressText(n: number, done = false): string {
    const verb = done ? (n === 1 ? 'was' : 'were') : 'will be';
    return `${plural(n, 'consultation')} in progress ${verb} left to finish (not cancelled or refunded)`;
  }
}
