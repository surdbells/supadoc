import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '@supadoc/auth';
import { ButtonComponent, InputComponent } from '@supadoc/ui';

/** Sign in with phone (Figma 361:4760). */
@Component({
  selector: 'pat-sign-in-phone',
  imports: [ReactiveFormsModule, RouterLink, ButtonComponent, InputComponent],
  template: `
    <div class="flex flex-col gap-12">
      <h1 class="font-heading text-h1 text-abyss">👋 Welcome back</h1>

      <div class="flex flex-col gap-12">
        <div class="flex flex-col gap-4 text-center">
          <h2 class="font-heading text-h2 text-ink">Sign In with your Phone</h2>
          <p class="text-h5 text-slate">
            Enter your phone number to log in to
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
            <div class="flex flex-col gap-2">
              <span class="font-sans text-body font-semibold text-ink"
                >Phone <span class="text-alert">*</span></span
              >
              <div class="flex gap-2">
                <button
                  type="button"
                  class="flex shrink-0 items-center gap-2 rounded-field border border-[#d7e0e8] bg-white px-3 py-4 text-body text-ink"
                >
                  <svg
                    width="22"
                    height="16"
                    viewBox="0 0 22 16"
                    aria-hidden="true"
                  >
                    <rect width="22" height="16" rx="2" fill="#fcfcfc" />
                    <rect width="7.33" height="16" fill="#008751" />
                    <rect x="14.67" width="7.33" height="16" fill="#008751" />
                  </svg>
                  +234
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    class="text-slate"
                    aria-hidden="true"
                  >
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </button>
                <input
                  class="w-full rounded-field border border-[#d7e0e8] bg-white px-4 py-4 text-body text-ink placeholder:text-slate/60 focus:border-teal focus:outline-none focus:ring-2 focus:ring-teal/15"
                  type="tel"
                  inputmode="tel"
                  autocomplete="tel-national"
                  placeholder="7080060034"
                  formControlName="phone"
                />
              </div>
              @if (phoneError()) {
                <span class="font-label text-caption text-alert">{{
                  phoneError()
                }}</span>
              }
            </div>

            <div class="flex flex-col gap-2">
              <sd-input
                label="Password"
                [required]="true"
                type="password"
                placeholder="Enter your password"
                autocomplete="current-password"
                formControlName="password"
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
                  routerLink="/auth/recover/phone"
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
export class SignInPhone {
  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal('');

  protected readonly form = this.fb.nonNullable.group({
    phone: ['', [Validators.required, Validators.minLength(7)]],
    password: ['', [Validators.required]],
    remember: [false],
  });

  protected phoneError(): string {
    const control = this.form.controls.phone;
    if (!control.touched || control.valid) return '';
    if (control.errors?.['required']) return 'This field is required';
    return 'Enter a valid phone number';
  }

  protected async submit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.submitting.set(true);
    this.errorMessage.set('');
    try {
      await this.auth.login({
        email: `+234${this.form.controls.phone.value}`,
        password: this.form.controls.password.value,
      });
      await this.router.navigateByUrl('/');
    } catch (err) {
      const message = (err as { message?: string })?.message;
      this.errorMessage.set(message ?? 'Unable to log in. Please try again.');
    } finally {
      this.submitting.set(false);
    }
  }
}
