import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { apiErrorMessage, PatientApi } from '@supadoc/data-access';
import type { TwoFactorSetupDto } from '@supadoc/models';
import { IconComponent, ToggleComponent } from '@supadoc/ui';

type Modal = 'none' | 'setup' | 'codes' | 'disable';

/**
 * Settings › Privacy & Security (Figma 908:34552). Two-factor auth is a real TOTP
 * enrolment (setup → verify → recovery codes); biometrics persists to
 * /portal/me/settings.
 */
@Component({
  selector: 'pat-settings-privacy',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, FormsModule, IconComponent, ToggleComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <div class="flex items-start justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">Privacy &amp; Security</h1>
          <p class="font-sans text-body text-slate">Control how your account is protected and accessed.</p>
        </div>
        <a routerLink="/dashboard/settings" class="flex shrink-0 items-center gap-1 font-sans text-body text-slate transition-colors hover:text-cerulean">
          <sd-icon name="arrow-right" [size]="18" class="rotate-180" />
          Back
        </a>
      </div>

      @if (error()) {
        <p class="rounded-field bg-alert/10 px-4 py-3 font-label text-caption text-alert">{{ error() }}</p>
      }

      <div class="flex flex-col gap-4">
        @if (loading()) {
          @for (i of [1, 2]; track i) {
            <div class="h-[76px] animate-pulse rounded-card bg-cloud/70"></div>
          }
        } @else {
          <!-- Two-factor authentication -->
          <div class="flex items-center gap-4 rounded-card border border-cloud bg-white p-5">
            <span class="flex size-11 shrink-0 items-center justify-center rounded-full bg-frost/60 text-cerulean">
              <sd-icon name="lock" [size]="22" />
            </span>
            <div class="flex min-w-0 flex-1 flex-col">
              <p class="font-sans text-body font-semibold text-ink">Two-Factor Authentication</p>
              <p class="font-sans text-caption text-slate">
                @if (twoFaEnabled()) { On — you'll enter a code from your authenticator when signing in. }
                @else { Add an extra layer of security to sign-ins. }
              </p>
            </div>
            @if (twoFaEnabled()) {
              <span class="flex shrink-0 items-center gap-1 rounded-pill bg-sage/15 px-2.5 py-1 font-sans text-caption font-semibold text-sage">
                <sd-icon name="circle-check" [size]="14" />On
              </span>
              <button type="button" class="shrink-0 rounded-field border border-alert px-4 py-2 font-sans text-body-sm font-semibold text-alert transition-colors hover:bg-alert/5" (click)="openDisable()">Disable</button>
            } @else {
              <button type="button" class="shrink-0 rounded-field bg-cerulean px-4 py-2 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean" (click)="openSetup()">Enable</button>
            }
          </div>

          <!-- Biometrics (device preference) -->
          <div class="flex items-center gap-4 rounded-card border border-cloud bg-white p-5">
            <span class="flex size-11 shrink-0 items-center justify-center rounded-full bg-frost/60 text-cerulean">
              <sd-icon name="fingerprint" [size]="22" />
            </span>
            <div class="flex min-w-0 flex-1 flex-col">
              <p class="font-sans text-body font-semibold text-ink">Face ID / Biometrics</p>
              <p class="font-sans text-caption text-slate">Sign in faster on this device.</p>
            </div>
            @if (savingBiometrics()) {
              <span class="size-4 shrink-0 animate-spin rounded-full border-2 border-cloud border-t-cerulean"></span>
            }
            <sd-toggle [checked]="biometrics()" (checkedChange)="onBiometrics($event)" />
          </div>
        }

        @for (link of links; track link.title) {
          <a [routerLink]="link.route" class="flex items-center gap-4 rounded-card border border-cloud bg-white p-5 transition-colors hover:border-cerulean/50">
            <span class="flex size-11 shrink-0 items-center justify-center rounded-full bg-frost/60 text-cerulean">
              <sd-icon [name]="link.icon" [size]="22" />
            </span>
            <div class="flex min-w-0 flex-1 flex-col">
              <p class="font-sans text-body font-semibold text-ink">{{ link.title }}</p>
              <p class="font-sans text-caption text-slate">{{ link.desc }}</p>
            </div>
            <sd-icon name="chevron-right" [size]="20" class="shrink-0 text-slate" />
          </a>
        }
      </div>
    </div>

    <!-- Modals -->
    @if (modal() !== 'none') {
      <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <button type="button" class="absolute inset-0 cursor-default bg-abyss/40" aria-label="Close" (click)="closeModal()"></button>
        <div class="relative z-10 flex w-full max-w-md flex-col gap-5 rounded-[16px] border border-cloud bg-white p-6 shadow-[0_4px_24px_rgba(10,22,40,0.12)]">

          @switch (modal()) {
            @case ('setup') {
              <div class="flex items-center justify-between">
                <h3 class="font-heading text-h5 text-ink">Set up two-factor auth</h3>
                <button type="button" class="text-slate transition-colors hover:text-ink" aria-label="Close" (click)="closeModal()"><sd-icon name="x" [size]="24" /></button>
              </div>
              <ol class="flex list-decimal flex-col gap-2 pl-4 font-sans text-body-sm text-slate">
                <li>Open your authenticator app (Google Authenticator, Authy, 1Password…).</li>
                <li>Add an account and enter this setup key:</li>
              </ol>
              @if (setup(); as s) {
                <div class="flex items-center justify-between gap-2 rounded-field bg-glacier px-4 py-3">
                  <code class="select-all break-all font-mono text-body-sm font-semibold tracking-wider text-ink">{{ s.secret }}</code>
                  <button type="button" class="shrink-0 font-sans text-caption font-semibold text-cerulean hover:underline" (click)="copySecret(s.secret)">{{ copied() ? 'Copied' : 'Copy' }}</button>
                </div>
                <a [href]="s.otpauth_uri" class="font-sans text-caption font-semibold text-cerulean hover:underline">Open in an installed authenticator app</a>
              }
              <label class="flex flex-col gap-1.5">
                <span class="font-sans text-caption font-semibold text-slate">Enter the 6-digit code to confirm</span>
                <input inputmode="numeric" maxlength="6" [(ngModel)]="code" placeholder="123456" class="w-full rounded-field border border-cloud bg-white px-4 py-3 font-mono text-body tracking-widest text-ink focus:border-cerulean focus:outline-none" />
              </label>
              @if (modalError()) { <p class="font-sans text-caption text-alert">{{ modalError() }}</p> }
              <button type="button" class="rounded-field bg-cerulean px-5 py-3 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60" [disabled]="busy()" (click)="confirmEnable()">{{ busy() ? 'Verifying…' : 'Verify & enable' }}</button>
            }

            @case ('codes') {
              <div class="flex items-center justify-between">
                <h3 class="font-heading text-h5 text-ink">Save your recovery codes</h3>
              </div>
              <p class="font-sans text-body-sm text-slate">Store these somewhere safe. Each code can be used once to sign in if you lose your authenticator.</p>
              <ul class="grid grid-cols-2 gap-2 rounded-field bg-glacier p-4">
                @for (c of backupCodes(); track c) {
                  <li class="select-all text-center font-mono text-body-sm font-semibold tracking-wider text-ink">{{ c }}</li>
                }
              </ul>
              <button type="button" class="rounded-field border border-cloud px-5 py-2.5 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean" (click)="copyCodes()">{{ copied() ? 'Copied' : 'Copy codes' }}</button>
              <button type="button" class="rounded-field bg-cerulean px-5 py-3 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean" (click)="closeModal()">Done</button>
            }

            @case ('disable') {
              <div class="flex items-center justify-between">
                <h3 class="font-heading text-h5 text-ink">Disable two-factor auth</h3>
                <button type="button" class="text-slate transition-colors hover:text-ink" aria-label="Close" (click)="closeModal()"><sd-icon name="x" [size]="24" /></button>
              </div>
              <p class="font-sans text-body-sm text-slate">Enter your password to turn off two-factor authentication. Your account will be less protected.</p>
              <label class="flex flex-col gap-1.5">
                <span class="font-sans text-caption font-semibold text-slate">Password</span>
                <input type="password" autocomplete="current-password" [(ngModel)]="password" class="w-full rounded-field border border-cloud bg-white px-4 py-3 font-sans text-body-sm text-ink focus:border-cerulean focus:outline-none" />
              </label>
              @if (modalError()) { <p class="font-sans text-caption text-alert">{{ modalError() }}</p> }
              <button type="button" class="rounded-field bg-alert px-5 py-3 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-alert/90 disabled:opacity-60" [disabled]="busy()" (click)="confirmDisable()">{{ busy() ? 'Disabling…' : 'Disable 2FA' }}</button>
            }
          }
        </div>
      </div>
    }
  `,
})
export class SettingsPrivacy {
  private readonly patients = inject(PatientApi);

  protected readonly loading = signal(true);
  protected readonly error = signal('');

  protected readonly twoFaEnabled = signal(false);
  protected readonly biometrics = signal(false);
  protected readonly savingBiometrics = signal(false);

  // Modal state
  protected readonly modal = signal<Modal>('none');
  protected readonly setup = signal<TwoFactorSetupDto | null>(null);
  protected readonly backupCodes = signal<string[]>([]);
  protected readonly busy = signal(false);
  protected readonly modalError = signal('');
  protected readonly copied = signal(false);
  protected code = '';
  protected password = '';

  protected readonly links = [
    { icon: 'activity', title: 'Login Activity', desc: 'Recent account sign-ins', route: '/dashboard/settings/privacy/login-activity' },
    { icon: 'monitor-smartphone', title: 'Connected Devices', desc: 'Manage signed-in devices', route: '/dashboard/settings/privacy/devices' },
  ];

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      const [me, settings] = await Promise.all([
        firstValueFrom(this.patients.me()),
        firstValueFrom(this.patients.settings()),
      ]);
      this.twoFaEnabled.set(!!me.data.two_factor_enabled);
      this.biometrics.set(!!settings.data.privacy.biometrics);
    } catch {
      this.error.set("We couldn't load your security settings.");
    } finally {
      this.loading.set(false);
    }
  }

  // ----- Biometrics (device preference) -----
  protected async onBiometrics(checked: boolean): Promise<void> {
    this.error.set('');
    this.savingBiometrics.set(true);
    this.biometrics.set(checked);
    try {
      const res = await firstValueFrom(
        this.patients.updateSettings({ privacy: { biometrics: checked } }),
      );
      this.biometrics.set(res.data.privacy.biometrics);
    } catch (err) {
      this.biometrics.set(!checked);
      this.error.set(apiErrorMessage(err, 'Could not update that setting.'));
    } finally {
      this.savingBiometrics.set(false);
    }
  }

  // ----- 2FA setup -----
  protected async openSetup(): Promise<void> {
    this.resetModalState();
    this.modal.set('setup');
    this.busy.set(true);
    try {
      const res = await firstValueFrom(this.patients.setupTwoFactor());
      this.setup.set(res.data);
    } catch (err) {
      this.modalError.set(apiErrorMessage(err, 'Could not start setup.'));
    } finally {
      this.busy.set(false);
    }
  }

  protected async confirmEnable(): Promise<void> {
    const code = this.code.trim();
    if (code.length < 6) {
      this.modalError.set('Enter the 6-digit code from your app.');
      return;
    }
    this.busy.set(true);
    this.modalError.set('');
    try {
      const res = await firstValueFrom(this.patients.enableTwoFactor(code));
      this.backupCodes.set(res.data.backup_codes);
      this.twoFaEnabled.set(true);
      this.modal.set('codes');
    } catch (err) {
      this.modalError.set(apiErrorMessage(err, 'That code is incorrect. Try again.'));
    } finally {
      this.busy.set(false);
    }
  }

  // ----- 2FA disable -----
  protected openDisable(): void {
    this.resetModalState();
    this.modal.set('disable');
  }

  protected async confirmDisable(): Promise<void> {
    if (this.password.trim() === '') {
      this.modalError.set('Enter your password.');
      return;
    }
    this.busy.set(true);
    this.modalError.set('');
    try {
      await firstValueFrom(this.patients.disableTwoFactor(this.password));
      this.twoFaEnabled.set(false);
      this.closeModal();
    } catch (err) {
      this.modalError.set(apiErrorMessage(err, 'Could not disable 2FA.'));
    } finally {
      this.busy.set(false);
    }
  }

  protected closeModal(): void {
    this.modal.set('none');
    this.resetModalState();
  }

  private resetModalState(): void {
    this.setup.set(null);
    this.backupCodes.set([]);
    this.modalError.set('');
    this.copied.set(false);
    this.code = '';
    this.password = '';
  }

  protected copySecret(secret: string): void {
    void this.copy(secret);
  }
  protected copyCodes(): void {
    void this.copy(this.backupCodes().join('\n'));
  }
  private async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(true);
    } catch {
      /* clipboard unavailable — the value is selectable on screen */
    }
  }
}
