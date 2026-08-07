import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IconComponent } from '@supadoc/ui';

interface Device {
  readonly icon: string;
  readonly name: string;
}

/**
 * Settings › Privacy & Security › Connected Device (Figma 1034:45955). The
 * backend doesn't track a device registry yet, so this shows the real current
 * device (parsed from the browser) instead of a fabricated list.
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
          <h1 class="font-heading text-h3 text-ink">Connected Device</h1>
          <p class="font-sans text-body text-slate">
            The device you're using right now.
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
          <span class="font-sans text-caption text-slate">Currently active</span>
        </div>
      </div>

      <p
        class="flex items-start gap-2 rounded-field bg-glacier px-4 py-3 font-sans text-caption text-slate"
      >
        <sd-icon name="info" [size]="16" class="mt-0.5 shrink-0 text-cerulean" />
        A registry of your other signed-in devices isn't available yet.
      </p>
    </div>
  `,
})
export class SettingsDevices {
  protected readonly current = signal<Device>(this.describeDevice());

  private describeDevice(): Device {
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
}
