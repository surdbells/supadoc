import { InjectionToken } from '@angular/core';
import { apiErrorCode } from '@supadoc/data-access';
import type { SessionEndReason } from './session-auth';

/** A JWT's claims (unverified — only for timing and "same user?" checks), or null. */
function jwtClaims(token: string | null | undefined): Record<string, unknown> | null {
  const part = token?.split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
    const claims = JSON.parse(json) as unknown;
    return claims && typeof claims === 'object' ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The `exp` claim of a JWT as epoch ms, or null when absent/unreadable. */
export function jwtExpiryMs(token: string | null | undefined): number | null {
  const exp = jwtClaims(token)?.['exp'];
  return typeof exp === 'number' ? exp * 1000 : null;
}

/** The `iat` (issued-at) claim of a JWT as epoch ms, or null. */
export function jwtIssuedAtMs(token: string | null | undefined): number | null {
  const iat = jwtClaims(token)?.['iat'];
  return typeof iat === 'number' ? iat * 1000 : null;
}

/** The `sub` (user id) claim of a JWT, or null — tells "the same user" from "someone else". */
export function jwtSubject(token: string | null | undefined): string | null {
  const sub = jwtClaims(token)?.['sub'];
  if (typeof sub === 'number') return String(sub);
  return typeof sub === 'string' && sub !== '' ? sub : null;
}

/**
 * How long before an access token's expiry it counts as "about to expire", for
 * a wanted margin: `minMs`, but never more than three quarters of the token's
 * own lifetime — so a short-lived token (a 60 s test TTL) is not refreshed on
 * every request.
 */
export function refreshMarginMs(token: string | null | undefined, minMs: number): number {
  const exp = jwtExpiryMs(token);
  const iat = jwtIssuedAtMs(token);
  if (exp === null || iat === null || exp <= iat) return minMs;
  return Math.min(minMs, Math.floor((exp - iat) * 0.75));
}

/**
 * A same-app path that is safe to return to after signing in: starts with one
 * `/` (not `//host` or `/\host`, which browsers treat as another site) and is
 * not one of the sign-in screens themselves.
 */
export function isSafeReturnUrl(url: string | null | undefined): url is string {
  if (typeof url !== 'string' || url === '') return false;
  if (!url.startsWith('/') || url.startsWith('//') || url.startsWith('/\\')) return false;
  return !/^\/auth(\/|\?|#|$)/.test(url);
}

/** What to do about a 401 on a signed-in request, from its `errors.code`. */
export type Auth401Action = 'refresh' | 'end' | 'pass';

/**
 * - `token_expired` / `token_invalid` / no code (an API without codes) →
 *   refresh once, then retry;
 * - `token_missing` → refresh when there is a refresh token, else pass it on;
 * - `session_*`, `account_*`, `refresh_invalid`, `signed_out` → the session is
 *   over: end it now;
 * - `token_wrong_audience` (or anything unknown) → pass it on untouched.
 */
export function classifyAuth401(code: string | null, hasRefresh: boolean): Auth401Action {
  if (code === null || code === 'token_expired' || code === 'token_invalid') return 'refresh';
  if (code === 'token_missing') return hasRefresh ? 'refresh' : 'pass';
  if (isSessionEndCode(code)) return 'end';
  return 'pass';
}

/** Codes that mean the session is over (`signed_out` is the client's own). */
function isSessionEndCode(code: string | null): boolean {
  return code !== null && (/^(session_|account_)/.test(code) || code === 'refresh_invalid' || code === 'signed_out');
}

/** The sign-in notice to leave for a server-ended session. */
export function endReasonFor(code: string | null, reason?: string | null): SessionEndReason {
  if (code === 'session_revoked' || (code !== null && code.startsWith('account_'))) return 'revoked';
  if (code === 'session_expired' && reason === 'idle') return 'idle';
  return 'expired';
}

/** The HTTP status from a raw HttpErrorResponse or a normalised ApiError. */
export function errorStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as { status?: unknown; statusCode?: unknown };
  if (typeof e.statusCode === 'number') return e.statusCode;
  if (typeof e.status === 'number') return e.status;
  return undefined;
}

/**
 * Whether a failed refresh means the session is definitively over (the server
 * rejected it: 401, or a 422 for a malformed refresh token) rather than a
 * transient failure (offline, 5xx, 429 — or a 400 / 403 from a CDN or WAF in
 * front of the API) that must NOT sign the user out.
 */
export function isDefinitiveAuthFailure(err: unknown): boolean {
  const status = errorStatus(err);
  return status === 401 || status === 422;
}

/**
 * Whether an error means "your session is over" — the auth layer has already
 * signed the user out and is sending them to sign in, so a page should not
 * show it as a load / save error of its own.
 */
export function isSessionEndError(err: unknown): boolean {
  return errorStatus(err) === 401 && isSessionEndCode(apiErrorCode(err));
}

/** How long a failed request asked us to wait (`Retry-After`), from either error shape. */
export function retryAfterMsOf(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { retryAfterMs?: unknown; headers?: { get?: (name: string) => string | null } };
  if (typeof e.retryAfterMs === 'number' && e.retryAfterMs >= 0) return e.retryAfterMs;
  const raw = e.headers?.get?.('Retry-After')?.trim();
  if (raw && /^\d+(\.\d+)?$/.test(raw)) return Math.round(Number(raw) * 1000);
  return null;
}

/** Reload the window (a no-op outside a browser). */
export function reloadWindow(): void {
  if (typeof window !== 'undefined') window.location.reload();
}

/**
 * Reloads the page — when another tab signed a different user in, this tab
 * starts over clean under them. A token so tests can stand in for it; an app
 * with an idle timeout (`provideSessionTimeout`) defers it until a live call
 * on this tab has ended.
 */
export const RELOAD_PAGE = new InjectionToken<() => void>('SUPADOC_RELOAD_PAGE', {
  providedIn: 'root',
  factory: () => reloadWindow,
});

/**
 * How far this device's clock is ahead of the server's (ms), measured from a
 * token the server has just issued (its `iat` is "server now"). Token expiries
 * are in server time, so a device with a wrong clock must shift them by this.
 */
export function clockOffsetFrom(freshToken: string | null | undefined): number {
  const iat = jwtIssuedAtMs(freshToken);
  return iat === null ? 0 : Date.now() - iat;
}

/** A server-time token expiry translated to this device's clock, or null. */
export function localExpiryMs(token: string | null | undefined, offsetMs: number): number | null {
  const exp = jwtExpiryMs(token);
  return exp === null ? null : exp + offsetMs;
}

/** Cross-tab "session ended" marker, so other tabs can say why they signed out. */
export interface SessionEndedMarker {
  reason: SessionEndReason | 'signed-out';
  message?: string;
  at: number;
}

export function writeEndedMarker(key: string, marker: Omit<SessionEndedMarker, 'at'>): void {
  try {
    localStorage.setItem(key, JSON.stringify({ ...marker, at: Date.now() }));
  } catch {
    /* best-effort */
  }
}

/** A marker written within the last few seconds (older ones are stale). */
export function readEndedMarker(key: string): SessionEndedMarker | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const marker = JSON.parse(raw) as SessionEndedMarker;
    return Date.now() - marker.at < 10_000 ? marker : null;
  } catch {
    return null;
  }
}
