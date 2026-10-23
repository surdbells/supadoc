import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { StaffAuthService } from '@supadoc/auth';
import { AdminDoctorApplicationsApi } from '@supadoc/data-access';
import type { DoctorApplicationQueueDto } from '@supadoc/models';

/**
 * What waits for a reviewer among doctor applications — the badge on the
 * Applications nav item counts the ones that need action (new, answered, or an
 * interview that has passed); the list's filter chips show the per-status
 * counts. The shell refreshes it on navigation; the application screens
 * refresh it after each decision, so the badge never lags behind what the
 * reviewer just did. The API never caches it. Forgotten the moment the session
 * ends (however it ends), so the next sign-in never sees the last reviewer's
 * counts. (A copy of the Specialists `ReviewQueue`.)
 */
@Injectable({ providedIn: 'root' })
export class ApplicationsQueue {
  private readonly api = inject(AdminDoctorApplicationsApi);
  private readonly auth = inject(StaffAuthService);

  private readonly state = signal<DoctorApplicationQueueDto | null>(null);
  /** The latest counts (null until first loaded). */
  readonly counts = this.state.asReadonly();
  /** The badge: applications that need a reviewer's action. */
  readonly count = computed(() => Math.max(0, Number(this.state()?.needs_action) || 0));
  private inFlight = false;
  private again = false;
  /** Bumped on sign-out: a read that started before it is dropped. */
  private epoch = 0;

  constructor() {
    effect(() => {
      if (!this.auth.isAuthenticated()) untracked(() => this.clear());
    });
  }

  /** Re-read the counts (only for reviewers — others never see the badge). */
  refresh(): void {
    if (!this.auth.isAuthenticated() || !this.auth.hasPermission('specialists.manage')) return;
    if (this.inFlight) {
      // A decision landed while a read was out: read once more afterwards.
      this.again = true;
      return;
    }
    this.inFlight = true;
    const epoch = this.epoch;
    this.api.queue().subscribe({
      next: (res) => {
        if (epoch !== this.epoch) return;
        this.state.set(res.data ?? null);
        this.done();
      },
      // The badge is only a pointer; the Applications page shows the real error.
      error: () => {
        if (epoch === this.epoch) this.done();
      },
    });
  }

  /** Signed out: forget the counts, and any read still out. */
  clear(): void {
    this.epoch++;
    this.inFlight = false;
    this.again = false;
    this.state.set(null);
  }

  private done(): void {
    this.inFlight = false;
    if (this.again) {
      this.again = false;
      this.refresh();
    }
  }
}
