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
  selector: 'mob-login',
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
          <h1 class="auth__title">Welcome back 👋</h1>
          <p class="auth__sub">Log in to continue to your VideoMed account.</p>
        </div>

        <form [formGroup]="form" (ngSubmit)="submit()">
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

          <a routerLink="/auth/forgot-password" class="auth__link auth__forgot">
            Forgot password?
          </a>

          @if (errorMessage()) {
            <p class="auth__error">{{ errorMessage() }}</p>
          }

          <ion-button type="submit" expand="block" [disabled]="submitting()">
            {{ submitting() ? 'Logging in…' : 'Log in' }}
          </ion-button>
        </form>

        <p class="auth__foot">
          Don't have an account?
          <a routerLink="/auth/signup" class="auth__link">Sign up</a>
        </p>
      </div>
    </ion-content>
  `,
  styleUrl: '../auth.scss',
})
export class LoginPage {
  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal('');

  protected readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
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
      await this.auth.login(this.form.getRawValue());
      await this.router.navigateByUrl('/');
    } catch (err) {
      const message = (err as { message?: string })?.message;
      this.errorMessage.set(message ?? 'Unable to log in. Please try again.');
    } finally {
      this.submitting.set(false);
    }
  }
}
