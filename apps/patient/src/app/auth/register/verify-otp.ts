import { Component, DestroyRef, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthFlowService, AuthService } from '@supadoc/auth';
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
        [formGroup]="form"
        (ngSubmit)="verify()"
      >
        <sd-otp formControlName="code" />
        <p class="font-sans text-body-sm text-slate">
          Code expires in
          <span class="font-semibold text-cerulean">{{ mmss() }}</span>
        </p>
        <sd-button
          type="submit"
          [full]="true"
          [disabled]="form.invalid || submitting()"
        >
          {{ submitting() ? 'Verifying…' : 'Verify' }}
        </sd-button>
        @if (errorMessage()) {
          <p
            class="w-full rounded-field bg-alert/10 px-4 py-3 font-label text-caption text-alert"
          >
            {{ errorMessage() }}
          </p>
        }
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
  private readonly fb = inject(FormBuilder);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly auth = inject(AuthService);
  private readonly flow = inject(AuthFlowService);

  protected readonly channel =
    (this.route.snapshot.data['channel'] as 'email' | 'phone') ?? 'email';
  protected readonly channelLabel =
    this.channel === 'phone' ? 'Phone' : 'Email';
  private readonly mode =
    (this.route.snapshot.data['mode'] as 'register' | 'recover') ?? 'register';
  private readonly next =
    (this.route.snapshot.data['next'] as string) ?? '/auth/register/setup';
  protected readonly target = signal(
    this.route.snapshot.queryParamMap.get('target') ?? 'your account',
  );

  protected readonly form = this.fb.nonNullable.group({
    code: ['', [Validators.required, Validators.minLength(6)]],
  });
  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal('');
  private readonly seconds = signal(299);

  protected mmss(): string {
    const s = this.seconds();
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(
      s % 60,
    ).padStart(2, '0')}`;
  }

  constructor() {
    const id = setInterval(() => {
      this.seconds.update((s) => (s > 0 ? s - 1 : 0));
      // When the code expires, clear whatever the user has typed.
      if (this.seconds() === 0 && this.form.controls.code.value) {
        this.form.controls.code.reset('');
      }
    }, 1000);
    this.destroyRef.onDestroy(() => clearInterval(id));
  }

  /**
   * Address the code was sent to. `AuthFlowService` is in-memory, so fall back
   * to the `target` query param set when the code was requested — that keeps a
   * page refresh from stranding the flow. The OTP itself stays out of the URL.
   */
  private resolveEmail(): string {
    const fromFlow = this.flow.email();
    if (fromFlow) return fromFlow;
    const fromQuery = this.route.snapshot.queryParamMap.get('target') ?? '';
    if (fromQuery) this.flow.start(fromQuery);
    return fromQuery;
  }

  protected async verify(): Promise<void> {
    if (this.form.invalid) return;
    const code = this.form.getRawValue().code;

    // Phone channel goes through Termii (pin id -> proof token).
    if (this.channel === 'phone') {
      const phone = this.flow.phone();
      const pinId = this.flow.pinId();
      if (!phone || !pinId) {
        this.errorMessage.set('Your session expired — please start again.');
        return;
      }
      this.submitting.set(true);
      this.errorMessage.set('');
      try {
        const token = await this.auth.verifyPhoneOtp(pinId, code, phone);
        this.flow.verificationToken.set(token);
        if (this.flow.purpose() === 'login') {
          await this.auth.loginByPhone(token);
          await this.router.navigateByUrl('/dashboard');
        } else {
          await this.router.navigateByUrl('/auth/register/setup');
        }
      } catch (err) {
        const message = (err as { message?: string })?.message;
        this.errorMessage.set(message ?? 'That code is invalid or expired.');
      } finally {
        this.submitting.set(false);
      }
      return;
    }

    const email = this.resolveEmail();
    if (!email) {
      this.errorMessage.set('Your session expired — please start again.');
      return;
    }
    this.submitting.set(true);
    this.errorMessage.set('');
    try {
      const purpose = this.mode === 'recover' ? 'reset' : 'register';
      const token = await this.auth.verifyEmailOtp(email, code, purpose);
      this.flow.verificationToken.set(token);
      await this.router.navigateByUrl(this.next);
    } catch (err) {
      const message = (err as { message?: string })?.message;
      this.errorMessage.set(message ?? 'That code is invalid or expired.');
    } finally {
      this.submitting.set(false);
    }
  }

  protected async resend(): Promise<void> {
    this.errorMessage.set('');

    if (this.channel === 'phone') {
      const phone = this.flow.phone();
      if (!phone) {
        this.errorMessage.set('Your session expired — please start again.');
        return;
      }
      try {
        this.flow.pinId.set(await this.auth.requestPhoneOtp(phone));
        this.seconds.set(299);
      } catch (err) {
        const message = (err as { message?: string })?.message;
        this.errorMessage.set(message ?? 'Could not resend the code.');
      }
      return;
    }

    const email = this.resolveEmail();
    if (!email) {
      this.errorMessage.set('Your session expired — please start again.');
      return;
    }
    try {
      await this.auth.requestEmailOtp(
        email,
        this.mode === 'recover' ? 'reset' : 'register',
      );
      this.seconds.set(299);
    } catch (err) {
      const message = (err as { message?: string })?.message;
      this.errorMessage.set(message ?? 'Could not resend the code.');
    }
  }
}
