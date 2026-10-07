import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { StaffAuthService, consumeSessionNotice } from '@supadoc/auth';
import { apiErrorMessage } from '@supadoc/data-access';
import {
  AlertComponent,
  ButtonComponent,
  IconComponent,
  InputComponent,
} from '@supadoc/ui';

/** Doctor sign-in. Only accounts with the `doctor` role are accepted. */
@Component({
  selector: 'doc-login',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    AlertComponent,
    ButtonComponent,
    IconComponent,
    InputComponent,
  ],
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

        @if (notice(); as message) {
          <!-- Why the previous session ended (idle, expired, another tab). -->
          <sd-alert tone="info" class="mt-5">
            <span class="flex items-start gap-3">
              <span class="min-w-0 flex-1">{{ message }}</span>
              <button
                type="button"
                class="-my-0.5 -mr-1 shrink-0 rounded-field p-0.5 text-cerulean/70 transition-colors hover:text-cerulean focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cerulean"
                aria-label="Dismiss message"
                (click)="dismissNotice()"
              >
                <sd-icon name="x" [size]="18" />
              </button>
            </span>
          </sd-alert>
        }

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
  /**
   * Why the last session ended (idle timeout, expiry, sign-out in another tab),
   * read once on arrival — the library clears it so a refresh won't repeat it.
   */
  protected readonly notice = signal<string | null>(consumeSessionNotice());

  protected readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required]],
  });

  protected dismissNotice(): void {
    this.notice.set(null);
  }

  protected async submit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    // The explanation has done its job; any sign-in error now stands alone.
    this.notice.set(null);
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
