import { apiErrorMessage } from '@supadoc/data-access';
import type { ConfirmOptions, DialogService } from '@supadoc/ui';

/**
 * The patient app's one "Log out?" question — the sidebar, the Settings row
 * and "Sign out of this device" ask it the same way. Resolves true to sign out.
 */
export async function askSignOut(dialogs: DialogService, options: Partial<ConfirmOptions> = {}): Promise<boolean> {
  const { confirmed } = await dialogs.confirm({
    tone: 'warning',
    icon: 'log-out',
    title: 'Log out?',
    message: "You'll need to sign in again to access your dashboard.",
    confirmLabel: 'Log out',
    cancelLabel: 'Stay signed in',
    ...options,
  });
  return confirmed;
}

/**
 * "Sign out {device}?" before another session or remembered device is signed
 * out; `action` does it (the dialog shows its progress and any failure).
 */
export async function askSignOutDevice(
  dialogs: DialogService,
  device: string,
  action: () => Promise<unknown>,
  failure: string,
): Promise<boolean> {
  const name = device.trim() || 'this device';
  const { confirmed } = await dialogs.confirm({
    tone: 'warning',
    icon: 'log-out',
    title: `Sign out ${name}?`,
    message: 'It will need your password to get back in.',
    confirmLabel: 'Sign out',
    cancelLabel: 'Keep signed in',
    busyLabel: 'Signing out…',
    action,
    errorMessage: (err) => apiErrorMessage(err, failure),
  });
  return confirmed;
}
