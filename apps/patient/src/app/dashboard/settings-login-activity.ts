import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IconComponent } from '@supadoc/ui';

interface Session {
  readonly icon: string;
  readonly name: string;
  readonly time: string;
  readonly location: string;
  readonly current?: boolean;
}

/** Settings › Privacy & Security › Login Activity (Figma 916:18056). */
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
            Recent sign-ins to your account.
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

      <div class="flex flex-col gap-4">
        @for (s of sessions; track s.name) {
          <div
            class="flex items-center gap-4 rounded-card border border-cloud bg-white p-5"
          >
            <span
              class="flex size-11 shrink-0 items-center justify-center rounded-full bg-frost/60 text-cerulean"
            >
              <sd-icon [name]="s.icon" [size]="22" />
            </span>
            <div class="flex min-w-0 flex-1 flex-col gap-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-sans text-body font-semibold text-ink">{{
                  s.name
                }}</span>
                @if (s.current) {
                  <span
                    class="rounded-pill bg-sage/15 px-2.5 py-0.5 font-sans text-[10px] font-medium text-sage"
                    >This device</span
                  >
                }
              </div>
              <div
                class="flex flex-wrap items-center gap-x-4 gap-y-1 font-sans text-caption text-slate"
              >
                <span class="flex items-center gap-1.5">
                  <sd-icon name="clock" [size]="14" />{{ s.time }}
                </span>
                <span class="flex items-center gap-1.5">
                  <sd-icon name="map-pin" [size]="14" />{{ s.location }}
                </span>
              </div>
            </div>
            @if (!s.current) {
              <button
                type="button"
                class="shrink-0 font-sans text-body-sm font-medium text-alert transition-colors hover:brightness-95"
              >
                Log Out
              </button>
            }
          </div>
        }
      </div>

      <div class="flex justify-center pt-2">
        <button
          type="button"
          class="inline-flex w-full max-w-md items-center justify-center rounded-field border border-cloud px-5 py-3 font-sans text-body font-semibold text-alert transition-colors hover:bg-alert/5"
        >
          Log out all devices
        </button>
      </div>
    </div>
  `,
})
export class SettingsLoginActivity {
  // TODO: source from the sessions API once available.
  protected readonly sessions: Session[] = [
    {
      icon: 'laptop',
      name: 'Chrome on MacOS',
      time: 'Just now',
      location: 'Lagos, Nigeria',
      current: true,
    },
    {
      icon: 'smartphone',
      name: 'Safari on Iphone',
      time: 'Yesterday, 06:45pm',
      location: 'Lagos, Nigeria',
    },
    {
      icon: 'laptop',
      name: 'Chrome on Windows',
      time: 'July 20, 2026. 05:00am',
      location: 'Abuja, Nigeria',
    },
  ];
}
