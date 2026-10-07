import {
  DestroyRef,
  effect,
  EnvironmentProviders,
  inject,
  Injectable,
  InjectionToken,
  Injector,
  makeEnvironmentProviders,
  NgZone,
  provideEnvironmentInitializer,
  signal,
  Type,
  untracked,
} from '@angular/core';
import { ActivatedRouteSnapshot, Router } from '@angular/router';
import { SESSION_AUTH, SessionAuth, SessionEndReason } from './session-auth';
import { peekSessionNotice } from './session-notice';

export interface SessionTimeoutConfig {
  /** Minutes without user activity before the session is ended. */
  idleMinutes: number;
  /** How long the "Are you still there?" warning counts down first. Default 60. */
  warningSeconds?: number;
  /** How often an active user's server session is touched. Default 4. */
  keepAliveMinutes?: number;
  /** Where to send the user once signed out. Default `/auth/login`. */
  loginUrl?: string;
  /**
   * How long before the absolute session lifetime runs out to warn that the
   * session is about to end (it cannot be extended). Default 5.
   */
  deadlineWarningMinutes?: number;
}

type ResolvedConfig = Required<SessionTimeoutConfig>;

export const SESSION_TIMEOUT_CONFIG = new InjectionToken<ResolvedConfig>(
  'SUPADOC_SESSION_TIMEOUT_CONFIG',
);

/** User input that counts as "still here". */
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;
/** Shared activity timestamp is written at most this often (ms). */
const PERSIST_EVERY = 5_000;

/**
 * Production idle-timeout + session-expiry watcher for a portal.
 *
 * - Tracks real user activity (pointer, keys, scroll, touch) and shares it
 *   across tabs through localStorage, so working in one tab keeps the others
 *   alive and signing out in one signs out all.
 * - Shows a countdown warning `warningSeconds` before the idle limit; only an
 *   explicit "Stay signed in" dismisses it (a stray mouse move does not).
 * - Ends the session at the idle limit, at the absolute lifetime (the refresh
 *   token's expiry), or when the server rejects it — revoking it server-side
 *   and sending the user to sign in with a notice saying why, then back to
 *   where they were.
 * - Survives a closed browser: on startup, a remembered session whose last
 *   activity is older than the idle limit is ended before any page loads.
 * - Pauses while something legitimately has no input (an active video call)
 *   via {@link hold}/{@link release}, and keeps the server session warm with a
 *   periodic keep-alive while the user is active, so the server-side idle
 *   window never closes under someone who is using the app.
 */
