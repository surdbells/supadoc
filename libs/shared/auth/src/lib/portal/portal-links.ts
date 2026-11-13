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

/** The label each staff portal's host starts with (`doctor.dosthq.com`, `backoffice.dosthq.com`). */
const PORTAL_LABEL: Record<PortalKind, string> = {
  doctor: 'doctor',
  admin: 'backoffice',
};
const STAFF_LABELS = Object.values(PORTAL_LABEL);

/** The homepage's query parameter naming the portal the visitor just left (`?from=admin`). */
const FROM_PARAM = 'from';
/** Where the homepage keeps it for the tab (sessionStorage): the portal "Go to Dashboard" prefers. */
const FROM_KEY = 'vm_portal_from';

const isPortalKind = (v: unknown): v is PortalKind =>
  typeof v === 'string' && Object.hasOwn(HINT_COOKIE, v);

/**
 * The public homepage for a staff portal at `loc`: the patient site of the same
 * group (`doctor.betacrest.com` → `https://patient.betacrest.com/`; the groups
 * run the same builds, so this follows the location, not the build), the dev
 * patient app on localhost, else the main site — never a guessed host on a
 * shared domain such as a preview's `pages.dev`. With `from`, it names the
 * portal being left (`?from=admin`, non-secret) so the homepage's "Go to
 * Dashboard" leads back there even when the browser holds both portals' hints.
 */
export function publicHomeUrl(loc: SiteLocation, from?: PortalKind): string {
  const query = from ? `?${FROM_PARAM}=${from}` : '';
  if (isLocalHost(loc.hostname))
    return `${loc.protocol}//${loc.hostname}:${DEV_PATIENT_PORT}/${query}`;
  const labels = loc.hostname.split('.');
  if (
    loc.protocol === 'https:' &&
    labels.length >= 3 &&
    STAFF_LABELS.includes(labels[0])
  ) {
    return `https://patient.${labels.slice(1).join('.')}/${query}`;
  }
  return `${DEFAULT_HOME}${query}`;
}

/**
 * A hint's portal homepage, if it is this group's `kind` portal; else null. On
 * a live site: https, under this site's parent domain, and on the portal's own
 * label (`doctor.` / `backoffice.`), so no other sibling (the API host, say)
 * can steer "Go to Dashboard" elsewhere.
 */
function validHint(
  raw: string,
  loc: SiteLocation,
  kind: PortalKind,
): string | null {
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
      !url.hostname.endsWith(`.${parent}`) ||
      url.hostname.split('.')[0] !== PORTAL_LABEL[kind]
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
    const url = validHint(part.slice(eq + 1).trim(), loc, kind);
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
 * The portal the visitor came to the homepage from (the staff logo's
 * `?from=doctor|admin`), kept for the tab so the homepage keeps preferring it
 * after in-app browsing; else the one kept earlier, or null. Never throws.
 */
export function portalFrom(
  search: string,
  store: Pick<Storage, 'getItem' | 'setItem'> | null = sessionStore(),
): PortalKind | null {
  const fresh = new URLSearchParams(search).get(FROM_PARAM);
  try {
    if (isPortalKind(fresh)) {
      store?.setItem(FROM_KEY, fresh);
      return fresh;
    }
    const kept = store?.getItem(FROM_KEY);
    return isPortalKind(kept) ? kept : null;
  } catch {
    return isPortalKind(fresh) ? fresh : null;
  }
}

function sessionStore(): Storage | null {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
}

/** `search` without the homepage's `from` parameter (`''` when nothing else is left). */
export function withoutPortalFrom(search: string): string {
  const params = new URLSearchParams(search);
  if (!params.has(FROM_PARAM)) return search;
  params.delete(FROM_PARAM);
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}

/**
 * Whether a link click is a plain primary click, which the app may handle
 * itself; a modified click keeps the link's own behaviour (new tab / window).
 */
export function isPlainClick(e: MouseEvent): boolean {
  return e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;
}
