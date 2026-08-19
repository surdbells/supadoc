import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '@supadoc/auth';
import { ButtonComponent, IconComponent } from '@supadoc/ui';
import { GoogleAuthService } from '../google-auth.service';

/** Continue with Google (Figma 365:5218). */
@Component({
  selector: 'pat-sign-in-google',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, ButtonComponent, IconComponent],
  template: `
    <div class="flex flex-col gap-12">
      <h1 class="font-heading text-h1 text-abyss">👋 Welcome</h1>

      <div class="flex flex-col gap-12">
        <div class="flex flex-col gap-4 text-center">
          <h2 class="font-heading text-h2 text-ink">
            Sign In with your Google Account
          </h2>
          <p class="text-h5 text-slate">
            Use your google account to sign in instantly
          </p>
        </div>

        <div
          class="relative mx-auto h-52 w-full max-w-[300px]"
          aria-hidden="true"
        >
          <!-- User (top, centered) -->
          <div
            class="absolute left-1/2 top-0 flex size-12 -translate-x-1/2 items-center justify-center rounded-full bg-frost/60 text-cerulean"
          >
            <sd-icon name="user" [size]="20" />
          </div>
          <!-- Accent ring between the user and the logo -->
          <div
            class="absolute left-1/2 top-[70px] size-3 -translate-x-1/2 rounded-full border-2 border-[#EC4899]"
          ></div>
          <!-- Shield (mid-left) -->
          <div
            class="absolute left-0 top-[104px] flex size-12 items-center justify-center rounded-full bg-frost/50 text-cerulean"
          >
            <sd-icon name="shield" [size]="18" />
          </div>
          <!-- Lock (mid-right) -->
          <div
            class="absolute right-0 top-[104px] flex size-12 items-center justify-center rounded-full bg-frost/50 text-cerulean"
          >
            <sd-icon name="lock" [size]="18" />
          </div>
          <!-- Google logo (centered, bottom) -->
          <div
            class="absolute bottom-0 left-1/2 flex size-24 -translate-x-1/2 items-center justify-center rounded-full border border-frost bg-white shadow-[0_4px_16px_rgba(10,22,40,0.08)]"
          >
            <svg width="44" height="44" viewBox="0 0 24 24">
              <path
                fill="#4285F4"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              />
              <path
                fill="#34A853"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              />
              <path
                fill="#FBBC05"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
              />
              <path
                fill="#EA4335"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
              />
            </svg>
          </div>
        </div>

        @if (errorMessage()) {
          <p
            class="rounded-field bg-alert/10 px-4 py-3 text-center font-label text-caption text-alert"
          >
            {{ errorMessage() }}
          </p>
        }

        <sd-button
          type="button"
          [full]="true"
          [disabled]="submitting()"
          (click)="continueWithGoogle()"
        >
          {{ submitting() ? 'Signing in…' : 'Continue' }}
          <sd-icon name="arrow-right" [size]="18" />
        </sd-button>
      </div>

      <p class="text-center text-body text-ink">
        Already have an account?
        <a
          routerLink="/auth/register"
          class="font-semibold text-cerulean hover:text-cerulean-dark"
          >Sign Up</a
        >
      </p>
    </div>
  `,
})
export class SignInGoogle {
  private readonly google = inject(GoogleAuthService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal('');

  protected async continueWithGoogle(): Promise<void> {
    this.submitting.set(true);
    this.errorMessage.set('');
    try {
      await this.google.signIn();
      await this.router.navigateByUrl(this.auth.consumeRedirect() ?? '/dashboard');
    } catch (err) {
      const code = (err as { code?: string })?.code;
      // A user closing the popup isn't an error worth shouting about.
      if (code !== 'auth/popup-closed-by-user' && code !== 'auth/cancelled-popup-request') {
        const message = (err as { message?: string })?.message;
        this.errorMessage.set(message ?? 'Google sign-in failed. Please try again.');
      }
    } finally {
      this.submitting.set(false);
    }
  }
}
