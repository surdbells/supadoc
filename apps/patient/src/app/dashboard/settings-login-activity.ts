import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '@supadoc/auth';
import { IconComponent } from '@supadoc/ui';

interface Session {
  readonly icon: string;
  readonly name: string;
}

/**
 * Settings › Privacy & Security › Login Activity (Figma 916:18056). The backend
 * uses stateless JWTs and doesn't record a sign-in history yet, so this shows
 * the real current session (parsed from the browser) rather than fabricated
 * entries; "Sign out" ends it.
 */
@Component({
  selector: 'pat-settings-login-activity',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <div class="flex items-start justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">Login Activity</h1>
          <p class="font-sans text-body text-slate">
            The device you're currently signed in on.
          </p>
        </div>
        <a
          routerLink="/dashboard/settings/privacy"
          class="flex shrink-0 items-center gap-1 font-sans text-body text-slate transition-colors hover:text-cerulean"
        >
          <sd-icon name="arrow-right" [size]="18" class="rotate-180" />
          Back
        </a>
      </div>

      <div
        class="flex items-center gap-4 rounded-card border border-cloud bg-white p-5"
      >
        <span
          class="flex size-11 shrink-0 items-center justify-center rounded-full bg-frost/60 text-cerulean"
        >
          <sd-icon [name]="current().icon" [size]="22" />
        </span>
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-sans text-body font-semibold text-ink">{{
              current().name
            }}</span>
            <span
              class="rounded-pill bg-sage/15 px-2.5 py-0.5 font-sans text-[10px] font-medium text-sage"
              >This device</span
            >
          </div>
          <span
            class="flex items-center gap-1.5 font-sans text-caption text-slate"
          >
            <sd-icon name="clock" [size]="14" />Active now
          </span>
        </div>
      </div>

      <p
        class="flex items-start gap-2 rounded-field bg-glacier px-4 py-3 font-sans text-caption text-slate"
      >
        <sd-icon name="info" [size]="16" class="mt-0.5 shrink-0 text-cerulean" />
        Sign-in history from other devices isn't available yet. You can end this
        session below.
      </p>

      <div class="flex justify-center pt-2">
        <button
          type="button"
          class="inline-flex w-full max-w-md items-center justify-center rounded-field border border-cloud px-5 py-3 font-sans text-body font-semibold text-alert transition-colors hover:bg-alert/5"
          (click)="signOut()"
        >
          Sign out of this device
        </button>
      </div>
    </div>
  `,
})
export class SettingsLoginActivity {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly current = signal<Session>(this.describeDevice());

  private describeDevice(): Session {
    const ua =
      typeof navigator === 'undefined' ? '' : navigator.userAgent || '';
    const browser = /Edg\//.test(ua)
      ? 'Edge'
      : /OPR\/|Opera/.test(ua)
        ? 'Opera'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Firefox\//.test(ua)
            ? 'Firefox'
            : /Safari\//.test(ua)
              ? 'Safari'
              : 'Your browser';
    const os = /Windows/.test(ua)
      ? 'Windows'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'macOS'
        : /Android/.test(ua)
          ? 'Android'
          : /iPhone|iPad|iPod/.test(ua)
            ? 'iOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'your device';
    const mobile = /Mobi|Android|iPhone|iPad|iPod/.test(ua);
    return { name: `${browser} on ${os}`, icon: mobile ? 'smartphone' : 'laptop' };
  }

  protected async signOut(): Promise<void> {
    await this.auth.logout();
    await this.router.navigateByUrl('/auth/login');
  }
}
