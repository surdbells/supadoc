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
import { FormControl } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { DialogComponent, IconComponent } from '@supadoc/ui';
import { ApplicationDraftStore } from '../core/application-draft.store';
import { apiErrorCode, bannerMessage, retryAfterMs } from '../core/errors';
import { CodeEntryComponent, CodeTimer } from './code-entry';
import { ModalHeaderComponent } from './modal-header';
import { onbModalButton } from './ui-classes';

const CODE_INVALID = "That code isn't right. Check it and try again.";

/**
 * "Confirm your email" (470px, the Enter-code layout): on open it asks for a
 * code (POST email-code), then "Verify and submit" checks it and reports
 * `verified` — the review page then submits. An address already proven (by the
 * resume link or code) skips straight to `verified`.
 */
@Component({
  selector: 'onb-confirm-email-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CodeEntryComponent, DialogComponent, IconComponent, ModalHeaderComponent],
  template: `
    <sd-dialog
      [open]="open()"
      layout="plain"
      [maxWidth]="470"
      [busy]="busy()"
      labelledBy="onb-confirm-title"
      describedBy="onb-confirm-subtitle"
      (closed)="closed.emit()"
    >
      <div class="p-6">
        <onb-modal-header
          baseId="onb-confirm"
          title="Confirm your email"
          [subtitle]="subtitle()"
          [busy]="busy()"
          (closed)="closed.emit()"
        />
        <div class="mt-6">
          <onb-code-entry
            [control]="code"
            [timer]="timer"
            [invalid]="wrong()"
            [error]="error()"
            [busy]="busy()"
            errorId="onb-confirm-error"
            (resend)="send(true)"
          />
        </div>
        <div class="mt-10 flex justify-center">
          <button
            type="button"
            [class]="verifyClass()"
            [attr.aria-disabled]="!complete() || null"
            [attr.aria-busy]="busy() || null"
            (click)="verify()"
          >
            @if (busy()) {
              <sd-icon name="loader-circle" [size]="16" class="animate-spin" />
            }
            Verify and submit
          </button>
        </div>
      </div>
    </sd-dialog>
  `,
})
export class ConfirmEmailDialogComponent {
  private readonly store = inject(ApplicationDraftStore);

  readonly open = input(false);
  readonly verified = output<void>();
  readonly closed = output<void>();

  protected readonly code = new FormControl('', { nonNullable: true });
  private readonly codeEntry = viewChild(CodeEntryComponent);
  private readonly codeValue = toSignal(this.code.valueChanges, { initialValue: '' });
  protected readonly timer = new CodeTimer(inject(DestroyRef));
  protected readonly sentTo = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly wrong = signal(false);
  protected readonly complete = computed(() => /^\d{6}$/.test(this.codeValue()));
  protected readonly verifyClass = computed(() => `${onbModalButton('primary', !this.complete())} w-full sm:w-[247px]`);
  protected readonly subtitle = computed(
    () => `We sent a 6-digit code to ${this.sentTo() || 'your email address'}. Enter it to submit your application.`,
  );

  constructor() {
    effect(() => {
      if (this.open()) untracked(() => void this.send(false));
      else untracked(() => this.timer.stop());
    });
  }

  /** POST email-code (also "Resend code"). */
  async send(resend: boolean): Promise<void> {
    this.error.set(null);
    this.wrong.set(false);
    if (resend) this.code.setValue('');
    try {
      const sent = await this.store.requestEmailCode();
      if (sent.already_verified) {
        this.verified.emit();
        return;
      }
      this.sentTo.set(sent.sent_to);
      this.timer.start(sent.expires_in, sent.resend_after);
    } catch (err) {
      if (apiErrorCode(err) === 'resend_cooldown') {
        this.timer.holdResend(Math.ceil((retryAfterMs(err) ?? 60_000) / 1000));
        if (!this.timer.running()) this.timer.start(600, Math.ceil((retryAfterMs(err) ?? 60_000) / 1000));
        if (resend) this.error.set(bannerMessage(err));
        return;
      }
      this.error.set(bannerMessage(err, "We couldn't send a code. Please try again."));
    }
  }

  protected async verify(): Promise<void> {
    if (this.busy()) return;
    if (!this.complete()) {
      this.error.set('Enter the 6-digit code.');
      this.codeEntry()?.focus();
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.wrong.set(false);
    try {
      await this.store.verifyEmail(this.code.value);
      this.timer.stop();
      this.verified.emit();
    } catch (err) {
      const code = apiErrorCode(err);
      this.wrong.set(code === 'code_invalid');
      this.error.set(code === 'code_invalid' ? CODE_INVALID : bannerMessage(err, "We couldn't check the code. Please try again."));
      if (code === 'code_expired' || code === 'code_locked') this.code.setValue('');
    } finally {
      this.busy.set(false);
    }
  }
}
