import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { StaffAuthService } from '@supadoc/auth';
import { SpecialistsApi } from '@supadoc/data-access';
import type { SpecialistReviewQueueDto } from '@supadoc/models';

/**
 * What waits for a reviewer — the badge on the Specialists nav item counts
 * profiles in review, change requests and documents to verify (`total`); the
 * list's filter chips show the other counts (licences expiring / expired,
 * documents missing). The shell refreshes it on navigation; the specialist
 * screens refresh it after each decision, so the badge never lags behind what
 * the reviewer just did. Forgotten the moment the session ends (however it
 * ends), so the next sign-in never sees the last reviewer's counts.
 */
@Injectable({ providedIn: 'root' })
export class ReviewQueue {
  private readonly api = inject(SpecialistsApi);
  private readonly auth = inject(StaffAuthService);

  private readonly state = signal<SpecialistReviewQueueDto | null>(null);
  /** The latest counts (null until first loaded). */
  readonly counts = this.state.asReadonly();
  /** The badge: everything a reviewer has to act on. */
  readonly count = computed(() => Math.max(0, Number(this.state()?.total) || 0));
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
    this.api.reviewQueue().subscribe({
      next: (res) => {
        if (epoch !== this.epoch) return;
        this.state.set(res.data ?? null);
        this.done();
      },
      // The badge is only a pointer; the Specialists page shows the real error.
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
