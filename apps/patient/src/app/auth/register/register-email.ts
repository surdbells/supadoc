import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthFlowService, AuthService } from '@supadoc/auth';
import { ButtonComponent, IconComponent, InputComponent } from '@supadoc/ui';

/** Sign up with email (Figma 262:4224): capture email, continue to OTP verify. */
@Component({
  selector: 'pat-register-email',
  imports: [
    ReactiveFormsModule,
    RouterLink,
    ButtonComponent,
    IconComponent,
    InputComponent,
  ],
  template: `
    <div class="flex flex-col gap-12">
      <h1 class="font-heading text-h1 text-abyss">👋 Welcome</h1>

      <div class="flex flex-col gap-12">
        <div class="flex flex-col gap-4 text-center">
          <h2 class="font-heading text-h2 text-ink">Sign Up with your Email</h2>
          <p class="text-h5 text-slate">
            Enter your email to create your account
          </p>
        </div>

        <form
          class="flex flex-col gap-12"
          [formGroup]="form"
          (ngSubmit)="submit()"
        >
          <sd-input
            label="Email"
            type="email"
            placeholder="you@example.com"
            autocomplete="email"
            formControlName="email"
            [error]="emailError()"
            [success]="emailValid() ? 'Valid email' : ''"
          />
          @if (errorMessage()) {
            <p
              class="rounded-field bg-alert/10 px-4 py-3 font-label text-caption text-alert"
            >
              {{ errorMessage() }}
            </p>
          }
          <sd-button type="submit" [full]="true" [disabled]="submitting()">
            Continue
            <sd-icon name="arrow-right" [size]="18" />
          </sd-button>
        </form>
      </div>

      <p class="text-center text-body text-ink">
        Already have an account?
        <a
          routerLink="/auth/login"
          class="font-semibold text-cerulean hover:text-cerulean-dark"
          >Log in</a
        >
      </p>
    </div>
  `,
})
export class RegisterEmail {
  private readonly fb = inject(FormBuilder);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly flow = inject(AuthFlowService);

  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal('');

  protected readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
  });

  private readonly emailControl = this.form.controls.email;

  protected emailValid(): boolean {
    return this.emailControl.valid && !!this.emailControl.value;
  }

  protected emailError(): string {
    const c = this.emailControl;
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
    const email = this.emailControl.value;
    try {
      await this.auth.requestEmailOtp(email, 'register');
      this.flow.start(email);
      await this.router.navigate(['/auth/register/verify-email'], {
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
