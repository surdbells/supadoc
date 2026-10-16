import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import type { HasUnsavedChanges } from '@supadoc/auth';
import { StaffAuthService } from '@supadoc/auth';
import { apiErrorMessage } from '@supadoc/data-access';
import type { LeaveCopy } from '@supadoc/ui';
import { AlertComponent, IconComponent } from '@supadoc/ui';
import {
  BTN_PRIMARY,
  CHIP,
  FIELD,
  FIELD_STACK,
  LABEL,
  PAGE_HEADER_TEXT,
  PAGE_NARROW,
  PAGE_SUBTITLE,
  PAGE_TITLE,
  SECTION,
  SECTION_TITLE,
} from '../shared/layout';
import { BookingSettingsSection } from './booking-settings';

/**
 * Back-office settings (route `/settings`) — profile + password for everyone,
 * plus the platform's booking rules (calendar, closing past consultations,
 * no-show refunds, late cancellation) for `settings.manage`. Leaving with
 * unsaved booking-rule edits asks first.
 */
@Component({
  selector: 'bo-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, AlertComponent, BookingSettingsSection],
  host: { class: 'block' },
  template: `
    <div class="${PAGE_NARROW}">
      <header class="${PAGE_HEADER_TEXT}">
        <h1 class="${PAGE_TITLE}">Settings</h1>
        <p class="${PAGE_SUBTITLE}">{{ canManageSettings() ? 'Your account and password, and the booking rules.' : 'Your account and password.' }}</p>
      </header>

      <section class="${SECTION} !flex-row items-center !gap-4">
        <span class="flex size-16 shrink-0 items-center justify-center rounded-full bg-ink/10 font-heading text-h5 font-semibold text-ink ring-2 ring-white shadow-control" aria-hidden="true">
          {{ initials() || 'AD' }}
        </span>
        <div class="flex min-w-0 flex-col gap-1">
          <p class="font-heading text-h4 text-ink">{{ name() || 'Staff' }}</p>
          <p class="truncate font-sans text-body-sm text-slate">{{ email() }}</p>
          <p class="font-sans text-caption text-slate capitalize">{{ roles() || '—' }}</p>
        </div>
      </section>

      <section class="${SECTION} !gap-4">
        <h2 class="${SECTION_TITLE}">
          <sd-icon name="shield-check" [size]="20" class="text-cerulean" />Permissions
        </h2>
        @if (permissions().length > 0) {
          <div class="flex flex-wrap gap-2">
            @for (p of permissions(); track p) {
              <span class="${CHIP} bg-frost font-mono text-cerulean-dark">{{ p }}</span>
            }
          </div>
        } @else {
          <p class="font-sans text-body-sm text-slate">No specific permissions{{ isSuperAdmin() ? ' — super admin has full access.' : '.' }}</p>
        }
      </section>

      <!-- Change password -->
      <section class="${SECTION}">
        <h2 class="${SECTION_TITLE}">
          <sd-icon name="lock" [size]="20" class="text-cerulean" />Change password
        </h2>
        <div class="flex max-w-md flex-col gap-4">
        <label class="${FIELD_STACK}">
          <span class="${LABEL}">Current password</span>
          <input type="password" autocomplete="current-password" class="${FIELD}" [value]="currentPw()" (input)="currentPw.set($any($event.target).value)" />
        </label>
        <label class="${FIELD_STACK}">
          <span class="${LABEL}">New password</span>
          <input type="password" autocomplete="new-password" class="${FIELD}" [value]="newPw()" (input)="newPw.set($any($event.target).value)" placeholder="At least 8 characters" />
        </label>
        <label class="${FIELD_STACK}">
          <span class="${LABEL}">Confirm new password</span>
          <input type="password" autocomplete="new-password" class="${FIELD}" [value]="confirmPw()" (input)="confirmPw.set($any($event.target).value)" />
        </label>
        @if (notice()) {
          <sd-alert [tone]="ok() ? 'success' : 'error'">{{ notice() }}</sd-alert>
        }
        <button type="button" class="${BTN_PRIMARY} w-fit" [disabled]="saving()" (click)="changePassword()">
          <sd-icon [name]="saving() ? 'loader-circle' : 'lock'" [size]="18" [class.animate-spin]="saving()" />{{ saving() ? 'Updating…' : 'Update password' }}
        </button>
        </div>
      </section>

      @if (canManageSettings()) {
        <bo-booking-settings />
      }
    </div>
  `,
})
export class AdminSettings implements HasUnsavedChanges {
  private readonly auth = inject(StaffAuthService);
  private readonly booking = viewChild(BookingSettingsSection);

  /** For the route's unsavedChangesGuard. */
  hasUnsavedChanges(): boolean {
    return this.booking()?.hasUnsavedChanges() ?? false;
  }
  readonly leaveCopy: LeaveCopy = {
    title: 'Leave without saving the booking rules?',
    message: "Your changes to the booking rules haven't been saved. If you leave now, they'll be lost.",
  };

  protected readonly name = computed(() => this.auth.displayName());
  protected readonly email = computed(() => this.auth.user()?.email ?? '');
  protected readonly roles = computed(() => this.auth.roles().join(', '));
  protected readonly permissions = computed(() => this.auth.permissions());
  protected readonly isSuperAdmin = computed(() => this.auth.hasRole('super_admin'));
  protected readonly canManageSettings = computed(() => this.auth.hasPermission('settings.manage'));
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
