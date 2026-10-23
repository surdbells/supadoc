import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { DoctorApplicationsApi } from '@supadoc/data-access';
import { DRAFT_CODE_PATTERN } from '@supadoc/models';
import { AlertComponent, DialogComponent, IconComponent } from '@supadoc/ui';
import { firstValueFrom } from 'rxjs';
import { ApplicationDraftStore } from '../core/application-draft.store';
import { apiErrorCode, bannerMessage } from '../core/errors';
import { Notices } from '../core/notices';
import { isValidEmail } from '../core/validators';
import { stepUrl } from '../core/wizard-steps';
import { FieldComponent } from '../shared/field';
import { ModalHeaderComponent } from '../shared/modal-header';
import { onbControl, onbModalButton } from '../shared/ui-classes';

export const RESEND_RESULT = "If there's a saved application for that email, we've sent a new link and code.";
const EMAIL_ERROR = 'Enter a valid email address.';
const CODE_ERROR = 'Draft code must be 6 characters.';

/** Upper case; spaces and hyphens dropped; O→0, I and L→1 (as the API normalises). */
export function normaliseDraftCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .slice(0, 6);
}

/** "Resume your application" (Figma Resume Application, 470px): email + 6-character draft code. */
@Component({
  selector: 'onb-resume-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AlertComponent, DialogComponent, FieldComponent, IconComponent, ModalHeaderComponent, ReactiveFormsModule],
  template: `
    <sd-dialog
      [open]="open()"
      layout="plain"
      [maxWidth]="470"
      [busy]="busy()"
      labelledBy="onb-resume-title"
      describedBy="onb-resume-subtitle"
      (closed)="closed.emit()"
    >
      <form class="p-6" novalidate (submit)="$event.preventDefault(); resume()">
        <onb-modal-header
          baseId="onb-resume"
          title="Resume your application"
          subtitle="Open the link in your resume email, or enter the email and draft code we sent you."
          [busy]="busy()"
          (closed)="closed.emit()"
        />
        @if (notice()) {
          <sd-alert tone="info" class="mt-4">{{ notice() }}</sd-alert>
        }
        <div class="mt-6 flex flex-col gap-6">
          <onb-field #fEmail label="Email" forId="onb-resume-email" [required]="true" [error]="emailError()">
            <input
              id="onb-resume-email"
              type="email"
              autocomplete="email"
              inputmode="email"
              data-autofocus
              [formControl]="email"
              [class]="emailClass()"
              [attr.aria-describedby]="fEmail.describedBy()"
              [attr.aria-invalid]="!!emailError() || null"
              (blur)="emailTouched.set(true)"
            />
          </onb-field>
          <onb-field #fCode label="Draft code" forId="onb-resume-code" [required]="true" hint="6 characters, from your resume email" [error]="codeError()">
            <input
              id="onb-resume-code"
              type="text"
              maxlength="6"
              autocapitalize="characters"
              autocomplete="off"
              spellcheck="false"
              [formControl]="code"
              [class]="codeClass()"
              [attr.aria-describedby]="fCode.describedBy()"
              [attr.aria-invalid]="!!codeError() || null"
              (blur)="codeTouched.set(true)"
            />
          </onb-field>
        </div>
        @if (serverError()) {
          <sd-alert tone="error" class="mt-4">{{ serverError() }}</sd-alert>
        }
        <div class="mt-10 flex justify-center">
          <button type="submit" [class]="resumeClass()" [attr.aria-disabled]="!valid() || null" [attr.aria-busy]="busy() || null">
            @if (busy()) {
              <sd-icon name="loader-circle" [size]="16" class="animate-spin" />
            }
            Resume application
          </button>
        </div>
        <p class="mt-4 text-center font-sans text-body-sm text-slate">
          Didn't get the email?
          <button type="button" class="rounded font-medium text-cerulean hover:text-cerulean-dark focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40" [disabled]="resending()" (click)="resend()">
            Send a new code
          </button>
        </p>
        <p class="mt-2 text-center font-sans text-caption text-slate" aria-live="polite">{{ resendResult() }}</p>
      </form>
    </sd-dialog>
  `,
})
export class ResumeDialogComponent {
  private readonly api = inject(DoctorApplicationsApi);
  private readonly store = inject(ApplicationDraftStore);
  private readonly router = inject(Router);
  private readonly notices = inject(Notices);

