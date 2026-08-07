import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { PatientApi } from '@supadoc/data-access';
import { IconComponent, ToggleComponent } from '@supadoc/ui';

interface ToggleRow {
  readonly key: 'two_factor' | 'biometrics';
  readonly icon: string;
  readonly title: string;
  readonly desc: string;
  checked: boolean;
}

/**
 * Settings › Privacy & Security (Figma 908:34552). The two switches persist to
 * /portal/me/settings on change (there is no explicit save here).
 */
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

      @if (error()) {
        <p
          class="rounded-field bg-alert/10 px-4 py-3 font-label text-caption text-alert"
        >
          {{ error() }}
        </p>
      }

      <div class="flex flex-col gap-4">
        @if (loading()) {
          @for (i of [1, 2]; track i) {
            <div class="h-[76px] animate-pulse rounded-card bg-cloud/70"></div>
          }
        } @else {
          @for (row of toggles(); track row.key) {
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
              @if (savingKey() === row.key) {
                <span
                  class="size-4 shrink-0 animate-spin rounded-full border-2 border-cloud border-t-cerulean"
                ></span>
              }
              <sd-toggle
                [checked]="row.checked"
                (checkedChange)="onToggle(row, $event)"
              />
            </div>
          }
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
  private readonly patients = inject(PatientApi);

  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly savingKey = signal<string | null>(null);

  protected readonly toggles = signal<ToggleRow[]>([
    {
      key: 'two_factor',
      icon: 'lock',
      title: 'Two-Factor Authentication',
      desc: 'Add an extra layer of security to sign-ins',
      checked: false,
    },
    {
      key: 'biometrics',
      icon: 'fingerprint',
      title: 'Face ID / Biometrics',
      desc: 'Signin faster on this device',
      checked: false,
    },
  ]);

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

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      const res = await firstValueFrom(this.patients.settings());
      const privacy = res.data.privacy;
      this.toggles.update((rows) =>
        rows.map((r) => ({ ...r, checked: !!privacy[r.key] })),
      );
    } catch {
      this.error.set("We couldn't load your security settings.");
    } finally {
      this.loading.set(false);
    }
  }

  protected async onToggle(row: ToggleRow, checked: boolean): Promise<void> {
    this.error.set('');
    this.savingKey.set(row.key);
    this.setChecked(row.key, checked); // optimistic
    try {
      const res = await firstValueFrom(
        this.patients.updateSettings({ privacy: { [row.key]: checked } }),
      );
      this.setChecked(row.key, res.data.privacy[row.key]); // authoritative
    } catch (err) {
      this.setChecked(row.key, !checked); // revert
      const message = (err as { message?: string })?.message;
      this.error.set(message ?? 'Could not update that setting.');
    } finally {
      this.savingKey.set(null);
    }
  }

  private setChecked(key: ToggleRow['key'], checked: boolean): void {
    this.toggles.update((rows) =>
      rows.map((r) => (r.key === key ? { ...r, checked } : r)),
    );
  }
}
