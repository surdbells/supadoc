import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ButtonComponent, IconComponent, InputComponent } from '@supadoc/ui';

@Component({
  selector: 'pat-forgot-password',
  imports: [
    ReactiveFormsModule,
    RouterLink,
    ButtonComponent,
    IconComponent,
    InputComponent,
  ],
  template: `
    <div class="flex flex-col gap-8">
      <a
        routerLink="/auth/login"
        class="inline-flex items-center gap-1 font-sans text-body-sm font-semibold text-slate hover:text-ink"
      >
        <sd-icon name="arrow-right" [size]="16" class="rotate-180" />
        Back to log in
      </a>

      <div class="flex flex-col gap-2">
        <h1 class="font-heading text-h1 text-abyss">Forgot password?</h1>
        <p class="text-body text-slate">
          Enter the email linked to your account and we'll send you a reset
          link.
        </p>
      </div>

      @if (sent()) {
        <p
          class="rounded-field bg-success/10 px-4 py-3 font-label text-body-sm text-success"
        >
          If an account exists for {{ form.controls.email.value }}, a reset link
          is on its way.
        </p>
      } @else {
        <form
          class="flex flex-col gap-5"
          [formGroup]="form"
          (ngSubmit)="submit()"
        >
          <sd-input
            label="Email"
            type="email"
            leadingIcon="mail"
            placeholder="you@example.com"
            autocomplete="email"
            formControlName="email"
            [error]="fieldError()"
          />
          <sd-button type="submit" [full]="true" [disabled]="submitting()">
            {{ submitting() ? 'Sending…' : 'Send reset link' }}
            <sd-icon name="arrow-right" [size]="18" />
          </sd-button>
        </form>
      }
    </div>
  `,
})
export class ForgotPassword {
  private readonly fb = inject(FormBuilder);

  protected readonly submitting = signal(false);
  protected readonly sent = signal(false);

  protected readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
  });

  protected fieldError(): string {
    const control = this.form.controls.email;
    if (!control.touched || control.valid) return '';
    if (control.errors?.['required']) return 'This field is required';
    return 'Enter a valid email address';
  }

  protected async submit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.submitting.set(true);
    // Placeholder until the password-reset endpoint is available.
    await new Promise((r) => setTimeout(r, 600));
    this.submitting.set(false);
    this.sent.set(true);
  }
}
