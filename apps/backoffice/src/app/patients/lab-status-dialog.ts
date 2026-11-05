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
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { apiErrorFields, apiErrorMessage, CLINIC_TIME_ZONE, LabRequestsApi, todayInZone } from '@supadoc/data-access';
import type { AdminLabRequestSummaryDto, LabCorrectionTarget } from '@supadoc/models';
import { AlertComponent, DialogComponent, IconComponent } from '@supadoc/ui';
import { BTN_GHOST, BTN_PRIMARY, FIELD, FIELD_INVALID, FOCUS_RING } from '../shared/layout';
import { calendarDate, isReopen, labCorrectionLabel, labStatusLabel } from './lab-request-ui';

export const REASON_MIN = 5;
export const REASON_MAX = 500;

/** Exact copy (lab spec §5). */
export const LAB_STATUS_COPY = {
  title: 'Correct lab request status',
  legend: 'New status',
  sampleLabel: 'Date the sample was taken (optional)',
  sampleHelper: 'Leave empty to use today.',
  reasonHelper:
    'Kept with the request, visible only to staff who manage lab requests. The doctor sees that VideoMed support changed it, not your reason.',
  reopenNote: 'The patient gets a notice that the request is open again.',
  submit: 'Change status',
  cancel: 'Cancel',
  conflict: 'This request changed. Reload and try again.',
  chooseStatus: 'Choose a status from the list',
  reasonShort: `Add a reason (at least ${REASON_MIN} characters)`,
  reasonLong: `Keep the reason to ${REASON_MAX} characters or fewer.`,
  failed: "Couldn't change the status. Try again.",
} as const;

/** Field errors shown next to their field (anything else goes in the alert). */
const INLINE_FIELDS = ['status', 'reason', 'sample_date'] as const;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

let nextId = 0;

function statusOf(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { statusCode?: unknown; status?: unknown };
  if (typeof e.statusCode === 'number') return e.statusCode;
  if (typeof e.status === 'number') return e.status;
  return null;
}

/**
 * The row on screen is out of date. The API refuses a target that is no longer
 * allowed with 422 `status` when it checks before the row lock, and with 409
 * `status_changed` only in the gap between that check and the lock. The form
 * only ever sends a target from the row's own `corrections`, so a server
 * `status` refusal can only mean the request changed after the page loaded.
 */
function isStaleRow(code: number | null, fields: Record<string, string>): boolean {
  return code === 409 || (code === 422 && !!fields['status']);
}

/**
 * Correct a lab request's status from the patient page (`labs.manage`, lab
 * spec §5 / E16): the allowed targets only (C1 booked → In Lab with an
 * optional sample date, C2 In Lab → Booked, C3/C4 reopen a declined or
 * expired request). The reason is required and kept with the request for
 * staff who manage lab requests; the audit log only records that one was
 * given. Runs the request itself and emits `corrected` with the updated row.
 */
