import { computed, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { DoctorApi } from '@supadoc/data-access';
import type { DoctorOnboardingDto, DoctorStandingCode, DoctorStandingDto } from '@supadoc/models';
import { isBlockingStanding } from './standing-rules';

/** How long a loaded onboarding payload counts as fresh for the guard. */
const FRESH_MS = 60_000;

/**
 * The signed-in doctor's account standing, app-wide: their onboarding payload
 * (status, checklist, documents, terms, licence, suspension) and whether they
 * may do clinical work now. The route guard, the 403 interceptor, the shell's
 * terms banner, the dashboard and the onboarding pages all read it; a page
 * that loads the payload itself hands it over with `set()`.
 */
@Injectable({ providedIn: 'root' })
export class DoctorStandingStore {
  private readonly api = inject(DoctorApi);

  /** GET /api/doctor/onboarding, once loaded (null before, or when it couldn't be read). */
  readonly onboarding = signal<DoctorOnboardingDto | null>(null);
  /** A refusal a request just met, shown until the payload catches up. */
  private readonly refused = signal<DoctorStandingDto | null>(null);

  /** Why the doctor may not do clinical work now, or null when they may. */
  readonly standing = computed<DoctorStandingDto | null>(() => this.refused() ?? this.onboarding()?.standing ?? null);
  readonly code = computed<DoctorStandingCode | null>(() => this.standing()?.code ?? null);
  /** Suspended, or not approved yet: clinical pages are closed. */
  readonly blocked = computed(() => isBlockingStanding(this.code()));

  private loadedAt = 0;
  /** Bumped by a noted refusal and by clear(): a read that started before it is stale. */
  private epoch = 0;
  private inflight: Promise<DoctorOnboardingDto | null> | null = null;
  /** A forced read waiting for the one in flight (see load). */
  private queued: Promise<DoctorOnboardingDto | null> | null = null;

  /**
   * The payload — a copy under a minute old unless `force`. Never rejects:
   * resolves to what is known (null when it can't be read; the API still
   * enforces everything). A forced load always reads afresh — after a read
   * already in flight, which began before whatever made it forced — and
   * resolves to null, never an older copy, when that read fails.
   */
  load(force = false): Promise<DoctorOnboardingDto | null> {
    const known = this.onboarding();
    if (!force && known && Date.now() - this.loadedAt < FRESH_MS) return Promise.resolve(known);
    if (!this.inflight) return this.read(force);
    if (!force) return this.inflight;
    if (!this.queued) {
      const queued: Promise<DoctorOnboardingDto | null> = this.inflight.then(() => {
        if (this.queued !== queued) return this.onboarding(); // cleared meanwhile
        this.queued = null;
        return this.read(true);
      });
      this.queued = queued;
    }
    return this.queued;
  }

  private read(force: boolean): Promise<DoctorOnboardingDto | null> {
    const epoch = this.epoch;
    const req: Promise<DoctorOnboardingDto | null> = firstValueFrom(this.api.onboarding())
      .then((res) => {
        // Started before a refusal was noted (or a sign-out): what is known now stands.
        if (epoch !== this.epoch) return this.onboarding();
        this.set(res.data);
        return res.data;
      })
      .catch(() => (force ? null : this.onboarding()))
      .finally(() => {
        if (this.inflight === req) this.inflight = null;
      });
    this.inflight = req;
    return req;
  }

  /** A fresh payload from a page that loaded (or changed) it. */
  set(data: DoctorOnboardingDto): void {
    this.onboarding.set(data);
    this.refused.set(null);
    this.loadedAt = Date.now();
  }

  /** A request was refused for this standing (403): say so at once, then re-read the payload. */
  noteRefusal(code: DoctorStandingCode, message: string): void {
    if (this.code() === code) return;
    this.epoch++;
    this.refused.set({ code, message });
    void this.load(true);
  }

  /** Signed out (or a new sign-in): forget the doctor, and any read still in flight. */
  clear(): void {
    this.epoch++;
    this.inflight = null;
    this.queued = null;
    this.onboarding.set(null);
    this.refused.set(null);
    this.loadedAt = 0;
  }
}
