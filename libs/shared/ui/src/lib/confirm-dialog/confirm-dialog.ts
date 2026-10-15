import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { DialogComponent, DialogRole, DialogSize } from '../dialog/dialog';
import { IconComponent } from '../icon/icon';

/** How serious the prompt is: colours, default icon, role and initial focus. */
export type ConfirmTone = 'danger' | 'warning' | 'info' | 'success';

/** A fact the person should see before deciding (amount, account, date…). */
export interface ConfirmDetail {
  label: string;
  value: string;
}

/** A free-text reason collected with the confirmation. */
export interface ConfirmReasonOptions {
  /** Field label, e.g. "Reason for rejecting". "(optional)" is added when not required. */
  label: string;
  placeholder?: string;
  /** Must be filled in (after trimming) to confirm. */
  required?: boolean;
  /** Minimum trimmed length (when anything is entered, or always if required). */
  minLength?: number;
  /** Maximum length; shows a counter. */
  maxLength?: number;
  /** Help text under the field. */
  hint?: string;
  /** Pre-filled text. */
  initial?: string;
}

/** A third, alternative action (e.g. "End, keep the visit open"). */
export interface ConfirmSecondaryAction {
  label: string;
  /** Returned as `choice` (DialogService) / emitted by `(choice)` as `{ value, reason }`. */
  value: string;
  /** `danger` draws it in red; default is a neutral outlined button. */
  tone?: 'neutral' | 'danger';
  /**
   * When a reason field is shown, this action validates it like the confirm
   * button and passes the trimmed reason on. True: it ignores the field (no
   * validation, no reason) — e.g. "Hold for review" next to "Reject (reason
   * required)".
   */
  ignoreReason?: boolean;
}

/** What `(choice)` emits: the secondary action's `value`, with the reason when it uses one. */
export interface ConfirmChoice {
  value: string;
  /** The trimmed reason (absent when there is no reason field, it was left empty, or `ignoreReason`). */
  reason?: string;
}

/** Which control takes focus on open. `auto`: required reason → reason; danger/warning → cancel; else confirm. */
export type ConfirmAutofocus = 'auto' | 'confirm' | 'cancel' | 'reason';

const TONE_ICON: Record<ConfirmTone, string> = {
  danger: 'triangle-alert',
  warning: 'circle-alert',
  info: 'info',
  success: 'circle-check',
};

const BADGE: Record<ConfirmTone, string> = {
  danger: 'bg-(--sd-dialog-danger-soft) text-(--sd-dialog-danger-text)',
  warning: 'bg-(--sd-dialog-warning-soft) text-(--sd-dialog-warning-text)',
  info: 'bg-(--sd-dialog-info-soft) text-(--sd-dialog-info-text)',
  success: 'bg-(--sd-dialog-success-soft) text-(--sd-dialog-success-text)',
};

const CONFIRM_BUTTON: Record<ConfirmTone, string> = {
  danger: 'bg-(--sd-dialog-danger) hover:bg-(--sd-dialog-danger-hover)',
  warning: 'bg-(--sd-dialog-primary) hover:bg-(--sd-dialog-primary-hover)',
  info: 'bg-(--sd-dialog-primary) hover:bg-(--sd-dialog-primary-hover)',
  success: 'bg-(--sd-dialog-success) hover:bg-(--sd-dialog-success-hover)',
};

const BUTTON =
  'inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-field px-4 py-3 font-sans text-body font-semibold ' +
  'transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-(--sd-dialog-ring) focus-visible:ring-offset-2 ' +
  'focus-visible:ring-offset-(--sd-dialog-surface) aria-disabled:cursor-not-allowed aria-disabled:opacity-60';

let nextId = 0;

/**
 * Confirmation prompt on {@link DialogComponent}: icon, title, message, an
 * optional details list, an optional reason field (with validation and a
 * counter), up to three actions, a busy state and an inline error.
 *
 * Render it always and toggle `open`. It emits `confirm` (with the trimmed
 * reason, if a reason field is shown and filled in), `cancel` (Cancel, Esc, the
 * scrim) and `choice` (`{ value, reason }` for the secondary action). While
 * `busy` nothing can be clicked or dismissed and the confirm button shows a
 * spinner; put the request's failure in `error` (e.g. `apiErrorMessage(err)`).
 * Once `open` is false (also while it animates out) the buttons do nothing, so
 * a quick second Enter cannot confirm twice.
 *
 * For most prompts prefer `DialogService.confirm()`, which renders this for you
 * and runs the action with busy / error handling.
 *
 * Usage:
 * ```html
 * <sd-confirm-dialog [open]="ask()" tone="danger" title="Remove your photo?"
 *   message="Your doctors will see your initials instead." confirmLabel="Remove photo"
 *   cancelLabel="Keep it" [busy]="removing()" [error]="removeError()"
 *   (confirm)="removePhoto()" (cancel)="ask.set(false)" />
 * ```
 */
