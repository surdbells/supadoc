import { inject } from '@angular/core';
import {
  CanActivateChildFn,
  CanActivateFn,
  Router,
  UrlTree,
} from '@angular/router';
import { AuthService } from './auth.service';
import type { SessionAuth } from './session/session-auth';

/** A token with less life than this left is refreshed before the page opens. */
export const GUARD_TOKEN_MARGIN_MS = 60_000;
/** A navigation waits at most this long for that refresh (the page's own requests still wait for it). */
export const GUARD_REFRESH_WAIT_MS = 10_000;

/**
 * The shared "signed in, with a token good enough to load this page" check:
 * `true` at once while the access token has a minute or more left; otherwise
 * it waits for a refresh first (so the page's first requests leave with a
 * fresh token) — for {@link GUARD_REFRESH_WAIT_MS} at most, so a slow API never
 * freezes navigation. Signed out — before, or because that refresh was
 * refused — it remembers the page and answers with the sign-in page. A
 * refresh that failed for now (offline), or is still running, lets the page
 * open: the API still enforces the session.
 */
export function ensureSignedIn(
  auth: SessionAuth,
  router: Router,
  url: string,
  loginUrl = '/auth/login',
): true | UrlTree | Promise<true | UrlTree> {
  const toLogin = (): UrlTree => {
    auth.rememberRedirect(url);
    return router.parseUrl(loginUrl);
  };
  if (!auth.isAuthenticated()) return toLogin();
  const exp = auth.accessExpiresAt();
  if (exp === null || exp - Date.now() > GUARD_TOKEN_MARGIN_MS) return true;
  const fresh = new Promise<void>((resolve) => {
    const giveUp = setTimeout(resolve, GUARD_REFRESH_WAIT_MS);
    auth
      .ensureFreshToken(GUARD_TOKEN_MARGIN_MS)
      .catch(() => undefined)
      .then(() => {
        clearTimeout(giveUp);
        resolve();
      });
  });
  return fresh.then(() => (auth.isAuthenticated() ? true : toLogin()));
}

/**
 * Route guard (`canActivate` on the signed-in shell and `canActivateChild` for
 * every page under it) that allows navigation only when the patient is signed
 * in, refreshing a token about to expire first. Otherwise it remembers the
 * attempted URL (so the auth flow can return there, keeping the patient's
 * selection) and redirects to the sign-in screen.
 */
export const authGuard: CanActivateFn & CanActivateChildFn = (_route, state) =>
  ensureSignedIn(inject(AuthService), inject(Router), state.url);
