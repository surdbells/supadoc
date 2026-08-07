import { Component, inject, signal } from '@angular/core';
import {
  AbstractControl,
  FormBuilder,
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
} from '@angular/forms';
import { Router } from '@angular/router';
import { AuthFlowService, AuthService } from '@supadoc/auth';
import { ButtonComponent, IconComponent, InputComponent } from '@supadoc/ui';

function passwordsMatch(group: AbstractControl): ValidationErrors | null {
  const password = group.get('password')?.value;
  const confirm = group.get('confirm')?.value;
  return password && confirm && password !== confirm
    ? { mismatch: true }
    : null;
}

/** Password recovery — set new password (Figma 376:5650). */
@Component({
  selector: 'pat-new-password',
  imports: [
    ReactiveFormsModule,
    ButtonComponent,
    IconComponent,
    InputComponent,
  ],
  template: `
    <div class="flex flex-col items-center gap-8">
      <div
        class="flex size-16 items-center justify-center rounded-full bg-frost/60 text-cerulean"
      >
        <sd-icon name="lock" [size]="26" />
      </div>

      <div class="flex flex-col gap-2 text-center">
        <h2 class="font-heading text-h2 text-ink">Set new password</h2>
        <p class="text-h5 text-slate">
          Your new password must be different from previously used passwords.
        </p>
      </div>

      <form
        class="flex w-full flex-col gap-6"
        [formGroup]="form"
        (ngSubmit)="submit()"
      >
        <div class="flex flex-col gap-3">
          <sd-input
            label="New Password"
            [required]="true"
            type="password"
            placeholder="Create a new password"
            autocomplete="new-password"
            formControlName="password"
          />
          <ul class="flex flex-col gap-1.5">
            @for (rule of rules; track rule.label) {
              <li
                class="flex items-center gap-2 font-sans text-body-sm"
                [class.text-sage]="ruleOk(rule)"
                [class.text-slate]="!ruleOk(rule)"
              >
                <sd-icon name="check" [size]="16" />
                {{ rule.label }}
              </li>
            }
          </ul>
        </div>

        <sd-input
          label="Confirm Password"
          [required]="true"
          type="password"
          placeholder="Re-enter your password"
          autocomplete="new-password"
          formControlName="confirm"
          [error]="confirmError()"
        />

        @if (errorMessage()) {
          <p
            class="rounded-field bg-alert/10 px-4 py-3 font-label text-caption text-alert"
          >
            {{ errorMessage() }}
          </p>
        }
        <sd-button
          type="submit"
          [full]="true"
          [disabled]="form.invalid || submitting()"
        >
          Reset password
          <sd-icon name="arrow-right" [size]="18" />
        </sd-button>
      </form>
    </div>
  `,
})
export class NewPassword {
  private readonly fb = inject(FormBuilder);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly flow = inject(AuthFlowService);

  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal('');

  protected readonly rules = [
    { label: 'Minimum of 8 characters', test: (v: string) => v.length >= 8 },
    { label: 'Include a number', test: (v: string) => /\d/.test(v) },
    { label: 'Include an uppercase', test: (v: string) => /[A-Z]/.test(v) },
  ];

  protected readonly form = this.fb.nonNullable.group(
    {
      password: [
        '',
        [
          Validators.required,
          Validators.minLength(8),
          Validators.pattern(/^(?=.*\d)(?=.*[A-Z]).+$/),
        ],
      ],
      confirm: ['', [Validators.required]],
    },
    { validators: passwordsMatch },
  );

  protected ruleOk(rule: { test: (v: string) => boolean }): boolean {
    return rule.test(this.form.controls.password.value);
  }

  protected confirmError(): string {
    const c = this.form.controls.confirm;
    if (!c.touched) return '';
    if (c.errors?.['required']) return 'This field is required';
    if (this.form.errors?.['mismatch']) return 'Passwords do not match';
    return '';
  }

  protected async submit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.submitting.set(true);
    this.errorMessage.set('');
    try {
      await this.auth.resetPasswordWithEmail({
        verificationToken: this.flow.verificationToken(),
        email: this.flow.email(),
        newPassword: this.form.controls.password.value,
      });
      this.flow.reset();
      await this.router.navigateByUrl('/auth/recover/success');
    } catch (err) {
      const message = (err as { message?: string })?.message;
      this.errorMessage.set(message ?? 'Could not reset your password.');
    } finally {
      this.submitting.set(false);
    }
  }
}
