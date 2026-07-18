import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '@supadoc/auth';
import { ButtonComponent, IconComponent, InputComponent } from '@supadoc/ui';

@Component({
  selector: 'pat-login',
  imports: [
    ReactiveFormsModule,
    RouterLink,
    ButtonComponent,
    IconComponent,
    InputComponent,
  ],
  template: `
    <div class="flex flex-col gap-8">
      <div class="flex flex-col gap-2">
        <h1 class="font-heading text-h1 text-abyss">Welcome back 👋</h1>
        <p class="text-body text-slate">
          Log in to continue to your VideoMed account.
        </p>
      </div>

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
          [error]="fieldError('email')"
        />
        <sd-input
          label="Password"
          type="password"
          leadingIcon="lock"
          placeholder="Enter your password"
          autocomplete="current-password"
          formControlName="password"
          [error]="fieldError('password')"
        />

        <a
          routerLink="/auth/forgot-password"
          class="self-end font-sans text-body-sm font-semibold text-cerulean hover:text-cerulean-dark"
        >
          Forgot password?
        </a>

        @if (errorMessage()) {
          <p
            class="rounded-field bg-alert/10 px-4 py-3 font-label text-caption text-alert"
          >
            {{ errorMessage() }}
          </p>
        }

        <sd-button type="submit" [full]="true" [disabled]="submitting()">
          {{ submitting() ? 'Logging in…' : 'Log in' }}
          <sd-icon name="arrow-right" [size]="18" />
        </sd-button>
      </form>

      <p class="text-center text-body text-slate">
        Don't have an account?
        <a
          routerLink="/auth/signup"
          class="font-semibold text-cerulean hover:text-cerulean-dark"
          >Sign up</a
        >
      </p>
    </div>
  `,
})
export class Login {
  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal('');

  protected readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required]],
  });

  protected fieldError(name: 'email' | 'password'): string {
    const control = this.form.controls[name];
    if (!control.touched || control.valid) return '';
    if (control.errors?.['required']) return 'This field is required';
    if (control.errors?.['email']) return 'Enter a valid email address';
    return 'Invalid value';
  }

  protected async submit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.submitting.set(true);
    this.errorMessage.set('');
    try {
      await this.auth.login(this.form.getRawValue());
      await this.router.navigateByUrl('/');
    } catch (err) {
      const message = (err as { message?: string })?.message;
      this.errorMessage.set(message ?? 'Unable to log in. Please try again.');
    } finally {
      this.submitting.set(false);
    }
  }
}
