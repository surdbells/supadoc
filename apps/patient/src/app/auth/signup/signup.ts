import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '@supadoc/auth';
import { ButtonComponent, IconComponent, InputComponent } from '@supadoc/ui';

@Component({
  selector: 'pat-signup',
  imports: [
    ReactiveFormsModule,
    RouterLink,
    ButtonComponent,
    IconComponent,
    InputComponent,
  ],
  template: `
    <div class="flex flex-col gap-8">
      <div class="flex flex-col gap-2">
        <h1 class="font-heading text-h1 text-abyss">Create your account</h1>
        <p class="text-body text-slate">
          Join VideoMed to book appointments and consult specialists online.
        </p>
      </div>

      <form
        class="flex flex-col gap-5"
        [formGroup]="form"
        (ngSubmit)="submit()"
      >
        <sd-input
          label="Full name"
          leadingIcon="user"
          placeholder="Jane Doe"
          autocomplete="name"
          formControlName="fullName"
          [error]="fieldError('fullName')"
        />
        <sd-input
          label="Email"
          type="email"
          leadingIcon="mail"
          placeholder="you@example.com"
          autocomplete="email"
          formControlName="email"
          [error]="fieldError('email')"
        />
        <sd-input
          label="Phone number"
          type="tel"
          leadingIcon="phone"
          placeholder="+234 800 000 0000"
          autocomplete="tel"
          formControlName="phone"
          [error]="fieldError('phone')"
        />
        <sd-input
          label="Password"
          type="password"
          leadingIcon="lock"
          placeholder="Create a password"
          autocomplete="new-password"
          formControlName="password"
          [error]="fieldError('password')"
        />

        <label class="flex items-start gap-3 text-body-sm text-slate">
          <input
            type="checkbox"
            formControlName="terms"
            class="mt-0.5 size-5 shrink-0 rounded-md accent-cerulean"
          />
          <span
            >I agree to the
            <a class="font-semibold text-cerulean">Terms of Service</a> and
            <a class="font-semibold text-cerulean">Privacy Policy</a>.</span
          >
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
          [disabled]="submitting() || !form.controls.terms.value"
        >
          {{ submitting() ? 'Creating account…' : 'Create account' }}
          <sd-icon name="arrow-right" [size]="18" />
        </sd-button>
      </form>

      <p class="text-center text-body text-slate">
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
export class Signup {
  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal('');

  protected readonly form = this.fb.nonNullable.group({
    fullName: ['', [Validators.required, Validators.minLength(2)]],
    email: ['', [Validators.required, Validators.email]],
    phone: [''],
    password: ['', [Validators.required, Validators.minLength(8)]],
    terms: [false, [Validators.requiredTrue]],
  });

  protected fieldError(
    name: 'fullName' | 'email' | 'phone' | 'password',
  ): string {
    const control = this.form.controls[name];
    if (!control.touched || control.valid) return '';
    if (control.errors?.['required']) return 'This field is required';
    if (control.errors?.['email']) return 'Enter a valid email address';
    if (control.errors?.['minlength']) {
      return name === 'password'
        ? 'Use at least 8 characters'
        : 'This value is too short';
    }
    return 'Invalid value';
  }

  protected async submit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.submitting.set(true);
    this.errorMessage.set('');
    try {
      // Placeholder: the real registration endpoint is wired via @supadoc/data-access
      // once the API team ships it. For now reuse the login call shape.
      await this.auth.login({
        email: this.form.controls.email.value,
        password: this.form.controls.password.value,
      });
      await this.router.navigateByUrl('/');
    } catch (err) {
      const message = (err as { message?: string })?.message;
      this.errorMessage.set(
        message ?? 'Unable to create your account. Please try again.',
      );
    } finally {
      this.submitting.set(false);
    }
  }
}