  readonly open = input(false);
  readonly closed = output<void>();

  protected readonly email = new FormControl('', { nonNullable: true });
  protected readonly code = new FormControl('', { nonNullable: true });
  private readonly emailValue = toSignal(this.email.valueChanges, { initialValue: '' });
  private readonly codeValue = toSignal(this.code.valueChanges, { initialValue: '' });
  protected readonly emailTouched = signal(false);
  protected readonly codeTouched = signal(false);
  private readonly submitted = signal(false);
  protected readonly busy = signal(false);
  protected readonly resending = signal(false);
  protected readonly serverError = signal<string | null>(null);
  protected readonly resendResult = signal('');
  protected readonly notice = signal<string | null>(null);

  private readonly emailOk = computed(() => isValidEmail(this.emailValue().trim().toLowerCase()));
  private readonly codeOk = computed(() => DRAFT_CODE_PATTERN.test(this.codeValue()));
  protected readonly valid = computed(() => this.emailOk() && this.codeOk());
  protected readonly emailError = computed(() =>
    (this.emailTouched() || this.submitted()) && !this.emailOk() ? EMAIL_ERROR : null,
  );
  protected readonly codeError = computed(() =>
    (this.codeTouched() || this.submitted()) && !this.codeOk() ? CODE_ERROR : null,
  );
  protected readonly emailClass = computed(() => onbControl(!!this.emailError()));
  protected readonly codeClass = computed(() => `${onbControl(!!this.codeError())} uppercase tracking-[0.2em]`);
  protected readonly resumeClass = computed(() => `${onbModalButton('primary', !this.valid())} w-full sm:w-[247px]`);

  constructor() {
    this.code.valueChanges.subscribe((v) => {
      const n = normaliseDraftCode(v);
      if (n !== v) this.code.setValue(n, { emitEvent: true });
    });
    effect(() => {
      if (!this.open()) return;
      untracked(() => {
        this.notice.set(this.notices.take('resume'));
        this.serverError.set(null);
        this.resendResult.set('');
      });
    });
  }

  async resume(): Promise<void> {
    if (this.busy()) return;
    this.submitted.set(true);
    this.serverError.set(null);
    if (!this.valid()) {
      document.getElementById(this.emailOk() ? 'onb-resume-code' : 'onb-resume-email')?.focus();
      return;
    }
    this.busy.set(true);
    try {
      const res = await firstValueFrom(
        this.api.resumeWithCode({ email: this.email.value.trim().toLowerCase(), draft_code: this.code.value }),
      );
      this.store.adopt(res.data.draft_token, res.data.draft);
      this.closed.emit();
      await this.router.navigateByUrl(stepUrl(res.data.draft.next_step));
    } catch (err) {
      const code = apiErrorCode(err);
      this.serverError.set(
        bannerMessage(err, code === 'resume_invalid' ? "We couldn't find a draft with those details. Check your resume email." : undefined),
      );
    } finally {
      this.busy.set(false);
    }
  }

  async resend(): Promise<void> {
    this.emailTouched.set(true);
    if (!this.emailOk()) {
      document.getElementById('onb-resume-email')?.focus();
      return;
    }
    this.resending.set(true);
    this.resendResult.set('');
    try {
      await firstValueFrom(this.api.resendResume(this.email.value.trim().toLowerCase()));
      this.resendResult.set(RESEND_RESULT);
    } catch (err) {
      this.resendResult.set(bannerMessage(err, RESEND_RESULT));
    } finally {
      this.resending.set(false);
    }
  }
}
