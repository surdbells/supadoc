import { isSafeReturnUrl } from './session-utils';

/**
 * Where to go back to after signing in, and whose page it was — held in
 * sessionStorage (this tab only). `sub` is the user who was signed out
 * involuntarily (idle, expiry, revoked); their page is never handed to someone
 * else who signs in at the same screen. No `sub`: remembered for a visitor who
 * was not signed in (e.g. "Book consultation" while signed out) — honoured
 * for whoever signs in.
 */
export interface ReturnTarget {
  url?: string;
  sub?: string | null;
}

export function readReturnTarget(key: string): ReturnTarget | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  // Before return targets were tied to a user they were stored as the bare URL.
  if (raw.startsWith('/')) return isSafeReturnUrl(raw) ? { url: raw } : null;
  try {
    const parsed = JSON.parse(raw) as ReturnTarget | null;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      url: isSafeReturnUrl(parsed.url) ? parsed.url : undefined,
      sub:
        typeof parsed.sub === 'string' && parsed.sub !== '' ? parsed.sub : null,
    };
  } catch {
    return null;
  }
}

export function writeReturnTarget(key: string, target: ReturnTarget): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(target));
  } catch {
    /* storage unavailable — the redirect is best-effort */
  }
}

export function clearReturnTarget(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* no-op */
  }
}

/**
 * The URL of a stored target if `me` may use it — `me` being the user now
 * signed in (null before sign-in, e.g. a peek from the sign-in screen, or an
 * opaque token with no `sub`).
 */
export function returnUrlFor(
  target: ReturnTarget | null,
  me: string | null,
): string | null {
  if (!target?.url) return null;
  if (target.sub && me !== null && target.sub !== me) return null;
  return target.url;
}
