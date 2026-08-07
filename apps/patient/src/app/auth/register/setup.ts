import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthFlowService, AuthService } from '@supadoc/auth';
import {
  ButtonComponent,
  IconComponent,
  InputComponent,
  PhoneInputComponent,
} from '@supadoc/ui';

/** Registration step 2 — set up account (Figma 336:4568). */
@Component({
  selector: 'pat-register-setup',
  imports: [
    ReactiveFormsModule,
    ButtonComponent,
    IconComponent,
    InputComponent,
    PhoneInputComponent,
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
        @if (isPhoneFlow()) {
          <sd-input
            label="Email"
            [required]="true"
            type="email"
            placeholder="you@example.com"
            autocomplete="email"
            formControlName="email"
            [error]="emailError()"
          />
        }
        @if (isPhoneFlow()) {
          <sd-phone-input
            label="Phone"
            [required]="true"
            formControlName="phone"
            [error]="phoneError()"
          />
        }

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

        <label class="flex items-start gap-2 font-sans text-body-sm text-slate">
          <input
            type="checkbox"
            formControlName="acceptPrivacy"
            class="mt-0.5 size-5 shrink-0 rounded accent-cerulean"
          />
          <span>
            I have read and accept VideoMed's
            <a
              href="/legal/privacy"
              target="_blank"
              rel="noopener"
              class="font-semibold text-cerulean hover:text-cerulean-dark"
              >Privacy Policy</a
            >.
          </span>
        </label>

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

  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal('');

  protected readonly rules = [
    { label: 'Minimum of 8 characters', test: (v: string) => v.length >= 8 },
    { label: 'Include a number', test: (v: string) => /\d/.test(v) },
    { label: 'Include an uppercase', test: (v: string) => /[A-Z]/.test(v) },
  ];

  protected readonly form = this.fb.nonNullable.group({
    fullName: ['', [Validators.required, Validators.minLength(2)]],
    // Email is only collected (and required) in the phone-registration flow;
    // the email flow already has it in AuthFlowService.
    email: [''],
    // Full E.164 number (dial code + local digits), emitted by sd-phone-input.
    // Only shown/required in the phone flow (see constructor); the email flow
    // hides it and captures the number later in My Profile.
    phone: ['', [Validators.pattern(/^\+\d{7,15}$/)]],
    password: [
      '',
      [
        Validators.required,
        Validators.minLength(8),
        Validators.pattern(/^(?=.*\d)(?=.*[A-Z]).+$/),
      ],
    ],
    acceptPrivacy: [false, [Validators.requiredTrue]],
  });

  constructor() {
    if (this.isPhoneFlow()) {
      this.form.controls.email.addValidators([
        Validators.required,
        Validators.email,
      ]);
      this.form.controls.email.updateValueAndValidity();
      // Phone was verified over SMS — prefill it (the backend uses the proof).
      this.form.controls.phone.addValidators(Validators.required);
      this.form.controls.phone.setValue(`+${this.flow.phone()}`);
      this.form.controls.phone.updateValueAndValidity();
    }
  }

  /**
   * True when we arrived here from the phone-OTP registration flow (a verified
   * phone is present). The email flow leaves `flow.phone` empty.
   */
  protected isPhoneFlow(): boolean {
    return this.flow.phone() !== '';
  }

  protected ruleOk(rule: { test: (v: string) => boolean }): boolean {
    return rule.test(this.form.controls.password.value);
  }

  protected emailError(): string {
    const control = this.form.controls.email;
    if (!control.touched || control.valid) return '';
    if (control.errors?.['required']) return 'Email is required';
    return 'Enter a valid email address';
  }

  protected phoneError(): string {
    const control = this.form.controls.phone;
    if (!control.touched || control.valid) return '';
    if (control.errors?.['required']) return 'Phone number is required';
    return 'Enter a valid phone number';
  }

  protected async submit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.submitting.set(true);
    this.errorMessage.set('');
    const { fullName, email, password } = this.form.getRawValue();
    const [firstName, ...rest] = fullName.trim().split(/\s+/);
    const lastName = rest.join(' ') || firstName;

    // Phone-OTP registration: create the account against the local backend.
    if (this.isPhoneFlow()) {
      try {
        await this.auth.registerByPhone({
          verificationToken: this.flow.verificationToken(),
          email,
          firstName,
          lastName,
          password,
        });
        this.flow.reset();
        await this.router.navigateByUrl('/dashboard');
      } catch (err) {
        const message = (err as { message?: string })?.message;
        this.errorMessage.set(message ?? 'Could not create your account.');
      } finally {
        this.submitting.set(false);
      }
      return;
    }

    // Email-OTP registration: create the account against the local backend
    // (the email proof token was issued at the verify step) and sign in.
    try {
      await this.auth.registerWithEmail({
        verificationToken: this.flow.verificationToken(),
        email: this.flow.email(),
        firstName,
        lastName,
        password,
      });
      this.flow.reset();
      await this.router.navigateByUrl('/dashboard');
    } catch (err) {
      const message = (err as { message?: string })?.message;
      this.errorMessage.set(message ?? 'Could not create your account.');
    } finally {
      this.submitting.set(false);
    }
  }
}
