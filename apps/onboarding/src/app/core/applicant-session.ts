import { Injectable, signal } from '@angular/core';
import type { LicenceRoute } from '@supadoc/models';

/** sessionStorage keys. Only tokens and the licence-route choice are ever stored. */
export const DRAFT_TOKEN_KEY = 'videomed.onb.draft';
export const TRACK_TOKEN_KEY = 'videomed.onb.track';
export const ROUTE_KEY = 'videomed.onb.route';

function read(key: string): string | null {
  try {
    return globalThis.sessionStorage?.getItem(key) ?? null;
  } catch {
    return null; // storage blocked (private mode, sandbox): memory only
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) globalThis.sessionStorage?.removeItem(key);
    else globalThis.sessionStorage?.setItem(key, value);
  } catch {
    // storage blocked: the signal still holds it for this page's life
  }
}

/**
 * The applicant's tokens: the draft token (wizard, 4 h) and the track access
 * token (status page, 30 min). Kept in sessionStorage so a reload keeps the
 * session but closing the tab ends it; sent only as Bearer headers by
 * `applicantTokenInterceptor`, never in a URL.
 */
@Injectable({ providedIn: 'root' })
export class ApplicantSession {
  readonly draftToken = signal<string | null>(read(DRAFT_TOKEN_KEY));
  readonly accessToken = signal<string | null>(read(TRACK_TOKEN_KEY));

  setDraftToken(token: string | null): void {
    write(DRAFT_TOKEN_KEY, token);
    this.draftToken.set(token);
  }

  setAccessToken(token: string | null): void {
    write(TRACK_TOKEN_KEY, token);
    this.accessToken.set(token);
  }

  /** The licence route chosen before a draft exists (step 0). */
  readRoute(): LicenceRoute | null {
    const r = read(ROUTE_KEY);
    return r === 'ng' || r === 'abroad' ? r : null;
  }

  writeRoute(route: LicenceRoute | null): void {
    write(ROUTE_KEY, route);
  }
}