@Component({
  selector: 'sd-confirm-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DialogComponent, IconComponent],
  // `title` is an input: no browser tooltip from a static `title="…"`.
  host: { '[attr.title]': 'null' },
  template: `
    <sd-dialog
      [open]="open()"
      layout="plain"
      [size]="size()"
      [busy]="busy()"
      [dismissible]="dismissible()"
      [dialogRole]="role()"
      [labelledBy]="titleId"
      [describedBy]="message() ? messageId : null"
      (closed)="cancel.emit()"
      (afterClose)="afterClose.emit()"
    >
      <div class="flex flex-col gap-4 px-5 pt-6 pb-2 sm:px-6" [attr.aria-busy]="busy() || null">
        <div class="flex flex-col items-center gap-3 text-center">
          <span class="flex size-14 items-center justify-center rounded-full" [class]="badgeClass()" aria-hidden="true">
            <sd-icon [name]="iconName()" [size]="26" />
          </span>
          <div class="flex flex-col gap-1">
            <h2 [id]="titleId" class="break-words font-heading text-h5 text-(--sd-dialog-strong)">{{ title() }}</h2>
            @if (message()) {
              <p [id]="messageId" class="whitespace-pre-line font-sans text-body-sm text-(--sd-dialog-muted)">{{ message() }}</p>
            }
          </div>
        </div>

        @if (details().length) {
          <dl class="flex flex-col divide-y divide-(--sd-dialog-border) rounded-[12px] border border-(--sd-dialog-border) bg-(--sd-dialog-raised) px-4 font-sans text-body-sm">
            @for (d of details(); track $index) {
              <div class="flex items-baseline justify-between gap-4 py-2.5">
                <dt class="shrink-0 text-(--sd-dialog-muted)">{{ d.label }}</dt>
                <dd class="min-w-0 break-words text-right font-semibold text-(--sd-dialog-strong)">{{ d.value }}</dd>
              </div>
            }
          </dl>
        }

        @if (reason(); as r) {
          <div class="flex flex-col gap-1.5 text-left">
            <label [for]="reasonId" class="font-sans text-body-sm font-semibold text-(--sd-dialog-text)">
              {{ r.label }}
              @if (!r.required) {
                <span class="font-normal text-(--sd-dialog-muted)">(optional)</span>
              }
            </label>
            <textarea
              #reasonField
              [id]="reasonId"
              rows="3"
              class="w-full resize-y rounded-[12px] border bg-(--sd-dialog-surface) px-3.5 py-2.5 font-sans text-body text-(--sd-dialog-text) placeholder:text-(--sd-dialog-muted) focus:outline-none focus-visible:ring-2 focus-visible:ring-(--sd-dialog-ring)"
              [class]="showReasonError() ? 'border-(--sd-dialog-danger)' : 'border-(--sd-dialog-field)'"
              [attr.placeholder]="r.placeholder || null"
              [attr.maxlength]="r.maxLength || null"
              [attr.aria-required]="r.required || null"
              [attr.aria-invalid]="showReasonError() || null"
              [attr.aria-describedby]="reasonDescribedBy()"
              [attr.data-autofocus]="focusTarget() === 'reason' ? '' : null"
              [readOnly]="busy()"
              [value]="reasonText()"
              (input)="onReasonInput($event)"
            ></textarea>
            <div class="flex items-start justify-between gap-3 font-sans text-caption">
              <div class="flex min-w-0 flex-col gap-0.5">
                @if (showReasonError()) {
                  <p [id]="reasonErrorId" class="text-(--sd-dialog-danger-text)">{{ reasonError() }}</p>
                }
                @if (r.hint) {
                  <p [id]="reasonHintId" class="text-(--sd-dialog-muted)">{{ r.hint }}</p>
                }
              </div>
              @if (r.maxLength) {
                <span class="shrink-0 tabular-nums text-(--sd-dialog-muted)" [id]="reasonCountId">
                  {{ reasonText().length }}/{{ r.maxLength }}<span class="sr-only"> characters</span>
                </span>
              }
            </div>
          </div>
        }

        @if (error()) {
          <p
            role="alert"
            class="flex items-start gap-2 rounded-[12px] bg-(--sd-dialog-danger-soft) px-3.5 py-2.5 text-left font-sans text-body-sm text-(--sd-dialog-danger-text)"
          >
            <sd-icon name="circle-alert" [size]="18" class="mt-0.5 shrink-0" />
            <span class="min-w-0 flex-1">{{ error() }}</span>
          </p>
        }
        <p class="sr-only" aria-live="polite">{{ busy() ? busyLabel() : '' }}</p>
      </div>

      <div
        dialogFooter
        class="flex shrink-0 gap-3 px-5 pt-4 pb-5 sm:px-6 sm:pb-6"
        [class]="secondary() ? 'flex-col-reverse' : 'flex-col-reverse sm:flex-row'"
      >
        <button
          type="button"
          [class]="cancelClass"
          [attr.aria-disabled]="busy() || null"
          [attr.data-autofocus]="focusTarget() === 'cancel' ? '' : null"
          (click)="onCancel()"
        >
          {{ cancelLabel() }}
        </button>
        @if (secondary(); as s) {
          <button
            type="button"
            [class]="secondaryClass()"
            [attr.aria-disabled]="busy() || null"
            (click)="onSecondary()"
          >
            @if (busy() && pending() === 'secondary') {
              <sd-icon name="loader-circle" [size]="18" class="motion-safe:animate-spin" />
            }
            {{ s.label }}
          </button>
        }
        <button
          type="button"
          [class]="confirmClass()"
          [attr.aria-disabled]="busy() || null"
          [attr.data-autofocus]="focusTarget() === 'confirm' ? '' : null"
          (click)="onConfirm()"
        >
          @if (busy() && pending() === 'confirm') {
            <sd-icon name="loader-circle" [size]="18" class="motion-safe:animate-spin" />
          }
          {{ confirmLabel() }}
        </button>
      </div>
    </sd-dialog>
  `,
})
export class ConfirmDialogComponent {
  readonly open = input(false);
  readonly title = input('Are you sure?');
  readonly message = input('');
  readonly confirmLabel = input('Confirm');
  readonly cancelLabel = input('Cancel');
  /** Lucide icon name; defaults to the tone's icon. */
  readonly icon = input('');
  /** Legacy switch for `tone="danger"` (used when `tone` is not set). */
  readonly danger = input(false);
  /** Defaults to `danger` when `[danger]="true"`, else `info`. */
  readonly tone = input<ConfirmTone | undefined>(undefined);
  readonly details = input<readonly ConfirmDetail[]>([]);
  readonly reason = input<ConfirmReasonOptions | null | undefined>(null);
  readonly secondary = input<ConfirmSecondaryAction | null | undefined>(null);
  /** A request is in flight: nothing can be clicked or dismissed. */
  readonly busy = input(false);
  /** Inline error (e.g. `apiErrorMessage(err)`), shown above the buttons. */
  readonly error = input<string | null | undefined>(null);
  /** Announced to screen readers while busy. */
  readonly busyLabel = input('Working…');
  /** False: Esc and the scrim do nothing (Cancel still works). */
  readonly dismissible = input(true);
  readonly autofocus = input<ConfirmAutofocus>('auto');
  readonly size = input<DialogSize>('sm');

