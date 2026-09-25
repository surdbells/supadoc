import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { StaffAuthService } from '@supadoc/auth';
import { apiErrorMessage } from '@supadoc/data-access';
import { ButtonComponent, IconComponent } from '@supadoc/ui';

const FIELD =
  'w-full rounded-field border border-[#b8c6d4] bg-white px-4 py-3 font-sans text-body-sm text-ink placeholder:text-slate/50 focus:border-cerulean focus:outline-none focus:ring-2 focus:ring-cerulean/20';

/** Doctor account settings (route `/settings`) — security + session. */
@Component({
  selector: 'doc-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex max-w-2xl flex-col gap-6 py-2">
      <header class="flex flex-col gap-1">
        <h1 class="font-heading text-h3 text-ink">Settings</h1>
        <p class="font-sans text-body text-slate">Manage your account security and session.</p>
      </header>

      <section class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6">
        <h2 class="flex items-center gap-2 font-heading text-body-lg text-ink">
          <sd-icon name="lock" [size]="20" class="text-cerulean" />Change password
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
        <sd-button class="w-fit" [disabled]="saving()" (click)="changePassword()">
          {{ saving() ? 'Updating…' : 'Update password' }}
        </sd-button>
      </section>

      <section class="flex items-center justify-between gap-4 rounded-card border border-cloud bg-white p-6">
        <div class="flex flex-col">
          <p class="font-heading text-body-lg text-ink">Sign out</p>
          <p class="font-sans text-body-sm text-slate">End your session on this device.</p>
        </div>
        <sd-button variant="outline" (click)="logout()">
          <sd-icon name="log-out" [size]="18" />Log Out
        </sd-button>
      </section>
    </div>
  `,
})
export class DoctorSettings {
  private readonly auth = inject(StaffAuthService);
  private readonly router = inject(Router);

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

  protected logout(): void {
    this.auth.logout();
    void this.router.navigateByUrl('/auth/login');
  }
}
