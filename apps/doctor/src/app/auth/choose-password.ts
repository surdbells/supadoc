import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import {
  AbstractControl,
  FormBuilder,
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
} from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { StaffAuthService } from '@supadoc/auth';
import { apiErrorMessage, DoctorApi } from '@supadoc/data-access';
import {
  AlertComponent,
  ButtonComponent,
  IconComponent,
  InputComponent,
} from '@supadoc/ui';
import { doctorLandingUrl } from '../onboarding/onboarding-landing';
import { DoctorAuthCard } from './doctor-auth-card';

/** Same rule as the API (and the password change in Settings). */
const MIN_PASSWORD = 8;

type Mode = 'invite' | 'reset';

const COPY: Record<Mode, { heading: string; subtitle: string; cta: string; busy: string; missing: string; fallback: string; recover: string }> = {
  invite: {
    heading: 'Set your password',
    subtitle: 'Welcome to VideoMed. Choose a password to finish setting up your doctor account.',
    cta: 'Set password and continue',
    busy: 'Setting password…',
    missing: 'This invite link is incomplete. Open the link from your invite email again. If you have already set your password, reset it instead.',
    fallback: 'Could not set your password. Please try again.',
    // A used invite can't be resent (the admin gets a 422) — forgot-password is the way back in.
    recover: 'Already set your password? Reset it',
  },
  reset: {
    heading: 'Choose a new password',
    subtitle: 'Enter a new password for your VideoMed doctor account.',
    cta: 'Update password and sign in',
    busy: 'Updating…',
    missing: 'This reset link is incomplete. Open the link from your email again, or request a new one.',
    fallback: 'Could not update your password. Please try again.',
    recover: 'Request a new reset link',
  },
};

/** The confirm field must repeat the password. */
function passwordsMatch(group: AbstractControl): ValidationErrors | null {
  const pw = group.get('password')?.value as string;
  const confirm = group.get('confirm')?.value as string;
  return confirm && pw !== confirm ? { mismatch: true } : null;
}

/**
 * Choose a password from an emailed one-time link (routes `auth/set-password`
 * for an invite, `auth/reset-password` for a reset — `data.mode`). The link's
 * token is the credential; on success the doctor is signed in and goes to
 * onboarding (until approved) or their schedule.
 */
@Component({
  selector: 'doc-choose-password',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    RouterLink,
    AlertComponent,
    ButtonComponent,
    IconComponent,
    InputComponent,
    DoctorAuthCard,
  ],
  template: `
    <doc-auth-card [heading]="copy().heading" [subtitle]="copy().subtitle">
      @if (!token) {
        <sd-alert tone="error" class="mt-5">{{ copy().missing }}</sd-alert>
        <a
          routerLink="/auth/forgot-password"
          class="mt-4 inline-flex font-sans text-body-sm font-semibold text-cerulean hover:underline"
          >{{ copy().recover }}</a
        >
      } @else {
        <form class="mt-6 flex flex-col gap-4" [formGroup]="form" (ngSubmit)="submit()">
          <sd-input
            label="New password"
            type="password"
            autocomplete="new-password"
            placeholder="At least 8 characters"
            formControlName="password"
            [error]="passwordError()"
          />
          <sd-input
            label="Confirm password"
            type="password"
            autocomplete="new-password"
            placeholder="Type it again"
            formControlName="confirm"
            [error]="confirmError()"
          />
          @if (error()) {
            <sd-alert tone="error">
              {{ error() }}
              <a routerLink="/auth/forgot-password" class="mt-1 block font-semibold underline">{{ copy().recover }}</a>
            </sd-alert>
          }
          <sd-button type="submit" [full]="true" [disabled]="busy()">
            {{ busy() ? copy().busy : copy().cta }}
            <sd-icon name="arrow-right" [size]="18" />
          </sd-button>
        </form>
      }
      <p class="mt-6 text-center font-sans text-body-sm text-slate">
        <a routerLink="/auth/login" class="font-semibold text-cerulean hover:underline">Back to sign in</a>
      </p>
    </doc-auth-card>
  `,
})
export class DoctorChoosePassword {
  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(StaffAuthService);
  private readonly doctorApi = inject(DoctorApi);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly mode = signal<Mode>(
    this.route.snapshot.data['mode'] === 'reset' ? 'reset' : 'invite',
  );
  protected readonly copy = computed(() => COPY[this.mode()]);
  /** The one-time token from the emailed link. */
  protected readonly token = (this.route.snapshot.queryParamMap.get('token') ?? '').trim();

  protected readonly busy = signal(false);
  protected readonly error = signal('');

  protected readonly form = this.fb.nonNullable.group(
    {
      password: ['', [Validators.required, Validators.minLength(MIN_PASSWORD)]],
      confirm: ['', [Validators.required]],
    },
    { validators: passwordsMatch },
  );
  private readonly submitted = signal(false);

  protected passwordError(): string {
    const c = this.form.controls.password;
    if (!(this.submitted() || c.touched) || c.valid) return '';
    return `Password must be at least ${MIN_PASSWORD} characters`;
  }

  protected confirmError(): string {
    const c = this.form.controls.confirm;
    if (!(this.submitted() || c.touched)) return '';
    if (c.hasError('required')) return 'Type your password again';
    return this.form.hasError('mismatch') ? "Passwords don't match" : '';
  }

  protected async submit(): Promise<void> {
    this.submitted.set(true);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.busy.set(true);
    this.error.set('');
    const { password } = this.form.getRawValue();
    try {
      if (this.mode() === 'reset') {
        await this.auth.resetPassword(this.token, password);
      } else {
        await this.auth.acceptInvite(this.token, password);
      }
      const target = this.auth.consumeRedirect() ?? (await doctorLandingUrl(this.doctorApi));
      await this.router.navigateByUrl(target, { replaceUrl: true });
    } catch (err) {
      this.error.set(
        (err as Error)?.message?.includes('doctor login')
          ? (err as Error).message
          : apiErrorMessage(err, this.copy().fallback),
      );
    } finally {
      this.busy.set(false);
    }
  }
}
