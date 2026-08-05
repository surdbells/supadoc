import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IconComponent } from '@supadoc/ui';

interface Device {
  readonly icon: string;
  readonly name: string;
  readonly meta: string;
  readonly current?: boolean;
}

/**
 * Settings › Privacy & Security › Connected Devices (Figma 1034:45955).
 * Adapted from the Login Activity pattern — the exact frame wasn't provided, so
 * this mirrors the device-list style and should get a pixel pass when available.
 */
@Component({
  selector: 'pat-settings-devices',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <div class="flex items-start justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">Connected Devices</h1>
          <p class="font-sans text-body text-slate">
            Devices currently signed in to your account.
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
        @for (d of devices; track d.name) {
          <div
            class="flex items-center gap-4 rounded-card border border-cloud bg-white p-5"
          >
            <span
              class="flex size-11 shrink-0 items-center justify-center rounded-full bg-frost/60 text-cerulean"
            >
              <sd-icon [name]="d.icon" [size]="22" />
            </span>
            <div class="flex min-w-0 flex-1 flex-col gap-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-sans text-body font-semibold text-ink">{{
                  d.name
                }}</span>
                @if (d.current) {
                  <span
                    class="rounded-pill bg-sage/15 px-2.5 py-0.5 font-sans text-[10px] font-medium text-sage"
                    >This device</span
                  >
                }
              </div>
              <span class="font-sans text-caption text-slate">{{
                d.meta
              }}</span>
            </div>
            @if (!d.current) {
              <button
                type="button"
                class="shrink-0 font-sans text-body-sm font-medium text-alert transition-colors hover:brightness-95"
              >
                Remove
              </button>
            }
          </div>
        }
      </div>
    </div>
  `,
})
export class SettingsDevices {
  // TODO: source from the devices API once available.
  protected readonly devices: Device[] = [
    {
      icon: 'laptop',
      name: 'MacBook Pro',
      meta: 'Chrome  •  Lagos, Nigeria  •  Active now',
      current: true,
    },
    {
      icon: 'smartphone',
      name: 'iPhone 15',
      meta: 'Safari  •  Lagos, Nigeria  •  Yesterday, 06:45pm',
    },
    {
      icon: 'laptop',
      name: 'Windows PC',
      meta: 'Chrome  •  Abuja, Nigeria  •  July 20, 2026',
    },
  ];
}
