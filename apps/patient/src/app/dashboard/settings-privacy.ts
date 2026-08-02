import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IconComponent, ToggleComponent } from '@supadoc/ui';

interface PrivacyRow {
  readonly icon: string;
  readonly title: string;
  readonly desc: string;
  checked: boolean;
}

/** Settings › Privacy & Security (standard pattern; Figma 908:34552). */
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
            Control your privacy and security settings.
          </p>
        </div>
        <a
          routerLink="/dashboard/settings"
          class="flex shrink-0 items-center gap-1 font-sans text-body text-slate transition-colors hover:text-cerulean"
        >
          <sd-icon name="chevron-right" [size]="18" class="rotate-180" />
          Back
        </a>
      </div>

      <section
        class="flex flex-col rounded-card border border-cloud bg-white p-6"
      >
        @for (row of rows; track row.title) {
          <div
            class="flex items-center justify-between gap-4 border-t border-cloud py-4 first-of-type:border-t-0"
          >
            <div class="flex items-start gap-3">
              <span
                class="flex size-10 shrink-0 items-center justify-center rounded-full bg-frost text-cerulean"
              >
                <sd-icon [name]="row.icon" [size]="20" />
              </span>
              <div class="flex flex-col">
                <p class="font-sans text-body font-medium text-ink">
                  {{ row.title }}
                </p>
                <p class="font-sans text-caption text-slate">{{ row.desc }}</p>
              </div>
            </div>
            <sd-toggle [(checked)]="row.checked" />
          </div>
        }
      </section>

      <section
        class="flex flex-col gap-4 rounded-card border border-alert/30 bg-white p-6"
      >
        <h2 class="font-sans text-body font-semibold text-alert">
          Danger zone
        </h2>
        <div
          class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div class="flex flex-col">
            <p class="font-sans text-body font-medium text-ink">
              Log out of all devices
            </p>
            <p class="font-sans text-caption text-slate">
              End every active session except this one.
            </p>
          </div>
          <button
            type="button"
            class="inline-flex shrink-0 items-center justify-center rounded-field border border-alert px-4 py-2.5 font-sans text-body-sm font-semibold text-alert transition-colors hover:bg-alert/5"
          >
            Log out everywhere
          </button>
        </div>
        <div
          class="flex flex-col gap-4 border-t border-cloud pt-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div class="flex flex-col">
            <p class="font-sans text-body font-medium text-ink">
              Delete account
            </p>
            <p class="font-sans text-caption text-slate">
              Permanently remove your account and all data.
            </p>
          </div>
          <button
            type="button"
            class="inline-flex shrink-0 items-center justify-center gap-2 rounded-field bg-alert px-4 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:brightness-95"
          >
            <sd-icon name="trash-2" [size]="16" />
            Delete account
          </button>
        </div>
      </section>
    </div>
  `,
})
export class SettingsPrivacy {
  // TODO: persist via the security API once available.
  protected readonly rows: PrivacyRow[] = [
    {
      icon: 'shield-check',
      title: 'Two-factor authentication',
      desc: 'Require a verification code at sign in',
      checked: false,
    },
    {
      icon: 'lock',
      title: 'Biometric login',
      desc: 'Use fingerprint or face to unlock',
      checked: true,
    },
    {
      icon: 'user',
      title: 'Show profile to doctors',
      desc: 'Let matched specialists see your basic profile',
      checked: true,
    },
    {
      icon: 'activity',
      title: 'Share anonymised data for research',
      desc: 'Help improve care — never sold or shared with advertisers',
      checked: false,
    },
  ];
}
