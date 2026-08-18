import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ButtonComponent, IconComponent } from '@supadoc/ui';

/** Password recovery by phone — step 1 (Figma 379:6700): request a reset code. */
@Component({
  selector: 'pat-recover-phone',
  imports: [ReactiveFormsModule, RouterLink, ButtonComponent, IconComponent],
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
          Enter your phone number and we'll send you a code to reset your
          password.
        </p>
      </div>

      <form
        class="flex w-full flex-col gap-8"
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
export class RecoverPhone {
  private readonly fb = inject(FormBuilder);
  private readonly router = inject(Router);

  protected readonly submitting = signal(false);
  protected readonly form = this.fb.nonNullable.group({
    phone: ['', [Validators.required, Validators.minLength(7)]],
  });

  protected async submit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.submitting.set(true);
    await this.router.navigate(['/auth/recover/verify-phone'], {
      queryParams: { target: `+234 ${this.form.controls.phone.value}` },
    });
    this.submitting.set(false);
  }
}
