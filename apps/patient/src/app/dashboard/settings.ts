import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { AuthService } from '@supadoc/auth';
import { PatientApi } from '@supadoc/data-access';
import { IconComponent } from '@supadoc/ui';

interface SettingRow {
  readonly icon: string;
  readonly title: string;
  readonly subtitle: string;
  readonly link?: string;
  readonly danger?: boolean;
  readonly action?: 'logout';
}

/** Settings (Figma 497:8315). Rows open the settings sub-pages. */
@Component({
  selector: 'pat-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <div class="flex flex-col gap-1">
        <h1 class="font-heading text-h3 text-ink">Settings</h1>
        <p class="font-sans text-body text-slate">
          Manage your account preferences and security.
        </p>
      </div>

      <!-- Profile card -->
      <div class="flex items-center gap-4 rounded-card bg-frost/50 p-5">
        @if (avatarSrc()) {
          <img
            [src]="avatarSrc()"
            alt="Profile photo"
            width="56"
            height="56"
            class="size-14 shrink-0 rounded-full object-cover"
          />
        } @else {
          <span
            class="flex size-14 shrink-0 items-center justify-center rounded-full bg-cerulean/15 font-heading text-h5 text-cerulean"
          >
            @if (initials()) {
              {{ initials() }}
            } @else {
              <sd-icon name="user" [size]="24" />
            }
          </span>
        }
        <div class="flex min-w-0 flex-col">
          <p class="font-heading text-h5 text-ink">{{ name() || '—' }}</p>
          <p class="truncate font-sans text-body-sm text-slate">
            {{ email() }}
          </p>
        </div>
      </div>

      <!-- Rows -->
      <div class="flex flex-col gap-4">
        @for (row of rows; track row.title) {
          <button
            type="button"
            class="flex items-center gap-4 rounded-card border border-cloud bg-white p-5 text-left transition-colors hover:border-cerulean/50"
            (click)="go(row)"
          >
            <span
              class="flex size-11 shrink-0 items-center justify-center rounded-full"
              [class]="
                row.danger ? 'bg-alert/10 text-alert' : 'bg-frost text-cerulean'
              "
            >
              <sd-icon [name]="row.icon" [size]="20" />
            </span>
            <div class="flex min-w-0 flex-1 flex-col">
              <p
                class="font-sans text-body font-semibold"
                [class]="row.danger ? 'text-alert' : 'text-ink'"
              >
                {{ row.title }}
              </p>
              <p class="font-sans text-caption text-slate">
                {{ row.subtitle }}
              </p>
            </div>
            <sd-icon
              name="chevron-right"
              [size]="20"
              class="shrink-0 text-slate"
            />
          </button>
        }
      </div>
    </div>
  `,
})
export class Settings {
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly patient = inject(PatientApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly name = signal('');
  protected readonly email = signal('');
  protected readonly avatarPath = signal<string | null>(null);
  protected readonly avatarSrc = computed(() =>
    this.patient.assetUrl(this.avatarPath()),
  );
  protected readonly initials = computed(() =>
    this.name()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase(),
  );

  constructor() {
    this.patient
      .me()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.name.set(
            `${res.data.first_name} ${res.data.last_name}`.trim(),
          );
          this.email.set(res.data.email);
          this.avatarPath.set(res.data.avatar_url ?? null);
        },
        error: () => {
          /* leave the header blank on failure */
        },
      });
  }

  protected readonly rows: SettingRow[] = [
    {
      icon: 'lock',
      title: 'Change Password',
      subtitle: 'Update your account password',
      link: '/dashboard/settings/password',
    },
    {
      icon: 'bell',
      title: 'Notification Preferences',
      subtitle: 'Manage reminders and alerts',
      link: '/dashboard/settings/notifications',
    },
    {
      icon: 'shield-check',
      title: 'Privacy & Security',
      subtitle: 'Control your privacy and security settings',
      link: '/dashboard/settings/privacy',
    },
    {
      icon: 'circle-help',
      title: 'Help & Support',
      subtitle: 'Contact support & browse FAQs',
      link: '/dashboard/settings/help',
    },
    {
      icon: 'log-out',
      title: 'Logout',
      subtitle: 'Securely log out your account',
      danger: true,
      action: 'logout',
    },
  ];

  protected async go(row: SettingRow): Promise<void> {
    if (row.action === 'logout') {
      await this.auth.logout();
      await this.router.navigateByUrl('/auth/login');
      return;
    }
    if (row.link) await this.router.navigateByUrl(row.link);
  }
}
