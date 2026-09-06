import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { StaffAuthService } from '@supadoc/auth';
import { apiErrorMessage } from '@supadoc/data-access';
import { ButtonComponent, IconComponent, InputComponent } from '@supadoc/ui';

/** Doctor sign-in. Only accounts with the `doctor` role are accepted. */
@Component({
  selector: 'doc-login',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, ButtonComponent, IconComponent, InputComponent],
  host: { class: 'block min-h-screen bg-glacier' },
  template: `
    <div class="flex min-h-screen items-center justify-center px-4 py-10">
      <div
        class="w-full max-w-md rounded-card border border-cloud bg-white p-8 shadow-[0_4px_24px_rgba(10,22,40,0.06)]"
      >
        <div class="mb-6 flex items-center gap-2">
          <span class="font-heading text-h4 tracking-tight">
            <span class="text-cerulean">Video</span><span class="text-sage">Med</span>
          </span>
          <span
            class="rounded-pill bg-cerulean/10 px-2.5 py-1 font-sans text-caption font-semibold text-cerulean"
            >Doctor</span
          >
        </div>
        <h1 class="font-heading text-h4 text-ink">Doctor sign in</h1>
        <p class="mt-1 font-sans text-body-sm text-slate">
          Sign in to see your consultations and manage clinical records.
        </p>

        <form class="mt-6 flex flex-col gap-4" [formGroup]="form" (ngSubmit)="submit()">
          <sd-input
            label="Email"
            type="email"
            autocomplete="username"
            placeholder="you@videomed.test"
            formControlName="email"
          />
          <sd-input
            label="Password"
            type="password"
            autocomplete="current-password"
            placeholder="Enter your password"
            formControlName="password"
          />
          @if (error()) {
            <p class="rounded-field bg-alert/10 px-4 py-2 font-label text-caption text-alert">
              {{ error() }}
            </p>
          }
          <sd-button type="submit" [full]="true" [disabled]="busy()">
            {{ busy() ? 'Signing in…' : 'Sign in' }}
            <sd-icon name="arrow-right" [size]="18" />
          </sd-button>
        </form>
      </div>
    </div>
  `,
})
export class DoctorLogin {
  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(StaffAuthService);
  private readonly router = inject(Router);

  protected readonly busy = signal(false);
  protected readonly error = signal('');

  protected readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required]],
  });

  protected async submit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.busy.set(true);
    this.error.set('');
    const { email, password } = this.form.getRawValue();
    try {
      await this.auth.login(email, password);
      const target = this.auth.consumeRedirect() ?? '/schedule';
      await this.router.navigateByUrl(target);
    } catch (err) {
      this.error.set(
        (err as Error)?.message?.includes('doctor login')
          ? (err as Error).message
          : apiErrorMessage(err, 'Invalid email or password.'),
      );
    } finally {
      this.busy.set(false);
    }
  }
}
