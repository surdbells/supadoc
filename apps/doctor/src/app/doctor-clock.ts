import { computed, DestroyRef, inject, Injectable, Injector, NgZone, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { StaffAuthService } from '@supadoc/auth';
import {
  CLINIC_TIME_ZONE,
  DoctorApi,
  dualTime,
  formatInZone,
  isValidTimeZone,
  nowHmInZone,
  timeLabel,
  todayInZone,
  viewerTimeZone,
  whenLabel,
  zoneAbbr,
  zoneLongName,
  type ZoneStyle,
} from '@supadoc/data-access';
import type { DoctorProfileDto, TimeZoneSource } from '@supadoc/models';

/** How often the abbreviation, "today" and "now" are re-read (a DST change, midnight). */
const TICK_MS = 60_000;

type Instant = string | number | Date;

/**
 * The doctor's clock: every time the doctor app shows or sends is on the
 * doctor's PROFILE time zone (`GET /doctor/profile` → `timezone`), never the
 * device's — weekly hours, availability, the schedule and emails all use it.
 *
 * - `zone()` is the profile zone once loaded; Africa/Lagos for a loaded profile
 *   without `timezone` (an older API's effective zone); the device's zone only
 *   while loading or after a failed load — for display only. Writes must use
 *   {@link profileZone} and never run without it (the API refuses a stale zone
 *   with 409 `timezone_changed`).
 * - The shell and the call page share one load ({@link ensureLoaded}); a
 *   different signed-in doctor loads afresh.
 */
@Injectable({ providedIn: 'root' })
export class DoctorClock {
  /** Dependencies are resolved when first needed, so any component (tests included) can read the clock. */
  private readonly injector = inject(Injector);

  private readonly statusState = signal<'loading' | 'ready' | 'failed'>('loading');
  private readonly profileZoneState = signal<string | null>(null);
  private readonly sourceState = signal<TimeZoneSource | null>(null);
  private readonly supportedState = signal(false);
  private readonly profileState = signal<DoctorProfileDto | null>(null);
  /** Re-read each minute: the abbreviation flips at a DST change, "today" at midnight. */
  private readonly tick = signal(Date.now());

  /** The profile load: `loading` until the first answer, then `ready` or `failed`. */
  readonly status = this.statusState.asReadonly();
  /** The zone the API holds for this doctor (null until loaded, or from an older API without one). */
  readonly profileZone = this.profileZoneState.asReadonly();
  /** `auto` (detected), `manual` (chosen) or null (never set). */
  readonly source = this.sourceState.asReadonly();
  /** The API sends a zone at all (an older one doesn't: nothing can be changed then). */
  readonly supported = this.supportedState.asReadonly();
  /** The last loaded profile (the shell's header reads its specialty and photo). */
  readonly profile = this.profileState.asReadonly();

  /**
   * The zone to show times in: the profile's once loaded (the clinic zone for
   * a profile without one); the device's while loading or after a failure —
   * display only, never sent in a write.
   */
  readonly zone = computed(() => {
    if (this.statusState() !== 'ready') return viewerTimeZone();
    return this.profileZoneState() ?? CLINIC_TIME_ZONE;
  });
  /** "CST", "WAT", "GMT+4" — now. */
  readonly abbr = computed(() => zoneAbbr(this.zone(), this.tick()));
  /** "Central Time", "West Africa Time". */
  readonly longName = computed(() => zoneLongName(this.zone(), new Date(this.tick())));

  private loading: Promise<void> | null = null;
  private loadedFor: string | null | undefined = undefined;

  constructor() {
    // Outside Angular's zone: a forever-ticking timer would keep the app from
    // ever being "stable" (tests' whenStable, hydration). A signal change still
    // schedules change detection.
    const timer = inject(NgZone).runOutsideAngular(() => setInterval(() => this.tick.set(Date.now()), TICK_MS));
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  /**
   * Loads the profile once per signed-in doctor (the shell and the call page
   * share it). Resolves on failure too, with `status()` `failed`. Without a
   * portal session nothing is fetched (a call opened from an emailed link).
   */
  ensureLoaded(): Promise<void> {
    const sub = this.subject();
    if (this.loading && this.loadedFor === sub) return this.loading;
    return this.start(sub);
  }

  /** Runs the load again (after a failure, or to pick up a profile change). */
  retry(): Promise<void> {
    return this.start(this.subject());
  }

  private subject(): string | null {
    try {
      return this.injector.get(StaffAuthService).subject() ?? null;
    } catch {
      return null;
    }
  }

  private signedIn(): boolean {
    try {
      return this.injector.get(StaffAuthService).isAuthenticated();
    } catch {
      return true; // an auth without the flag: let the request decide
    }
  }

  private start(sub: string | null): Promise<void> {
    this.loadedFor = sub;
    const run = this.load(sub);
    this.loading = run;
    return run;
  }

  private async load(sub: string | null): Promise<void> {
    if (this.statusState() !== 'ready' || this.profileState() === null) this.statusState.set('loading');
    if (!this.signedIn()) {
      this.statusState.set('failed');
      return;
    }
    try {
      const res = await firstValueFrom(this.injector.get(DoctorApi).getProfile());
      // Another doctor signed in on this machine meanwhile: theirs loads instead.
      if (this.subject() !== sub) return;
      const p = res.data;
      this.profileState.set(p);
      this.supportedState.set(typeof p.timezone === 'string');
      this.profileZoneState.set(isValidTimeZone(p.timezone) ? p.timezone : null);
      this.sourceState.set(p.timezone_source ?? null);
      this.statusState.set('ready');
    } catch {
      if (this.subject() !== sub) return;
      // A failed refresh keeps a zone already loaded.
      if (this.statusState() !== 'ready') this.statusState.set('failed');
    }
  }

  /**
   * Take a zone the API just reported (a save, a sync, a 409
   * `timezone_changed`). The source is kept when the answer has none.
   */
  apply(state: { timezone: string; timezone_source?: TimeZoneSource | null }): void {
    if (!isValidTimeZone(state.timezone)) return;
    this.profileZoneState.set(state.timezone);
    this.supportedState.set(true);
    if (state.timezone_source !== undefined) this.sourceState.set(state.timezone_source);
    this.profileState.update((p) =>
      p
        ? {
            ...p,
            timezone: state.timezone,
            ...(state.timezone_source !== undefined ? { timezone_source: state.timezone_source } : {}),
          }
        : p,
    );
    this.statusState.set('ready');
  }

  // ----- Labels on the doctor's clock -----

  /** Any {@link ZoneStyle} on the doctor's clock ('' for a missing or bad instant). */
  format(at: Instant | null | undefined, style: ZoneStyle): string {
    return at === null || at === undefined || at === '' ? '' : formatInZone(at, this.zone(), style);
  }
  /** "9:00 AM". */
  time(at: Instant | null | undefined): string {
    return this.format(at, 'time');
  }
  /** "9:00 AM CST". */
  timeTz(at: Instant | null | undefined): string {
    return at === null || at === undefined || at === '' ? '' : timeLabel(at, this.zone());
  }
  /** "Wed 4 Nov 2026". */
  date(at: Instant | null | undefined): string {
    return this.format(at, 'date');
  }
  /** "4 Nov 2026" (no weekday). */
  shortDate(at: Instant | null | undefined): string {
    return this.date(at).replace(/^[A-Z][a-z]{2} /, '');
  }
  /** "Wed 4 Nov, 9:00 AM". */
  dayTime(at: Instant | null | undefined): string {
    return this.format(at, 'dayTime');
  }
  /** "Wed 4 Nov 2026, 9:00 AM". */
  dateTime(at: Instant | null | undefined): string {
    return this.format(at, 'dateTime');
  }
  /** "Wed 4 Nov, 9:00 AM CST". */
  when(at: Instant | null | undefined): string {
    return at === null || at === undefined || at === '' ? '' : whenLabel(at, this.zone());
  }
  /** The calendar day on the doctor's clock, 'YYYY-MM-DD'. */
  ymd(at: Instant | null | undefined): string {
    return this.format(at, 'ymd');
  }
  /** Today on the doctor's calendar, 'YYYY-MM-DD'. */
  today(): string {
    return todayInZone(this.zone(), new Date(Math.max(this.tick(), Date.now())));
  }
  /** Now on the doctor's clock, "HH:MM". */
  nowHm(): string {
    return nowHmInZone(this.zone(), new Date(Math.max(this.tick(), Date.now())));
  }
  /**
   * The patient's time ("4:00 PM WAT" for 9:00 AM CST, with the weekday when
   * their date differs) when their UTC offset differs at that instant; null
   * when it doesn't, or the patient's zone isn't known.
   */
  patientTime(at: Instant | null | undefined, patientTz: string | null | undefined): string | null {
    if (at === null || at === undefined || at === '' || !patientTz) return null;
    return dualTime(at, this.zone(), patientTz).secondary;
  }
}
