import { InjectionToken, Signal } from '@angular/core';

/** Why a session ended without the user signing out in this tab. */
export type SessionEndReason = 'idle' | 'expired' | 'revoked' | 'elsewhere';

/**
 * What the idle/expiry machinery needs from an auth silo. Both the patient
 * `AuthService` and the staff `StaffAuthService` implement it, so one
 * {@link SessionTimeoutService} serves every portal.
 */
export interface SessionAuth {
  readonly isAuthenticated: Signal<boolean>;
  /**
   * End the session involuntarily (idle timeout, expiry, server rejection):
   * revoke it server-side, clear it locally (and in other tabs) and leave a
   * notice for the sign-in screen explaining why.
   */
  expire(reason: SessionEndReason, message?: string): void;
  /** Sign out on purpose (no notice). */
  logout(): unknown;
  /** Touch the server session so its idle clock restarts (refreshing if needed). */
  keepAlive(): Promise<void>;
  /** Epoch ms when the session hits its absolute lifetime, or null if unknown. */
  sessionDeadline(): number | null;
  /** Remember where to return after signing back in. */
  rememberRedirect(url: string): void;
  /** localStorage key holding the last-activity timestamp shared across tabs. */
  readonly activityKey: string;
}

export const SESSION_AUTH = new InjectionToken<SessionAuth>('SUPADOC_SESSION_AUTH');
