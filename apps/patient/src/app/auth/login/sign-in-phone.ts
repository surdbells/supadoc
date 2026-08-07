import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthFlowService, AuthService } from '@supadoc/auth';
import { ButtonComponent } from '@supadoc/ui';

/** Sign in with phone (Figma 361:4760) — SMS OTP via Termii. */
@Component({
  selector: 'pat-sign-in-phone',
  imports: [ReactiveFormsModule, RouterLink, ButtonComponent],
  template: `
    <div class="flex flex-col gap-12">
      <h1 class="font-heading text-h1 text-abyss">👋 Welcome back</h1>

      <div class="flex flex-col gap-12">
        <div class="flex flex-col gap-4 text-center">
          <h2 class="font-heading text-h2 text-ink">Sign In with your Phone</h2>
          <p class="text-h5 text-slate">
            We'll text a verification code to log you in to
            <span class="text-cerulean">Video</span
            ><span class="text-teal">Med</span>
          </p>
        </div>

        <form
          class="flex flex-col gap-12"
          [formGroup]="form"
          (ngSubmit)="submit()"
        >
          <div class="flex flex-col gap-2">
            <span class="font-sans text-body font-semibold text-ink"
              >Phone <span class="text-alert">*</span></span
            >
            <div class="flex gap-2">
              <button
                type="button"
                class="flex shrink-0 items-center gap-2 rounded-field border border-[#d7e0e8] bg-white px-3 py-4 text-body text-ink"
              >
                <svg width="22" height="16" viewBox="0 0 22 16" aria-hidden="true">
                  <rect width="22" height="16" rx="2" fill="#fcfcfc" />
                  <rect width="7.33" height="16" fill="#008751" />
                  <rect x="14.67" width="7.33" height="16" fill="#008751" />
                </svg>
                +234
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

          @if (errorMessage()) {
            <p
              class="rounded-field bg-alert/10 px-4 py-3 font-label text-caption text-alert"
            >
              {{ errorMessage() }}
            </p>
          }

          <sd-button type="submit" [full]="true" [disabled]="submitting()">
            {{ submitting() ? 'Sending code…' : 'Send code' }}
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
  private readonly flow = inject(AuthFlowService);
  private readonly router = inject(Router);

  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal('');

  protected readonly form = this.fb.nonNullable.group({
    phone: ['', [Validators.required, Validators.minLength(7)]],
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
    const local = this.form.controls.phone.value.replace(/\D/g, '');
    const intl = `234${local}`;
    try {
      const pinId = await this.auth.requestPhoneOtp(intl);
      this.flow.startPhone(intl, pinId, 'login');
      await this.router.navigate(['/auth/login/verify-phone'], {
        queryParams: { target: `+234 ${local}` },
      });
    } catch (err) {
      const message = (err as { message?: string })?.message;
      this.errorMessage.set(message ?? 'Could not send the code. Please try again.');
    } finally {
      this.submitting.set(false);
    }
  }
}
