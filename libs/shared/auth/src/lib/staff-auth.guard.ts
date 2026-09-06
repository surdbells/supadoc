import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { StaffAuthService } from './staff-auth.service';

/**
 * Allows navigation only when a staff user is signed in (and, if the app
 * configured a `requiredRole`, carries it). Otherwise remembers the target URL
 * and redirects to the sign-in screen.
 */
export const staffAuthGuard: CanActivateFn = (_route, state) => {
  const auth = inject(StaffAuthService);
  const router = inject(Router);
  if (!auth.isAuthenticated()) {
    auth.rememberRedirect(state.url);
    return router.parseUrl('/auth/login');
  }
  const required = auth.requiredRole();
  if (required && !auth.hasRole(required)) {
    return router.parseUrl('/auth/login');
  }
  return true;
};

/**
 * Factory for a permission-gated route guard. Redirects to `/` (the app's
 * landing) when the signed-in user lacks the permission. Use for RBAC nav.
 */
export function permissionGuard(permission: string): CanActivateFn {
  return () => {
    const auth = inject(StaffAuthService);
    const router = inject(Router);
    if (!auth.isAuthenticated()) return router.parseUrl('/auth/login');
    return auth.hasPermission(permission) ? true : router.parseUrl('/');
  };
}
