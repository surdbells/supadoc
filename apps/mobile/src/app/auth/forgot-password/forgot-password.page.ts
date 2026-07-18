import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { IonButton, IonContent, IonInput } from '@ionic/angular/standalone';
import { LogoComponent } from '@supadoc/ui';

@Component({
  selector: 'mob-forgot-password',
  imports: [
    ReactiveFormsModule,
    RouterLink,
    IonContent,
    IonInput,
    IonButton,
    LogoComponent,
  ],
  template: `
    <ion-content class="ion-padding">
      <div class="auth">
        <a routerLink="/auth/login" class="auth__back">← Back to log in</a>
        <sd-logo [size]="40" />
        <div>
          <h1 class="auth__title">Forgot password?</h1>
          <p class="auth__sub">
            Enter the email linked to your account and we'll send you a reset
            link.
          </p>
        </div>

        @if (sent()) {
          <p class="auth__success">
            If an account exists for {{ form.controls.email.value }}, a reset
            link is on its way.
          </p>
        } @else {
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
            <ion-button type="submit" expand="block" [disabled]="submitting()">
              {{ submitting() ? 'Sending…' : 'Send reset link' }}
            </ion-button>
          </form>
        }
      </div>
    </ion-content>
  `,
  styleUrl: '../auth.scss',
})
export class ForgotPasswordPage {
  private readonly fb = inject(FormBuilder);

  protected readonly submitting = signal(false);
  protected readonly sent = signal(false);

  protected readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
  });

  protected async submit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.submitting.set(true);
    await new Promise((r) => setTimeout(r, 600));
    this.submitting.set(false);
    this.sent.set(true);
  }
}
