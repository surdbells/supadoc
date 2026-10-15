import { inject, Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { StaffAuthService } from '@supadoc/auth';
import { DialogService } from '@supadoc/ui';
import { DoctorStandingStore } from './standing/doctor-standing.store';

/**
 * The doctor portal's sign-out — one prompt wherever it is offered (the
 * shell's menu, Settings): asks first, then signs out, forgets the account's
 * standing and goes to the sign-in page.
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

  /** "Sign out?" — resolves true once signed out, false when the doctor stayed. */
  async ask(): Promise<boolean> {
    const { confirmed } = await this.dialogs.confirm({
      tone: 'warning',
      icon: 'log-out',
      title: 'Sign out?',
      message: "You'll need to sign in again to see your consultations and patients.",
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
