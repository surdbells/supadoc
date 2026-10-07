import type { SessionEndReason } from './session-auth';

/** The `exp` claim of a JWT as epoch ms, or null when absent/unreadable. */
export function jwtExpiryMs(token: string | null | undefined): number | null {
  const part = token?.split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/** The `iat` (issued-at) claim of a JWT as epoch ms, or null. */
export function jwtIssuedAtMs(token: string | null | undefined): number | null {
  const part = token?.split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
    const iat = (JSON.parse(json) as { iat?: unknown }).iat;
    return typeof iat === 'number' ? iat * 1000 : null;
  } catch {
    return null;
  }
}

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
 * rejected it) rather than a transient failure (offline, 5xx) that must NOT
 * sign the user out.
 */
export function isDefinitiveAuthFailure(err: unknown): boolean {
  const status = errorStatus(err);
  return status === 400 || status === 401 || status === 403 || status === 422;
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
