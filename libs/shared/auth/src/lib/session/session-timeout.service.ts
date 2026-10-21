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
import {
  ActivatedRouteSnapshot,
  NavigationCancel,
  NavigationEnd,
  NavigationError,
  NavigationSkipped,
  Router,
} from '@angular/router';
import { filter, take } from 'rxjs';
import { SESSION_AUTH, SessionAuth, SessionEndReason } from './session-auth';
import { peekSessionNotice } from './session-notice';
import { refreshMarginMs, RELOAD_PAGE, reloadWindow } from './session-utils';

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
/** Refresh the access token this long before it expires (while someone is using the app). */
const PROACTIVE_REFRESH_MS = 120_000;
/** …only for someone active within this long (or while a hold is on). */
const PROACTIVE_ACTIVE_MS = 15 * 60_000;
/** …and at most this often, whatever happens to the attempt. */
const PROACTIVE_EVERY_MS = 30_000;
/** During a call, warn this long before the absolute session lifetime runs out. */
const IN_CALL_DEADLINE_LEAD_MS = 30 * 60_000;
/** Holds taken by uploads (`upload:1`, …) — they pause the idle timer but aren't a call. */
export const UPLOAD_HOLD_PREFIX = 'upload:';

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
 * - Pauses while something legitimately has no input (an active video call,
 *   a long upload) via {@link hold}/{@link release}, and keeps the server
 *   session warm with a periodic keep-alive while the user is active, so the
 *   server-side idle window never closes under someone who is using the app.
 * - Refreshes the access token two minutes before it expires while the user
 *   is active in a visible tab (or a hold is on, even hidden), so requests
 *   never meet an expired token.
 * - Never ends a session, or leaves the page, in the middle of a hold: the
 *   absolute-lifetime notice comes 30 minutes early in a call, and the local
 *   sign-out waits for the call to end (the server's limit still applies).
 *   Nor reloads it mid-call when someone else signs in in another tab (see
 *   {@link reloadWhenFree}).
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
  /** A call holds the session open — the deadline notice then comes early and offers signing in again in a new tab. */
  readonly holding = signal(false);
  /** Where the app's sign-in page is (for "sign in again in a new tab"). */
  readonly loginUrl: string = this.config.loginUrl;
  /** The user dismissed the deadline notice; don't show it again this session. */
  private deadlineNoticeDismissed = false;
  /** A sign-out happened during a call; leave the page once the call ends. */
  private pendingRedirect = false;
  /** The absolute lifetime ran out during a hold: end the session once it is released. */
  private deadlineDeferred = false;
  /** Another user signed in in another tab during a call: reload once the call is left. */
  private reloadPending: (() => void) | null = null;
  /** Waiting for the navigation after a call before that reload. */
  private awaitingReloadNavigation = false;
  /** A sign-out arrived during a navigation: look again once it settles. */
  private awaitingNavigation = false;

  private readonly holds = new Set<string>();
  private lastActivity = Date.now();
  private lastPersisted = 0;
  private lastKeepAlive = Date.now();
  private activeSinceKeepAlive = false;
  private lastProactive = 0;
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
    this.syncHolding();
  }

  release(key: string): void {
    if (this.holds.delete(key)) this.recordActivity(Date.now(), true);
    this.syncHolding();
    if (this.holds.size > 0) return;
    // Someone else signed in in another tab during the call: start over under
    // them as soon as this tab moves on from the call screen.
    if (this.reloadPending) this.reloadAfterNextNavigation();
    // The absolute lifetime ran out during the call: the session ends only now —
    // if it is still that session (not one signed in again since, in another tab).
    if (this.deadlineDeferred) {
      this.deadlineDeferred = false;
      const deadline = this.auth.sessionDeadline();
      if (this.auth.isAuthenticated() && deadline !== null && Date.now() >= deadline) {
        this.end('expired');
        return;
      }
    }
    // A sign-out that happened mid-call leaves the page only now.
    if (this.pendingRedirect && !this.auth.isAuthenticated()) {
      this.pendingRedirect = false;
      this.leaveProtectedPage();
    }
  }

  /**
   * Reload the page (another user signed in in another tab, so this one starts
   * over under them) — at once, or during a call only after it: at the first
   * navigation once the call has released its hold. Never on the release
   * itself: the call screen is still open then (the patient left first, or
   * the doctor is about to be taken elsewhere), and a reload there would join
   * the call again. A live consultation is never dropped by a reload.
   */
  reloadWhenFree(reload: () => void = reloadWindow): void {
    if (!this.holding()) {
      reload();
      return;
    }
    this.reloadPending = reload;
  }

  /** Dismiss the "session ends soon" notice (it cannot be extended). */
  dismissDeadlineNotice(): void {
    this.deadlineNoticeDismissed = true;
    this.setDeadlineSoon(null);
  }

  // ----- internals -----

  private onSignedIn(): void {
    this.pendingRedirect = false;
    this.deadlineDeferred = false;
    this.deadlineNoticeDismissed = false;
    this.setDeadlineSoon(null);
    this.recordActivity(Date.now(), true);
    this.lastKeepAlive = Date.now();
    this.activeSinceKeepAlive = false;
    this.lastProactive = 0;
    this.setWarning(false);
  }

  /** Signed out (here, in another tab, or by the server): leave protected pages. */
  private onSignedOut(): void {
    this.setWarning(false);
    this.setDeadlineSoon(null);
    this.deadlineDeferred = false;
    // A navigation already under way (e.g. "Log out" sending the user to the
    // sign-in page) decides where they land — but once it settles, a user
    // left on a protected page (the destination let them through before the
    // sign-out took effect) is still taken to sign in.
    if (untracked(() => this.router.currentNavigation()) !== null) {
      this.afterNavigation();
      return;
    }
    // Never tear down a live consultation: leave once the call is over.
    if (this.holds.size > 0) {
      this.pendingRedirect = true;
      return;
    }
    this.leaveProtectedPage();
  }

  /** The deferred reload, once the next navigation lands — unless a call holds the session again by then. */
  private reloadAfterNextNavigation(): void {
    if (this.awaitingReloadNavigation) return;
    this.awaitingReloadNavigation = true;
    this.router.events
      .pipe(
        filter((e) => e instanceof NavigationEnd),
        take(1),
      )
      .subscribe(() => {
        this.awaitingReloadNavigation = false;
        const reload = this.reloadPending;
        // A new call took the session (its release watches again).
        if (!reload || this.holding()) return;
        this.reloadPending = null;
        reload();
      });
  }

  /** Run the sign-out check again once the current navigation ends (one watcher at a time). */
  private afterNavigation(): void {
    if (this.awaitingNavigation) return;
    this.awaitingNavigation = true;
    this.router.events
      .pipe(
        filter(
          (e) =>
            e instanceof NavigationEnd ||
            e instanceof NavigationCancel ||
            e instanceof NavigationError ||
            e instanceof NavigationSkipped,
        ),
        take(1),
      )
      // The router marks the navigation finished only after announcing its end.
      .subscribe(() =>
        setTimeout(() => {
          this.awaitingNavigation = false;
          // Signed in again meanwhile: nothing to do.
          if (!this.auth.isAuthenticated()) this.onSignedOut();
        }),
      );
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

    const held = this.holds.size > 0;
    const deadline = this.auth.sessionDeadline();
    if (deadline !== null && now >= deadline) {
      if (!held) {
        this.end('expired');
        return;
      }
      // Mid-call: the server's limit stands (requests may start failing), but
      // the local sign-out — and leaving the page — waits for the call to end.
      this.deadlineDeferred = true;
    } else {
      // A new session (signed in again in another tab) has its own deadline.
      this.deadlineDeferred = false;
    }
    // Warn ahead of the absolute lifetime so nobody loses work to it — in a
    // call, half an hour ahead, with a way to sign in again in another tab.
    const lead = this.holding() ? IN_CALL_DEADLINE_LEAD_MS : this.config.deadlineWarningMinutes * 60_000;
    const soon = deadline !== null && deadline - now <= lead && !this.deadlineNoticeDismissed ? deadline : null;
    if (soon !== this.deadlineSoon()) this.setDeadlineSoon(soon);

    if (held) this.recordActivity(now);

    // Activity in another tab counts too.
    const stored = this.readStoredActivity();
    if (stored !== null && stored > this.lastActivity) this.lastActivity = stored;

    this.refreshAhead(now, held);

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

  /**
   * Renew the access token shortly before it expires, so a request never has
   * to: while the user is active in a visible tab, or while a hold is on (a
   * call screen keeps working in a hidden tab). At most every 30 s, whatever
   * the outcome (a refused refresh ends the session; a transient failure backs off).
   */
  private refreshAhead(now: number, held: boolean): void {
    if (now - this.lastProactive < PROACTIVE_EVERY_MS || !this.auth.hasRefreshToken()) return;
    const exp = this.auth.accessExpiresAt();
    if (exp === null) return;
    if (exp - now > refreshMarginMs(this.auth.token(), PROACTIVE_REFRESH_MS)) return;
    const visible = typeof document === 'undefined' || document.visibilityState === 'visible';
    if (!held && !(visible && now - this.lastActivity < PROACTIVE_ACTIVE_MS)) return;
    this.lastProactive = now;
    this.zone.run(() => void this.auth.refresh());
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

  /** `holding` is on while a call (any hold but an upload's) keeps the session open. */
  private syncHolding(): void {
    const on = [...this.holds].some((key) => !key.startsWith(UPLOAD_HOLD_PREFIX));
    if (this.holding() === on) return;
    this.zone.run(() => this.holding.set(on));
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
    {
      // The auth service reloads when another user signs in elsewhere: never
      // mid-call. Resolved lazily — the watcher itself depends on the auth service.
      provide: RELOAD_PAGE,
      useFactory: () => {
        const injector = inject(Injector);
        return () => injector.get(SessionTimeoutService).reloadWhenFree();
      },
    },
    provideEnvironmentInitializer(() => inject(SessionTimeoutService).start()),
  ]);
}
