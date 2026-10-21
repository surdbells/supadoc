import { InjectionToken, Signal } from '@angular/core';

/** Why a session ended without the user signing out in this tab. */
export type SessionEndReason = 'idle' | 'expired' | 'revoked' | 'elsewhere';

/** How a token refresh was started. */
export interface RefreshOptions {
  /**
   * Started on behalf of a background poll (a request carrying
   * `X-SD-Passive: 1`): the refresh is sent passive too, so the API checks the
   * session without restarting its idle clock. The timed pre-expiry refresh,
   * the guards and user-initiated requests never pass it — the call hold and
   * an active user's session rely on those counting as activity. A passive
   * caller joining a refresh already in flight shares it either way.
   */
  readonly passive?: boolean;
}

/**
 * What the request handler ({@link handleSessionRequest}) needs from an auth
 * silo: the access token, and a way to renew it or end the session.
 */
export interface TokenSession {
  readonly token: Signal<string | null>;
  readonly isAuthenticated: Signal<boolean>;
  /** Whether a refresh token is stored (an expired access token can be renewed). */
  hasRefreshToken(): boolean;
  /**
   * Exchange the refresh token for a new access token — one request however
   * many callers. False when it failed: definitively (the session was ended)
   * or for now (offline, 5xx, rate limited — still signed in, backing off).
   */
  refresh(options?: RefreshOptions): Promise<boolean>;
  /**
   * Resolve once the access token is good for at least `minMs` more (default
   * 60 s): waits for a refresh already running, refreshes once when the token
   * is about to expire, and never throws or loops.
   */
  ensureFreshToken(minMs?: number, options?: RefreshOptions): Promise<void>;
  /**
   * End the session involuntarily (idle timeout, expiry, server rejection):
   * revoke it server-side, clear it locally (and in other tabs) and leave a
   * notice for the sign-in screen explaining why.
   */
  expire(reason: SessionEndReason, message?: string): void;
}

/**
 * What the idle/expiry machinery needs from an auth silo. Both the patient
 * `AuthService` and the staff `StaffAuthService` implement it, so one
 * {@link SessionTimeoutService} serves every portal.
 */
export interface SessionAuth extends TokenSession {
  /** Sign out on purpose (no notice). */
  logout(): unknown;
  /** Touch the server session so its idle clock restarts (refreshing if needed). */
  keepAlive(): Promise<void>;
  /** Epoch ms when the session hits its absolute lifetime, or null if unknown. */
  sessionDeadline(): number | null;
  /** Epoch ms (this device's clock) when the access token expires, or null if unknown. */
  accessExpiresAt(): number | null;
  /** Remember where to return after signing back in. */
  rememberRedirect(url: string): void;
  /** localStorage key holding the last-activity timestamp shared across tabs. */
  readonly activityKey: string;
}

export const SESSION_AUTH = new InjectionToken<SessionAuth>(
  'SUPADOC_SESSION_AUTH',
);
