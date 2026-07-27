import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import {
  IonButton,
  IonContent,
  IonInput,
  IonInputPasswordToggle,
} from '@ionic/angular/standalone';
import { AuthService } from '@supadoc/auth';
import { LogoComponent } from '@supadoc/ui';

@Component({
  selector: 'mob-signup',
  imports: [
    ReactiveFormsModule,
    RouterLink,
    IonContent,
    IonInput,
    IonInputPasswordToggle,
    IonButton,
    LogoComponent,
  ],
  template: `
    <ion-content class="ion-padding">
      <div class="auth">
        <sd-logo [size]="40" />
        <div>
          <h1 class="auth__title">Create your account</h1>
          <p class="auth__sub">
            Join VideoMed to book appointments and consult specialists online.
          </p>
        </div>

        <form [formGroup]="form" (ngSubmit)="submit()">
          <ion-input
            label="Full name"
            labelPlacement="stacked"
            fill="outline"
            autocomplete="name"
            placeholder="Jane Doe"
            formControlName="fullName"
          ></ion-input>
          <ion-input
            label="Email"
            labelPlacement="stacked"
            fill="outline"
            type="email"
            inputmode="email"
            autocomplete="email"
            placeholder="you@example.com"
            formControlName="email"
          ></ion-input>
          <ion-input
            label="Phone number"
            labelPlacement="stacked"
            fill="outline"
            type="tel"
            inputmode="tel"
            autocomplete="tel"
            placeholder="+234 800 000 0000"
            formControlName="phone"
          ></ion-input>
          <ion-input
            label="Password"
            labelPlacement="stacked"
            fill="outline"
            type="password"
            autocomplete="new-password"
            placeholder="Create a password"
            formControlName="password"
          >
            <ion-input-password-toggle slot="end"></ion-input-password-toggle>
          </ion-input>

          <label class="auth__terms">
            <input type="checkbox" formControlName="terms" />
            <span>I agree to the Terms of Service and Privacy Policy.</span>
          </label>

          @if (errorMessage()) {
            <p class="auth__error">{{ errorMessage() }}</p>
          }

          <ion-button
            type="submit"
            expand="block"
            [disabled]="submitting() || !form.controls.terms.value"
          >
            {{ submitting() ? 'Creating account…' : 'Create account' }}
          </ion-button>
        </form>

        <p class="auth__foot">
          Already have an account?
          <a routerLink="/auth/login" class="auth__link">Log in</a>
        </p>
      </div>
    </ion-content>
  `,
  styleUrl: '../auth.scss',
})
export class SignupPage {
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

  protected async submit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.submitting.set(true);
    this.errorMessage.set('');
    try {
      await this.auth.login({
        userName: this.form.controls.email.value,
        password: this.form.controls.password.value,
        loginType: 'username',
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
