/**
 * The "portal hint": a non-secret cookie a signed-in staff app (doctor / back
 * office) sets on the parent domain it shares with the public homepage
 * (`doctor.dosthq.com` and `patient.dosthq.com` → `dosthq.com`), so the
 * homepage can offer "Go to Dashboard". Its value is only the portal's own
 * public origin: never a token, id, name or email. It is not an authenticator
 * (the portal still needs its own session), and the homepage accepts only an
 * origin under its own parent domain (see `@supadoc/auth/portal`).
 *
 * Only the writer lives here (it runs with every staff session, so it is kept
 * small); the reader, the homepage URL and the logo's leaving are in the lazy
 * `@supadoc/auth/portal`.
 */

export type PortalKind = 'doctor' | 'admin';

/** The parts of `window.location` these helpers use (injectable for tests). */
export interface SiteLocation {
  readonly protocol: string;
  readonly hostname: string;
  readonly origin: string;
}

/** A hint outlives no session, and never lasts more than 12 hours unrefreshed. */
const MAX_AGE_CAP_S = 43200;

/**
 * The cookie string recording "this browser has a `kind` portal session at
 * `loc`", expiring with the session (`deadlineMs`, device clock; null: unknown)
 * or in 12 h. A deadline already past (e.g. 0) gives the string that removes
 * it. On https it is Secure and shared on the parent domain (the last two
 * labels of a 3+ label name); on localhost it is host-only, which every dev
 * port shares.
 */
export function portalHintCookie(
  kind: PortalKind,
  loc: SiteLocation,
  deadlineMs: number | null,
  now = Date.now(),
): string {
  const left =
    deadlineMs === null ? MAX_AGE_CAP_S : Math.floor((deadlineMs - now) / 1000);
  const maxAge = Math.max(0, Math.min(MAX_AGE_CAP_S, left));
  const labels = loc.hostname.split('.');
  const secure = loc.protocol === 'https:';
  return (
    `vm_portal_${kind}=${maxAge ? encodeURIComponent(loc.origin) : ''}; Path=/; Max-Age=${maxAge}; SameSite=Lax` +
    (secure ? '; Secure' : '') +
    (secure && labels.length > 2 && !/^[\d.]+$/.test(loc.hostname)
      ? `; Domain=${labels.slice(-2).join('.')}`
      : '')
  );
}

/** Set, refresh (`deadlineMs`) or remove (`0`) this page's hint. Never throws. */
export function writePortalHint(
  kind: PortalKind,
  deadlineMs: number | null,
): void {
  try {
    document.cookie = portalHintCookie(kind, location, deadlineMs);
  } catch {
    /* cookies unavailable: the homepage just shows Sign in */
  }
}
