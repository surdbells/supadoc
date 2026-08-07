import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthFlowService, AuthService } from '@supadoc/auth';
import { ButtonComponent, IconComponent } from '@supadoc/ui';

/** Sign up with phone (Figma 271:4673): capture number, continue to OTP verify. */
@Component({
  selector: 'pat-register-phone',
  imports: [ReactiveFormsModule, RouterLink, ButtonComponent, IconComponent],
  template: `
    <div class="flex flex-col gap-12">
      <h1 class="font-heading text-h1 text-abyss">👋 Welcome</h1>

      <div class="flex flex-col gap-12">
        <div class="flex flex-col gap-4 text-center">
          <h2 class="font-heading text-h2 text-ink">Sign Up with your Phone</h2>
          <p class="text-h5 text-slate">
            Enter your phone number to create your account
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
          </div>

          @if (errorMessage()) {
            <p
              class="rounded-field bg-alert/10 px-4 py-3 font-label text-caption text-alert"
            >
              {{ errorMessage() }}
            </p>
          }

          <sd-button type="submit" [full]="true" [disabled]="submitting()">
            {{ submitting() ? 'Sending code…' : 'Continue' }}
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
export class RegisterPhone {
  private readonly fb = inject(FormBuilder);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly flow = inject(AuthFlowService);

  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal('');

  protected readonly form = this.fb.nonNullable.group({
    phone: ['', [Validators.required, Validators.minLength(7)]],
  });

  protected async submit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.submitting.set(true);
    this.errorMessage.set('');
    const local = this.form.controls.phone.value.replace(/\D/g, '');
    const intl = `234${local}`; // Termii international format (no +)
    try {
      const pinId = await this.auth.requestPhoneOtp(intl);
      this.flow.startPhone(intl, pinId, 'register');
      await this.router.navigate(['/auth/register/verify-phone'], {
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