@Injectable({ providedIn: 'root' })
export class SessionTimeoutService {
  private readonly auth: SessionAuth = inject(SESSION_AUTH);
  private readonly config = inject(SESSION_TIMEOUT_CONFIG);
  private readonly router = inject(Router);
  private readonly zone = inject(NgZone);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);

  /** Whether the inactivity warning is showing. */
  readonly warning = signal(false);
  /** Seconds left on the warning countdown. */
  readonly secondsLeft = signal(0);
  /**
   * Epoch ms when the session hits its absolute lifetime, while that is close
   * enough to warn about (it cannot be extended — only signing in again helps).
   */
  readonly deadlineSoon = signal<number | null>(null);
  /** The user dismissed the deadline notice; don't show it again this session. */
  private deadlineNoticeDismissed = false;
  /** A sign-out happened during a call; leave the page once the call ends. */
  private pendingRedirect = false;

  private readonly holds = new Set<string>();
  private lastActivity = Date.now();
  private lastPersisted = 0;
  private lastKeepAlive = Date.now();
  private activeSinceKeepAlive = false;
  /** Auth state as last seen by the transition effect (the tick acts only on it). */
  private wasAuthed = false;
  private started = false;

  private get idleMs(): number {
    return this.config.idleMinutes * 60_000;
  }

  /** Begin watching. Called once at bootstrap by {@link provideSessionTimeout}. */
  start(): void {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;

    // A remembered session abandoned for longer than the idle limit (browser
    // closed, laptop asleep) ends before the first page renders.
    if (this.auth.isAuthenticated()) {
      const stored = this.readStoredActivity();
      const deadline = this.auth.sessionDeadline();
      if (deadline !== null && Date.now() >= deadline) {
        this.auth.expire('expired');
      } else if (stored !== null && Date.now() - stored >= this.idleMs) {
        this.auth.expire('idle');
      } else {
        this.lastActivity = stored ?? Date.now();
      }
    }

    effect(
      () => {
        const authed = this.auth.isAuthenticated();
        if (authed && !this.wasAuthed) this.onSignedIn();
        if (!authed && this.wasAuthed) this.onSignedOut();
        this.wasAuthed = authed;
      },
      { injector: this.injector },
    );

    this.zone.runOutsideAngular(() => {
      const onActivity = () => this.onActivity();
      const onVisible = () => {
        if (document.visibilityState === 'visible') this.tick();
      };
      for (const evt of ACTIVITY_EVENTS) {
        window.addEventListener(evt, onActivity, { passive: true, capture: true });
      }
      document.addEventListener('visibilitychange', onVisible);
      const timer = setInterval(() => this.tick(), 1_000);

      this.destroyRef.onDestroy(() => {
        for (const evt of ACTIVITY_EVENTS) {
          window.removeEventListener(evt, onActivity, { capture: true });
        }
        document.removeEventListener('visibilitychange', onVisible);
        clearInterval(timer);
      });
    });
  }

  /** "Stay signed in" — restart the idle clock everywhere and touch the server. */
  staySignedIn(): void {
    this.recordActivity(Date.now(), true);
    this.setWarning(false);
    this.lastKeepAlive = Date.now();
    this.activeSinceKeepAlive = false;
    void this.auth.keepAlive();
  }

  /** "Sign out" from the warning — a deliberate sign-out, no notice. */
  signOutNow(): void {
    this.setWarning(false);
    void this.auth.logout();
  }

  /**
   * Suspend the idle timer while `key` holds (e.g. `'call'` during a video
   * consultation, where nobody touches the keyboard for long stretches).
   */
  hold(key: string): void {
    this.holds.add(key);
    this.recordActivity(Date.now(), true);
    this.setWarning(false);
  }

  release(key: string): void {
    if (this.holds.delete(key)) this.recordActivity(Date.now(), true);
    // A sign-out that happened mid-call leaves the page only now.
    if (this.holds.size === 0 && this.pendingRedirect && !this.auth.isAuthenticated()) {
      this.pendingRedirect = false;
      this.leaveProtectedPage();
    }
  }

  /** Dismiss the "session ends soon" notice (it cannot be extended). */
  dismissDeadlineNotice(): void {
    this.deadlineNoticeDismissed = true;
    this.setDeadlineSoon(null);
  }

  // ----- internals -----

  private onSignedIn(): void {
    this.pendingRedirect = false;
    this.deadlineNoticeDismissed = false;
    this.setDeadlineSoon(null);
    this.recordActivity(Date.now(), true);
    this.lastKeepAlive = Date.now();
    this.activeSinceKeepAlive = false;
    this.setWarning(false);
  }

  /** Signed out (here, in another tab, or by the server): leave protected pages. */
  private onSignedOut(): void {
    this.setWarning(false);
    this.setDeadlineSoon(null);
    // A navigation already under way (e.g. "Log out" sending the user home)
    // decides where they land; the destination's own guard still applies.
    if (untracked(() => this.router.currentNavigation()) !== null) return;
    // Never tear down a live consultation: leave once the call is over.
    if (this.holds.size > 0) {
      this.pendingRedirect = true;
      return;
    }
    this.leaveProtectedPage();
  }

  private leaveProtectedPage(): void {
    if (!this.isOnProtectedRoute()) return;
    // Involuntary sign-outs leave a notice; return the user to this page after.
    if (peekSessionNotice()) this.auth.rememberRedirect(this.router.url);
    void this.router.navigateByUrl(this.config.loginUrl);
  }

  private onActivity(): void {
    // While the warning shows, only the explicit button keeps the session.
    if (!this.wasAuthed || this.warning()) return;
    this.recordActivity(Date.now());
  }

  private recordActivity(now: number, persistNow = false): void {
    this.lastActivity = now;
    this.activeSinceKeepAlive = true;
    if (persistNow || now - this.lastPersisted >= PERSIST_EVERY) {
      this.lastPersisted = now;
      try {
        localStorage.setItem(this.auth.activityKey, String(now));
      } catch {
        /* storage unavailable — this tab still tracks its own activity */
      }
    }
  }

  private tick(): void {
    if (!this.wasAuthed) return;
    const now = Date.now();

    const deadline = this.auth.sessionDeadline();
    if (deadline !== null && now >= deadline) {
      this.end('expired');
      return;
    }
    // Warn ahead of the absolute lifetime so nobody loses work to it.
    const lead = this.config.deadlineWarningMinutes * 60_000;
    const soon = deadline !== null && deadline - now <= lead && !this.deadlineNoticeDismissed ? deadline : null;
    if (soon !== this.deadlineSoon()) this.setDeadlineSoon(soon);

    if (this.holds.size > 0) this.recordActivity(now);

    // Activity in another tab counts too.
    const stored = this.readStoredActivity();
    if (stored !== null && stored > this.lastActivity) this.lastActivity = stored;

    const idle = now - this.lastActivity;
    const warnMs = this.config.warningSeconds * 1_000;
    if (idle >= this.idleMs) {
      this.end('idle');
      return;
    }
    if (idle >= this.idleMs - warnMs) {
      const left = Math.max(0, Math.ceil((this.idleMs - idle) / 1_000));
      if (!this.warning()) this.setWarning(true);
      if (this.secondsLeft() !== left) this.zone.run(() => this.secondsLeft.set(left));
    } else if (this.warning()) {
      this.setWarning(false);
    }

    if (this.activeSinceKeepAlive && now - this.lastKeepAlive >= this.config.keepAliveMinutes * 60_000) {
      this.lastKeepAlive = now;
      this.activeSinceKeepAlive = false;
      void this.auth.keepAlive();
    }
  }

  private end(reason: SessionEndReason): void {
    this.zone.run(() => {
      this.setWarning(false);
      this.auth.expire(reason);
    });
  }

  private setDeadlineSoon(at: number | null): void {
    if (this.deadlineSoon() === at) return;
    this.zone.run(() => this.deadlineSoon.set(at));
  }

  private setWarning(on: boolean): void {
    if (this.warning() === on) return;
    this.zone.run(() => this.warning.set(on));
  }

  private readStoredActivity(): number | null {
    try {
      const raw = localStorage.getItem(this.auth.activityKey);
      const at = raw === null ? NaN : Number(raw);
      return Number.isFinite(at) ? at : null;
    } catch {
      return null;
    }
  }

  /** Whether any route in the active branch is guarded (i.e. needs a session). */
  private isOnProtectedRoute(): boolean {
    let snap: ActivatedRouteSnapshot | null = this.router.routerState.snapshot.root;
    while (snap) {
      const cfg = snap.routeConfig;
      if (cfg?.canActivate?.length || cfg?.canActivateChild?.length || cfg?.canMatch?.length) {
        return true;
      }
      snap = snap.firstChild;
    }
    return false;
  }
}

/**
 * Turn on idle timeout + session-expiry handling for an app:
 * `provideSessionTimeout(AuthService, { idleMinutes: 15 })`. Pair with
 * `<sd-session-timeout />` in the root template for the warning dialog.
 */
export function provideSessionTimeout(
  auth: Type<SessionAuth>,
  config: SessionTimeoutConfig,
): EnvironmentProviders {
  const resolved: ResolvedConfig = {
    warningSeconds: 60,
    keepAliveMinutes: 4,
    loginUrl: '/auth/login',
    deadlineWarningMinutes: 5,
    ...config,
  };
  return makeEnvironmentProviders([
    { provide: SESSION_AUTH, useExisting: auth },
    { provide: SESSION_TIMEOUT_CONFIG, useValue: resolved },
    provideEnvironmentInitializer(() => inject(SessionTimeoutService).start()),
  ]);
}
