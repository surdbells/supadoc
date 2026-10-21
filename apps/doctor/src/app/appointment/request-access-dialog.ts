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
import type { Subscription } from 'rxjs';
import { apiErrorCode, apiErrorFields, apiErrorMessage, DoctorApi } from '@supadoc/data-access';
import type { DoctorAccessRequestDto, DocumentAccessRequestKind } from '@supadoc/models';
import { DialogComponent, IconComponent } from '@supadoc/ui';
import {
  isStaleRequestCode,
  REQUEST_BODY,
  REQUEST_FAILED,
  REQUEST_HINT,
  REQUEST_MESSAGE_MAX,
  requestDialogTitle,
  requestErrorCopy,
} from './document-access';

let nextId = 0;

const BUTTON =
  'inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-field px-4 py-3 font-sans text-body font-semibold ' +
  'transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-(--sd-dialog-ring) focus-visible:ring-offset-2 ' +
  'focus-visible:ring-offset-(--sd-dialog-surface) aria-disabled:cursor-not-allowed aria-disabled:opacity-60';

/**
 * "Ask {Patient} to share documents" — the doctor asks the patient of this
 * consultation to share (or, while a whole-folder share ends soon, to keep
 * sharing). The patient gets a notification and chooses what and for how
 * long; nothing is shared by asking. An optional note (≤ 500 characters) is
 * shown to the patient in the app only — never in emails or notifications.
 *
 * Render it always and toggle `open`. It sends the request itself and emits
 * `sent` with the API's answer (the host then shows the pending state and
 * announces it), `refused` with the code when the page is out of date (the
 * host reloads), and `closed` when the doctor cancels. A failure keeps the
 * dialog open with the note as typed. Colours come from the dialog's own
 * tokens, so it reads the same over the appointment page and the call; the
 * call theme only stops a stray click on the scrim from dropping the note.
 */
@Component({
  selector: 'doc-request-access-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DialogComponent, IconComponent],
  template: `
    <sd-dialog
      [open]="open()"
      layout="plain"
      size="sm"
      [busy]="sending()"
      [closeOnBackdrop]="theme() !== 'call'"
      [labelledBy]="titleId"
      [describedBy]="bodyId"
      (closed)="cancel()"
      (afterClose)="afterClose.emit()"
    >
      <form [id]="formId" class="flex flex-col gap-4 px-5 pt-6 pb-2 sm:px-6" novalidate [attr.aria-busy]="sending() || null" (submit)="$event.preventDefault(); send()">
        <div class="flex flex-col items-center gap-3 text-center">
          <span class="flex size-14 items-center justify-center rounded-full bg-(--sd-dialog-info-soft) text-(--sd-dialog-info-text)" aria-hidden="true">
            <sd-icon name="key-round" [size]="26" />
          </span>
          <div class="flex flex-col gap-1">
            <h2 [id]="titleId" tabindex="-1" data-autofocus class="break-words font-heading text-h5 text-(--sd-dialog-strong) outline-none">{{ title() }}</h2>
            <p [id]="bodyId" class="font-sans text-body-sm text-(--sd-dialog-muted)">{{ body }}</p>
          </div>
        </div>

        <div class="flex flex-col gap-1.5 text-left">
          <label [for]="fieldId" class="font-sans text-body-sm font-semibold text-(--sd-dialog-text)">
            Reason <span class="font-normal text-(--sd-dialog-muted)">(optional)</span>
          </label>
          <textarea
            [id]="fieldId"
            rows="3"
            [attr.maxlength]="max"
            class="w-full resize-y rounded-[12px] border border-(--sd-dialog-field) bg-(--sd-dialog-surface) px-3.5 py-2.5 font-sans text-body text-(--sd-dialog-text) placeholder:text-(--sd-dialog-muted) focus:outline-none focus-visible:ring-2 focus-visible:ring-(--sd-dialog-ring)"
            [attr.aria-describedby]="hintId + ' ' + countId"
            [readOnly]="sending()"
            [value]="message()"
            (input)="onInput($event)"
          ></textarea>
          <div class="flex items-start justify-between gap-3 font-sans text-caption">
            <p [id]="hintId" class="min-w-0 text-(--sd-dialog-muted)">{{ hint }}</p>
            <span [id]="countId" class="shrink-0 tabular-nums text-(--sd-dialog-muted)">{{ message().length }}/{{ max }}<span class="sr-only"> characters</span></span>
          </div>
        </div>

        @if (error()) {
          <p class="flex items-start gap-2 rounded-[12px] bg-(--sd-dialog-danger-soft) px-3.5 py-2.5 font-sans text-body-sm text-(--sd-dialog-danger-text)" role="alert">
            <sd-icon name="circle-alert" [size]="18" class="mt-0.5 shrink-0" />{{ error() }}
          </p>
        }
        <p class="sr-only" aria-live="polite">{{ sending() ? 'Sending your request…' : '' }}</p>
      </form>

      <div dialogFooter class="flex shrink-0 flex-col-reverse gap-3 px-5 pt-4 pb-5 sm:flex-row sm:px-6 sm:pb-6">
        <button
          type="button"
          class="${BUTTON} border border-(--sd-dialog-border) bg-(--sd-dialog-surface) text-(--sd-dialog-muted) hover:bg-(--sd-dialog-hover) hover:text-(--sd-dialog-text)"
          [attr.aria-disabled]="sending() || null"
          (click)="cancel()"
        >
          Cancel
        </button>
        <button
          type="submit"
          [attr.form]="formId"
          class="${BUTTON} bg-(--sd-dialog-primary) text-(--sd-dialog-on-accent) shadow-control inset-shadow-rim hover:bg-(--sd-dialog-primary-hover)"
          [attr.aria-disabled]="sending() || null"
        >
          @if (sending()) {
            <sd-icon name="loader-circle" [size]="18" class="motion-safe:animate-spin" />Sending…
          } @else {
            <sd-icon name="send" [size]="18" />Send request
          }
        </button>
      </div>
    </sd-dialog>
  `,
})
export class RequestAccessDialog {
  private readonly api = inject(DoctorApi);
  private readonly destroyRef = inject(DestroyRef);

