import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthFlowService, AuthService } from '@supadoc/auth';
import { ProfileApi } from '@supadoc/data-access';
import { firstValueFrom } from 'rxjs';
import { ButtonComponent, IconComponent, InputComponent } from '@supadoc/ui';

/** Registration step 2 — set up account (Figma 336:4568). */
@Component({
  selector: 'pat-register-setup',
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
        <sd-icon name="user" [size]="26" />
      </div>

      <div class="flex flex-col gap-2 text-center">
        <h2 class="font-heading text-h2 text-ink">Let's Set Up Your Account</h2>
        <p class="text-h5 text-slate">
          Fill in the following details to get started.
        </p>
      </div>

      <form
        class="flex w-full flex-col gap-6"
        [formGroup]="form"
        (ngSubmit)="submit()"
      >
        <sd-input
          label="Full Name"
          placeholder="Your full name"
          autocomplete="name"
          formControlName="fullName"
        />
        <sd-input label="Date of Birth" type="date" formControlName="dob" />

        <div class="flex flex-col gap-3">
          <sd-input
            label="Password"
            type="password"
            placeholder="Create a password"
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
          Continue
          <sd-icon name="arrow-right" [size]="18" />
        </sd-button>
      </form>
    </div>
  `,
})
export class RegisterSetup {
  private readonly fb = inject(FormBuilder);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly flow = inject(AuthFlowService);
  private readonly profileApi = inject(ProfileApi);

  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal('');

  protected readonly rules = [
    { label: 'Minimum of 8 characters', test: (v: string) => v.length >= 8 },
    { label: 'Include a number', test: (v: string) => /\d/.test(v) },
    { label: 'Include an uppercase', test: (v: string) => /[A-Z]/.test(v) },
  ];

  protected readonly form = this.fb.nonNullable.group({
    fullName: ['', [Validators.required, Validators.minLength(2)]],
    dob: ['', [Validators.required]],
    password: [
      '',
      [
        Validators.required,
        Validators.minLength(8),
        Validators.pattern(/^(?=.*\d)(?=.*[A-Z]).+$/),
      ],
    ],
  });

  protected ruleOk(rule: { test: (v: string) => boolean }): boolean {
    return rule.test(this.form.controls.password.value);
  }

  protected async submit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.submitting.set(true);
    this.errorMessage.set('');
    const email = this.flow.email();
    const { fullName, password } = this.form.getRawValue();
    const [firstName, ...rest] = fullName.trim().split(/\s+/);
    const lastName = rest.join(' ') || firstName;
    try {
      await this.auth.register({
        email,
        password,
        accountType: 'public',
        otpCode: this.flow.otpCode(),
      });
      // Best-effort: create the profile; don't block success if it fails.
      try {
        await firstValueFrom(
          this.profileApi.createProfile({ firstName, lastName, email }),
        );
      } catch {
        /* profile can be completed later */
      }
      this.flow.reset();
      await this.router.navigateByUrl('/auth/register/success');
    } catch (err) {
      const message = (err as { message?: string })?.message;
      this.errorMessage.set(message ?? 'Could not create your account.');
      await this.router.navigateByUrl('/auth/register/failure');
    } finally {
      this.submitting.set(false);
    }
  }
}
