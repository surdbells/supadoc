import { effect, inject, Injectable, signal, untracked } from '@angular/core';
import type { Subscription } from 'rxjs';
import { StaffAuthService } from '@supadoc/auth';
import { StaffNotificationsApi } from '@supadoc/data-access';

/**
 * A count read still out after this long has stalled: the next refresh (a
 * poll, or the window regaining focus) gives it up and reads afresh, so one
 * hung request can't freeze the badge. Checked then rather than by a timer,
 * so no timer keeps the app from counting as stable while a read is out.
 */
export const UNREAD_READ_TIMEOUT_MS = 15_000;

/**
 * The signed-in staff user's unread notification count: the header bell's
 * badge. The bell polls it; the Notifications page adjusts it as items are
 * read, so the badge never lags behind what the user just did. Forgotten the
 * moment the session ends (however it ends), so the next sign-in never sees
 * the last user's count.
 */
@Injectable({ providedIn: 'root' })
export class UnreadNotifications {
  private readonly api = inject(StaffNotificationsApi);
  private readonly auth = inject(StaffAuthService);

  private readonly state = signal(0);
  /** How many notifications are unread (0 hides the badge). */
  readonly count = this.state.asReadonly();
  /** The read still out, and when it started. */
  private inFlight: { readonly since: number; sub?: Subscription } | null =
    null;

  constructor() {
    effect(() => {
      if (!this.auth.isAuthenticated()) untracked(() => this.clear());
    });
  }

  /**
   * Re-read the count (one read at a time; never when signed out). Always a
   * background read (`passive`): the bell's poll must not keep an unattended
   * session alive, and wherever the user is acting, their own requests count.
   */
  refresh(): void {
    if (!this.auth.isAuthenticated()) return;
    if (
      this.inFlight &&
      Date.now() - this.inFlight.since < UNREAD_READ_TIMEOUT_MS
    ) {
      return;
    }
    this.drop(); // a read still out by now has stalled
    const read: { readonly since: number; sub?: Subscription } = {
      since: Date.now(),
    };
    this.inFlight = read;
    const done = () => {
      if (this.inFlight === read) this.inFlight = null;
    };
    read.sub = this.api.unread({ passive: true }).subscribe({
      next: (res) => {
        this.state.set(Math.max(0, Math.floor(Number(res.data?.count)) || 0));
        done();
      },
      // The badge is only a pointer; the Notifications page shows the real error.
      error: done,
      complete: done,
    });
  }

  /** One notification was just read on this device. */
  markedRead(): void {
    this.drop();
    this.state.update((n) => Math.max(0, n - 1));
  }

  /** Every notification was just marked read. */
  markedAllRead(): void {
    this.drop();
    this.state.set(0);
  }

  /** Signed out: forget the count, and any read still out. */
  clear(): void {
    this.drop();
    this.state.set(0);
  }

  /** A read still out predates a local change (or has stalled): cancel it, so its answer never lands. */
  private drop(): void {
    this.inFlight?.sub?.unsubscribe();
    this.inFlight = null;
  }
}
