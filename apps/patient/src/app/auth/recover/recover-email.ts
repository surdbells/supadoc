import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthFlowService, AuthService } from '@supadoc/auth';
import { ButtonComponent, IconComponent, InputComponent } from '@supadoc/ui';

/** Password recovery by email — step 1 (Figma 376:5405): request a reset code. */
@Component({
  selector: 'pat-recover-email',
  imports: [
    ReactiveFormsModule,
    RouterLink,
    ButtonComponent,
    IconComponent,
    InputComponent,
  ],
  template: `
    <div class="flex flex-col items-center gap-8">
      <div
        class="flex size-16 items-center justify-center rounded-full bg-frost/60 text-cerulean"
      >
        <sd-icon name="lock" [size]="26" />
      </div>

      <div class="flex flex-col gap-2 text-center">
        <h2 class="font-heading text-h2 text-ink">Forgot Password?</h2>
        <p class="text-h5 text-slate">
          Enter your email and we'll send you a code to reset your password.
        </p>
      </div>

      <form
        class="flex w-full flex-col gap-8"
        [formGroup]="form"
        (ngSubmit)="submit()"
      >
        <sd-input
          label="Email"
          [required]="true"
          type="email"
          placeholder="you@example.com"
          autocomplete="email"
          formControlName="email"
          [error]="emailError()"
        />
        @if (errorMessage()) {
          <p
            class="rounded-field bg-alert/10 px-4 py-3 font-label text-caption text-alert"
          >
            {{ errorMessage() }}
          </p>
        }
        <sd-button type="submit" [full]="true" [disabled]="submitting()">
          Send code
          <sd-icon name="arrow-right" [size]="18" />
        </sd-button>
      </form>

      <a routerLink="/auth/login" class="block w-full">
        <sd-button variant="outline" [full]="true">
          <sd-icon name="arrow-right" [size]="18" class="rotate-180" />
          Back to log in
        </sd-button>
      </a>
    </div>
  `,
})
export class RecoverEmail {
  private readonly fb = inject(FormBuilder);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly flow = inject(AuthFlowService);

  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal('');
  protected readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
  });

  protected emailError(): string {
    const c = this.form.controls.email;
    if (!c.touched || c.valid) return '';
    if (c.errors?.['required']) return 'This field is required';
    return 'Enter a valid email address';
  }

  protected async submit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.submitting.set(true);
    this.errorMessage.set('');
    const email = this.form.controls.email.value;
    try {
      await this.auth.requestEmailOtp(email, 'reset');
      this.flow.start(email);
      await this.router.navigate(['/auth/recover/verify-email'], {
        queryParams: { target: email },
      });
    } catch (err) {
      const message = (err as { message?: string })?.message;
      this.errorMessage.set(message ?? 'Could not send the code. Try again.');
    } finally {
      this.submitting.set(false);
    }
  }
}