  /** Confirmed; carries the trimmed reason (undefined when there is no reason field or it was left empty). */
  readonly confirm = output<string | undefined>();
  // `cancel` mirrors `confirm` and is the public API every caller binds to;
  // it is a component output, never re-dispatched as a DOM event.
  // eslint-disable-next-line @angular-eslint/no-output-native
  readonly cancel = output<void>();
  /** The secondary action: its `value`, and the trimmed reason when it uses the reason field. */
  readonly choice = output<ConfirmChoice>();
  /** Fully closed (after the exit animation). */
  readonly afterClose = output<void>();

  private readonly id = ++nextId;
  protected readonly titleId = `sd-confirm-${this.id}-title`;
  protected readonly messageId = `sd-confirm-${this.id}-message`;
  protected readonly reasonId = `sd-confirm-${this.id}-reason`;
  protected readonly reasonErrorId = `${this.reasonId}-error`;
  protected readonly reasonHintId = `${this.reasonId}-hint`;
  protected readonly reasonCountId = `${this.reasonId}-count`;
  protected readonly cancelClass =
    `${BUTTON} border border-(--sd-dialog-border) bg-(--sd-dialog-surface) text-(--sd-dialog-muted) ` +
    'hover:bg-(--sd-dialog-hover) hover:text-(--sd-dialog-text)';

  protected readonly reasonText = signal('');
  /** The person tried to confirm: from now on show what is wrong with the reason. */
  private readonly attempted = signal(false);
  /** Which button started the current busy state (it gets the spinner). */
  protected readonly pending = signal<'confirm' | 'secondary'>('confirm');

