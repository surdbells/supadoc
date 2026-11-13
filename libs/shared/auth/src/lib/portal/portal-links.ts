import type { PortalKind, SiteLocation } from '../session/portal-hint';

// Kept apart from session/portal-hint (the writer, in every staff app's main
// bundle) on purpose: this file loads lazily, and importing values from there
// would make the main bundle export them. The cookie names must match its own.
const HINT_COOKIE: Record<PortalKind, string> = {
  doctor: 'vm_portal_doctor',
  admin: 'vm_portal_admin',
};

const isLocalHost = (h: string) =>
  h === 'localhost' || h === '127.0.0.1' || h === '[::1]';

/** The parent domain of a 3+ label name (`patient.dosthq.com` → `dosthq.com`), else null. */
function parentDomain(hostname: string): string | null {
  if (isLocalHost(hostname) || /^[\d.]+$/.test(hostname)) return null;
  const labels = hostname.split('.');
  return labels.length >= 3 ? labels.slice(-2).join('.') : null;
}

/** Validated portal homepages from the hint cookies (origin + `/`). */
export type PortalHints = Partial<Record<PortalKind, string>>;

/** Where staff go when this site's group can't be told (e.g. a preview URL). */
const DEFAULT_HOME = 'https://patient.dosthq.com/';

/** Dev: every app runs on localhost, the patient app on this port. */
const DEV_PATIENT_PORT = 4201;

/** The labels a staff portal's host starts with (`doctor.dosthq.com`). */
const STAFF_LABELS = ['doctor', 'backoffice'];

/**
 * The public homepage for a staff portal at `loc`: the patient site of the same
 * group (`doctor.betacrest.com` → `https://patient.betacrest.com/`; the groups
 * run the same builds, so this follows the location, not the build), the dev
 * patient app on localhost, else the main site — never a guessed host on a
 * shared domain such as a preview's `pages.dev`.
 */
export function publicHomeUrl(loc: SiteLocation): string {
  if (isLocalHost(loc.hostname))
    return `${loc.protocol}//${loc.hostname}:${DEV_PATIENT_PORT}/`;
  const labels = loc.hostname.split('.');
  if (
    loc.protocol === 'https:' &&
    labels.length >= 3 &&
    STAFF_LABELS.includes(labels[0])
  ) {
    return `https://patient.${labels.slice(1).join('.')}/`;
  }
  return DEFAULT_HOME;
}

/** A hint's portal homepage, if it is a site of this group; else null. */
function validHint(raw: string, loc: SiteLocation): string | null {
  let url: URL;
  try {
    url = new URL(decodeURIComponent(raw));
  } catch {
    return null;
  }
  if (isLocalHost(loc.hostname)) {
    if (
      !isLocalHost(url.hostname) ||
      (url.protocol !== 'http:' && url.protocol !== 'https:')
    )
      return null;
  } else {
    const parent = parentDomain(loc.hostname);
    if (
      url.protocol !== 'https:' ||
      !parent ||
      !url.hostname.endsWith(`.${parent}`)
    )
      return null;
  }
  return `${url.origin}/`;
}

/** The staff portals this browser is signed in to, from the hint cookies (only this group's sites). */
export function parsePortalHints(
  cookies: string,
  loc: SiteLocation,
): PortalHints {
  const hints: PortalHints = {};
  const kinds = Object.keys(HINT_COOKIE) as PortalKind[];
  for (const part of cookies.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const kind = kinds.find((k) => HINT_COOKIE[k] === name);
    if (!kind) continue;
    const url = validHint(part.slice(eq + 1).trim(), loc);
    if (url) hints[kind] = url;
  }
  return hints;
}

/** {@link parsePortalHints} for this page. Never throws. */
export function readPortalHints(): PortalHints {
  try {
    return parsePortalHints(document.cookie, location);
  } catch {
    return {};
  }
}

/**
 * Whether a link click is a plain primary click, which the app may handle
 * itself; a modified click keeps the link's own behaviour (new tab / window).
 */
export function isPlainClick(e: MouseEvent): boolean {
  return e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;
}
