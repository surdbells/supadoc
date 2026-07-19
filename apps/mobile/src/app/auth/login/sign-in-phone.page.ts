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

/** Mobile sign in with phone. */
@Component({
  selector: 'mob-sign-in-phone',
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
        <div class="auth__head">
          <h1 class="auth__title">Sign In with your Phone</h1>
          <p class="auth__sub">
            Enter your phone number to log in to your VideoMed account
          </p>
        </div>

        <form [formGroup]="form" (ngSubmit)="submit()">
          <ion-input
            label="Phone"
            labelPlacement="stacked"
            fill="outline"
            type="tel"
            inputmode="tel"
            autocomplete="tel-national"
            placeholder="7080060034"
            formControlName="phone"
          >
            <span slot="start" style="color:#546e7a;margin-inline:4px;"
              >+234</span
            >
          </ion-input>
          <ion-input
            label="Password"
            labelPlacement="stacked"
            fill="outline"
            type="password"
            autocomplete="current-password"
            placeholder="Enter your password"
            formControlName="password"
          >
            <ion-input-password-toggle slot="end"></ion-input-password-toggle>
          </ion-input>

          <a routerLink="/auth/recover/phone" class="auth__link auth__forgot">
            Forgot Password?
          </a>

          @if (errorMessage()) {
            <p class="auth__error">{{ errorMessage() }}</p>
          }

          <ion-button type="submit" expand="block" [disabled]="submitting()">
            {{ submitting() ? 'Logging in…' : 'Log in' }}
          </ion-button>
        </form>

        <p class="auth__foot">
          Are you a new user?
          <a routerLink="/auth/register" class="auth__link">Register</a>
        </p>
      </div>
    </ion-content>
  `,
  styleUrl: '../auth.scss',
})
export class SignInPhonePage {
  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal('');

  protected readonly form = this.fb.nonNullable.group({
    phone: ['', [Validators.required, Validators.minLength(7)]],
    password: ['', [Validators.required]],
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
        email: `+234${this.form.controls.phone.value}`,
        password: this.form.controls.password.value,
      });
      await this.router.navigateByUrl('/');
    } catch (err) {
      const message = (err as { message?: string })?.message;
      this.errorMessage.set(message ?? 'Unable to log in. Please try again.');
    } finally {
      this.submitting.set(false);
    }
  }
}