  private readonly reasonField = viewChild<ElementRef<HTMLTextAreaElement>>('reasonField');

  protected readonly effectiveTone = computed<ConfirmTone>(() => this.tone() ?? (this.danger() ? 'danger' : 'info'));
  protected readonly alert = computed(() => this.effectiveTone() === 'danger' || this.effectiveTone() === 'warning');
  protected readonly role = computed<DialogRole>(() => (this.alert() ? 'alertdialog' : 'dialog'));
  protected readonly iconName = computed(() => this.icon() || TONE_ICON[this.effectiveTone()]);
  protected readonly badgeClass = computed(() => BADGE[this.effectiveTone()]);
  protected readonly confirmClass = computed(
    () => `${BUTTON} text-(--sd-dialog-on-accent) ${CONFIRM_BUTTON[this.effectiveTone()]}`,
  );
  protected readonly secondaryClass = computed(() =>
    this.secondary()?.tone === 'danger'
      ? `${BUTTON} border border-(--sd-dialog-danger) bg-(--sd-dialog-surface) text-(--sd-dialog-danger-text) hover:bg-(--sd-dialog-danger-soft)`
      : `${BUTTON} border border-(--sd-dialog-field) bg-(--sd-dialog-surface) text-(--sd-dialog-text) hover:bg-(--sd-dialog-hover)`,
  );

  protected readonly focusTarget = computed<Exclude<ConfirmAutofocus, 'auto'>>(() => {
    const wanted = this.autofocus();
    if (wanted === 'reason') return this.reason() ? 'reason' : 'confirm';
    if (wanted !== 'auto') return wanted;
    if (this.reason()?.required) return 'reason';
    return this.alert() ? 'cancel' : 'confirm';
  });

  /** What is wrong with the reason, or null when it is acceptable. */
  readonly reasonError = computed<string | null>(() => {
    const r = this.reason();
    if (!r) return null;
    const value = this.reasonText().trim();
    if (!value) return r.required ? `${r.label.replace(/[.:]\s*$/, '')} is required.` : null;
    if (r.minLength && value.length < r.minLength) return `Please enter at least ${r.minLength} characters.`;
    if (r.maxLength && value.length > r.maxLength) return `Please keep it to ${r.maxLength} characters or fewer.`;
    return null;
  });

  protected readonly showReasonError = computed(() => this.attempted() && this.reasonError() !== null);

  protected readonly reasonDescribedBy = computed(() => {
    const r = this.reason();
    const ids = [
      this.showReasonError() ? this.reasonErrorId : '',
      r?.hint ? this.reasonHintId : '',
      r?.maxLength ? this.reasonCountId : '',
    ].filter(Boolean);
    return ids.length ? ids.join(' ') : null;
  });

  constructor() {
    // Every opening starts with a fresh reason field.
    let wasOpen = false;
    effect(() => {
      const open = this.open();
      if (open && !wasOpen) {
        untracked(() => {
          this.reasonText.set(this.reason()?.initial ?? '');
          this.attempted.set(false);
          this.pending.set('confirm');
        });
      }
      wasOpen = open;
    });
  }

  protected onReasonInput(event: Event): void {
    this.reasonText.set((event.target as HTMLTextAreaElement).value);
  }

  protected onConfirm(): void {
    if (!this.acting() || !this.reasonAccepted()) return;
    this.pending.set('confirm');
    this.confirm.emit(this.trimmedReason());
  }

  protected onSecondary(): void {
    const s = this.secondary();
    if (!s || !this.acting()) return;
    const withReason = !s.ignoreReason;
    if (withReason && !this.reasonAccepted()) return;
    this.pending.set('secondary');
    const reason = withReason ? this.trimmedReason() : undefined;
    this.choice.emit(reason === undefined ? { value: s.value } : { value: s.value, reason });
  }

  protected onCancel(): void {
    if (this.acting()) this.cancel.emit();
  }

  /** The buttons answer only while open and idle (not busy, not animating out). */
  private acting(): boolean {
    return this.open() && !this.busy();
  }

  /** The reason is valid (or there is no reason field); otherwise show what is wrong and focus it. */
  private reasonAccepted(): boolean {
    if (!this.reason() || this.reasonError() === null) return true;
    this.attempted.set(true);
    this.reasonField()?.nativeElement.focus();
    return false;
  }

  /** The reason as entered, trimmed (undefined without a reason field or when empty). */
  private trimmedReason(): string | undefined {
    if (!this.reason()) return undefined;
    return this.reasonText().trim() || undefined;
  }
}
