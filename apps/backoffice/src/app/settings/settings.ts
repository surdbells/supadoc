import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { StaffAuthService } from '@supadoc/auth';
import { apiErrorMessage } from '@supadoc/data-access';
import { IconComponent } from '@supadoc/ui';

const FIELD =
  'w-full rounded-field border border-cloud bg-white px-4 py-3 font-sans text-body-sm text-ink placeholder:text-slate/50 focus:border-cerulean focus:outline-none focus:ring-2 focus:ring-cerulean/20';

/** Back-office account settings (route `/settings`) — profile + password. */
@Component({
  selector: 'bo-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <header class="flex flex-col gap-1">
        <h1 class="font-heading text-h3 text-ink">Settings</h1>
        <p class="font-sans text-body text-slate">Your account and password.</p>
      </header>

      <section class="flex items-center gap-4 rounded-card border border-cloud bg-white p-6">
        <span class="flex size-16 shrink-0 items-center justify-center rounded-full bg-ink/10 font-heading text-h5 font-semibold text-ink">
          {{ initials() || 'AD' }}
        </span>
        <div class="flex min-w-0 flex-col gap-1">
          <p class="font-heading text-h5 text-ink">{{ name() || 'Staff' }}</p>
          <p class="truncate font-sans text-body-sm text-slate">{{ email() }}</p>
          <p class="font-sans text-caption text-slate capitalize">{{ roles() || '—' }}</p>
        </div>
      </section>

      <section class="flex flex-col gap-3 rounded-card border border-cloud bg-white p-6">
        <h2 class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean">
          <sd-icon name="shield-check" [size]="20" />Permissions
        </h2>
        @if (permissions().length > 0) {
          <div class="flex flex-wrap gap-2">
            @for (p of permissions(); track p) {
              <span class="rounded-pill bg-frost px-3 py-1 font-mono text-caption text-cerulean">{{ p }}</span>
            }
          </div>
        } @else {
          <p class="font-sans text-body-sm text-slate">No specific permissions{{ isSuperAdmin() ? ' — super admin has full access.' : '.' }}</p>
        }
      </section>

      <!-- Change password -->
      <section class="flex max-w-md flex-col gap-4 rounded-card border border-cloud bg-white p-6">
        <h2 class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean">
          <sd-icon name="lock" [size]="20" />Change password
        </h2>
        <label class="flex flex-col gap-1.5">
          <span class="font-sans text-caption font-semibold text-slate">Current password</span>
          <input type="password" autocomplete="current-password" class="${FIELD}" [value]="currentPw()" (input)="currentPw.set($any($event.target).value)" />
        </label>
        <label class="flex flex-col gap-1.5">
          <span class="font-sans text-caption font-semibold text-slate">New password</span>
          <input type="password" autocomplete="new-password" class="${FIELD}" [value]="newPw()" (input)="newPw.set($any($event.target).value)" placeholder="At least 8 characters" />
        </label>
        <label class="flex flex-col gap-1.5">
          <span class="font-sans text-caption font-semibold text-slate">Confirm new password</span>
          <input type="password" autocomplete="new-password" class="${FIELD}" [value]="confirmPw()" (input)="confirmPw.set($any($event.target).value)" />
        </label>
        @if (notice()) {
          <p class="rounded-field px-4 py-2 font-label text-caption" [class]="ok() ? 'bg-sage/10 text-sage' : 'bg-alert/10 text-alert'">{{ notice() }}</p>
        }
        <button type="button" class="flex w-fit items-center gap-2 rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60" [disabled]="saving()" (click)="changePassword()">
          {{ saving() ? 'Updating…' : 'Update password' }}
        </button>
      </section>
    </div>
  `,
})
export class AdminSettings {
  private readonly auth = inject(StaffAuthService);

  protected readonly name = computed(() => this.auth.displayName());
  protected readonly email = computed(() => this.auth.user()?.email ?? '');
  protected readonly roles = computed(() => this.auth.roles().join(', '));
  protected readonly permissions = computed(() => this.auth.permissions());
  protected readonly isSuperAdmin = computed(() => this.auth.hasRole('super_admin'));
  protected readonly initials = computed(() =>
    this.auth
      .displayName()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase(),
  );

  protected readonly currentPw = signal('');
  protected readonly newPw = signal('');
  protected readonly confirmPw = signal('');
  protected readonly saving = signal(false);
  protected readonly notice = signal('');
  protected readonly ok = signal(false);

  protected async changePassword(): Promise<void> {
    this.notice.set('');
    if (this.newPw().length < 8) {
      this.ok.set(false);
      this.notice.set('New password must be at least 8 characters.');
      return;
    }
    if (this.newPw() !== this.confirmPw()) {
      this.ok.set(false);
      this.notice.set('New passwords do not match.');
      return;
    }
    this.saving.set(true);
    try {
      await this.auth.changePassword(this.currentPw(), this.newPw());
      this.ok.set(true);
      this.notice.set('Password updated.');
      this.currentPw.set('');
      this.newPw.set('');
      this.confirmPw.set('');
    } catch (err) {
      this.ok.set(false);
      this.notice.set(apiErrorMessage(err, 'Could not update your password.'));
    } finally {
      this.saving.set(false);
    }
  }
}
