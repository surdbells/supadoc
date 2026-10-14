import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { StaffAuthService } from '@supadoc/auth';
import { apiErrorMessage } from '@supadoc/data-access';
import {
  AlertComponent,
  ButtonComponent,
  IconComponent,
  InputComponent,
} from '@supadoc/ui';
import { DoctorAuthCard } from './doctor-auth-card';

/**
 * Forgot password (route `auth/forgot-password`): emails a one-time reset link.
 * The reply is the same whether or not the email has an account, so this page
 * always shows the same confirmation.
 */
@Component({
  selector: 'doc-forgot-password',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    RouterLink,
    AlertComponent,
    ButtonComponent,
    IconComponent,
    InputComponent,
    DoctorAuthCard,
  ],
  template: `
    <doc-auth-card
      heading="Forgot your password?"
      subtitle="Enter the email you sign in with and we'll send you a link to choose a new password."
    >
      @if (sent()) {
        <sd-alert tone="success" class="mt-5">
          {{ sent() }} The link works once and expires in 1 hour — check your spam folder if it doesn't arrive.
        </sd-alert>
        <sd-button variant="outline" [full]="true" class="mt-4" [disabled]="busy()" (click)="sent.set('')">
          Use a different email
        </sd-button>
      } @else {
        <form class="mt-6 flex flex-col gap-4" [formGroup]="form" (ngSubmit)="submit()">
          <sd-input
            label="Email"
            type="email"
            autocomplete="username"
            placeholder="you@videomed.test"
            formControlName="email"
            [error]="emailError()"
          />
          @if (error()) {
            <sd-alert tone="error">{{ error() }}</sd-alert>
          }
          <sd-button type="submit" [full]="true" [disabled]="busy()">
            {{ busy() ? 'Sending…' : 'Send reset link' }}
            <sd-icon name="send" [size]="18" />
          </sd-button>
        </form>
      }
      <p class="mt-6 text-center font-sans text-body-sm text-slate">
        Remembered it?
        <a routerLink="/auth/login" class="font-semibold text-cerulean hover:underline">Back to sign in</a>
      </p>
    </doc-auth-card>
  `,
})
export class DoctorForgotPassword {
  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(StaffAuthService);

  protected readonly busy = signal(false);
  protected readonly error = signal('');
  /** The server's confirmation once a link has been requested. */
  protected readonly sent = signal('');
  private readonly submitted = signal(false);

  protected readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
  });

  protected emailError(): string {
    const c = this.form.controls.email;
    if (!(this.submitted() || c.touched) || c.valid) return '';
    return 'Enter a valid email address';
  }

  protected async submit(): Promise<void> {
    this.submitted.set(true);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      this.sent.set(await this.auth.requestPasswordReset(this.form.getRawValue().email));
    } catch (err) {
      this.error.set(apiErrorMessage(err, 'Could not send the reset link. Please try again.'));
    } finally {
      this.busy.set(false);
    }
  }
}
