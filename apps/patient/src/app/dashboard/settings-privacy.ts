import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IconComponent, ToggleComponent } from '@supadoc/ui';

interface ToggleRow {
  readonly icon: string;
  readonly title: string;
  readonly desc: string;
  checked: boolean;
}

/** Settings › Privacy & Security (Figma 908:34552). */
@Component({
  selector: 'pat-settings-privacy',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent, ToggleComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <div class="flex items-start justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">Privacy &amp; Security</h1>
          <p class="font-sans text-body text-slate">
            Control how your account is protected and accessed.
          </p>
        </div>
        <a
          routerLink="/dashboard/settings"
          class="flex shrink-0 items-center gap-1 font-sans text-body text-slate transition-colors hover:text-cerulean"
        >
          <sd-icon name="arrow-right" [size]="18" class="rotate-180" />
          Back
        </a>
      </div>

      <div class="flex flex-col gap-4">
        @for (row of toggles; track row.title) {
          <div
            class="flex items-center gap-4 rounded-card border border-cloud bg-white p-5"
          >
            <span
              class="flex size-11 shrink-0 items-center justify-center rounded-full bg-frost/60 text-cerulean"
            >
              <sd-icon [name]="row.icon" [size]="22" />
            </span>
            <div class="flex min-w-0 flex-1 flex-col">
              <p class="font-sans text-body font-semibold text-ink">
                {{ row.title }}
              </p>
              <p class="font-sans text-caption text-slate">{{ row.desc }}</p>
            </div>
            <sd-toggle [(checked)]="row.checked" />
          </div>
        }

        @for (link of links; track link.title) {
          <a
            [routerLink]="link.route"
            class="flex items-center gap-4 rounded-card border border-cloud bg-white p-5 transition-colors hover:border-cerulean/50"
          >
            <span
              class="flex size-11 shrink-0 items-center justify-center rounded-full bg-frost/60 text-cerulean"
            >
              <sd-icon [name]="link.icon" [size]="22" />
            </span>
            <div class="flex min-w-0 flex-1 flex-col">
              <p class="font-sans text-body font-semibold text-ink">
                {{ link.title }}
              </p>
              <p class="font-sans text-caption text-slate">{{ link.desc }}</p>
            </div>
            <sd-icon
              name="chevron-right"
              [size]="20"
              class="shrink-0 text-slate"
            />
          </a>
        }
      </div>
    </div>
  `,
})
export class SettingsPrivacy {
  // TODO: persist via the security API once available.
  protected readonly toggles: ToggleRow[] = [
    {
      icon: 'lock',
      title: 'Two-Factor Authentication',
      desc: 'Add an extra layer of security to sign-ins',
      checked: false,
    },
    {
      icon: 'fingerprint',
      title: 'Face ID / Biometrics',
      desc: 'Signin faster on this device',
      checked: false,
    },
  ];

  protected readonly links = [
    {
      icon: 'activity',
      title: 'Login Activity',
      desc: 'Recent review sign-ins',
      route: '/dashboard/settings/privacy/login-activity',
    },
    {
      icon: 'monitor-smartphone',
      title: 'Connected Device',
      desc: '3 devices signed in',
      route: '/dashboard/settings/privacy/devices',
    },
  ];
}
