import { Component, DestroyRef, inject, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ButtonComponent, IconComponent, OtpComponent } from '@supadoc/ui';

/** Verify email/phone OTP (Figma 269:4546). Channel comes from route data. */
@Component({
  selector: 'pat-verify-otp',
  imports: [ReactiveFormsModule, ButtonComponent, IconComponent, OtpComponent],
  template: `
    <div class="flex flex-col items-center gap-8 text-center">
      <div
        class="flex size-16 items-center justify-center rounded-full bg-frost/60 text-cerulean"
      >
        <sd-icon [name]="channel === 'phone' ? 'phone' : 'mail'" [size]="26" />
      </div>

      <div class="flex flex-col gap-2">
        <h2 class="font-heading text-h2 text-ink">
          Verify your {{ channelLabel }}
        </h2>
        <p class="text-h5 text-slate">
          We've sent a six(6) digits OTP to your {{ target() }}
        </p>
      </div>

      <form
        class="flex w-full flex-col items-center gap-8"
        (ngSubmit)="verify()"
      >
        <sd-otp [formControl]="code" />
        <p class="font-sans text-body-sm text-slate">
          Code expires in
          <span class="font-semibold text-cerulean">{{ mmss() }}</span>
        </p>
        <sd-button
          type="submit"
          [full]="true"
          [disabled]="code.invalid || submitting()"
        >
          {{ submitting() ? 'Verifying…' : 'Verify' }}
        </sd-button>
      </form>

      <p class="text-body text-slate">
        Didn't receive the code?
        <button
          type="button"
          class="font-semibold text-cerulean hover:text-cerulean-dark"
          (click)="resend()"
        >
          Resend code
        </button>
      </p>
    </div>
  `,
})
export class VerifyOtp {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly channel =
    (this.route.snapshot.data['channel'] as 'email' | 'phone') ?? 'email';
  protected readonly channelLabel =
    this.channel === 'phone' ? 'Phone' : 'Email';
  private readonly next =
    (this.route.snapshot.data['next'] as string) ?? '/auth/register/setup';
  protected readonly target = signal(
    this.route.snapshot.queryParamMap.get('target') ?? 'your account',
  );

  protected readonly code = new FormControl('', {
    nonNullable: true,
    validators: [Validators.required, Validators.minLength(6)],
  });
  protected readonly submitting = signal(false);
  private readonly seconds = signal(299);

  protected mmss(): string {
    const s = this.seconds();
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(
      s % 60,
    ).padStart(2, '0')}`;
  }

  constructor() {
    const id = setInterval(
      () => this.seconds.update((s) => (s > 0 ? s - 1 : 0)),
      1000,
    );
    this.destroyRef.onDestroy(() => clearInterval(id));
  }

  protected async verify(): Promise<void> {
    if (this.code.invalid) return;
    this.submitting.set(true);
    await this.router.navigateByUrl(this.next);
    this.submitting.set(false);
  }

  protected resend(): void {
    this.seconds.set(299);
  }
}
