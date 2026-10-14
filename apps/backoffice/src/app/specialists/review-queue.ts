import { inject, Injectable, signal } from '@angular/core';
import { StaffAuthService } from '@supadoc/auth';
import { SpecialistsApi } from '@supadoc/data-access';

/**
 * How many doctors have submitted their profile and wait for review — the
 * "Needs review" badge on the Specialists nav item. The shell refreshes it on
 * navigation; the Specialists page pushes its own count after loading and after
 * each decision, so the badge never lags behind what the reviewer just did.
 */
@Injectable({ providedIn: 'root' })
export class ReviewQueue {
  private readonly api = inject(SpecialistsApi);
  private readonly auth = inject(StaffAuthService);

  private readonly pending = signal(0);
  readonly count = this.pending.asReadonly();
  private inFlight = false;

  /** Re-read the count (only for reviewers — others never see the badge). */
  refresh(): void {
    if (this.inFlight || !this.auth.hasPermission('specialists.manage')) return;
    this.inFlight = true;
    this.api.reviewQueue().subscribe({
      next: (res) => {
        this.pending.set(Math.max(0, Number(res.data?.pending_review) || 0));
        this.inFlight = false;
      },
      // The badge is only a pointer; the Specialists page shows the real error.
      error: () => {
        this.inFlight = false;
      },
    });
  }

  set(count: number): void {
    this.pending.set(Math.max(0, count));
  }
}