@Component({
  selector: 'bo-lab-status-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DialogComponent, IconComponent, AlertComponent],
  template: `
    <sd-dialog
      [open]="open()"
      [title]="copy.title"
      [subtitle]="subtitle()"
      size="md"
      [busy]="saving()"
      (closed)="closed.emit()"
    >
      <form [id]="formId" class="flex flex-col gap-5" novalidate (submit)="$event.preventDefault(); submit()">
        <fieldset class="flex min-w-0 flex-col gap-2" [attr.aria-describedby]="fieldError('status') ? formId + '-status-error' : null">
          <legend class="mb-2 font-sans text-body-sm font-semibold text-ink">{{ copy.legend }}</legend>
          @for (t of targets(); track t; let first = $first) {
            <label
              class="flex min-h-11 cursor-pointer items-center gap-3 rounded-field border px-4 py-3 transition-colors"
              [class]="target() === t ? 'border-cerulean bg-frost/30' : (fieldError('status') ? 'border-alert' : 'border-cloud hover:border-cerulean/50')"
            >
              <input
                type="radio"
                class="size-5 shrink-0 accent-cerulean ${FOCUS_RING}"
                [name]="formId + '-status'"
                [value]="t"
                [checked]="target() === t"
                [disabled]="saving()"
                [attr.data-autofocus]="target() === t || (!target() && first) ? '' : null"
                (change)="setTarget(t)"
              />
              <span class="font-sans text-body-sm font-semibold text-ink">{{ targetLabel(t) }}</span>
            </label>
          }
          @if (fieldError('status'); as msg) {
            <p [id]="formId + '-status-error'" class="flex items-start gap-1.5 font-sans text-caption text-alert">
              <sd-icon name="circle-alert" [size]="14" class="mt-0.5 shrink-0" />{{ msg }}
            </p>
          }
        </fieldset>

        @if (target() === 'in_lab') {
          <div class="flex flex-col gap-1.5">
            <label [for]="formId + '-sample'" class="font-sans text-body-sm font-semibold text-ink">{{ copy.sampleLabel }}</label>
            <input
              [id]="formId + '-sample'"
              type="date"
              class="${FIELD} sm:max-w-xs"
              [class]="fieldError('sample_date') ? '${FIELD_INVALID}' : ''"
              [attr.min]="minSampleDate()"
              [attr.max]="today()"
              [value]="sampleDate()"
              [readOnly]="saving()"
              [attr.aria-invalid]="fieldError('sample_date') ? 'true' : null"
              [attr.aria-describedby]="formId + '-sample-hint' + (fieldError('sample_date') ? ' ' + formId + '-sample-error' : '')"
              (input)="setSampleDate($any($event.target).value)"
              (change)="setSampleDate($any($event.target).value)"
            />
            @if (fieldError('sample_date'); as msg) {
              <p [id]="formId + '-sample-error'" class="flex items-start gap-1.5 font-sans text-caption text-alert">
                <sd-icon name="circle-alert" [size]="14" class="mt-0.5 shrink-0" />{{ msg }}
              </p>
            }
            <p [id]="formId + '-sample-hint'" class="font-sans text-caption text-slate">{{ copy.sampleHelper }}</p>
          </div>
        }

        <div class="flex flex-col gap-1.5">
          <label [for]="formId + '-reason'" class="font-sans text-body-sm font-semibold text-ink">Reason</label>
          <textarea
            [id]="formId + '-reason'"
            rows="3"
            class="${FIELD} resize-y"
            [class]="fieldError('reason') ? '${FIELD_INVALID}' : ''"
            [attr.maxlength]="reasonMax"
            aria-required="true"
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
              <p [id]="formId + '-reason-hint'" class="text-slate">{{ copy.reasonHelper }}</p>
            </div>
            <span class="shrink-0 tabular-nums text-slate">{{ reason().length }}/{{ reasonMax }}<span class="sr-only"> characters</span></span>
          </div>
        </div>

        @if (reopening()) {
          <p class="flex items-start gap-2 rounded-field bg-glacier px-4 py-3 font-sans text-body-sm text-slate">
            <sd-icon name="bell" [size]="18" class="mt-0.5 shrink-0 text-cerulean" />{{ copy.reopenNote }}
          </p>
        }

        @if (error(); as e) {
          <sd-alert tone="error">{{ e }}</sd-alert>
        }
        <p class="sr-only" aria-live="polite">{{ saving() ? 'Changing the status…' : '' }}</p>
      </form>

      <div dialogFooter class="flex flex-col-reverse gap-2 border-t border-cloud px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
        <button #cancelBtn type="button" class="${BTN_GHOST}" [disabled]="saving()" (click)="closed.emit()">{{ copy.cancel }}</button>
        <button type="submit" [attr.form]="formId" class="${BTN_PRIMARY}" [disabled]="saving() || stale() || targets().length === 0">
          <sd-icon [name]="saving() ? 'loader-circle' : 'square-pen'" [size]="18" [class.animate-spin]="saving()" />{{ saving() ? 'Changing…' : copy.submit }}
        </button>
      </div>
    </sd-dialog>
  `,
})
export class LabStatusDialog {
  private readonly api = inject(LabRequestsApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly cancelBtn = viewChild<ElementRef<HTMLButtonElement>>('cancelBtn');

  readonly open = input(false);
  /** The row being corrected (its `corrections` are the allowed targets). */
  readonly request = input<AdminLabRequestSummaryDto | null>(null);

  /** Close it (Cancel / ×, Esc, the scrim — not while a request runs). */
  readonly closed = output<void>();
  /** The status changed: the updated row. */
  readonly corrected = output<AdminLabRequestSummaryDto>();
  /** The request changed meanwhile (409, or 422 `status` — see isStaleRow): the page reloads its rows. */
  readonly conflict = output<void>();

  protected readonly copy = LAB_STATUS_COPY;
  protected readonly formId = `bo-lab-status-${++nextId}`;
  protected readonly reasonMax = REASON_MAX;

  protected readonly target = signal<LabCorrectionTarget | null>(null);
  protected readonly sampleDate = signal('');
  protected readonly reason = signal('');
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  /** The API said the request changed: this row is out of date, so nothing more is sent from it. */
  protected readonly stale = signal(false);
  /** Clinic today ('Y-m-d'): the latest sample date the API accepts. Set when the dialog opens. */
  protected readonly today = signal(todayInZone(CLINIC_TIME_ZONE));
  /** Field errors: the form's own checks after a submit attempt, then the API's 422 `errors`. */
  private readonly errors = signal<Record<string, string>>({});

  private readonly requestId = computed(() => this.request()?.id ?? null);
  protected readonly targets = computed<readonly LabCorrectionTarget[]>(() => this.request()?.corrections ?? []);

  protected readonly subtitle = computed(() => {
    const r = this.request();
    return r ? `${r.number} · now ${labStatusLabel(r.status)}` : '';
  });

  /** The clinic consent date: the earliest sample date (none when it was never accepted). */
  protected readonly minSampleDate = computed(() => {
    const on = this.request()?.consented_on ?? null;
    return on && YMD.test(on) ? on : null;
  });

  protected readonly reopening = computed(() => {
    const r = this.request();
    return !!r && isReopen(r.status, this.target());
  });

  constructor() {
    // Start fresh each time it opens (or is pointed at another request while open).
    effect(() => {
      const open = this.open();
      const id = this.requestId();
      if (!open || !id) return;
      untracked(() => this.reset());
    });
  }

  protected targetLabel(t: LabCorrectionTarget): string {
    return labCorrectionLabel(t);
  }

  protected fieldError(key: string): string {
    return this.errors()[key] ?? '';
  }

  protected setTarget(t: LabCorrectionTarget): void {
    this.target.set(t);
    this.clearError('status');
    if (t !== 'in_lab') this.clearError('sample_date');
  }

  protected setSampleDate(raw: string): void {
    this.sampleDate.set(raw ?? '');
    this.clearError('sample_date');
  }

  protected setReason(raw: string): void {
    this.reason.set(raw ?? '');
    this.clearError('reason');
  }

  protected submit(): void {
    const r = this.request();
    if (this.saving() || this.stale() || !r) return;
    this.error.set('');
    const problems = this.validate();
    this.errors.set(problems);
    if (Object.keys(problems).length > 0) {
      this.focusFirstProblem();
      return;
    }
    const status = this.target() as LabCorrectionTarget;
    const sample = status === 'in_lab' ? this.sampleDate().trim() : '';
    this.saving.set(true);
    this.api
      .correctStatus(r.id, { status, reason: this.reason().trim(), ...(sample ? { sample_date: sample } : {}) })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.saving.set(false);
          this.corrected.emit(res.data);
        },
        error: (err: unknown) => {
          this.saving.set(false);
          const fields = apiErrorFields(err);
          if (isStaleRow(statusOf(err), fields)) {
            this.errors.set({});
            this.error.set(LAB_STATUS_COPY.conflict);
            this.stale.set(true);
            this.conflict.emit();
            // "Change status" is now disabled: put focus on Cancel (which closes and reloads), not the page.
            afterNextRender(() => this.cancelBtn()?.nativeElement.focus(), { injector: this.injector });
            return;
          }
          const inline: Record<string, string> = {};
          for (const k of INLINE_FIELDS) if (fields[k]) inline[k] = fields[k];
          this.errors.set(inline);
          if (Object.keys(inline).length > 0) {
            this.focusFirstProblem();
          } else {
            this.error.set(apiErrorMessage(err, LAB_STATUS_COPY.failed));
          }
        },
      });
  }

  // ----- internals -----

  private validate(): Record<string, string> {
    const out: Record<string, string> = {};
    const t = this.target();
    if (!t || !this.targets().includes(t)) out['status'] = LAB_STATUS_COPY.chooseStatus;
    if (t === 'in_lab') {
      const s = this.sampleDate().trim();
      if (s) {
        const min = this.minSampleDate();
        const max = this.today();
        if (!YMD.test(s) || (min !== null && s < min) || s > max) out['sample_date'] = this.sampleRangeMessage();
      }
    }
    const reason = this.reason().trim();
    if (reason.length < REASON_MIN) out['reason'] = LAB_STATUS_COPY.reasonShort;
    else if (reason.length > REASON_MAX) out['reason'] = LAB_STATUS_COPY.reasonLong;
    return out;
  }

  /** The API's wording: "Choose a date between {consent date} and today". */
  private sampleRangeMessage(): string {
    const min = this.minSampleDate();
    return min ? `Choose a date between ${calendarDate(min)} and today` : 'Choose a date no later than today';
  }

  private clearError(key: string): void {
    if (!this.errors()[key]) return;
    const next = { ...this.errors() };
    delete next[key];
    this.errors.set(next);
  }

  /** Focus the first field with a problem (form order: status, sample date, reason) once it renders. */
  private focusFirstProblem(): void {
    afterNextRender(
      () => {
        const root = this.host.nativeElement;
        const e = this.errors();
        const target =
          (e['status'] && root.querySelector<HTMLElement>(`input[name="${this.formId}-status"]`)) ||
          root.querySelector<HTMLElement>('[aria-invalid="true"]');
        target?.focus();
      },
      { injector: this.injector },
    );
  }

  private reset(): void {
    const targets = this.targets();
    // staffTargets() gives one target per status today: choose it for the user.
    this.target.set(targets.length === 1 ? targets[0] : null);
    this.sampleDate.set('');
    this.reason.set('');
    this.errors.set({});
    this.error.set('');
    this.stale.set(false);
    this.saving.set(false);
    this.today.set(todayInZone(CLINIC_TIME_ZONE));
  }
}
