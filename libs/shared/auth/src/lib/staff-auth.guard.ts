import { inject } from '@angular/core';
import {
  CanActivateChildFn,
  CanActivateFn,
  Router,
  UrlTree,
} from '@angular/router';
import type { StaffUserDto } from '@supadoc/models';
import { ensureSignedIn } from './auth.guard';
import { StaffAuthService } from './staff-auth.service';

/** Told on the sign-in page when a signed-in account lacks the role this portal needs. */
export const WRONG_PORTAL_MESSAGE =
  "This account can't sign in to this portal. Please sign in with the right account.";

type GuardResult = true | UrlTree;

/**
 * Allows navigation only when a staff user is signed in (and, if the app
 * configured a `requiredRole`, carries it), refreshing a token about to
 * expire first. Use it as `canActivate` on the shell AND `canActivateChild`,
 * so every page is checked. Otherwise remembers the target URL and redirects
 * to the sign-in screen. An account that has loaded and lacks the role is
 * signed out (with a notice saying why) rather than bounced silently; when the
 * user is not known yet (e.g. the cached copy has not arrived from the tab
 * that signed in), it is loaded first — and if that fails for now, the page
 * opens (the API enforces roles), never ending a session that may be valid.
 */
export const staffAuthGuard: CanActivateFn & CanActivateChildFn = (
  _route,
  state,
) => {
  const auth = inject(StaffAuthService);
  const router = inject(Router);
  const judge = (user: StaffUserDto, required: string): GuardResult => {
    if (user.roles.includes(required)) return true;
    auth.expire('revoked', WRONG_PORTAL_MESSAGE);
    return router.parseUrl('/auth/login');
  };
  const roleCheck = (signedIn: GuardResult): GuardResult | Promise<GuardResult> => {
    if (signedIn !== true) return signedIn;
    const required = auth.requiredRole();
    if (!required) return true;
    const cached = auth.user();
    if (cached && Array.isArray(cached.roles)) return judge(cached, required);
    return auth.loadMe().then((user) => {
      if (user && Array.isArray(user.roles)) return judge(user, required);
      // The session ended while loading (its 401 signed the user out): sign in.
      if (!auth.isAuthenticated()) {
        auth.rememberRedirect(state.url);
        return router.parseUrl('/auth/login');
      }
      return true;
    });
  };
  const signedIn = ensureSignedIn(auth, router, state.url);
  return signedIn instanceof Promise
    ? signedIn.then(roleCheck)
    : roleCheck(signedIn);
};

/**
 * Factory for a permission-gated route guard. Redirects to `/` (the app's
 * landing) when the signed-in user lacks the permission. Use for RBAC nav.
 */
export function permissionGuard(permission: string): CanActivateFn {
  return (_route, state) => {
    const auth = inject(StaffAuthService);
    const router = inject(Router);
    if (!auth.isAuthenticated()) {
      auth.rememberRedirect(state.url);
      return router.parseUrl('/auth/login');
    }
    return auth.hasPermission(permission) ? true : router.parseUrl('/');
  };
}
