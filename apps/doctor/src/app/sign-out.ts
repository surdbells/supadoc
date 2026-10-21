import { inject, Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { StaffAuthService } from '@supadoc/auth';
import { DialogService } from '@supadoc/ui';
import { NoteDraftStore } from './appointment/note-draft';
import { DoctorStandingStore } from './standing/doctor-standing.store';

/**
 * The doctor portal's sign-out — one prompt wherever it is offered (the
 * shell's menu, Settings): asks first, then signs out, forgets the account's
 * standing and goes to the sign-in page. It says so when consultation notes
 * written while a session had ended are still only on this device.
 *
 * Usage: `protected readonly signOut = inject(DoctorSignOut);` then
 * `(click)="signOut.ask()"`.
 */
@Injectable({ providedIn: 'root' })
export class DoctorSignOut {
  private readonly auth = inject(StaffAuthService);
  private readonly dialogs = inject(DialogService);
  private readonly router = inject(Router);
  private readonly standing = inject(DoctorStandingStore);
  private readonly drafts = inject(NoteDraftStore);

  /** "Sign out?" — resolves true once signed out, false when the doctor stayed. */
  async ask(): Promise<boolean> {
    const unsynced = this.drafts.pendingCount(this.auth.subject());
    const { confirmed } = await this.dialogs.confirm({
      tone: 'warning',
      icon: 'log-out',
      title: 'Sign out?',
      message:
        unsynced > 0
          ? `${unsynced === 1 ? 'A consultation note is' : `${unsynced} consultation notes are`} still saved only on this device. ` +
            "They stay here, and are saved to the record when you open the consultation again after signing in on this device. You'll need to sign in again to see your consultations and patients."
          : "You'll need to sign in again to see your consultations and patients.",
      confirmLabel: 'Sign out',
      cancelLabel: 'Stay signed in',
    });
    if (!confirmed) return false;
    this.auth.logout();
    this.standing.clear();
    void this.router.navigateByUrl('/auth/login');
    return true;
  }
}
