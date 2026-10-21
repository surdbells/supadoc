import { ChangeDetectionStrategy, Component, computed, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { apiErrorMessage, PatientApi } from '@supadoc/data-access';
import type { TwoFactorSetupDto } from '@supadoc/models';
import { DialogComponent, IconComponent, ToggleComponent } from '@supadoc/ui';

type Modal = 'none' | 'setup' | 'codes' | 'disable';

/**
 * Settings › Privacy & Security (Figma 908:34552). Two-factor auth is a real TOTP
 * enrolment (setup → verify → recovery codes); biometrics persists to
 * /portal/me/settings.
 */
@Component({
  selector: 'pat-settings-privacy',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, FormsModule, DialogComponent, IconComponent, ToggleComponent],
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
          <div class="flex items-center gap-4 rounded-card border border-haze bg-white p-5 shadow-card">
            <span class="flex size-11 shrink-0 items-center justify-center rounded-full bg-frost/60 text-cerulean-dark">
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
              <span class="flex shrink-0 items-center gap-1 rounded-pill bg-sage/15 px-2.5 py-1 font-sans text-caption font-semibold text-sage-ink">
                <sd-icon name="circle-check" [size]="14" />On
              </span>
              <button type="button" class="shrink-0 rounded-field border border-alert px-4 py-2 font-sans text-body-sm font-semibold text-alert transition-colors hover:bg-alert/5" (click)="openDisable()">Disable</button>
            } @else {
              <button type="button" class="shrink-0 rounded-field bg-cerulean px-4 py-2 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean" (click)="openSetup()">Enable</button>
            }
          </div>

          <!-- Biometrics (device preference) -->
          <div class="flex items-center gap-4 rounded-card border border-haze bg-white p-5 shadow-card">
            <span class="flex size-11 shrink-0 items-center justify-center rounded-full bg-frost/60 text-cerulean-dark">
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
          <a [routerLink]="link.route" class="flex items-center gap-4 rounded-card border border-haze bg-white p-5 shadow-card transition hover:border-cerulean/40 hover:shadow-card-hover">
            <span class="flex size-11 shrink-0 items-center justify-center rounded-full bg-frost/60 text-cerulean-dark">
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

    <!-- Two-factor dialogs (setup → recovery codes; turning it off) -->
    <sd-dialog
      #twoFaDialog
      [open]="modalShown()"
      [title]="modalTitle()"
      [subtitle]="modalSubtitle()"
      size="sm"
      [busy]="busy()"
      [dismissible]="modal() !== 'codes'"
      [dialogRole]="modal() === 'disable' ? 'alertdialog' : 'dialog'"
      (closed)="closeModal()"
      (afterClose)="afterModalClosed()"
    >
      @switch (modal()) {
        @case ('setup') {
          <form class="flex flex-col gap-5" (submit)="$event.preventDefault(); confirmEnable()">
            <ol class="flex list-decimal flex-col gap-2 pl-4 font-sans text-body-sm text-slate">
              <li>Open your authenticator app (Google Authenticator, Authy, 1Password…).</li>
              <li>Add an account and enter this setup key:</li>
            </ol>
            @if (setup(); as s) {
              <div class="flex items-center justify-between gap-2 rounded-field bg-glacier px-4 py-3">
                <code class="select-all break-all font-mono text-body-sm font-semibold tracking-wider text-ink">{{ s.secret }}</code>
                <button type="button" class="min-h-11 shrink-0 px-2 font-sans text-caption font-semibold text-cerulean hover:underline" (click)="copySecret(s.secret)">{{ copied() ? 'Copied' : 'Copy' }}</button>
              </div>
              <a [href]="s.otpauth_uri" class="font-sans text-caption font-semibold text-cerulean hover:underline">Open in an installed authenticator app</a>
            } @else if (busy()) {
              <div class="sd-shimmer h-12 rounded-field" aria-hidden="true"></div>
            }
            <label class="flex flex-col gap-1.5">
              <span class="font-sans text-caption font-semibold text-slate">Enter the 6-digit code to confirm</span>
              <input
                name="code"
                inputmode="numeric"
                autocomplete="one-time-code"
                maxlength="6"
                [(ngModel)]="code"
                placeholder="123456"
                [attr.aria-invalid]="!!modalError() || null"
                [attr.aria-describedby]="modalError() ? 'twofa-error' : null"
                class="w-full rounded-field border border-cloud bg-white px-4 py-3 font-mono text-body tracking-widest text-ink focus:border-cerulean focus:outline-none"
              />
            </label>
            @if (modalError()) {
              <p id="twofa-error" class="flex items-start gap-2 font-sans text-caption text-alert" role="alert">
                <sd-icon name="triangle-alert" [size]="16" class="mt-0.5 shrink-0" />{{ modalError() }}
              </p>
            }
            <button type="submit" class="min-h-11 rounded-field bg-cerulean px-5 py-3 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60" [disabled]="busy()">{{ busy() ? 'Verifying…' : 'Verify & enable' }}</button>
          </form>
        }

        @case ('codes') {
          <div class="flex flex-col gap-5">
            <p class="font-sans text-body-sm text-slate">Store these somewhere safe. Each code can be used once to sign in if you lose your authenticator. They won't be shown again.</p>
            <ul class="grid grid-cols-2 gap-2 rounded-field bg-glacier p-4" aria-label="Recovery codes">
              @for (c of backupCodes(); track c) {
                <li class="select-all text-center font-mono text-body-sm font-semibold tracking-wider text-ink">{{ c }}</li>
              }
            </ul>
            <button type="button" data-autofocus class="min-h-11 rounded-field border border-cloud px-5 py-2.5 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean" (click)="copyCodes()">{{ copied() ? 'Copied' : 'Copy codes' }}</button>
            <button type="button" class="min-h-11 rounded-field bg-cerulean px-5 py-3 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean" (click)="closeModal()">I've saved them</button>
          </div>
        }

        @case ('disable') {
          <form class="flex flex-col gap-5" (submit)="$event.preventDefault(); confirmDisable()">
            <p class="flex items-start gap-2 rounded-field bg-warning/10 px-4 py-3 font-sans text-body-sm text-ink">
              <sd-icon name="shield-off" [size]="18" class="mt-0.5 shrink-0 text-warning" />
              Your account will be less protected: anyone with your password could sign in.
            </p>
            <label class="flex flex-col gap-1.5">
              <span class="font-sans text-caption font-semibold text-slate">Password</span>
              <input
                name="password"
                type="password"
                autocomplete="current-password"
                [(ngModel)]="password"
                [attr.aria-invalid]="!!modalError() || null"
                [attr.aria-describedby]="modalError() ? 'twofa-error' : null"
                class="w-full rounded-field border border-cloud bg-white px-4 py-3 font-sans text-body-sm text-ink focus:border-cerulean focus:outline-none"
              />
            </label>
            @if (modalError()) {
              <p id="twofa-error" class="flex items-start gap-2 font-sans text-caption text-alert" role="alert">
                <sd-icon name="triangle-alert" [size]="16" class="mt-0.5 shrink-0" />{{ modalError() }}
              </p>
            }
            <div class="flex flex-col-reverse gap-3 sm:flex-row">
              <button type="button" class="min-h-11 flex-1 rounded-field border border-cloud px-5 py-3 font-sans text-body-sm font-semibold text-slate transition-colors hover:bg-glacier disabled:opacity-60" [disabled]="busy()" (click)="closeModal()">Keep it on</button>
              <button type="submit" class="min-h-11 flex-1 rounded-field bg-alert px-5 py-3 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-alert/90 disabled:opacity-60" [disabled]="busy()">{{ busy() ? 'Turning off…' : 'Turn off 2FA' }}</button>
            </div>
          </form>
        }
      }
    </sd-dialog>
  `,
})
export class SettingsPrivacy {
  private readonly patients = inject(PatientApi);

  protected readonly loading = signal(true);
  protected readonly error = signal('');

  protected readonly twoFaEnabled = signal(false);
  protected readonly biometrics = signal(false);
  protected readonly savingBiometrics = signal(false);

  // Modal state: which step shows (kept while the dialog animates out) and whether it is open.
  protected readonly modal = signal<Modal>('none');
  protected readonly modalShown = signal(false);
  private readonly twoFaDialog = viewChild<DialogComponent>('twoFaDialog');
  protected readonly modalTitle = computed(() => {
    switch (this.modal()) {
      case 'setup':
        return 'Set up two-factor auth';
      case 'codes':
        return 'Save your recovery codes';
      case 'disable':
        return 'Turn off two-factor auth?';
      default:
        return '';
    }
  });
  protected readonly modalSubtitle = computed(() =>
    this.modal() === 'disable' ? 'Enter your password to turn it off.' : '',
  );
  protected readonly setup = signal<TwoFactorSetupDto | null>(null);
  protected readonly backupCodes = signal<string[]>([]);
  protected readonly busy = signal(false);
  protected readonly modalError = signal('');
  protected readonly copied = signal(false);
  protected code = '';
  protected password = '';

  protected readonly links = [
    { icon: 'share-2', title: 'Document sharing', desc: 'Choose which doctors can see your documents', route: '/dashboard/documents/sharing' },
    { icon: 'activity', title: 'Login Activity', desc: 'Recent account sign-ins', route: '/dashboard/settings/privacy/login-activity' },
    { icon: 'monitor-smartphone', title: 'Connected Devices', desc: 'Manage signed-in devices', route: '/dashboard/settings/privacy/devices' },
  ];

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      const [me, settings] = await Promise.all([
        firstValueFrom(this.patients.me()),
        firstValueFrom(this.patients.settings()),
      ]);
      this.twoFaEnabled.set(!!me.data.two_factor_enabled);
      this.biometrics.set(!!settings.data.privacy.biometrics);
    } catch (err) {
      this.error.set(apiErrorMessage(err, "We couldn't load your security settings."));
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
    this.modalShown.set(true);
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
      this.twoFaDialog()?.refocus(); // the form (and its focused button) is gone
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
    this.modalShown.set(true);
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
      this.modalShown.set(false);
    } catch (err) {
      this.modalError.set(apiErrorMessage(err, 'Could not disable 2FA.'));
    } finally {
      this.busy.set(false);
    }
  }

  /** ×, Esc, the scrim, "Keep it on", "I've saved them" (never mid-request). */
  protected closeModal(): void {
    if (this.busy()) return;
    this.modalShown.set(false);
  }

  /** The dialog has gone: forget the secret, the codes and what was typed. */
  protected afterModalClosed(): void {
    if (this.modalShown()) return; // reopened meanwhile
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