  /** Whether the dialog is showing (the host owns it). */
  readonly open = input(false);
  /** The consultation the request is made from. */
  readonly appointmentId = input.required<string>();
  readonly patientName = input<string | null>(null);
  /** `extend`: a whole-folder share ends soon — "Ask … to keep sharing". */
  readonly kind = input<DocumentAccessRequestKind>('access');
  /** `call`: over the call screen (a click on the scrim keeps the dialog). */
  readonly theme = input<'light' | 'call'>('light');

  /** The doctor cancelled (Cancel, Esc, ×, the scrim). Set `open` to false. */
  readonly closed = output<void>();
  /** The request was made: the API's answer. Set `open` to false and show it as pending. */
  readonly sent = output<DoctorAccessRequestDto>();
  /** Refused because the page is out of date (`errors.code`): reload what the patient shares. */
  readonly refused = output<string>();
  /** Fully closed (after its exit animation) — e.g. to move focus to what replaced the opener. */
  readonly afterClose = output<void>();

  protected readonly formId = `doc-request-access-${++nextId}`;
  protected readonly titleId = `${this.formId}-title`;
  protected readonly bodyId = `${this.formId}-body`;
  protected readonly fieldId = `${this.formId}-reason`;
  protected readonly hintId = `${this.formId}-hint`;
  protected readonly countId = `${this.formId}-count`;

  protected readonly title = computed(() => requestDialogTitle(this.kind(), this.patientName()));
  protected readonly body = REQUEST_BODY;
  protected readonly hint = REQUEST_HINT;
  protected readonly max = REQUEST_MESSAGE_MAX;
  protected readonly message = signal('');
  protected readonly sending = signal(false);
  protected readonly error = signal('');
  private inFlight?: Subscription;

  constructor() {
    // A fresh form each time it opens.
    effect(() => {
      if (!this.open()) return;
      untracked(() => {
        this.message.set('');
        this.error.set('');
      });
    });
    this.destroyRef.onDestroy(() => this.inFlight?.unsubscribe());
  }

  protected onInput(event: Event): void {
    const value = (event.target as HTMLTextAreaElement).value;
    this.message.set(value.length > REQUEST_MESSAGE_MAX ? value.slice(0, REQUEST_MESSAGE_MAX) : value);
  }

  protected cancel(): void {
    if (this.sending()) return;
    this.closed.emit();
  }

  protected send(): void {
    if (this.sending() || !this.open()) return;
    this.sending.set(true);
    this.error.set('');
    this.inFlight = this.api
      .requestDocumentAccess(this.appointmentId(), this.message())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.sending.set(false);
          this.sent.emit(res.data);
        },
        error: (err: unknown) => {
          this.sending.set(false);
          const code = apiErrorCode(err);
          this.error.set(
            requestErrorCopy(code, apiErrorFields(err)['available_at'] ?? null) ?? apiErrorMessage(err, REQUEST_FAILED),
          );
          if (code && isStaleRequestCode(code)) this.refused.emit(code);
        },
      });
  }
}
