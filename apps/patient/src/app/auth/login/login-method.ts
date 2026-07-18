import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IconComponent } from '@supadoc/ui';

/** Login entry (Figma 345:4922): choose Google / Email / Phone to sign in. */
@Component({
  selector: 'pat-login-method',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent],
  template: `
    <div class="flex flex-col gap-14">
      <h1 class="font-heading text-h1 text-abyss">👋 Welcome back</h1>

      <div class="flex flex-col gap-10">
        <div class="flex flex-col gap-4 text-center">
          <h2 class="font-heading text-h2 text-ink">Sign in to your account</h2>
          <p class="text-h5 text-slate">Choose your log in method</p>
        </div>

        <div class="flex flex-col gap-6">
          <a routerLink="/auth/login/google" [class]="methodClass">
            <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
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
            Continue with Google
          </a>

          <a routerLink="/auth/login/email" [class]="methodClass">
            <sd-icon name="mail" [size]="24" class="text-ink" />
            Continue with Email
          </a>

          <a routerLink="/auth/login/phone" [class]="methodClass">
            <sd-icon name="phone" [size]="24" class="text-ink" />
            Continue with Phone
          </a>
        </div>
      </div>

      <p class="text-center text-body text-ink">
        Are you a new user?
        <a
          routerLink="/auth/register"
          class="font-semibold text-cerulean hover:text-cerulean-dark"
          >Register</a
        >
      </p>
    </div>
  `,
})
export class LoginMethod {
  protected readonly methodClass =
    'flex w-full items-center justify-center gap-4 rounded-lg border border-ash bg-white px-6 py-2.5 text-body-lg text-abyss transition-colors hover:bg-glacier';
}
