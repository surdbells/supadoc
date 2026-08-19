import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '@supadoc/auth';
import { ButtonComponent, InputComponent } from '@supadoc/ui';

/** Sign in with email (Figma 356:4406). */
@Component({
  selector: 'pat-sign-in-email',
  imports: [ReactiveFormsModule, RouterLink, ButtonComponent, InputComponent],
  template: `
    <div class="flex flex-col gap-12">
      <h1 class="font-heading text-h1 text-abyss">👋 Welcome back</h1>

      <div class="flex flex-col gap-12">
        <div class="flex flex-col gap-4 text-center">
          <h2 class="font-heading text-h2 text-ink">Sign In with your Email</h2>
          <p class="text-h5 text-slate">
            Enter your email to log in to
            <span class="text-cerulean">Video</span
            ><span class="text-teal">Med</span> your account
          </p>
        </div>

        <form
          class="flex flex-col gap-12"
          [formGroup]="form"
          (ngSubmit)="submit()"
        >
          <div class="flex flex-col gap-6">
            <sd-input
              label="Email"
              [required]="true"
              type="email"
              placeholder="you@example.com"
              autocomplete="email"
              formControlName="email"
              [error]="fieldError('email')"
            />
            <div class="flex flex-col gap-2">
              <sd-input
                label="Password"
                [required]="true"
                type="password"
                placeholder="Enter your password"
                autocomplete="current-password"
                formControlName="password"
                [error]="fieldError('password')"
              />
              <div class="flex items-center justify-between">
                <label
                  class="flex items-center gap-2 font-sans text-body-sm text-slate"
                >
                  <input
                    type="checkbox"
                    formControlName="remember"
                    class="size-5 rounded accent-cerulean"
                  />
                  Remember me
                </label>
                <a
                  routerLink="/auth/recover/email"
                  class="font-sans text-body-sm text-cerulean hover:text-cerulean-dark"
                >
                  Forgot Password?
                </a>
              </div>
            </div>
          </div>

          @if (errorMessage()) {
            <p
              class="rounded-field bg-alert/10 px-4 py-3 font-label text-caption text-alert"
            >
              {{ errorMessage() }}
            </p>
          }

          <sd-button type="submit" [full]="true" [disabled]="submitting()">
            {{ submitting() ? 'Logging in…' : 'Log in' }}
          </sd-button>
        </form>
      </div>

      <p class="text-center text-body text-ink">
        Are you a new user?
        <a
          routerLink="/auth/register"
          class="font-semibold text-cerulean hover:text-cerulean-dark"
          >Register</a
        >
      </p>
    </div>
  `,
})
export class SignInEmail {
  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal('');

  protected readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required]],
    remember: [false],
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
      await this.auth.login(
        {
          userName: this.form.controls.email.value,
          password: this.form.controls.password.value,
          loginType: 'username',
        },
        this.form.controls.remember.value,
      );
      await this.router.navigateByUrl(this.auth.consumeRedirect() ?? '/dashboard');
    } catch (err) {
      const message = (err as { message?: string })?.message;
      this.errorMessage.set(message ?? 'Unable to log in. Please try again.');
    } finally {
      this.submitting.set(false);
    }
  }
}
